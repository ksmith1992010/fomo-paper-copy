export const BOOK_VERSION = 4;
export const STARTING_CASH = 1_000;
/** Books saved before this id are replaced with a fresh $1,000. A book that already has it is kept. */
export const FRESH_BOOK = "2026-09-27-fresh-1000";
/** Disarmed. There is no setter and no order route. A later arm would be a sandbox account, never a main wallet. */
export const LIVE_MODE = false;

export function liveStatus() {
  return {
    enabled: false,
    armed: false,
    orders: "disabled",
    account: "sandbox",
    separateFromMainWallet: true,
  };
}
export const SLEEVE_FLOOR = 0.15;
export const SLEEVE_CAP = 0.5;
export const BUY_FRACTION = 0.08;
export const MIN_BUY_USD = 1;

export function emptyBook() {
  return {
    bookVersion: BOOK_VERSION,
    freshBook: FRESH_BOOK,
    cashUsd: STARTING_CASH,
    startingUsd: STARTING_CASH,
    lots: {},
    seen: {},
    trades: [],
    ledger: [],
    history: {},
    sleeveCash: null,
    exitCopied: {},
  };
}

const WALLET_HISTORY_CAP = 50;

function historyRow(line) {
  return {
    ts: line.ts || "",
    side: line.side === "sell" ? "sell" : "buy",
    symbol: line.symbol || "",
    usd: Number(line.usd) || 0,
    outcome: line.outcome || "",
    realizedUsd: Number(line.realizedUsd) || 0,
  };
}

function rememberHistory(book, line) {
  const id = String(line?.traderId || "");
  if (!id) return;
  if (!book.history || typeof book.history !== "object" || Array.isArray(book.history)) book.history = {};
  if (!Array.isArray(book.history[id])) book.history[id] = [];
  book.history[id].push(historyRow(line));
  if (book.history[id].length > WALLET_HISTORY_CAP) book.history[id] = book.history[id].slice(-WALLET_HISTORY_CAP);
}

/** Keep the newest 50 buy/sell rows for each sleeve. Does not touch cash or lots. */
export function ensureWalletHistory(book) {
  if (!book.history || typeof book.history !== "object" || Array.isArray(book.history)) {
    book.history = {};
    for (const line of book.ledger || []) rememberHistory(book, line);
  }
  return book.history;
}

/** Dex quote in whole-token dollars. A price off by 10^decimals is scaled back onto the human price. */
export function alignUsdPrice(quote, human) {
  const dex = Number(quote);
  const basis = Number(human);
  if (!(dex > 0)) return basis > 0 ? basis : 0;
  if (!(basis > 0)) return dex;
  const ratio = dex / basis;
  if (!(ratio > 0)) return dex;
  const exp = Math.round(Math.log10(ratio));
  // A 10× or 100× quote is a real mark.
  if (Math.abs(exp) < 3) return dex;
  // A few-thousand-times gap is not a rally and not a stop. Do not rescale it into a fake move.
  if (Math.abs(exp) < 6) return basis;
  const scaled = dex / 10 ** exp;
  const check = scaled / basis;
  if (check >= 0.25 && check <= 4) return scaled;
  return basis;
}

/**
 * Price a close may use. A quote over 100× entry or under 1/100 is ignored
 * unless it is a 10^6-or-more decimal shift, in which case the aligned mark is used.
 */
export function exitPrice(quote, entry) {
  const raw = Number(quote);
  const basis = Number(entry);
  if (!(raw > 0) || !(basis > 0)) return null;
  const ratio = raw / basis;
  if (ratio > 100 || ratio < 0.01) {
    const exp = Math.abs(Math.round(Math.log10(ratio)));
    if (exp < 6) return null;
  }
  const mark = alignUsdPrice(raw, basis);
  if (!(mark > 0)) return null;
  const aligned = mark / basis;
  if (aligned > 100 || aligned < 0.01) return null;
  if ((ratio > 100 || ratio < 0.01) && Math.abs(mark - raw) <= Math.abs(raw) * 1e-9) return null;
  return mark;
}

function lotEntry(lot) {
  const entry = Number(lot?.entryUsd);
  if (entry > 0) return entry;
  const qty = Number(lot?.qty);
  const cost = Number(lot?.costUsd);
  if (qty > 0 && cost > 0) return cost / qty;
  return 0;
}

function lotKey(traderId, mint) {
  return `${traderId}|${mint}`;
}

/** Weight by positive 24h PnL, then keep each sleeve inside 15–50% of the book. */
export function sleeveSizes(pnls) {
  const n = pnls.length;
  if (!n) return [];
  const positive = pnls.map((pnl) => Math.max(0, Number(pnl) || 0));
  const sum = positive.reduce((total, pnl) => total + pnl, 0);
  let weights = sum > 0 ? positive.map((pnl) => pnl / sum) : pnls.map(() => 1 / n);

  for (let pass = 0; pass < 12; pass += 1) {
    const clamped = weights.map((weight) => Math.min(SLEEVE_CAP, Math.max(SLEEVE_FLOOR, weight)));
    const total = clamped.reduce((acc, weight) => acc + weight, 0);
    const gap = 1 - total;
    if (Math.abs(gap) < 1e-9) {
      weights = clamped;
      break;
    }
    const adjustable = [];
    for (let i = 0; i < n; i += 1) {
      const room = gap > 0 ? SLEEVE_CAP - clamped[i] : clamped[i] - SLEEVE_FLOOR;
      if (room > 1e-9) adjustable.push({ i, room });
    }
    if (!adjustable.length) {
      weights = clamped;
      break;
    }
    const room = adjustable.reduce((acc, item) => acc + item.room, 0);
    const share = Math.min(1, Math.abs(gap) / room);
    weights = clamped.slice();
    for (const item of adjustable) {
      weights[item.i] += (gap > 0 ? item.room : -item.room) * share;
    }
  }

  return weights.map((weight) => weight * STARTING_CASH);
}

export function sleevesFor(traders) {
  const sizes = sleeveSizes((traders || []).map((trader) => trader.pnlUsd));
  const sleeves = {};
  (traders || []).forEach((trader, index) => {
    sleeves[trader.id] = sizes[index];
  });
  return sleeves;
}

function positiveLots(lots) {
  return (lots || []).filter((lot) => Number(lot.qty) > 0 && Number(lot.costUsd) >= 0);
}

/** Close at most the open quantity on this trader's mint. No lot means no sell. */
function closeHeld(book, key, price, print, onlyLots) {
  const all = book.lots[key] || [];
  const heldLots = positiveLots(onlyLots || all).filter((lot) => all.includes(lot));
  const heldQty = heldLots.reduce((sum, lot) => sum + Number(lot.qty), 0);
  if (!(heldQty > 0) || !(Number(price) > 0)) return null;
  let qty = heldQty;
  if (print.closeQty != null) {
    const requested = Number(print.closeQty);
    if (!Number.isFinite(requested) || !(requested > 0)) return null;
    qty = Math.min(heldQty, requested);
  }
  if (!(qty > 0) || qty > heldQty + 1e-9) return null;

  let fillPrice = null;
  for (const lot of heldLots) {
    const mark = exitPrice(price, lotEntry(lot));
    if (mark == null) return null;
    if (fillPrice == null) fillPrice = mark;
    else if (Math.abs(fillPrice - mark) / mark > 1e-4) return null;
  }
  if (!(fillPrice > 0)) return null;

  let left = qty;
  let cost = 0;
  const used = [];
  for (const lot of heldLots) {
    if (left <= 1e-12) break;
    const take = Math.min(Number(lot.qty), left);
    const frac = take / Number(lot.qty);
    cost += Number(lot.costUsd) * frac;
    left -= take;
    used.push(lot);
    const remainQty = Number(lot.qty) - take;
    if (remainQty > 1e-10) {
      lot.qty = remainQty;
      lot.costUsd = Number(lot.costUsd) * (1 - frac);
    } else {
      lot.qty = 0;
    }
  }
  const keep = all.filter((lot) => Number(lot.qty) > 1e-10);
  if (keep.length) book.lots[key] = keep;
  else delete book.lots[key];

  const filled = qty - Math.max(0, left);
  const proceeds = filled * fillPrice;
  const realizedUsd = proceeds - cost;
  if (!(filled > 0) || filled > heldQty + 1e-8 || !Number.isFinite(realizedUsd)) return null;
  book.cashUsd += proceeds;
  creditSleeve(book, print.traderId, proceeds);
  const trade = {
    id: print.id,
    ts: print.ts,
    side: "sell",
    traderId: print.traderId,
    traderName: print.traderName,
    mint: print.mint,
    symbol: print.symbol || used[0]?.symbol,
    qty: filled,
    usd: proceeds,
    priceUsd: fillPrice,
    entryUsd: filled > 0 ? cost / filled : null,
    realizedUsd,
    reason: print.reason || "sell",
  };
  book.trades.push(trade);
  pushLedger(book, {
    id: trade.id,
    ts: eventStamp(print),
    traderId: trade.traderId,
    traderName: trade.traderName,
    mint: trade.mint,
    symbol: trade.symbol,
    side: "sell",
    why: whyFor(print.reason || "sell"),
    entryUsd: filled > 0 ? cost / filled : null,
    exitUsd: fillPrice,
    outcome: "closed",
    realizedUsd: trade.realizedUsd,
    usd: proceeds,
  });
  return trade;
}

function whyFor(reason) {
  if (reason === "target") return "DexScreener mark is 20% above entry";
  if (reason === "stop") return "DexScreener mark is 15% below entry";
  if (reason === "partial") return "Leader sold part of a coin this sleeve holds";
  return "Leader sold a coin this sleeve holds";
}

/** Cumulative fraction of the leader position this print says is sold. A bare sell is a full exit. */
function leaderCumulative(print) {
  const explicit = Number(print?.exitFraction);
  if (explicit > 0) return Math.min(1, explicit);
  const sold = Number(print?.soldQty);
  const held = Number(print?.heldQty);
  if (sold > 0 && held > 0) return Math.min(1, sold / held);
  return 1;
}

function exitCopyKey(print) {
  const id = String(print?.positionId || "");
  if (!id || !print?.traderId) return "";
  return `${print.traderId}|${id}`;
}

/** Fraction of our remaining quantity that matches the new part of their exit. */
function sliceOfRemaining(book, print) {
  const cumulative = leaderCumulative(print);
  const key = exitCopyKey(print);
  const prior = key && book.exitCopied ? Number(book.exitCopied[key]) || 0 : 0;
  if (cumulative <= prior + 1e-9) return { slice: 0, cumulative };
  const open = 1 - Math.min(1, prior);
  if (!(open > 1e-9)) return { slice: 0, cumulative };
  return { slice: Math.min(1, (cumulative - prior) / open), cumulative };
}

function rememberExit(book, print, cumulative) {
  const key = exitCopyKey(print);
  if (!key) return;
  if (!book.exitCopied || typeof book.exitCopied !== "object" || Array.isArray(book.exitCopied)) book.exitCopied = {};
  book.exitCopied[key] = Math.min(1, cumulative);
}

function eventStamp(print) {
  const ts = print?.ts;
  if (ts && !Number.isNaN(new Date(ts).getTime())) return ts;
  return new Date().toISOString();
}

function creditSleeve(book, traderId, proceeds) {
  if (!book.sleeveCash) book.sleeveCash = {};
  const next = Math.max(0, (Number(book.sleeveCash[traderId]) || 0) + (Number(proceeds) || 0));
  book.sleeveCash[traderId] = next;
}

/** Seed sleeve cash once from the opening allocation. Later gains and losses stay on that sleeve. */
export function ensureSleeveCash(book, sleeves) {
  if (book.sleeveCash) return book.sleeveCash;
  const hasHistory = (book.trades || []).length > 0 || Object.keys(book.lots || {}).length > 0;
  if (!Object.keys(sleeves || {}).length && !hasHistory) return null;
  const openCost = {};
  for (const [key, lots] of Object.entries(book.lots || {})) {
    const traderId = key.split("|")[0];
    openCost[traderId] = (openCost[traderId] || 0) + (lots || []).reduce((sum, lot) => sum + (Number(lot.costUsd) || 0), 0);
  }
  const realized = {};
  for (const trade of book.trades || []) {
    if (trade.side !== "sell") continue;
    realized[trade.traderId] = (realized[trade.traderId] || 0) + (Number(trade.realizedUsd) || 0);
  }
  const ids = new Set([...Object.keys(sleeves || {}), ...Object.keys(openCost), ...Object.keys(realized)]);
  const cash = {};
  for (const id of ids) {
    cash[id] = Math.max(0, (Number(sleeves?.[id]) || 0) - (openCost[id] || 0) + (realized[id] || 0));
  }
  book.sleeveCash = cash;
  return cash;
}

/** Move sleeve cash that belongs to wallets no longer on the board. Open-lot cost stays on the lot. */
export function parkIdleSleeves(book, sleeves) {
  ensureSleeveCash(book, sleeves);
  if (!book.sleeveCash) return null;
  const active = Object.entries(sleeves || {}).filter(([, size]) => Number(size) > 0);
  if (!active.length) return book.sleeveCash;
  let idle = 0;
  for (const id of Object.keys(book.sleeveCash)) {
    if (active.some(([traderId]) => traderId === id)) continue;
    idle += Math.max(0, Number(book.sleeveCash[id]) || 0);
    delete book.sleeveCash[id];
  }
  if (!(idle > 0)) return book.sleeveCash;
  const weight = active.reduce((sum, [, size]) => sum + Number(size), 0);
  let left = idle;
  active.forEach(([id, size], index) => {
    const share = index === active.length - 1 ? left : idle * (Number(size) / weight);
    left -= share;
    book.sleeveCash[id] = Math.max(0, (Number(book.sleeveCash[id]) || 0) + share);
  });
  return book.sleeveCash;
}

function sameSliceCost(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!(left > 0) || !(right > 0)) return false;
  return Math.abs(left - right) <= Math.max(0.01, left * 0.001);
}

function ledgerHas(book, id) {
  return (book.ledger || []).some((line) => line?.id === id);
}

/** Drop repeated skip lines for the same print. Opens and closes stay, including the stop era. */
function compactSkippedLedger(book) {
  if (!Array.isArray(book.ledger) || book.ledger.length < 2) return;
  const seen = new Set();
  const next = [];
  for (const line of book.ledger) {
    if (line?.outcome === "skipped" && line.id) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
    }
    next.push(line);
  }
  if (next.length === book.ledger.length) return;
  book.ledger = next;
  book.history = {};
  for (const line of book.ledger) rememberHistory(book, line);
}

/**
 * A catch-up that buys the same mint several times at a full sleeve slice is one copy.
 * Keep the first slice, return the extra cost to that sleeve, and leave the old ledger in place.
 */
export function collapseStackedCopies(book) {
  if (!book.sleeveCash) book.sleeveCash = {};
  for (const [key, raw] of Object.entries(book.lots || {})) {
    const lots = positiveLots(raw);
    if (lots.length < 2) continue;
    let slice = 0;
    let repeats = 0;
    for (const lot of lots) {
      const cost = Number(lot.costUsd);
      if (!(cost >= 10)) continue;
      const count = lots.filter((item) => sameSliceCost(item.costUsd, cost)).length;
      if (count > repeats) {
        repeats = count;
        slice = cost;
      }
    }
    if (repeats < 2) continue;
    const first = lots.findIndex((lot) => sameSliceCost(lot.costUsd, slice));
    if (first < 0) continue;
    const extra = [];
    for (let i = first + 1; i < lots.length; i += 1) {
      const cost = Number(lots[i].costUsd);
      if (sameSliceCost(cost, slice) || cost < slice) extra.push(lots[i]);
    }
    if (!extra.length) continue;
    const refund = extra.reduce((sum, lot) => sum + Number(lot.costUsd), 0);
    if (!(refund > 0)) continue;
    const [traderId, mint] = key.split("|");
    const kept = lots[first];
    book.lots[key] = lots.filter((lot) => !extra.includes(lot));
    book.cashUsd += refund;
    book.sleeveCash[traderId] = Math.max(0, (Number(book.sleeveCash[traderId]) || 0) + refund);
    const id = `collapse:${key}`;
    if (ledgerHas(book, id)) continue;
    pushLedger(book, {
      id,
      ts: new Date().toISOString(),
      traderId,
      traderName: "",
      mint,
      symbol: kept.symbol || mint.slice(0, 4),
      side: "buy",
      why: "Collapsed extra catch-up buys of this mint to one slice",
      entryUsd: Number(kept.entryUsd) || null,
      exitUsd: null,
      outcome: "collapsed",
      realizedUsd: 0,
      usd: refund,
    });
  }
  return book;
}

export function sleeveEquity(book, traderId, marks) {
  const cash = Math.max(0, Number(book.sleeveCash?.[traderId]) || 0);
  const marked = positions(book, marks)
    .filter((row) => row.traderId === traderId)
    .reduce((sum, row) => sum + Number(row.valueUsd) || 0, 0);
  return Math.max(0, cash + marked);
}

function pushLedger(book, line) {
  if (!Array.isArray(book.ledger)) book.ledger = [];
  book.ledger.push(line);
  rememberHistory(book, line);
}

function ledgerFromTrade(trade) {
  const sell = trade.side === "sell";
  return {
    id: trade.id,
    ts: trade.ts,
    traderId: trade.traderId,
    traderName: trade.traderName,
    mint: trade.mint,
    symbol: trade.symbol,
    side: trade.side,
    why: sell ? whyFor(trade.reason || "sell") : "8% of the sleeve allocation",
    entryUsd: sell ? (Number(trade.entryUsd) > 0 ? Number(trade.entryUsd) : null) : Number(trade.priceUsd) || null,
    exitUsd: sell ? Number(trade.priceUsd) || null : null,
    outcome: sell ? "closed" : "opened",
    realizedUsd: Number(trade.realizedUsd) || 0,
    usd: Number(trade.usd) || 0,
  };
}

export function applyPrint(book, print, sleeves) {
  const id = String(print.id || "");
  if (!id || book.seen[id]) return { book, status: "duplicate" };
  const price = Number(print.priceUsd);
  const key = lotKey(print.traderId, print.mint);
  if (!(price > 0) || !print.mint) {
    book.seen[id] = "skip";
    pushLedger(book, {
      id,
      ts: eventStamp(print),
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      side: print.side === "sell" ? "sell" : "buy",
      why: "Print has no token price",
      entryUsd: null,
      exitUsd: null,
      outcome: "skipped",
      realizedUsd: 0,
      usd: 0,
    });
    return { book, status: "skip" };
  }

  if (print.side !== "sell") {
    const held = positiveLots(book.lots[key]);
    if (held.length) {
      book.seen[id] = "held";
      if (!ledgerHas(book, id)) {
        pushLedger(book, {
          id,
          ts: eventStamp(print),
          traderId: print.traderId,
          traderName: print.traderName,
          mint: print.mint,
          symbol: print.symbol,
          side: "buy",
          why: "Already holding this mint",
          entryUsd: null,
          exitUsd: null,
          outcome: "skipped",
          realizedUsd: 0,
          usd: 0,
        });
      }
      return { book, status: "held" };
    }
    ensureSleeveCash(book, sleeves);
    const allocation = Math.max(0, Number(sleeves?.[print.traderId]) || 0);
    const remaining = Math.max(0, Number(book.sleeveCash?.[print.traderId]) || 0);
    const slice = allocation * BUY_FRACTION;
    const cash = Math.max(0, book.cashUsd);
    const buyUsd = Math.min(slice, cash, remaining);
    if (!(buyUsd >= MIN_BUY_USD) || book.cashUsd - buyUsd < -1e-9) {
      book.seen[id] = "small";
      if (!ledgerHas(book, id)) {
        pushLedger(book, {
          id,
          ts: eventStamp(print),
          traderId: print.traderId,
          traderName: print.traderName,
          mint: print.mint,
          symbol: print.symbol,
          side: "buy",
          why: slice < MIN_BUY_USD || remaining < MIN_BUY_USD ? `Sleeve slice is under $${MIN_BUY_USD}` : "Sleeve is spent or cash is short",
          entryUsd: null,
          exitUsd: null,
          outcome: "skipped",
          realizedUsd: 0,
          usd: 0,
        });
      }
      return { book, status: "small" };
    }
    const qty = buyUsd / price;
    book.sleeveCash[print.traderId] = Math.max(0, remaining - buyUsd);
    const lots = positiveLots(book.lots[key]);
    lots.push({ qty, costUsd: buyUsd, entryUsd: price, symbol: print.symbol });
    book.lots[key] = lots;
    book.cashUsd -= buyUsd;
    book.seen[id] = "buy";
    book.trades.push({
      id,
      ts: print.ts,
      side: "buy",
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      qty,
      usd: buyUsd,
      priceUsd: price,
      realizedUsd: 0,
    });
    pushLedger(book, {
      id,
      ts: eventStamp(print),
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      side: "buy",
      why: "8% of the sleeve allocation",
      entryUsd: price,
      exitUsd: null,
      outcome: "opened",
      realizedUsd: 0,
      usd: buyUsd,
      qty,
    });
    return { book, status: "buy" };
  }

  const lots = positiveLots(book.lots[key] || []);
  if (!lots.length) {
    book.seen[id] = "flat";
    pushLedger(book, {
      id,
      ts: eventStamp(print),
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      side: "sell",
      why: "No open lot for this trader",
      entryUsd: null,
      exitUsd: null,
      outcome: "skipped",
      realizedUsd: 0,
      usd: 0,
    });
    return { book, status: "flat" };
  }
  if (print.closeQty != null && !(Number.isFinite(Number(print.closeQty)) && Number(print.closeQty) > 0) && !(Number(print.exitFraction) > 0) && !(Number(print.soldQty) > 0 && Number(print.heldQty) > 0)) {
    book.seen[id] = "skip";
    pushLedger(book, {
      id,
      ts: eventStamp(print),
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      side: "sell",
      why: "Sell quantity is missing",
      entryUsd: null,
      exitUsd: null,
      outcome: "skipped",
      realizedUsd: 0,
      usd: 0,
    });
    return { book, status: "skip" };
  }
  const heldQty = lots.reduce((sum, lot) => sum + Number(lot.qty), 0);
  const { slice, cumulative } = sliceOfRemaining(book, print);
  if (!(slice > 1e-8)) {
    book.seen[id] = "duplicate";
    return { book, status: "duplicate" };
  }
  const closeQty = slice >= 1 - 1e-9 ? heldQty : heldQty * slice;
  const closed = closeHeld(book, key, price, {
    ...print,
    reason: slice >= 1 - 1e-9 ? "sell" : "partial",
    closeQty,
  });
  if (closed) rememberExit(book, print, cumulative);
  book.seen[id] = closed ? "sell" : "skip";
  if (!closed) {
    pushLedger(book, {
      id,
      ts: eventStamp(print),
      traderId: print.traderId,
      traderName: print.traderName,
      mint: print.mint,
      symbol: print.symbol,
      side: "sell",
      why: "Exit price is off the entry scale",
      entryUsd: null,
      exitUsd: null,
      outcome: "skipped",
      realizedUsd: 0,
      usd: 0,
    });
  }
  return { book, status: closed ? "sell" : "skip" };
}

export function applyPrints(book, prints, sleeves) {
  ensureSleeveCash(book, sleeves);
  compactSkippedLedger(book);
  parkIdleSleeves(book, sleeves);
  collapseStackedCopies(book);
  const ordered = [...prints].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const counts = { buy: 0, sell: 0, small: 0, duplicate: 0, flat: 0, skip: 0 };
  for (const print of ordered) {
    const result = applyPrint(book, print, sleeves);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  parkIdleSleeves(book, sleeves);
  return { book, counts };
}

/** Marks do not close lots. A sell happens only when the copied wallet sells. */
export function closeOnMarks() {
  return [];
}

function copyBook(book, next) {
  book.bookVersion = next.bookVersion;
  book.freshBook = next.freshBook || FRESH_BOOK;
  book.cashUsd = next.cashUsd;
  book.startingUsd = next.startingUsd;
  book.lots = next.lots;
  book.seen = next.seen;
  book.trades = next.trades;
  book.ledger = next.ledger;
  book.history = next.history || {};
  book.sleeveCash = next.sleeveCash || null;
  book.exitCopied = next.exitCopied || {};
  return book;
}

/** A phantom sell or a negative balance means the saved book cannot be trusted. */
export function bookNeedsReset(book) {
  if (!book || typeof book.cashUsd !== "number" || book.cashUsd < -1e-6) return true;
  if (book.bookVersion !== BOOK_VERSION || book.startingUsd !== STARTING_CASH) return true;
  for (const lots of Object.values(book.lots || {})) {
    for (const lot of lots || []) {
      if (!(Number(lot.qty) > 0) || Number(lot.costUsd) < 0) return true;
    }
  }
  const open = {};
  let cash = STARTING_CASH;
  const trades = [...(book.trades || [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  for (const trade of trades) {
    const key = lotKey(trade.traderId, trade.mint);
    const qty = Number(trade.qty);
    if (!(qty > 0)) return true;
    if (trade.side === "sell") {
      const held = open[key] || 0;
      if (!(held > 1e-8) || qty > held + 1e-6) return true;
      open[key] = held - qty;
      if (open[key] <= 1e-8) delete open[key];
      cash += Number(trade.usd) || 0;
    } else {
      open[key] = (open[key] || 0) + qty;
      cash -= Number(trade.usd) || 0;
    }
    if (cash < -1e-4) return true;
  }
  return false;
}

export function resetBook(book) {
  return copyBook(book, emptyBook());
}

export function sanitizeBook(saved) {
  if (saved && saved.freshBook !== FRESH_BOOK) return emptyBook();
  if (!saved || bookNeedsReset(saved)) {
    if (saved && Array.isArray(saved.trades) && saved.trades.length >= 100) return saved;
    return emptyBook();
  }
  if (!Array.isArray(saved.ledger)) saved.ledger = (saved.trades || []).map(ledgerFromTrade);
  ensureWalletHistory(saved);
  return saved;
}

/**
 * Quotes that may mark an open lot. The same band as a close: over 100× entry
 * or under 1/100 is dropped. Nothing is written in its place.
 */
export function guardedMarks(book, marks) {
  const next = { ...(marks || {}) };
  const entries = {};
  for (const [key, lots] of Object.entries(book?.lots || {})) {
    const mint = key.split("|")[1];
    const held = positiveLots(lots);
    const qty = held.reduce((sum, lot) => sum + Number(lot.qty), 0);
    const cost = held.reduce((sum, lot) => sum + Number(lot.costUsd), 0);
    if (!mint || !(qty > 0) || !(cost > 0)) continue;
    if (!entries[mint]) entries[mint] = [];
    entries[mint].push(cost / qty);
  }
  for (const [mint, bases] of Object.entries(entries)) {
    const quoted = Number(next[mint]);
    if (!(quoted > 0)) continue;
    if (!bases.some((entry) => exitPrice(quoted, entry) != null)) delete next[mint];
  }
  return next;
}

export function positions(book, marks) {
  const usable = guardedMarks(book, marks);
  const rows = [];
  for (const [key, lots] of Object.entries(book.lots)) {
    const [traderId, mint] = key.split("|");
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const costUsd = lots.reduce((sum, lot) => sum + lot.costUsd, 0);
    if (qty <= 1e-10) continue;
    const entry = costUsd / qty;
    const quoted = Number(usable?.[mint]);
    const mark = quoted > 0 ? exitPrice(quoted, entry) : null;
    const unrealizedUsd = mark == null ? null : lots.reduce((sum, lot) => {
      const lotEntry = Number(lot.entryUsd) > 0 ? Number(lot.entryUsd) : entry;
      return sum + (mark - lotEntry) * Number(lot.qty);
    }, 0);
    const valueUsd = unrealizedUsd == null ? costUsd : costUsd + unrealizedUsd;
    rows.push({
      traderId,
      mint,
      symbol: lots[0]?.symbol || mint.slice(0, 4),
      qty,
      costUsd,
      markUsd: mark,
      valueUsd,
      unrealizedUsd,
    });
  }
  rows.sort((a, b) => b.valueUsd - a.valueUsd);
  return rows;
}

export function snapshot(book, marks) {
  const open = positions(book, marks);
  const valueUsd = open.reduce((sum, row) => sum + row.valueUsd, 0);
  const realizedUsd = book.trades.reduce((sum, trade) => sum + (trade.realizedUsd || 0), 0);
  const equityUsd = Math.max(0, book.cashUsd) + valueUsd;
  const pnlUsd = equityUsd - book.startingUsd;
  return {
    cashUsd: Math.max(0, book.cashUsd),
    startingUsd: book.startingUsd,
    equityUsd,
    valueUsd,
    realizedUsd,
    unrealizedUsd: open.reduce((sum, row) => sum + (row.unrealizedUsd == null ? 0 : row.unrealizedUsd), 0),
    pnlUsd: Math.abs(pnlUsd) < 1e-9 ? 0 : pnlUsd,
    positions: open,
    trades: [...book.trades].reverse(),
  };
}
