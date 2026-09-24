import { alignUsdPrice, sleevesFor } from "./paper.js";

const FOMO_BOARD = "https://api.fomoapi.io/v2/leaderboard/24h?limit=3";
const FOMO_USERS = "https://api.fomoapi.io/v2/users";
const DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";
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

async function getJson(url, routes, headers = {}) {
  const route = { method: "GET", url, ok: false, status: 0 };
  try {
    const response = await fetch(url, {
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

export async function loadFeed(options = {}) {
  if (!options.fresh && cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;

  const routes = [];
  const key = options.fomoKey || "";
  if (!key) {
    return {
      ok: false,
      source: "FOMO 24h leaderboard",
      error: "FOMO_API_KEY is not set.",
      traders: [],
      marks: {},
      routes,
    };
  }

  const auth = { authorization: `Bearer ${key}` };
  const boardResponse = await fetch(FOMO_BOARD, {
    headers: { accept: "application/json", "user-agent": "paper-copy-trader", ...auth },
  }).catch((error) => ({ ok: false, status: 0, error }));

  const boardStatus = boardResponse.status || 0;
  routes.push({ method: "GET", url: FOMO_BOARD, ok: Boolean(boardResponse.ok), status: boardStatus });
  if (boardStatus === 401 || boardStatus === 402) {
    return {
      ok: false,
      status: boardStatus,
      source: "FOMO 24h leaderboard",
      error: `FOMO leaderboard returned ${boardStatus}.`,
      traders: [],
      marks: {},
      routes,
    };
  }
  const board = boardResponse.ok ? await boardResponse.json() : null;
  const ranked = (board?.traders || []).filter((trader) => trader.userId).slice(0, 3);
  if (!ranked.length) {
    return {
      ok: false,
      status: boardStatus,
      source: "FOMO 24h leaderboard",
      error: boardStatus ? `FOMO leaderboard returned ${boardStatus}.` : "FOMO leaderboard returned no traders.",
      traders: [],
      marks: {},
      routes,
    };
  }

  const tapes = await Promise.all(ranked.map(async (trader) => {
    const url = `${FOMO_USERS}/${encodeURIComponent(trader.userId)}/trades?limit=10`;
    let body = await getJson(url, routes, auth);
    const last = routes[routes.length - 1];
    if (!last?.ok && last?.status === 503) {
      body = await getJson(url, routes, auth);
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
      pnlUsd: num(trader.pnlUsd),
      volumeUsd: num(trader.volumeUsd),
      tradeCount: Number(trader.trades) || prints.length,
      recent: ready.slice(0, 6).map(({ markUsd, ...print }) => print),
      prints: ready.map(({ markUsd, ...print }) => print),
    };
  });

  const mints = [];
  for (const trader of traders) {
    for (const print of trader.prints) {
      if (print.mint && !mints.some((item) => sameMint(item, print.mint))) mints.push(print.mint);
    }
  }
  const dexMarks = {};
  const liquidity = {};
  const dexResults = await Promise.all(mints.map((mint) => getJson(`${DEX_TOKENS}/${encodeURIComponent(mint)}`, routes)));
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
      }
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

  const body = {
    ok: true,
    source: "FOMO 24h leaderboard, ranked by the board. Trades come from each trader's FOMO trades route, keyed by userId.",
    error: null,
    fetchedAt: new Date().toISOString(),
    marks,
    dexMarks,
    traders,
    routes: routes.map(({ method, url, ok, status }) => ({ method, url, ok, status })),
  };
  cache = { at: Date.now(), body };
  return body;
}
