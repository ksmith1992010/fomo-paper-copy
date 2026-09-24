const GECKO_TRENDING = "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h";
const GECKO_TRADES = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DUST_USD = 25;
const POOLS = 4;
const CACHE_MS = 15_000;

let cache = { at: 0, body: null };

async function getJson(url, routes) {
  const route = { method: "GET", url, ok: false, status: 0 };
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "paper-copy-trader" },
    });
    route.status = response.status;
    route.ok = response.ok;
    routes.push(route);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    route.error = error.message || "request failed";
    routes.push(route);
    return null;
  }
}

function poolMint(pool) {
  const id = pool?.relationships?.base_token?.data?.id || "";
  return id.startsWith("solana_") ? id.slice("solana_".length) : "";
}

function short(address) {
  if (!address || address.length < 10) return address || "unknown";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function tradePrice(trade) {
  const kind = trade.kind === "sell" ? "sell" : "buy";
  const raw = kind === "buy" ? trade.price_to_in_usd : trade.price_from_in_usd;
  const price = Number(raw);
  return Number.isFinite(price) ? price : 0;
}

function tradeMint(trade) {
  return trade.kind === "sell" ? trade.from_token_address : trade.to_token_address;
}

export async function loadFeed(options = {}) {
  if (!options.fresh && cache.body && Date.now() - cache.at < CACHE_MS) {
    return cache.body;
  }

  const routes = [];
  const trending = await getJson(GECKO_TRENDING, routes);
  const pools = (trending?.data || [])
    .map((pool) => ({
      address: pool.attributes?.address,
      name: pool.attributes?.name || "",
      mint: poolMint(pool),
      priceUsd: Number(pool.attributes?.base_token_price_usd) || 0,
      volume24hUsd: Number(pool.attributes?.volume_usd?.h24) || 0,
    }))
    .filter((pool) => pool.address && pool.mint)
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, POOLS);

  if (!pools.length) {
    return {
      ok: false,
      source: "GeckoTerminal trending pools",
      error: "FOMO's leaderboard is not public, Solana Tracker requires an API key, and GeckoTerminal returned no Solana pools.",
      routes,
      traders: [],
      marks: {},
      solUsd: null,
    };
  }

  const symbols = new Map();
  const poolPrice = new Map();
  for (const pool of pools) {
    const symbol = pool.name.split("/")[0]?.trim() || short(pool.mint);
    symbols.set(pool.mint, symbol);
    if (pool.priceUsd > 0) poolPrice.set(pool.mint, pool.priceUsd);
  }

  const tapes = await Promise.all(
    pools.map((pool) => getJson(`${GECKO_TRADES}/${pool.address}/trades`, routes)),
  );

  const byWallet = new Map();
  for (const tape of tapes) {
    for (const row of tape?.data || []) {
      const trade = row.attributes || {};
      const wallet = trade.tx_from_address;
      const mint = tradeMint(trade);
      const usd = Number(trade.volume_in_usd);
      const price = tradePrice(trade) || poolPrice.get(mint) || 0;
      if (!wallet || !mint || mint === SOL_MINT || !(usd >= DUST_USD) || !(price > 0)) continue;
      const id = `${trade.tx_hash}:${trade.kind}:${mint}`;
      let bucket = byWallet.get(wallet);
      if (!bucket) {
        bucket = { wallet, volumeUsd: 0, prints: [], seen: new Set() };
        byWallet.set(wallet, bucket);
      }
      if (bucket.seen.has(id)) continue;
      bucket.seen.add(id);
      bucket.volumeUsd += usd;
      bucket.prints.push({
        id,
        ts: trade.block_timestamp,
        side: trade.kind === "sell" ? "sell" : "buy",
        mint,
        symbol: symbols.get(mint) || short(mint),
        usd,
        priceUsd: price,
        tx: trade.tx_hash,
      });
    }
  }

  const ranked = [...byWallet.values()].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, 3);
  const marks = {};
  for (const trader of ranked) {
    for (const print of trader.prints) {
      const prev = marks[print.mint];
      if (!prev || print.ts > (prev.ts || "")) marks[print.mint] = { priceUsd: print.priceUsd, ts: print.ts };
    }
  }

  const mints = Object.keys(marks);
  if (mints.length) {
    const dex = await getJson(`${DEX_TOKENS}/${mints.join(",")}`, routes);
    const best = new Map();
    for (const pair of dex?.pairs || []) {
      if (pair.chainId !== "solana") continue;
      const mint = pair.baseToken?.address;
      const price = Number(pair.priceUsd);
      const liquidity = Number(pair.liquidity?.usd) || 0;
      if (!mint || !(price > 0)) continue;
      const current = best.get(mint);
      if (!current || liquidity > current.liquidity) {
        best.set(mint, { price, liquidity, symbol: pair.baseToken?.symbol });
      }
    }
    for (const [mint, row] of best) {
      marks[mint] = { priceUsd: row.price, ts: marks[mint]?.ts || "" };
      if (row.symbol) symbols.set(mint, row.symbol);
    }
  }

  const quoteUrl =
    `${JUP_QUOTE}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000&slippageBps=50`;
  const quote = await getJson(quoteUrl, routes);
  let solUsd = null;
  if (quote?.inAmount && quote?.outAmount) {
    const sol = Number(quote.inAmount) / 1e9;
    const usdc = Number(quote.outAmount) / 1e6;
    if (sol > 0 && usdc > 0) solUsd = usdc / sol;
  }

  const markPrices = {};
  for (const [mint, row] of Object.entries(marks)) markPrices[mint] = row.priceUsd;

  const traders = ranked.map((trader, index) => {
    const prints = trader.prints
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, 30)
      .map((print) => ({
        ...print,
        symbol: symbols.get(print.mint) || print.symbol,
        priceUsd: markPrices[print.mint] || print.priceUsd,
        traderId: trader.wallet,
        traderNotionalUsd: trader.volumeUsd,
      }));
    return {
      rank: index + 1,
      id: trader.wallet,
      name: short(trader.wallet),
      address: trader.wallet,
      volumeUsd: trader.volumeUsd,
      tradeCount: trader.prints.length,
      recent: prints.slice(0, 6),
      prints,
    };
  });

  const geckoOk = routes.some((route) => route.url.startsWith(GECKO_TRADES) && route.ok);
  const body = {
    ok: geckoOk && traders.length > 0,
    source:
      "GeckoTerminal Solana trending-pool prints, ranked by taped USD volume. FOMO's in-app leaderboard and the Solana Tracker leaderboard both rejected a keyless request.",
    error: traders.length
      ? null
      : "Trending pools loaded, but none of the recent prints named a wallet above the dust cutoff.",
    fetchedAt: new Date().toISOString(),
    solUsd,
    marks: markPrices,
    traders,
    routes: routes.map(({ method, url, ok, status }) => ({ method, url, ok, status })),
  };

  if (body.ok) {
    cache = { at: Date.now(), body };
  }
  return body;
}
