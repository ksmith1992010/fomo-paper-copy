import { STARTING_CASH, applyPrints, bookNeedsReset, closeOnMarks, emptyBook, resetBook, sanitizeBook, sleevesFor, snapshot } from "./paper.js";

const STORAGE_KEY = "paper-copy-v3";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function loadBook() {
  try {
    localStorage.removeItem("paper-copy-v1");
    localStorage.removeItem("paper-copy-v2");
  } catch { /* private mode */ }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && saved.lots && saved.seen) {
      const book = sanitizeBook(saved);
      if (book !== saved) saveBook(book);
      return book;
    }
  } catch { /* fresh book */ }
  return emptyBook();
}

function saveBook(book) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
}

function cls(n) { return n >= 0 ? "up" : "down"; }

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function reasonLabel(reason) {
  if (reason === "target") return "target";
  if (reason === "stop") return "stop";
  if (reason === "sell") return "fomo";
  return "";
}

function gauge(usd) {
  const fill = Math.max(0, Math.min(100, (Number(usd) / STARTING_CASH) * 100));
  return `<div class="gauge" style="--fill:${fill.toFixed(1)}" title="Sleeve ${esc(money.format(usd))}"><div><strong>${money.format(usd)}</strong><span>Sleeve</span></div></div>`;
}

function render(feed, book) {
  const view = snapshot(book, feed.dexMarks || {});
  const traders = feed.traders || [];
  const sleeves = sleevesFor(traders);
  document.querySelector("#source").textContent = feed.source || "No source";
  const banner = document.querySelector("#banner");
  banner.className = feed.ok ? "" : "banner";
  banner.textContent = feed.ok ? "" : (feed.error || "The upstream feed is unavailable.");
  document.querySelector("#stats").innerHTML = `
    <div class="frame"><span>Cash</span><strong>${money.format(view.cashUsd)}</strong></div>
    <div class="frame"><span>Equity</span><strong>${money.format(view.equityUsd)}</strong></div>
    <div class="frame"><span>Total P&L</span><strong class="${cls(view.pnlUsd)}">${money.format(view.pnlUsd)}</strong></div>
    <div class="frame"><span>Realized</span><strong class="${cls(view.realizedUsd)}">${money.format(view.realizedUsd)}</strong></div>`;
  document.querySelector("#traders").innerHTML = traders.length ? traders.map((trader) => {
    const sleeve = Number(trader.sleeveUsd) > 0 ? Number(trader.sleeveUsd) : (sleeves[trader.id] || 0);
    return `
    <article class="card frame">
      <div class="card-top">
        <div>
          <div class="label">Rank ${esc(trader.rank)}</div>
          <div class="handle">${esc(trader.name)}</div>
          <div class="pnl ${cls(trader.pnlUsd || 0)}">${money.format(trader.pnlUsd || 0)} <span class="label">24h PnL</span></div>
        </div>
        ${gauge(sleeve)}
      </div>
      <ul class="activity">${(trader.recent || []).map((row) => `<li><span class="${row.side === "sell" ? "down" : "up"}">${esc(row.side)} ${esc(row.symbol)}</span><span>${money.format(row.usd)}</span></li>`).join("")}</ul>
    </article>`;
  }).join("") : `<p class="empty">No traders on this board.</p>`;
  document.querySelector("#trades").innerHTML = view.trades.length ? `<table><thead><tr><th>Side</th><th>Token</th><th>From</th><th>Paper</th><th>P&L</th></tr></thead><tbody>
    ${view.trades.slice(0, 40).map((trade) => {
      const tag = reasonLabel(trade.reason);
      return `<tr><td class="${trade.side === "sell" ? "down" : "up"}">${esc(trade.side)}${tag ? ` <em>${esc(tag)}</em>` : ""}</td><td>${esc(trade.symbol)}</td><td>${esc(trade.traderName || String(trade.traderId).slice(0, 8))}</td><td>${money.format(trade.usd)}</td><td class="${cls(trade.realizedUsd || 0)}">${trade.side === "sell" ? money.format(trade.realizedUsd || 0) : ""}</td></tr>`;
    }).join("")}
  </tbody></table>` : `<p class="empty">No mirrored trades yet.</p>`;
  document.querySelector("#positions").innerHTML = view.positions.length ? `<table><thead><tr><th>Token</th><th>Qty</th><th>Value</th><th>Unrealized</th></tr></thead><tbody>
    ${view.positions.map((row) => `<tr><td>${esc(row.symbol)}</td><td>${qtyFmt.format(row.qty)}</td><td>${money.format(row.valueUsd)}</td><td class="${cls(row.unrealizedUsd)}">${money.format(row.unrealizedUsd)}</td></tr>`).join("")}
  </tbody></table>` : `<p class="empty">No open paper positions.</p>`;
  const worked = (feed.routes || []).filter((route) => route.ok).map((route) => route.url.split("?")[0]);
  document.querySelector("#foot").textContent = worked.length ? `Live routes: ${[...new Set(worked)].join(" · ")}` : "No upstream route succeeded on the last refresh.";
}

function pricedPrints(feed) {
  const prints = [];
  for (const trader of feed.traders || []) prints.push(...(trader.prints || []));
  return prints.map((print) => {
    const dex = Number(feed.dexMarks?.[print.mint]);
    return dex > 0 ? { ...print, priceUsd: dex } : print;
  });
}

function absorb(feed, book) {
  if (bookNeedsReset(book)) resetBook(book);
  const sleeves = {};
  for (const trader of feed.traders || []) {
    if (Number(trader.sleeveUsd) > 0) sleeves[trader.id] = Number(trader.sleeveUsd);
  }
  if (!Object.keys(sleeves).length) Object.assign(sleeves, sleevesFor(feed.traders || []));
  closeOnMarks(book, feed.dexMarks || {}, feed.fetchedAt);
  applyPrints(book, pricedPrints(feed), sleeves);
  saveBook(book);
  render(feed, book);
}

let book = loadBook();
async function refresh(fresh) {
  const response = await fetch(fresh ? "/api/feed?fresh=1" : "/api/feed");
  const feed = await response.json();
  absorb(feed, book);
}

function tick() {
  const clock = document.querySelector("#clock");
  if (clock) clock.textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
}
tick();
setInterval(tick, 1000);

const embedded = window.__FEED__;
if (embedded && embedded.ok) absorb(embedded, book);
else refresh(false).catch((error) => render({ ok: false, error: error.message, traders: [], routes: [] }, book));

document.querySelector("#refresh").addEventListener("click", () => {
  refresh(true).catch((error) => render({ ok: false, error: error.message, traders: [], routes: [] }, book));
});
setInterval(() => refresh(false).catch(() => {}), 20_000);
