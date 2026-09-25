const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([USDC, USDT]);
const RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

function uiAmount(row) {
  const raw = row?.uiTokenAmount?.uiAmountString ?? row?.uiTokenAmount?.uiAmount;
  const n = Number(raw);
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

function accountKey(keys, index) {
  const key = keys?.[index];
  if (!key) return "";
  return typeof key === "string" ? key : key.pubkey || "";
}

/** A wallet's net swap in one parsed transaction. Null when it is not a buy or sell. */
export function swapFromTransaction(tx, wallet, solUsd) {
  const meta = tx?.meta;
  if (!meta || meta.err || !wallet) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const walletIndex = keys.findIndex((key, index) => accountKey(keys, index) === wallet);
  const pre = ownedBalances(meta.preTokenBalances, wallet);
  const post = ownedBalances(meta.postTokenBalances, wallet);
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
  if (!(quoteUsd > 0) || !(qty > 0)) return null;
  const heldQty = pre.get(token.mint) || 0;
  const left = post.get(token.mint) || 0;
  const sell = token.delta < 0;
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

async function rpc(fetcher, method, params) {
  for (const url of RPCS) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "paper-copy-trader" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (body?.error || body?.result === undefined) continue;
      return body.result;
    } catch {
      /* try the next public endpoint */
    }
  }
  return null;
}

/** Recent buys and sells for one wallet from public Solana RPC. No key. */
export async function recentSwaps(wallet, options = {}) {
  const fetcher = options.fetchImpl || globalThis.fetch;
  const limit = options.limit || 8;
  const signatures = await rpc(fetcher, "getSignaturesForAddress", [wallet, { limit }]);
  if (!Array.isArray(signatures)) return [];
  const prints = [];
  for (const row of signatures) {
    if (!row?.signature || row.err) continue;
    const tx = await rpc(fetcher, "getTransaction", [row.signature, {
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    }]);
    const swap = swapFromTransaction(tx, wallet, options.solUsd);
    if (!swap) continue;
    prints.push({
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
    });
  }
  return prints;
}
