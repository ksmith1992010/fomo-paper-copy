export const BOOK_VERSION = 4;
export const STARTING_CASH = 1_000;
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
export const MIN_BUY_USD = 5;
export const TAKE_PROFIT = 1;
export const RUNNER = 2;
export const STOP_LOSS = 0.15;

export function emptyBook() {
  return {
    bookVersion: BOOK_VERSION,
    cashUsd: STARTING_CASH,
    startingUsd: STARTING_CASH,
    lots: {},
    seen: {},
    trades: [],
    ledger: [],
    history: {},
    sleeveCash: null,
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
  if (reason === "half") return "DexScreener mark is 100% above entry; sold half";
  if (reason === "runner") return "DexScreener mark is 200% above entry";
  if (reason === "stop") return "DexScreener mark is 15% below entry";
  return "Leader sold a coin this sleeve holds";
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
    why: sell ? whyFor(trade.reason || "sell") : "8% of the sleeve still unused",
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
    ensureSleeveCash(book, sleeves);
    const remaining = Math.max(0, Number(book.sleeveCash?.[print.traderId]) || 0);
    const slice = remaining * BUY_FRACTION;
    const cash = Math.max(0, book.cashUsd);
    const buyUsd = Math.min(slice, cash, remaining);
    if (!(buyUsd >= MIN_BUY_USD) || book.cashUsd - buyUsd < -1e-9) {
      book.seen[id] = "small";
      pushLedger(book, {
        id,
        ts: eventStamp(print),
        traderId: print.traderId,
        traderName: print.traderName,
        mint: print.mint,
        symbol: print.symbol,
        side: "buy",
        why: slice < MIN_BUY_USD || remaining < MIN_BUY_USD ? "Sleeve slice is under $5" : "Sleeve is spent or cash is short",
        entryUsd: null,
        exitUsd: null,
        outcome: "skipped",
        realizedUsd: 0,
        usd: 0,
      });
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
      why: "8% of the sleeve still unused",
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
  if (print.closeQty != null && !(Number.isFinite(Number(print.closeQty)) && Number(print.closeQty) > 0)) {
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
  const closed = closeHeld(book, key, price, { ...print, reason: "sell" });
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
  const ordered = [...prints].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const counts = { buy: 0, sell: 0, small: 0, duplicate: 0, flat: 0, skip: 0 };
  for (const print of ordered) {
    const result = applyPrint(book, print, sleeves);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return { book, counts };
}

/** At +100% sell half. The rest closes at +200%, on a leader sell, or on the −15% stop. A quote beyond 100× entry is skipped. */
export function closeOnMarks(book, dexMarks, ts) {
  const closed = [];
  const when = ts || new Date().toISOString();
  for (const [key, lots] of Object.entries({ ...book.lots })) {
    const [traderId, mint] = key.split("|");
    const raw = Number(dexMarks?.[mint]);
    if (!(raw > 0)) continue;
    for (const lot of [...positiveLots(lots)]) {
      if (!(Number(lot.qty) > 1e-10)) continue;
      const entry = Number(lot.entryUsd);
      if (!(entry > 0)) continue;
      const mark = exitPrice(raw, entry);
      if (mark == null) continue;
      let reason = "";
      let closeQty = Number(lot.qty);
      if (mark <= entry * (1 - STOP_LOSS)) reason = "stop";
      else if (mark >= entry * (1 + RUNNER)) reason = "runner";
      else if (!lot.halfSold && mark >= entry * (1 + TAKE_PROFIT)) {
        reason = "half";
        closeQty = Number(lot.qty) / 2;
      }
      if (!reason) continue;
      const before = Number(lot.qty);
      const trade = closeHeld(book, key, mark, {
        id: `exit:${key}:${reason}:${entry}:${before}`,
        ts: when,
        traderId,
        mint,
        symbol: lot.symbol,
        reason,
        closeQty,
      }, [lot]);
      if (reason === "half" && Number(lot.qty) > 1e-10) lot.halfSold = true;
      if (trade) closed.push(trade);
    }
  }
  return closed;
}

function copyBook(book, next) {
  book.bookVersion = next.bookVersion;
  book.cashUsd = next.cashUsd;
  book.startingUsd = next.startingUsd;
  book.lots = next.lots;
  book.seen = next.seen;
  book.trades = next.trades;
  book.ledger = next.ledger;
  book.history = next.history || {};
  book.sleeveCash = next.sleeveCash || null;
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
  if (!saved || bookNeedsReset(saved)) return emptyBook();
  if (!Array.isArray(saved.ledger)) saved.ledger = (saved.trades || []).map(ledgerFromTrade);
  ensureWalletHistory(saved);
  return saved;
}

export function positions(book, marks) {
  const rows = [];
  for (const [key, lots] of Object.entries(book.lots)) {
    const [traderId, mint] = key.split("|");
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const costUsd = lots.reduce((sum, lot) => sum + lot.costUsd, 0);
    if (qty <= 1e-10) continue;
    const entry = costUsd / qty;
    const quoted = Number(marks?.[mint]);
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
