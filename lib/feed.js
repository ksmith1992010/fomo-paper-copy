import { snapshotBanner, snapshotFromBoard, traderImage } from "./board-snapshot.js";
import { readBoardSnapshot, writeBoardSnapshot } from "./board-store.js";
import { alignUsdPrice, liveStatus, sleevesFor } from "./paper.js";
import { recentSwaps } from "./solana-swaps.js";

const FOMO_BOARD = "https://api.fomoapi.io/v2/leaderboard/24h?limit=3";
const FOMO_USERS = "https://api.fomoapi.io/v2/users";
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const CACHE_MS = 15_000;

let cache = { at: 0, body: null };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sameMint(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const left = String(a);
  const right = String(b);
  return left.startsWith("0x") && right.startsWith("0x") && left.toLowerCase() === right.toLowerCase();
}

async function getJson(url, routes, headers = {}, fetcher = globalThis.fetch) {
  const route = { method: "GET", url, ok: false, status: 0 };
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json", "user-agent": "paper-copy-trader", ...headers },
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

function printsFromTrades(userId, payload) {
  const prints = [];
  for (const row of payload?.trades || []) {
    const mint = row?.token?.address;
    const symbol = row?.token?.symbol || (mint ? String(mint).slice(0, 4) : "token");
    const bought = num(row.boughtAmount);
    const entry = num(row.avgEntryPrice);
    const sold = num(row.soldAmount);
    const exit = num(row.avgExitPrice);
    if (mint && bought > 0 && entry > 0) {
      prints.push({
        id: `${row.tradeId}:buy`,
        ts: row.createdAt || "",
        side: "buy",
        mint,
        symbol,
        usd: bought * entry,
        priceUsd: entry,
        traderId: userId,
        markUsd: num(row.priceUsd),
      });
    }
    if (mint && sold > 0 && exit > 0) {
      prints.push({
        id: `${row.tradeId}:sell`,
        ts: row.closedAt || row.createdAt || "",
        side: "sell",
        mint,
        symbol,
        usd: sold * exit,
        priceUsd: exit,
        traderId: userId,
        markUsd: num(row.priceUsd),
      });
    }
  }
  return prints;
}

async function attachMarks(traders, routes, fomoMarks, fetcher) {
  const mints = [];
  for (const trader of traders) {
    for (const print of trader.prints) {
      if (print.mint && !mints.some((item) => sameMint(item, print.mint))) mints.push(print.mint);
    }
  }
  const dexMarks = {};
  const liquidity = {};
  const symbols = {};
  const tokenImages = {};
  const dexResults = await Promise.all(mints.map((mint) => getJson(`${DEX_TOKENS}/${encodeURIComponent(mint)}`, routes, {}, fetcher)));
  for (const dex of dexResults) {
    for (const pair of dex?.pairs || []) {
      const mint = pair.baseToken?.address;
      const price = num(pair.priceUsd);
      const pool = num(pair.liquidity?.usd);
      if (!mint || !(price > 0)) continue;
      const known = mints.find((item) => sameMint(item, mint));
      if (!known) continue;
      if (!(dexMarks[known] > 0) || pool >= (liquidity[known] || 0)) {
        dexMarks[known] = price;
        liquidity[known] = pool;
        if (pair.baseToken?.symbol) symbols[known] = pair.baseToken.symbol;
        if (typeof pair.info?.imageUrl === "string" && /^https:\/\//i.test(pair.info.imageUrl)) {
          tokenImages[known] = pair.info.imageUrl;
        }
      }
    }
  }
  for (const trader of traders) {
    for (const print of [...trader.prints, ...trader.recent]) {
      if (symbols[print.mint]) print.symbol = symbols[print.mint];
    }
  }
  for (const mint of Object.keys(dexMarks)) {
    dexMarks[mint] = alignUsdPrice(dexMarks[mint], fomoMarks[mint]);
  }
  const marks = {};
  for (const mint of new Set([...Object.keys(fomoMarks), ...Object.keys(dexMarks)])) {
    const dex = dexMarks[mint];
    marks[mint] = dex > 0 ? dex : fomoMarks[mint];
  }
  const sleeves = sleevesFor(traders);
  for (const trader of traders) trader.sleeveUsd = sleeves[trader.id] || 0;
  return { marks, dexMarks, tokenImages };
}

async function solPriceUsd(routes, fetcher) {
  const body = await getJson(`${DEX_TOKENS}/${SOL_MINT}`, routes, {}, fetcher);
  let best = 0;
  let pool = 0;
  for (const pair of body?.pairs || []) {
    const price = num(pair.priceUsd);
    const liquidity = num(pair.liquidity?.usd);
    if (price > 0 && liquidity >= pool) {
      best = price;
      pool = liquidity;
    }
  }
  return best;
}

function publish(body) {
  cache = { at: Date.now(), body };
  return body;
}

function within(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

async function followSnapshot(snapshot, routes, fetcher, status) {
  const solUsd = await within(solPriceUsd(routes, fetcher), 2500, 0);
  const printSets = await Promise.all(snapshot.traders.map((saved) => (
    saved.wallet
      ? within(recentSwaps(saved.wallet, { fetchImpl: fetcher, solUsd, limit: 5 }), 6000, [])
      : []
  )));
  const traders = [];
  snapshot.traders.forEach((saved, index) => {
    const ready = (printSets[index] || []).map((print) => ({ ...print, traderId: saved.userId, traderName: saved.handle }));
    traders.push({
      rank: saved.rank,
      id: saved.userId,
      userId: saved.userId,
      handle: saved.handle,
      name: saved.handle,
      wallet: saved.wallet || null,
      image: saved.image || null,
      pnlUsd: num(saved.pnlUsd),
      volumeUsd: 0,
      tradeCount: ready.length,
      recent: ready.slice(0, 6),
      prints: ready,
    });
  });
  const priced = await attachMarks(traders, routes, {}, fetcher);
  return publish({
    ok: true,
    stale: true,
    banner: snapshotBanner(status, snapshot),
    source: "Last saved FOMO top 3. The live leaderboard is down, so these wallets are followed from public Solana transactions.",
    error: null,
    fetchedAt: new Date().toISOString(),
    ...priced,
    traders,
    routes: routes.map(({ method, url, ok, status: routeStatus }) => ({ method, url, ok, status: routeStatus })),
    live: liveStatus(),
  });
}

export async function loadFeed(options = {}) {
  if (!options.fresh && cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;

  const routes = [];
  const fetcher = options.fetchImpl || globalThis.fetch;
  const readSnapshot = options.readSnapshot || readBoardSnapshot;
  const writeSnapshot = options.writeSnapshot || writeBoardSnapshot;
  const key = options.fomoKey || "";
  if (!key) {
    return {
      ok: false,
      source: "FOMO 24h leaderboard",
      error: "FOMO_API_KEY is not set.",
      traders: [],
      marks: {},
      routes,
      live: liveStatus(),
    };
  }

  const auth = { authorization: `Bearer ${key}` };
  const boardResponse = await fetcher(FOMO_BOARD, {
    headers: { accept: "application/json", "user-agent": "paper-copy-trader", ...auth },
  }).catch((error) => ({ ok: false, status: 0, error }));

  const boardStatus = boardResponse.status || 0;
  routes.push({ method: "GET", url: FOMO_BOARD, ok: Boolean(boardResponse.ok), status: boardStatus });
  const boardDown = !boardResponse.ok;
  const board = boardResponse.ok ? await boardResponse.json() : null;
  const ranked = (board?.traders || []).filter((trader) => trader.userId).slice(0, 3);
  if (boardDown || !ranked.length) {
    const snapshot = await readSnapshot();
    if (snapshot?.traders?.length) return followSnapshot(snapshot, routes, fetcher, boardStatus);
    return publish({
      ok: false,
      stale: false,
      status: boardStatus,
      banner: snapshotBanner(boardStatus, null),
      source: "FOMO 24h leaderboard",
      error: snapshotBanner(boardStatus, null),
      traders: [],
      marks: {},
      routes,
      live: liveStatus(),
    });
  }
  const snapshot = snapshotFromBoard(ranked);
  if (snapshot) await writeSnapshot(snapshot);

  const tapes = await Promise.all(ranked.map(async (trader) => {
    const url = `${FOMO_USERS}/${encodeURIComponent(trader.userId)}/trades?limit=10`;
    let body = await getJson(url, routes, auth, fetcher);
    const last = routes[routes.length - 1];
    if (!last?.ok && last?.status === 503) {
      body = await getJson(url, routes, auth, fetcher);
    }
    return body;
  }));

  const fomoMarks = {};
  const traders = ranked.map((trader, index) => {
    const prints = printsFromTrades(trader.userId, tapes[index] || {});
    for (const print of prints) {
      if (print.markUsd > 0) fomoMarks[print.mint] = print.markUsd;
    }
    const handle = trader.handle || trader.displayName || trader.userId;
    const sized = prints
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, 30);
    const notion = sized.reduce((sum, print) => sum + print.usd, 0);
    const ready = sized.map((print) => ({ ...print, traderName: handle, traderNotionalUsd: notion }));
    return {
      rank: trader.rank || index + 1,
      id: trader.userId,
      userId: trader.userId,
      handle,
      name: handle,
      wallet: snapshot?.traders?.find((row) => row.userId === trader.userId)?.wallet || null,
      image: traderImage(trader),
      pnlUsd: num(trader.pnlUsd),
      volumeUsd: num(trader.volumeUsd),
      tradeCount: Number(trader.trades) || prints.length,
      recent: ready.slice(0, 6).map(({ markUsd, ...print }) => print),
      prints: ready.map(({ markUsd, ...print }) => print),
    };
  });

  const priced = await attachMarks(traders, routes, fomoMarks, fetcher);
  return publish({
    ok: true,
    stale: false,
    banner: "",
    source: "FOMO 24h leaderboard, ranked by the board. Trades come from each trader's FOMO trades route, keyed by userId.",
    error: null,
    fetchedAt: new Date().toISOString(),
    ...priced,
    traders,
    routes: routes.map(({ method, url, ok, status }) => ({ method, url, ok, status })),
    live: liveStatus(),
  });
}
