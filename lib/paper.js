export const STARTING_CASH = 10_000;
export const TRADER_SLOTS = 3;
export const SLICE_USD = STARTING_CASH / TRADER_SLOTS;
export const DUST_USD = 25;
export const MIN_PAPER_USD = 1;

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

function takeLots(lots, qty) {
  let left = qty;
  let cost = 0;
  const next = [];
  for (const lot of lots) {
    if (left <= 1e-12) {
      next.push(lot);
      continue;
    }
    const take = Math.min(lot.qty, left);
    const frac = lot.qty > 0 ? take / lot.qty : 0;
    cost += lot.costUsd * frac;
    left -= take;
    const remain = lot.qty - take;
    if (remain > 1e-10) {
      next.push({ qty: remain, costUsd: lot.costUsd * (1 - frac) });
    }
  }
  return { lots: next, cost, filled: qty - left };
}

/**
 * Mirror one source print into the shared paper book.
 * Size is that print's share of the trader's taped notional, capped by the
 * trader's remaining 1/3 slice and by cash.
 */
export function applyPrint(book, print) {
  const id = String(print.id || "");
  if (!id || book.seen[id]) return { book, status: "duplicate" };
  const usd = Number(print.usd);
  const price = Number(print.priceUsd);
  const notional = Number(print.traderNotionalUsd);
  if (!(usd >= DUST_USD) || !(price > 0) || !(notional > 0)) {
    book.seen[id] = "dust";
    return { book, status: "dust" };
  }

  const fraction = Math.min(1, usd / notional);
  let paperUsd = SLICE_USD * fraction;
  const side = print.side === "sell" ? "sell" : "buy";
  const key = lotKey(print.traderId, print.mint);

  if (side === "buy") {
    paperUsd = Math.min(paperUsd, Math.max(0, SLICE_USD - usedUsd(book, print.traderId)), book.cashUsd);
    if (paperUsd < MIN_PAPER_USD) {
      book.seen[id] = "dust";
      return { book, status: "dust" };
    }
    const qty = paperUsd / price;
    const lots = book.lots[key] || [];
    lots.push({ qty, costUsd: paperUsd });
    book.lots[key] = lots;
    book.cashUsd -= paperUsd;
    book.seen[id] = "buy";
    book.trades.push({
      id,
      ts: print.ts,
      side: "buy",
      traderId: print.traderId,
      mint: print.mint,
      symbol: print.symbol,
      qty,
      usd: paperUsd,
      priceUsd: price,
      realizedUsd: 0,
    });
    return { book, status: "buy" };
  }

  const held = book.lots[key] || [];
  const heldQty = held.reduce((sum, lot) => sum + lot.qty, 0);
  if (heldQty <= 0) {
    book.seen[id] = "flat";
    return { book, status: "flat" };
  }
  const wantQty = Math.min(heldQty, paperUsd / price);
  const taken = takeLots(held, wantQty);
  const proceeds = taken.filled * price;
  if (proceeds < MIN_PAPER_USD) {
    book.seen[id] = "dust";
    return { book, status: "dust" };
  }
  if (taken.lots.length) book.lots[key] = taken.lots;
  else delete book.lots[key];
  book.cashUsd += proceeds;
  book.seen[id] = "sell";
  book.trades.push({
    id,
    ts: print.ts,
    side: "sell",
    traderId: print.traderId,
    mint: print.mint,
    symbol: print.symbol,
    qty: taken.filled,
    usd: proceeds,
    priceUsd: price,
    realizedUsd: proceeds - taken.cost,
  });
  return { book, status: "sell" };
}

export function applyPrints(book, prints) {
  const ordered = [...prints].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.id).localeCompare(String(b.id)));
  const counts = { buy: 0, sell: 0, dust: 0, duplicate: 0, flat: 0 };
  for (const print of ordered) {
    const result = applyPrint(book, print);
    counts[result.status] = (counts[result.status] || 0) + 1;
  }
  return { book, counts };
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
  const costUsd = open.reduce((sum, row) => sum + row.costUsd, 0);
  const realizedUsd = book.trades.reduce((sum, trade) => sum + (trade.realizedUsd || 0), 0);
  const equityUsd = book.cashUsd + valueUsd;
  return {
    cashUsd: book.cashUsd,
    startingUsd: book.startingUsd,
    equityUsd,
    valueUsd,
    costUsd,
    realizedUsd,
    unrealizedUsd: valueUsd - costUsd,
    pnlUsd: equityUsd - book.startingUsd,
    positions: open,
    trades: [...book.trades].reverse(),
  };
}
