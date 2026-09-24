import { LIVE_MODE, STARTING_CASH, emptyBook, exitPrice, sleeveEquity, snapshot } from "./paper.js";
import { formatCentral } from "./time.js";

function dropLocalBooks() {
  try {
    const gone = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith("paper-copy")) gone.push(key);
    }
    for (const key of gone) localStorage.removeItem(key);
  } catch { /* private mode */ }
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function bookFrom(feed) {
  const book = feed?.book;
  if (book && typeof book.cashUsd === "number" && book.lots && book.seen) return book;
  return emptyBook();
}

function cls(n) { return n >= 0 ? "up" : "down"; }
function shown(n) {
  const rounded = Math.round((Number(n) || 0) * 100) / 100;
  return Math.abs(rounded) < 0.005 ? 0 : rounded;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function priceFmt(value) {
  const n = Number(value);
  if (!(n > 0)) return "—";
  const digits = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: 2 }).format(n);
}

function gauge(usd) {
  const fill = Math.max(0, Math.min(100, (Number(usd) / STARTING_CASH) * 100));
  return `<div class="gauge" style="--fill:${fill.toFixed(1)}" title="Sleeve equity ${esc(money.format(usd))}"><div><strong>${money.format(usd)}</strong><span>Equity</span></div></div>`;
}

function art(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return "";
  return `<img class="art" alt="" src="${esc(url)}" onerror="this.remove()">`;
}

function caButton(mint) {
  if (!mint) return "";
  return `<button type="button" class="ca" data-ca="${esc(mint)}">CA</button>`;
}

function signed(n) {
  const value = shown(n);
  const text = money.format(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return money.format(0);
}

function unrealizedText(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const value = Number(n);
  if (Math.abs(value) < 1e-12) return money.format(0);
  const abs = Math.abs(value);
  const digits = abs >= 0.01 ? 2 : 6;
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(abs);
  return `${value > 0 ? "+" : "-"}${text}`;
}

function liveVsEntry(line, marks) {
  if (line.outcome !== "opened") return null;
  const entry = Number(line.entryUsd);
  const quoted = Number(marks?.[line.mint]);
  if (!(entry > 0) || !(quoted > 0)) return null;
  const mark = exitPrice(quoted, entry);
  if (mark == null) return null;
  const qty = Number(line.qty) > 0 ? Number(line.qty) : Number(line.usd) > 0 ? Number(line.usd) / entry : 0;
  if (!(mark > 0) || !(qty > 0)) return null;
  return (mark - entry) * qty;
}

function historyOutcome(row) {
  if (row.outcome === "closed") return `closed ${money.format(shown(row.realizedUsd))}`;
  return row.outcome || "";
}

function sleeveHistory(book, traderId) {
  const rows = [...(book.history?.[traderId] || [])].reverse();
  const body = rows.length
    ? rows.map((row) => `<tr><td class="when">${esc(formatCentral(row.ts))}</td><td class="${row.side === "sell" ? "down" : "up"}">${esc(row.side)}</td><td>${esc(row.symbol)}</td><td>${money.format(shown(row.usd))}</td><td>${esc(historyOutcome(row))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No sleeve fills yet.</td></tr>`;
  return `<div class="sleeve-history"><table><thead><tr><th>Time</th><th>Side</th><th>Ticker</th><th>USD</th><th>Outcome</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function render(feed, book) {
  const view = snapshot(book, feed.dexMarks || {});
  const traders = feed.traders || [];
  document.querySelector("#source").textContent = feed.source || "No source";
  const banner = document.querySelector("#banner");
  const note = feed.banner || (feed.ok ? "" : (feed.error || "The upstream feed is unavailable."));
  banner.className = note ? "banner" : "";
  banner.textContent = note;
  document.querySelector("#stats").innerHTML = `
    <div class="frame"><span>Cash</span><strong>${money.format(shown(view.cashUsd))}</strong></div>
    <div class="frame"><span>Equity</span><strong>${money.format(shown(view.equityUsd))}</strong></div>
    <div class="frame"><span>Total P&L</span><strong class="${cls(shown(view.pnlUsd))}">${money.format(shown(view.pnlUsd))}</strong></div>
    <div class="frame"><span>Realized</span><strong class="${cls(shown(view.realizedUsd))}">${money.format(shown(view.realizedUsd))}</strong></div>`;
  document.querySelector("#traders").innerHTML = traders.length ? traders.map((trader) => {
    const equity = sleeveEquity(book, trader.id, feed.dexMarks || {});
    return `
    <article class="card frame">
      <div class="card-top">
        <div>
          <div class="label">Rank ${esc(trader.rank)}</div>
          <div class="handle">${art(trader.image)}<span>${esc(trader.name)}</span></div>
          <div class="pnl ${cls(trader.pnlUsd || 0)}">${money.format(trader.pnlUsd || 0)} <span class="label">24h PnL</span></div>
        </div>
        ${gauge(equity)}
      </div>
      <ul class="activity">${(trader.recent || []).map((row) => `<li><span class="${row.side === "sell" ? "down" : "up"}">${esc(row.side)} ${esc(row.symbol)}</span><span>${money.format(row.usd)}</span></li>`).join("")}</ul>
      ${sleeveHistory(book, trader.id)}
    </article>`;
  }).join("") : `<p class="empty">No traders on this board.</p>`;
  const images = feed.tokenImages || {};
  const ledger = [...(book.ledger || [])].reverse();
  document.querySelector("#trades").innerHTML = ledger.length ? `<table><thead><tr><th>Time</th><th>Why</th><th>Token</th><th>Entry</th><th>Exit</th><th>Outcome</th></tr></thead><tbody>
    ${ledger.slice(0, 40).map((line) => {
      const live = liveVsEntry(line, feed.dexMarks || {});
      const outcome = line.outcome === "closed"
        ? `closed ${money.format(shown(line.realizedUsd))}`
        : live == null ? (line.outcome || "") : signed(live);
      const tone = line.outcome === "closed" ? shown(line.realizedUsd) : live == null ? 0 : shown(live);
      return `<tr><td class="when">${esc(formatCentral(line.ts))}</td><td>${esc(line.why)}</td><td><span class="ticker">${art(images[line.mint])}<span>${esc(line.symbol)}</span>${caButton(line.mint)}</span></td><td>${priceFmt(line.entryUsd)}</td><td>${priceFmt(line.exitUsd)}</td><td class="${cls(tone)}">${esc(outcome)}</td></tr>`;
    }).join("")}
  </tbody></table>` : `<p class="empty">No mirrored trades yet.</p>`;
  document.querySelector("#positions").innerHTML = view.positions.length ? `<table><thead><tr><th>Token</th><th>Qty</th><th>Value</th><th>Unrealized</th></tr></thead><tbody>
    ${view.positions.map((row) => `<tr><td><span class="ticker">${art(images[row.mint])}<span>${esc(row.symbol)}</span></span></td><td>${qtyFmt.format(row.qty)}</td><td>${money.format(row.valueUsd)}</td><td class="${row.unrealizedUsd == null ? "" : cls(row.unrealizedUsd)}">${unrealizedText(row.unrealizedUsd)}</td></tr>`).join("")}
  </tbody></table>` : `<p class="empty">No open paper positions.</p>`;
  const worked = (feed.routes || []).filter((route) => route.ok).map((route) => route.url.split("?")[0]);
  document.querySelector("#foot").textContent = worked.length ? `Live routes: ${[...new Set(worked)].join(" · ")}` : "No upstream route succeeded on the last refresh.";
}

function show(feed) {
  dropLocalBooks();
  render(feed, bookFrom(feed));
}

async function refresh(fresh) {
  const response = await fetch(fresh ? "/api/feed?fresh=1" : "/api/feed");
  show(await response.json());
}

function tick() {
  const clock = document.querySelector("#clock");
  if (clock) clock.textContent = formatCentral(new Date());
}

document.querySelector("#trades").addEventListener("click", async (event) => {
  const button = event.target.closest("button.ca");
  if (!button?.dataset.ca) return;
  const address = button.dataset.ca;
  let copied = false;
  try {
    await navigator.clipboard.writeText(address);
    copied = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = address;
    document.body.appendChild(area);
    area.select();
    copied = document.execCommand("copy");
    area.remove();
  }
  if (!copied) return;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "CA"; }, 1200);
});
tick();
setInterval(tick, 1000);

const live = document.querySelector("#live");
if (live) {
  live.textContent = LIVE_MODE === false
    ? "Live off · no orders · sandbox separate from any main wallet"
    : "Live flag refused · no orders";
}

dropLocalBooks();
const embedded = window.__FEED__;
if (embedded && embedded.book) show(embedded);
else refresh(false).catch((error) => show({ ok: false, error: error.message, traders: [], routes: [] }));

document.querySelector("#refresh").addEventListener("click", () => {
  refresh(true).catch((error) => show({ ok: false, error: error.message, traders: [], routes: [] }));
});
setInterval(() => refresh(false).catch(() => {}), 20_000);
