const STORAGE_KEY = "paper-copy-v2";
const STARTING_CASH = 10_000;
const SLICE_USD = STARTING_CASH / 3;
const DUST_USD = 25;
const MIN_PAPER_USD = 1;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function emptyBook() {
  return { cashUsd: STARTING_CASH, startingUsd: STARTING_CASH, lots: {}, seen: {}, trades: [] };
}

function loadBook() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved.cashUsd === "number" && saved.lots && saved.seen) return saved;
  } catch { /* fresh book */ }
  return emptyBook();
}

function saveBook(book) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
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

function applyPrint(book, print) {
  if (!print.id || book.seen[print.id]) return;
  const usd = Number(print.usd);
  const price = Number(print.priceUsd);
  const notional = Number(print.traderNotionalUsd);
  if (!(usd >= DUST_USD) || !(price > 0) || !(notional > 0)) {
    book.seen[print.id] = "dust";
    return;
  }
  let paperUsd = SLICE_USD * Math.min(1, usd / notional);
  const key = `${print.traderId}|${print.mint}`;
  if (print.side !== "sell") {
    paperUsd = Math.min(paperUsd, Math.max(0, SLICE_USD - usedUsd(book, print.traderId)), book.cashUsd);
    if (paperUsd < MIN_PAPER_USD) {
      book.seen[print.id] = "dust";
      return;
    }
    const lots = book.lots[key] || [];
    lots.push({ qty: paperUsd / price, costUsd: paperUsd, symbol: print.symbol });
    book.lots[key] = lots;
    book.cashUsd -= paperUsd;
    book.seen[print.id] = "buy";
    book.trades.push({ ...print, side: "buy", qty: paperUsd / price, usd: paperUsd, realizedUsd: 0 });
    return;
  }
  const held = book.lots[key] || [];
  const heldQty = held.reduce((sum, lot) => sum + lot.qty, 0);
  if (heldQty <= 0) {
    book.seen[print.id] = "flat";
    return;
  }
  let left = Math.min(heldQty, paperUsd / price);
  let cost = 0;
  const next = [];
  for (const lot of held) {
    if (left <= 1e-12) { next.push(lot); continue; }
    const take = Math.min(lot.qty, left);
    const frac = take / lot.qty;
    cost += lot.costUsd * frac;
    left -= take;
    if (lot.qty - take > 1e-10) next.push({ ...lot, qty: lot.qty - take, costUsd: lot.costUsd * (1 - frac) });
  }
  const filled = Math.min(heldQty, paperUsd / price) - left;
  const proceeds = filled * price;
  if (proceeds < MIN_PAPER_USD) {
    book.seen[print.id] = "dust";
    return;
  }
  if (next.length) book.lots[key] = next;
  else delete book.lots[key];
  book.cashUsd += proceeds;
  book.seen[print.id] = "sell";
  book.trades.push({ ...print, side: "sell", qty: filled, usd: proceeds, realizedUsd: proceeds - cost });
}

function snapshot(book, marks) {
  const positions = [];
  for (const [key, lots] of Object.entries(book.lots)) {
    const [traderId, mint] = key.split("|");
    const qty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const costUsd = lots.reduce((sum, lot) => sum + lot.costUsd, 0);
    if (qty <= 1e-10) continue;
    const mark = Number(marks?.[mint]) > 0 ? Number(marks[mint]) : costUsd / qty;
    const valueUsd = qty * mark;
    positions.push({ traderId, mint, symbol: lots[0].symbol || mint.slice(0, 4), qty, costUsd, mark, valueUsd, unrealizedUsd: valueUsd - costUsd });
  }
  const valueUsd = positions.reduce((sum, row) => sum + row.valueUsd, 0);
  const equityUsd = book.cashUsd + valueUsd;
  return {
    cashUsd: book.cashUsd,
    equityUsd,
    pnlUsd: equityUsd - book.startingUsd,
    realizedUsd: book.trades.reduce((sum, trade) => sum + (trade.realizedUsd || 0), 0),
    positions,
    trades: [...book.trades].reverse(),
  };
}

function cls(n) { return n >= 0 ? "up" : "down"; }

function render(feed, book) {
  const view = snapshot(book, feed.marks || {});
  document.querySelector("#source").textContent = feed.source || "No source";
  const banner = document.querySelector("#banner");
  banner.className = feed.ok ? "" : "banner";
  banner.textContent = feed.ok ? "" : (feed.error || "The upstream feed is unavailable.");
  document.querySelector("#stats").innerHTML = `
    <div><span>Cash</span><strong>${money.format(view.cashUsd)}</strong></div>
    <div><span>Equity</span><strong>${money.format(view.equityUsd)}</strong></div>
    <div><span>P&L</span><strong class="${cls(view.pnlUsd)}">${money.format(view.pnlUsd)}</strong></div>
    <div><span>Realized</span><strong class="${cls(view.realizedUsd)}">${money.format(view.realizedUsd)}</strong></div>`;
  const traders = feed.traders || [];
  document.querySelector("#traders").innerHTML = traders.length ? traders.map((trader) => `
    <article class="card">
      <div class="rank">#${trader.rank} ${trader.name}</div>
      <p>${trader.pnlUsd ? money.format(trader.pnlUsd) + " PnL · " : ""}${money.format(trader.volumeUsd)} volume</p>
      <ul class="activity">${(trader.recent || []).map((row) => `<li><span class="${row.side === "sell" ? "down" : "up"}">${row.side} ${row.symbol}</span><span>${money.format(row.usd)}</span></li>`).join("")}</ul>
    </article>`).join("") : `<p class="empty">No traders on this tape.</p>`;
  document.querySelector("#trades").innerHTML = view.trades.length ? `<table><thead><tr><th>Side</th><th>Token</th><th>From</th><th>Paper</th><th>P&L</th></tr></thead><tbody>
    ${view.trades.slice(0, 40).map((trade) => `<tr><td class="${trade.side === "sell" ? "down" : "up"}">${trade.side}</td><td>${trade.symbol}</td><td>${trade.traderName || String(trade.traderId).slice(0, 8)}</td><td>${money.format(trade.usd)}</td><td class="${cls(trade.realizedUsd || 0)}">${trade.side === "sell" ? money.format(trade.realizedUsd || 0) : ""}</td></tr>`).join("")}
  </tbody></table>` : `<p class="empty">No mirrored trades yet.</p>`;
  document.querySelector("#positions").innerHTML = view.positions.length ? `<table><thead><tr><th>Token</th><th>Qty</th><th>Value</th><th>Unrealized</th></tr></thead><tbody>
    ${view.positions.map((row) => `<tr><td>${row.symbol}</td><td>${qtyFmt.format(row.qty)}</td><td>${money.format(row.valueUsd)}</td><td class="${cls(row.unrealizedUsd)}">${money.format(row.unrealizedUsd)}</td></tr>`).join("")}
  </tbody></table>` : `<p class="empty">No open paper positions.</p>`;
  const worked = (feed.routes || []).filter((route) => route.ok).map((route) => route.url.split("?")[0]);
  document.querySelector("#foot").textContent = worked.length ? `Live routes: ${[...new Set(worked)].join(" · ")}` : "No upstream route succeeded on the last refresh.";
}

function absorb(feed, book) {
  const prints = [];
  for (const trader of feed.traders || []) prints.push(...(trader.prints || []));
  prints.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const print of prints) applyPrint(book, print);
  saveBook(book);
  render(feed, book);
}

let book = loadBook();
async function refresh(fresh) {
  const response = await fetch(fresh ? "/api/feed?fresh=1" : "/api/feed");
  const feed = await response.json();
  absorb(feed, book);
}

const embedded = window.__FEED__;
if (embedded && (embedded.traders || embedded.error)) absorb(embedded, book);
else refresh(false).catch((error) => render({ ok: false, error: error.message, traders: [], routes: [] }, book));

document.querySelector("#refresh").addEventListener("click", () => {
  refresh(true).catch((error) => render({ ok: false, error: error.message, traders: [], routes: [] }, book));
});
setInterval(() => refresh(false).catch(() => {}), 20_000);
