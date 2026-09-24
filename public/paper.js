export const STARTING_CASH = 1_000;
export const SLEEVE_FLOOR = 0.15;
export const SLEEVE_CAP = 0.5;
export const BUY_FRACTION = 0.08;
export const MIN_BUY_USD = 5;
export const TAKE_PROFIT = 0.2;
export const STOP_LOSS = 0.15;

export function emptyBook() {
  return {
    cashUsd: STARTING_CASH,
    startingUsd: STARTING_CASH,
    lots: {},
    seen: {},
    trades: [],
  };
}

function lotKey(traderId, mint) {
  return `${traderId}|${mint}`;
}

function usedUsd(book, traderId) {
  let used = 0;
  const prefix = `${traderId}|`;
  for (const [key, lots] of Object.entries(book.lots)) {
    if (!key.startsWith(prefix)) continue;
    for (const lot of lots) used += lot.costUsd;
  }
  return used;
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
  const requested = Number(print.closeQty);
  const qty = Math.min(heldQty, requested > 0 ? requested : heldQty);
  if (!(qty > 0)) return null;

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
  if (!(filled > 0)) return null;
  const proceeds = filled * Number(price);
  book.cashUsd += proceeds;
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
    priceUsd: Number(price),
    realizedUsd: proceeds - cost,
    reason: print.reason || "sell",
  };
  book.trades.push(trade);
  return trade;
}

export function applyPrint(book, print, sleeves) {
  const id = String(print.id || "");
  if (!id || book.seen[id]) return { book, status: "duplicate" };
  const price = Number(print.priceUsd);
  const key = lotKey(print.traderId, print.mint);
  if (!(price > 0) || !print.mint) {
    book.seen[id] = "skip";
    return { book, status: "skip" };
  }

  if (print.side !== "sell") {
    const remaining = Math.max(0, (Number(sleeves?.[print.traderId]) || 0) - usedUsd(book, print.traderId));
    const slice = remaining * BUY_FRACTION;
    const cash = Math.max(0, book.cashUsd);
    const buyUsd = Math.min(slice, cash, remaining);
    if (!(buyUsd >= MIN_BUY_USD) || book.cashUsd - buyUsd < -1e-9) {
      book.seen[id] = "small";
      return { book, status: "small" };
    }
    const qty = buyUsd / price;
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
    return { book, status: "buy" };
  }

  const closed = closeHeld(book, key, price, { ...print, reason: "sell" });
  book.seen[id] = closed ? "sell" : "flat";
  return { book, status: closed ? "sell" : "flat" };
}

export function applyPrints(book, prints, sleeves) {
  const ordered = [...prints].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const counts = { buy: 0, sell: 0, small: 0, duplicate: 0, flat: 0, skip: 0 };
  for (const print of ordered) {
    const result = applyPrint(book, print, sleeves);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return { book, counts };
}

/** Close a lot when the DexScreener mark is +20% or -15% from its entry. */
export function closeOnMarks(book, dexMarks, ts) {
  const closed = [];
  for (const [key, lots] of Object.entries({ ...book.lots })) {
    const [traderId, mint] = key.split("|");
    const mark = Number(dexMarks?.[mint]);
    const open = positiveLots(lots);
    if (!(mark > 0) || !open.length) continue;
    const hit = open.filter((lot) => mark >= lot.entryUsd * (1 + TAKE_PROFIT) || mark <= lot.entryUsd * (1 - STOP_LOSS));
    if (!hit.length) continue;
    const reason = mark >= hit[0].entryUsd * (1 + TAKE_PROFIT) ? "target" : "stop";
    const trade = closeHeld(book, key, mark, {
      id: `exit:${key}:${reason}:${hit[0].entryUsd}`,
      ts: ts || new Date().toISOString(),
      traderId,
      mint,
      symbol: hit[0].symbol,
      reason,
    }, hit);
    if (trade) closed.push(trade);
  }
  return closed;
}

function copyBook(book, next) {
  book.cashUsd = next.cashUsd;
  book.startingUsd = next.startingUsd;
  book.lots = next.lots;
  book.seen = next.seen;
  book.trades = next.trades;
  return book;
}

/** A phantom sell or a negative balance means the saved book cannot be trusted. */
export function bookNeedsReset(book) {
  if (!book || typeof book.cashUsd !== "number" || book.cashUsd < -1e-6) return true;
  if (book.startingUsd !== STARTING_CASH) return true;
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
  return saved;
}

export function positions(book, marks) {
  const rows = [];
  for (const [key, lots] of Object.entries(book.lots)) {
    const [traderId, mint] = key.split("|");
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const costUsd = lots.reduce((sum, lot) => sum + lot.costUsd, 0);
    if (qty <= 1e-10) continue;
    const mark = Number(marks?.[mint]) > 0 ? Number(marks[mint]) : costUsd / qty;
    const valueUsd = qty * mark;
    rows.push({
      traderId,
      mint,
      symbol: lots[0]?.symbol || mint.slice(0, 4),
      qty,
      costUsd,
      markUsd: mark,
      valueUsd,
      unrealizedUsd: valueUsd - costUsd,
    });
  }
  rows.sort((a, b) => b.valueUsd - a.valueUsd);
  return rows;
}

export function snapshot(book, marks) {
  const open = positions(book, marks);
  const valueUsd = open.reduce((sum, row) => sum + row.valueUsd, 0);
  const realizedUsd = book.trades.reduce((sum, trade) => sum + (trade.realizedUsd || 0), 0);
  const equityUsd = book.cashUsd + valueUsd;
  return {
    cashUsd: book.cashUsd,
    startingUsd: book.startingUsd,
    equityUsd,
    valueUsd,
    realizedUsd,
    unrealizedUsd: valueUsd - open.reduce((sum, row) => sum + row.costUsd, 0),
    pnlUsd: equityUsd - book.startingUsd,
    positions: open,
    trades: [...book.trades].reverse(),
  };
}
