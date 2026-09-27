const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([USDC, USDT]);
const RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

const RPC_MS = 8_000;
const SWAP_PAGE = 25;
const SWAP_PAGES = 2;
const TX_CONCURRENCY = 6;

function uiAmount(row) {
  const raw = row?.uiTokenAmount?.uiAmountString ?? row?.uiTokenAmount?.uiAmount;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function rawAmount(row) {
  const n = Number(row?.uiTokenAmount?.amount);
  return Number.isFinite(n) ? n : 0;
}

function ownedBalances(rows, wallet) {
  const map = new Map();
  for (const row of rows || []) {
    if (row?.owner !== wallet || !row.mint) continue;
    map.set(row.mint, (map.get(row.mint) || 0) + uiAmount(row));
  }
  return map;
}

function ownedRaw(rows, wallet) {
  const map = new Map();
  for (const row of rows || []) {
    if (row?.owner !== wallet || !row.mint) continue;
    map.set(row.mint, (map.get(row.mint) || 0) + rawAmount(row));
  }
  return map;
}

function accountKey(keys, index) {
  const key = keys?.[index];
  if (!key) return "";
  return typeof key === "string" ? key : key.pubkey || "";
}

function swapEvents(logs) {
  const events = [];
  for (const line of logs || []) {
    if (!String(line).includes("SwapEvent")) continue;
    const match = String(line).match(/amount_in:\s*(\d+)\s*,\s*amount_out:\s*(\d+)/);
    if (!match) continue;
    events.push({ amountIn: Number(match[1]), amountOut: Number(match[2]) });
  }
  return events;
}

function quoteLegs(tx) {
  const lists = [
    ...(tx?.transaction?.message?.instructions || []),
    ...(tx?.meta?.innerInstructions || []).flatMap((group) => group.instructions || []),
  ];
  const legs = [];
  for (const ix of lists) {
    const info = ix?.parsed?.info;
    const type = ix?.parsed?.type;
    if (!info || (type !== "transferChecked" && type !== "transfer")) continue;
    const mint = info.mint;
    if (mint !== WSOL && !STABLES.has(mint)) continue;
    const raw = Number(info.tokenAmount?.amount ?? info.amount);
    if (!(raw > 0)) continue;
    const ui = Number(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount);
    const decimals = mint === WSOL ? 9 : 6;
    legs.push({ mint, raw, ui: ui > 0 ? ui : raw / 10 ** decimals });
  }
  return legs;
}

/** Quote paid by a relayer, matched to this wallet's raw token change. Zero when it is not a swap. */
function relayedQuoteUsd(tx, rawQty, sell, solUsd) {
  if (!(rawQty > 0)) return 0;
  const event = swapEvents(tx?.meta?.logMessages).find((row) => {
    const tokenRaw = sell ? row.amountIn : row.amountOut;
    return Math.abs(tokenRaw - rawQty) <= 1;
  });
  if (!event) return 0;
  const quoteRaw = sell ? event.amountOut : event.amountIn;
  const leg = quoteLegs(tx).find((row) => Math.abs(row.raw - quoteRaw) <= 1);
  if (!leg) return 0;
  if (STABLES.has(leg.mint)) return leg.ui;
  if (!(Number(solUsd) > 0)) return 0;
  return leg.ui * Number(solUsd);
}

/** A wallet's net swap in one parsed transaction. Null when it is not a buy or sell. */
export function swapFromTransaction(tx, wallet, solUsd) {
  const meta = tx?.meta;
  if (!meta || meta.err || !wallet) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const walletIndex = keys.findIndex((key, index) => accountKey(keys, index) === wallet);
  const pre = ownedBalances(meta.preTokenBalances, wallet);
  const post = ownedBalances(meta.postTokenBalances, wallet);
  const preRaw = ownedRaw(meta.preTokenBalances, wallet);
  const postRaw = ownedRaw(meta.postTokenBalances, wallet);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const deltas = [];
  for (const mint of mints) {
    const delta = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (Math.abs(delta) > 1e-12) deltas.push({ mint, delta });
  }
  const token = deltas
    .filter((row) => !STABLES.has(row.mint) && row.mint !== WSOL)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (!token) return null;

  let quoteUsd = 0;
  for (const row of deltas) {
    if (STABLES.has(row.mint)) quoteUsd += Math.abs(row.delta);
  }
  if (!(quoteUsd > 0) && walletIndex >= 0) {
    const preLamports = Number(meta.preBalances?.[walletIndex]) || 0;
    const postLamports = Number(meta.postBalances?.[walletIndex]) || 0;
    let solDelta = (postLamports - preLamports) / 1e9;
    if (walletIndex === 0) solDelta += (Number(meta.fee) || 0) / 1e9;
    if (Math.abs(solDelta) > 0.00001 && Number(solUsd) > 0) quoteUsd = Math.abs(solDelta) * Number(solUsd);
  }
  const qty = Math.abs(token.delta);
  const sell = token.delta < 0;
  if (!(quoteUsd > 0)) {
    const rawQty = Math.abs((postRaw.get(token.mint) || 0) - (preRaw.get(token.mint) || 0));
    quoteUsd = relayedQuoteUsd(tx, rawQty, sell, solUsd);
  }
  if (!(quoteUsd > 0) || !(qty > 0)) return null;
  const heldQty = pre.get(token.mint) || 0;
  const left = post.get(token.mint) || 0;
  let exitFraction = 0;
  if (sell && heldQty > 0) exitFraction = left <= heldQty * 0.001 ? 1 : Math.min(1, qty / heldQty);
  return {
    mint: token.mint,
    side: sell ? "sell" : "buy",
    qty,
    usd: quoteUsd,
    priceUsd: quoteUsd / qty,
    heldQty: sell ? heldQty : 0,
    soldQty: sell ? qty : 0,
    exitFraction,
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function rpc(fetcher, method, params) {
  for (const url of RPCS) {
    try {
      const response = await withTimeout(fetcher(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "paper-copy-trader" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_MS),
      }), RPC_MS + 250);
      if (!response?.ok) continue;
      const body = await response.json();
      if (body?.error || body?.result === undefined) continue;
      return body.result;
    } catch {
      /* this endpoint hung or refused; try the next one */
    }
  }
  return null;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function printFromSwap(row, swap) {
  return {
    id: `${row.signature}:${swap.side}:${swap.mint}`,
    ts: row.blockTime ? new Date(row.blockTime * 1000).toISOString() : "",
    side: swap.side,
    mint: swap.mint,
    symbol: swap.mint.slice(0, 4),
    usd: swap.usd,
    priceUsd: swap.priceUsd,
    markUsd: 0,
    exitFraction: swap.side === "sell" ? swap.exitFraction : undefined,
    positionId: swap.side === "sell" ? row.signature : undefined,
    soldQty: swap.side === "sell" ? swap.soldQty : undefined,
    heldQty: swap.side === "sell" ? swap.heldQty : undefined,
  };
}

async function swapsOnPage(fetcher, wallet, signatures, solUsd) {
  const rows = (signatures || []).filter((row) => row?.signature && !row.err);
  const parsed = await mapPool(rows, TX_CONCURRENCY, async (row) => {
    try {
      const tx = await rpc(fetcher, "getTransaction", [row.signature, {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 1,
        commitment: "confirmed",
      }]);
      const swap = swapFromTransaction(tx, wallet, solUsd);
      return swap ? printFromSwap(row, swap) : null;
    } catch {
      return null;
    }
  });
  return parsed.filter(Boolean);
}

/** Recent buys and sells for one wallet from public Solana RPC. No key. */
export async function recentSwaps(wallet, options = {}) {
  const fetcher = options.fetchImpl || globalThis.fetch;
  const pageSize = options.limit || SWAP_PAGE;
  const pages = options.pages || SWAP_PAGES;
  const prints = [];
  let before;
  for (let page = 0; page < pages; page += 1) {
    const query = { limit: pageSize };
    if (before) query.before = before;
    const signatures = await rpc(fetcher, "getSignaturesForAddress", [wallet, query]);
    if (!Array.isArray(signatures) || !signatures.length) break;
    prints.push(...await swapsOnPage(fetcher, wallet, signatures, options.solUsd));
    if (prints.length || signatures.length < pageSize) break;
    before = signatures.at(-1)?.signature;
    if (!before) break;
  }
  return prints;
}
