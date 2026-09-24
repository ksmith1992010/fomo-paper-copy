import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_MODE,
  STARTING_CASH,
  alignUsdPrice,
  applyPrint,
  applyPrints,
  bookNeedsReset,
  closeOnMarks,
  emptyBook,
  liveStatus,
  sanitizeBook,
  sleeveSizes,
  snapshot,
  ensureSleeveCash,
  sleeveEquity,
  positions,
  ensureWalletHistory,
} from "../lib/paper.js";

test("sleeves stay inside 15–50% and sum to the book", () => {
  const sizes = sleeveSizes([1_218_247, 686_364, 576_811]);
  const sum = sizes.reduce((total, size) => total + size, 0);
  assert.ok(Math.abs(sum - STARTING_CASH) < 1e-6);
  assert.equal(STARTING_CASH, 1_000);
  for (const size of sizes) {
    assert.ok(size >= 150 - 1e-6);
    assert.ok(size <= 500 + 1e-6);
  }
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2]);
});

test("a lopsided board still respects the floor and the cap", () => {
  const sizes = sleeveSizes([100, 1, 1]);
  assert.ok(Math.abs(sizes[0] - 500) < 1e-6);
  assert.ok(Math.abs(sizes[1] - 250) < 1e-6);
  assert.ok(Math.abs(sizes[2] - 250) < 1e-6);
  assert.ok(Math.abs(sizes.reduce((total, size) => total + size, 0) - 1_000) < 1e-6);
});

test("a buy is 8% of the remaining sleeve and skips under $5", () => {
  const book = emptyBook();
  const sleeves = { wallet: 250 };
  const first = applyPrint(book, {
    id: "buy-1",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 50_000,
    priceUsd: 2,
  }, sleeves);
  assert.equal(first.status, "buy");
  assert.ok(Math.abs(book.trades[0].usd - 20) < 1e-9);

  const second = applyPrint(book, {
    id: "buy-2",
    ts: "2026-09-24T00:01:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 80_000,
    priceUsd: 2,
  }, sleeves);
  assert.equal(second.status, "buy");
  assert.ok(Math.abs(book.trades[1].usd - 18.4) < 1e-9);

  const tiny = emptyBook();
  const skipped = applyPrint(tiny, {
    id: "dust",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 9_000,
    priceUsd: 1,
  }, { wallet: 60 });
  assert.equal(skipped.status, "small");
  assert.equal(tiny.cashUsd, 1_000);
  assert.equal(tiny.trades.length, 0);
});

test("DexScreener +100% and -15% close the lot and realize P&L", () => {
  const book = emptyBook();
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  }, { wallet: 250 });
  assert.equal(closeOnMarks(book, { Mint111: 19.9 }, "2026-09-24T00:02:00Z").length, 0);

  const opened = book.lots["wallet|Mint111"][0].qty;
  const target = closeOnMarks(book, { Mint111: 20 }, "2026-09-24T00:03:00Z");
  assert.equal(target.length, 1);
  assert.equal(target[0].reason, "half");
  assert.ok(Math.abs(target[0].qty - opened / 2) < 1e-9);
  assert.ok(target[0].realizedUsd > 0);
  assert.ok(Math.abs(book.lots["wallet|Mint111"][0].qty - opened / 2) < 1e-9);
  assert.equal(book.lots["wallet|Mint111"][0].halfSold, true);
  assert.equal(closeOnMarks(book, { Mint111: 20 }, "2026-09-24T00:04:00Z").length, 0);

  const runner = closeOnMarks(book, { Mint111: 30 }, "2026-09-24T00:05:00Z");
  assert.equal(runner.length, 1);
  assert.equal(runner[0].reason, "runner");
  assert.equal(book.lots["wallet|Mint111"], undefined);

  const stopped = emptyBook();
  applyPrint(stopped, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  }, { wallet: 250 });
  const stop = closeOnMarks(stopped, { Mint111: 8.5 }, "2026-09-24T00:03:00Z");
  assert.equal(stop[0].reason, "stop");
  assert.ok(stop[0].realizedUsd < 0);
  assert.equal(closeOnMarks(stopped, {}, "2026-09-24T00:04:00Z").length, 0);
});

test("the half that remains closes on a leader sell, at +200%, or on the stop", () => {
  const sleeves = { wallet: 250 };
  const buy = {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  };
  const book = emptyBook();
  applyPrint(book, buy, sleeves);
  const qty = book.lots["wallet|Mint111"][0].qty;
  closeOnMarks(book, { Mint111: 20 }, "2026-09-24T00:01:00Z");
  const sold = applyPrint(book, {
    id: "leader-sell",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 22,
  }, sleeves);
  assert.equal(sold.status, "sell");
  assert.ok(Math.abs(book.trades.at(-1).qty - qty / 2) < 1e-9);
  assert.equal(book.lots["wallet|Mint111"], undefined);

  const stopped = emptyBook();
  applyPrint(stopped, { ...buy, id: "buy-2" }, sleeves);
  closeOnMarks(stopped, { Mint111: 20 }, "2026-09-24T00:01:00Z");
  const stop = closeOnMarks(stopped, { Mint111: 8.5 }, "2026-09-24T00:02:00Z");
  assert.equal(stop[0].reason, "stop");
  assert.ok(Math.abs(stop[0].qty - qty / 2) < 1e-9);
  assert.equal(stopped.lots["wallet|Mint111"], undefined);
});

test("a FOMO sell closes that trader's lot and duplicates are ignored", () => {
  const book = emptyBook();
  const sleeves = { wallet: 250 };
  const result = applyPrints(book, [
    {
      id: "buy-1",
      ts: "2026-09-24T00:00:00Z",
      traderId: "wallet",
      side: "buy",
      mint: "Mint111",
      symbol: "AAA",
      priceUsd: 10,
    },
    {
      id: "buy-1",
      ts: "2026-09-24T00:00:00Z",
      traderId: "wallet",
      side: "buy",
      mint: "Mint111",
      symbol: "AAA",
      priceUsd: 10,
    },
    {
      id: "sell-1",
      ts: "2026-09-24T00:05:00Z",
      traderId: "wallet",
      side: "sell",
      mint: "Mint111",
      symbol: "AAA",
      priceUsd: 11,
    },
  ], sleeves);
  assert.equal(result.counts.buy, 1);
  assert.equal(result.counts.duplicate, 1);
  assert.equal(result.counts.sell, 1);
  const view = snapshot(book, { Mint111: 11 });
  assert.equal(view.positions.length, 0);
  assert.equal(view.startingUsd, 1_000);
  assert.ok(Math.abs(view.pnlUsd - view.realizedUsd) < 1e-6);
  assert.ok(view.realizedUsd > 0);
  assert.ok(Math.abs((view.cashUsd - 1_000) - view.realizedUsd) < 1e-6);
});

test("a sell with no lot is skipped and cannot touch another trader", () => {
  const book = emptyBook();
  const sleeves = { ada: 250, bob: 250 };
  applyPrint(book, {
    id: "bob-buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "bob",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 80_000,
    priceUsd: 10,
  }, sleeves);
  const cash = book.cashUsd;
  const held = book.lots["bob|Mint111"][0].qty;
  const skipped = applyPrint(book, {
    id: "ada-sell",
    ts: "2026-09-24T00:01:00Z",
    traderId: "ada",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    usd: 90_000,
    priceUsd: 40,
    closeQty: 1_000,
  }, sleeves);
  assert.equal(skipped.status, "flat");
  assert.equal(book.trades.filter((trade) => trade.side === "sell").length, 0);
  assert.equal(book.cashUsd, cash);
  assert.equal(book.lots["bob|Mint111"][0].qty, held);
  assert.ok(book.cashUsd >= 0);

  const bare = emptyBook();
  assert.equal(closeOnMarks(bare, { Mint111: 1 }, "2026-09-24T00:02:00Z").length, 0);
  assert.equal(bare.trades.length, 0);
  assert.equal(bare.cashUsd, 1_000);

  const closed = applyPrint(book, {
    id: "bob-sell",
    ts: "2026-09-24T00:03:00Z",
    traderId: "bob",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    usd: 90_000,
    priceUsd: 12,
    closeQty: held * 10,
  }, sleeves);
  assert.equal(closed.status, "sell");
  assert.ok(Math.abs(closed.book.trades.at(-1).qty - held) < 1e-9);
  assert.equal(book.lots["bob|Mint111"], undefined);
  assert.ok(book.cashUsd > cash);
  assert.equal(applyPrint(book, {
    id: "bob-sell-again",
    ts: "2026-09-24T00:04:00Z",
    traderId: "bob",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 12,
  }, sleeves).status, "flat");
});

test("a saved phantom sell or negative cash resets the book", () => {
  const phantom = emptyBook();
  phantom.trades.push({
    id: "ghost",
    ts: "2026-09-24T00:00:00Z",
    side: "sell",
    traderId: "ada",
    mint: "Mint111",
    qty: 2,
    usd: 20,
  });
  assert.equal(bookNeedsReset(phantom), true);
  const cleared = sanitizeBook(phantom);
  assert.equal(cleared.cashUsd, 1_000);
  assert.deepEqual(cleared.lots, {});
  assert.equal(cleared.trades.length, 0);

  const negative = emptyBook();
  negative.cashUsd = -12;
  assert.equal(sanitizeBook(negative).cashUsd, 1_000);
  assert.equal(bookNeedsReset(emptyBook()), false);
});

test("open P&L is equity minus $1,000 and is unrealized until a close", () => {
  const book = emptyBook();
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  }, { wallet: 250 });
  const flat = snapshot(book, { Mint111: 10 });
  assert.ok(Math.abs(flat.equityUsd - 1_000) < 1e-6);
  assert.ok(Math.abs(flat.pnlUsd) < 1e-6);
  assert.equal(flat.realizedUsd, 0);
  const up = snapshot(book, { Mint111: 15 });
  assert.ok(up.pnlUsd > 0);
  assert.equal(up.realizedUsd, 0);
  assert.ok(Math.abs(up.pnlUsd - (up.equityUsd - 1_000)) < 1e-6);
  const qty = book.lots["wallet|Mint111"][0].qty;
  assert.ok(Math.abs(up.unrealizedUsd - (15 - 10) * qty) < 1e-6);
  assert.ok(Math.abs(up.positions[0].unrealizedUsd - up.unrealizedUsd) < 1e-6);
  const missing = positions(book, {});
  assert.equal(missing[0].markUsd, null);
  assert.equal(missing[0].unrealizedUsd, null);
});

test("a DexScreener quote off by 10^decimals is scaled onto the human price", () => {
  const human = 0.003781;
  const aligned = alignUsdPrice(human * 1e6, human);
  assert.ok(Math.abs(aligned - human) / human < 1e-9);
  const moved = alignUsdPrice(human * 3.7, human);
  assert.ok(Math.abs(moved - human * 3.7) < 1e-12);
  assert.equal(alignUsdPrice(human * 10, human), human * 10);
  const blown = alignUsdPrice(human * 4900, human);
  assert.ok(blown < human * 100);
  assert.equal(alignUsdPrice(0, human), human);
});

test("a decimal-shifted mark does not invent P&L, and a real move does", () => {
  const book = emptyBook();
  const entry = 0.003781;
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: entry,
  }, { wallet: 250 });
  const qty = book.lots["wallet|Mint111"][0].qty;
  const cash = book.cashUsd;
  const flat = snapshot(book, { Mint111: entry * 1e6 });
  assert.ok(Math.abs(flat.unrealizedUsd) < 1e-6);
  assert.ok(Math.abs(flat.pnlUsd) < 1e-6);
  assert.equal(closeOnMarks(book, { Mint111: entry * 1e6 }, "2026-09-24T00:01:00Z").length, 0);
  assert.equal(book.cashUsd, cash);

  const marked = snapshot(book, { Mint111: entry * 1.1 });
  assert.ok(Math.abs(marked.unrealizedUsd - (entry * 1.1 - entry) * qty) < 1e-6);
  assert.equal(marked.realizedUsd, 0);

  const skipped = closeOnMarks(book, { Mint111: entry * 4900 }, "2026-09-24T00:02:00Z");
  assert.equal(skipped.length, 0);
  assert.equal(book.cashUsd, cash);
  assert.ok(book.lots["wallet|Mint111"]);

  const ten = closeOnMarks(book, { Mint111: entry * 10 }, "2026-09-24T00:03:00Z");
  assert.equal(ten.length, 1);
  assert.equal(ten[0].reason, "runner");
  assert.ok(Math.abs(ten[0].priceUsd - entry * 10) / entry < 1e-6);
  assert.equal(book.lots["wallet|Mint111"], undefined);
});

test("a book saved before the mark fix resets to $1,000 and no positions", () => {
  const stale = emptyBook();
  delete stale.bookVersion;
  stale.cashUsd = 835;
  stale.lots = { "ada|Mint111": [{ qty: 10, costUsd: 40, entryUsd: 4, symbol: "AAA" }] };
  assert.equal(bookNeedsReset(stale), true);
  const cleared = sanitizeBook(stale);
  assert.equal(cleared.cashUsd, 1_000);
  assert.equal(cleared.bookVersion, 4);
  assert.deepEqual(cleared.lots, {});
  assert.equal(cleared.trades.length, 0);
});

test("live mode stays off and cannot name an order route", () => {
  assert.equal(LIVE_MODE, false);
  const status = liveStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.armed, false);
  assert.equal(status.orders, "disabled");
  assert.equal(status.account, "sandbox");
  assert.equal(status.separateFromMainWallet, true);
});

test("each copy is one ledger line and a skipped sell adds nothing", () => {
  const book = emptyBook();
  const sleeves = { ada: 250, bob: 250 };
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "ada",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 80_000,
    priceUsd: 10,
  }, sleeves);
  assert.equal(book.ledger.length, 1);
  assert.equal(book.ledger[0].why, "8% of the sleeve still unused");
  assert.equal(book.ledger[0].entryUsd, 10);
  assert.equal(book.ledger[0].exitUsd, null);
  assert.equal(book.ledger[0].outcome, "opened");
  assert.ok(Math.abs(book.ledger[0].usd - 20) < 1e-9);

  const cash = book.cashUsd;
  const skipped = applyPrint(book, {
    id: "bob-sell",
    ts: "2026-09-24T00:01:00Z",
    traderId: "bob",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    usd: 90_000,
    priceUsd: 40,
  }, sleeves);
  assert.equal(skipped.status, "flat");
  assert.equal(book.cashUsd, cash);
  assert.equal(book.trades.filter((trade) => trade.side === "sell").length, 0);
  assert.equal(book.ledger.at(-1).outcome, "skipped");
  assert.equal(book.ledger.at(-1).why, "No open lot for this trader");
  assert.equal(book.ledger.at(-1).realizedUsd, 0);
  assert.equal(book.ledger.at(-1).usd, 0);

  const closed = applyPrint(book, {
    id: "ada-sell",
    ts: "2026-09-24T00:02:00Z",
    traderId: "ada",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 12,
    closeQty: 10_000,
  }, sleeves);
  assert.equal(closed.status, "sell");
  const line = book.ledger.at(-1);
  assert.equal(line.outcome, "closed");
  assert.equal(line.entryUsd, 10);
  assert.equal(line.exitUsd, 12);
  assert.ok(line.realizedUsd > 0);
  assert.equal(book.ledger.filter((row) => row.id === "ada-sell").length, 1);
  assert.equal(book.lots["ada|Mint111"], undefined);
  assert.ok(book.cashUsd > cash);
});

test("a closed lot's P&L stays on the sleeve that opened it", () => {
  const book = emptyBook();
  const sleeves = { a: 500, b: 500 };
  applyPrint(book, {
    id: "a-buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "a",
    side: "buy",
    mint: "MintA",
    symbol: "AAA",
    priceUsd: 2,
  }, sleeves);
  applyPrint(book, {
    id: "b-buy",
    ts: "2026-09-24T00:00:01Z",
    traderId: "b",
    side: "buy",
    mint: "MintB",
    symbol: "BBB",
    priceUsd: 2,
  }, sleeves);
  assert.ok(Math.abs(book.sleeveCash.a - 460) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.b - 460) < 1e-9);

  const gain = applyPrint(book, {
    id: "a-sell",
    ts: "2026-09-24T00:02:00Z",
    traderId: "a",
    side: "sell",
    mint: "MintA",
    symbol: "AAA",
    priceUsd: 3,
  }, sleeves);
  assert.equal(gain.status, "sell");
  assert.ok(Math.abs(book.sleeveCash.a - 520) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.b - 460) < 1e-9);

  const next = applyPrint(book, {
    id: "a-next",
    ts: "2026-09-24T00:03:00Z",
    traderId: "a",
    side: "buy",
    mint: "MintC",
    symbol: "CCC",
    priceUsd: 1,
  }, sleeves);
  assert.equal(next.status, "buy");
  assert.ok(Math.abs(book.trades.at(-1).usd - 41.6) < 1e-9);

  applyPrint(book, {
    id: "b-sell",
    ts: "2026-09-24T00:04:00Z",
    traderId: "b",
    side: "sell",
    mint: "MintB",
    symbol: "BBB",
    priceUsd: 1,
  }, sleeves);
  assert.ok(Math.abs(book.sleeveCash.b - 480) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.a - 478.4) < 1e-9);
  assert.ok(book.sleeveCash.a >= 0 && book.sleeveCash.b >= 0);
});

test("a sleeve cannot go below zero or spend another sleeve's cash", () => {
  const book = emptyBook();
  book.sleeveCash = { a: 0, b: 80 };
  book.cashUsd = 80;
  book.lots = { "a|MintA": [{ qty: 10, costUsd: 50, entryUsd: 5, symbol: "AAA" }] };
  const closed = applyPrint(book, {
    id: "sell-a",
    ts: "2026-09-24T00:00:00Z",
    traderId: "a",
    side: "sell",
    mint: "MintA",
    symbol: "AAA",
    priceUsd: 1,
  }, { a: 500, b: 500 });
  assert.equal(closed.status, "sell");
  assert.ok(Math.abs(book.sleeveCash.a - 10) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.b - 80) < 1e-9);
  const blocked = applyPrint(book, {
    id: "buy-a",
    ts: "2026-09-24T00:01:00Z",
    traderId: "a",
    side: "buy",
    mint: "MintC",
    symbol: "CCC",
    priceUsd: 1,
  }, { a: 500, b: 500 });
  assert.equal(blocked.status, "small");
  assert.ok(Math.abs(book.sleeveCash.b - 80) < 1e-9);
  assert.equal(book.cashUsd, 90);
});

test("seeding sleeve cash keeps open lots and does not reset the book", () => {
  const book = emptyBook();
  book.cashUsd = 990;
  book.lots = { "a|Mint": [{ qty: 1, costUsd: 10, entryUsd: 10, symbol: "AAA" }] };
  book.trades = [{
    id: "old",
    ts: "2026-09-24T00:00:00Z",
    side: "buy",
    traderId: "a",
    mint: "Mint",
    qty: 1,
    usd: 10,
    priceUsd: 10,
    realizedUsd: 0,
  }];
  ensureSleeveCash(book, { a: 400, b: 600 });
  assert.equal(book.lots["a|Mint"][0].qty, 1);
  assert.equal(book.cashUsd, 990);
  assert.equal(book.bookVersion, 4);
  assert.ok(Math.abs(book.sleeveCash.a - 390) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.b - 600) < 1e-9);
  const equity = sleeveEquity(book, "a", {});
  assert.ok(Math.abs(equity - 400) < 1e-9);
  assert.equal(book.ledger.length, 0);
});

test("each sleeve history keeps the newest 50 rows and does not clear the book", () => {
  const book = emptyBook();
  book.cashUsd = 800;
  book.ledger = Array.from({ length: 60 }, (_, index) => ({
    traderId: "ada",
    ts: `2026-09-24T00:${String(index).padStart(2, "0")}:00Z`,
    side: index % 2 ? "sell" : "buy",
    symbol: `T${index}`,
    usd: index + 1,
    outcome: index % 2 ? "closed" : "opened",
    realizedUsd: 0,
  }));
  delete book.history;
  ensureWalletHistory(book);
  assert.equal(book.cashUsd, 800);
  assert.equal(book.ledger.length, 60);
  assert.equal(book.history.ada.length, 50);
  assert.equal(book.history.ada[0].symbol, "T10");
  assert.equal(book.history.ada.at(-1).symbol, "T59");
  assert.equal(book.lots && Object.keys(book.lots).length, 0);
});

test("a shifted double or triple closes at the aligned mark and the realized P&L matches the cost", () => {
  const book = emptyBook();
  const entry = 10;
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: entry,
  }, { wallet: 250 });
  const openedQty = book.lots["wallet|Mint111"][0].qty;
  const openedCost = book.lots["wallet|Mint111"][0].costUsd;
  const half = closeOnMarks(book, { Mint111: entry * 2 * 1e6 }, "2026-09-24T00:01:00Z");
  assert.equal(half.length, 1);
  assert.equal(half[0].reason, "half");
  assert.ok(Math.abs(half[0].priceUsd - entry * 2) / entry < 1e-6);
  assert.ok(half[0].priceUsd < entry * 100);
  assert.ok(Math.abs(half[0].qty - openedQty / 2) < 1e-8);
  assert.ok(Math.abs(half[0].usd - half[0].priceUsd * half[0].qty) < 1e-6);
  assert.ok(Math.abs(half[0].realizedUsd - (half[0].usd - openedCost / 2)) < 1e-6);

  const runner = closeOnMarks(book, { Mint111: entry * 3 * 1e6 }, "2026-09-24T00:02:00Z");
  assert.equal(runner.length, 1);
  assert.equal(runner[0].reason, "runner");
  assert.ok(Math.abs(runner[0].priceUsd - entry * 3) / entry < 1e-6);
  assert.ok(runner[0].priceUsd < entry * 100);
  assert.ok(Math.abs(runner[0].realizedUsd - (runner[0].usd - openedCost / 2)) < 1e-6);
  assert.equal(book.lots["wallet|Mint111"], undefined);
});

test("a leader sell keeps a real 10× price and drops a print on another scale", () => {
  const sleeves = { wallet: 250 };
  const buy = {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  };
  const blown = emptyBook();
  applyPrint(blown, buy, sleeves);
  const cash = blown.cashUsd;
  const qty = blown.lots["wallet|Mint111"][0].qty;
  const cooked = alignUsdPrice(10 * 4900, 10);
  assert.ok(Math.abs(cooked - 10) / 10 < 1e-9);
  assert.equal(closeOnMarks(blown, { Mint111: 10 * 4900 }, "2026-09-24T00:01:00Z").length, 0);
  assert.equal(closeOnMarks(blown, { Mint111: cooked }, "2026-09-24T00:01:30Z").length, 0);
  const skipped = applyPrint(blown, {
    id: "sell-blown",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10 * 4900,
  }, sleeves);
  assert.equal(skipped.status, "skip");
  assert.equal(blown.trades.filter((trade) => trade.side === "sell").length, 0);
  assert.equal(blown.cashUsd, cash);
  assert.ok(Math.abs(blown.lots["wallet|Mint111"][0].qty - qty) < 1e-9);
  assert.equal(blown.ledger.at(-1).why, "Exit price is off the entry scale");

  const ten = emptyBook();
  applyPrint(ten, { ...buy, id: "buy-10" }, sleeves);
  const heldQty = ten.lots["wallet|Mint111"][0].qty;
  const heldCost = ten.lots["wallet|Mint111"][0].costUsd;
  const sold = applyPrint(ten, {
    id: "sell-10",
    ts: "2026-09-24T00:01:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 100,
  }, sleeves);
  assert.equal(sold.status, "sell");
  const trade = ten.trades.at(-1);
  assert.ok(Math.abs(trade.priceUsd - 100) < 1e-9);
  assert.ok(Math.abs(trade.qty - heldQty) < 1e-8);
  assert.ok(Math.abs(trade.realizedUsd - (trade.usd - heldCost)) < 1e-6);

  const shifted = emptyBook();
  applyPrint(shifted, { ...buy, id: "buy-shift" }, sleeves);
  const basisCost = shifted.lots["wallet|Mint111"][0].costUsd;
  const aligned = applyPrint(shifted, {
    id: "sell-shift",
    ts: "2026-09-24T00:01:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 20 * 1e6,
  }, sleeves);
  assert.equal(aligned.status, "sell");
  const fill = shifted.trades.at(-1);
  assert.ok(Math.abs(fill.priceUsd - 20) < 1e-6);
  assert.ok(Math.abs(fill.realizedUsd - (fill.usd - basisCost)) < 1e-6);
  assert.ok(fill.priceUsd < 1000);
});

test("a sell with a missing quantity does not close the lot", () => {
  const book = emptyBook();
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  }, { wallet: 250 });
  const cash = book.cashUsd;
  const qty = book.lots["wallet|Mint111"][0].qty;
  for (const [id, closeQty] of [["nan", Number.NaN], ["zero", 0]]) {
    const result = applyPrint(book, {
      id,
      ts: "2026-09-24T00:01:00Z",
      traderId: "wallet",
      side: "sell",
      mint: "Mint111",
      symbol: "AAA",
      priceUsd: 12,
      closeQty,
    }, { wallet: 250 });
    assert.equal(result.status, "skip");
    assert.equal(book.ledger.at(-1).why, "Sell quantity is missing");
  }
  assert.equal(book.trades.filter((trade) => trade.side === "sell").length, 0);
  assert.equal(book.cashUsd, cash);
  assert.ok(Math.abs(book.lots["wallet|Mint111"][0].qty - qty) < 1e-9);
});
