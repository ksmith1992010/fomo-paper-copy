import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_MODE,
  STARTING_CASH,
  alignUsdPrice,
  exitPrice,
  guardedMarks,
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
  parkIdleSleeves,
  collapseStackedCopies,
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

test("a buy is 8% of the sleeve allocation and skips under $1", () => {
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
    mint: "Mint222",
    symbol: "BBB",
    usd: 80_000,
    priceUsd: 2,
  }, sleeves);
  assert.equal(second.status, "buy");
  assert.ok(Math.abs(book.trades[1].usd - 20) < 1e-9);

  const third = applyPrint(book, {
    id: "buy-3",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint333",
    symbol: "CCC",
    usd: 90_000,
    priceUsd: 2,
  }, sleeves);
  assert.equal(third.status, "buy");
  assert.ok(Math.abs(book.trades[2].usd - 20) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.wallet - 190) < 1e-9);

  const underFive = emptyBook();
  const filled = applyPrint(underFive, {
    id: "under-five",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 1,
  }, { wallet: 60 });
  assert.equal(filled.status, "buy");
  assert.ok(Math.abs(underFive.trades[0].usd - 4.8) < 1e-9);

  const tiny = emptyBook();
  const skipped = applyPrint(tiny, {
    id: "dust",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 1,
  }, { wallet: 10 });
  assert.equal(skipped.status, "small");
  assert.equal(tiny.cashUsd, 1_000);
  assert.equal(tiny.trades.length, 0);
  assert.equal(tiny.ledger.at(-1).why, "Sleeve slice is under $1");
});

test("a DexScreener mark does not take profit or stop out", () => {
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
  const opened = book.lots["wallet|Mint111"][0].qty;
  const cash = book.cashUsd;
  assert.equal(closeOnMarks(book, { Mint111: 12 }, "2026-09-24T00:02:00Z").length, 0);
  assert.equal(closeOnMarks(book, { Mint111: 8.5 }, "2026-09-24T00:03:00Z").length, 0);
  assert.equal(closeOnMarks(book, { Mint111: 100 }, "2026-09-24T00:04:00Z").length, 0);
  assert.ok(Math.abs(book.lots["wallet|Mint111"][0].qty - opened) < 1e-9);
  assert.equal(book.cashUsd, cash);
  assert.equal(book.trades.filter((trade) => trade.side === "sell").length, 0);
});

test("a leader sell closes the whole open lot and a mark does not", () => {
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
  assert.equal(closeOnMarks(book, { Mint111: 12 }, "2026-09-24T00:01:00Z").length, 0);
  assert.ok(book.lots["wallet|Mint111"]);
  const sold = applyPrint(book, {
    id: "leader-sell",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 11,
    exitFraction: 1,
    positionId: "pos-1",
  }, sleeves);
  assert.equal(sold.status, "sell");
  assert.ok(Math.abs(book.trades.at(-1).qty - qty) < 1e-9);
  assert.equal(book.lots["wallet|Mint111"], undefined);
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
  assert.equal(ten.length, 0);
  assert.ok(Math.abs(book.lots["wallet|Mint111"][0].qty - qty) < 1e-8);
  assert.equal(book.cashUsd, cash);
});

test("a quote over 100× entry is ignored for unrealized P&L and equity", () => {
  const book = emptyBook();
  const entry = 0.000453069;
  const qty = 4419.018677625677;
  const cost = 2.002120373253188;
  book.cashUsd = 998;
  book.lots["natan|MintAI"] = [{ qty, symbol: "AI", costUsd: cost, entryUsd: entry }];
  const quote = entry * 541;
  const cash = book.cashUsd;
  const view = snapshot(book, { MintAI: quote });
  const row = view.positions.find((item) => item.symbol === "AI");
  assert.equal(exitPrice(quote, entry), null);
  assert.equal(guardedMarks(book, { MintAI: quote }).MintAI, undefined);
  assert.equal(row.markUsd, null);
  assert.equal(row.unrealizedUsd, null);
  assert.ok(Math.abs(row.valueUsd - cost) < 1e-9);
  assert.ok(Math.abs(view.equityUsd - (cash + cost)) < 1e-6);
  assert.equal(view.positions.length, 1);
  assert.equal(closeOnMarks(book, { MintAI: quote }, "2026-09-27T00:00:00Z").length, 0);
  assert.equal(book.cashUsd, cash);
  assert.equal(book.lots["natan|MintAI"][0].qty, qty);

  const kept = snapshot(book, { MintAI: entry * 10 });
  assert.ok(Math.abs(kept.positions[0].markUsd - entry * 10) < 1e-12);
  assert.ok(kept.positions[0].unrealizedUsd > 0);

  const dust = snapshot(book, { MintAI: entry / 200 });
  assert.equal(dust.positions[0].markUsd, null);
  assert.equal(dust.positions[0].unrealizedUsd, null);
  assert.ok(Math.abs(dust.positions[0].valueUsd - cost) < 1e-9);
  assert.equal(book.cashUsd, cash);
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
  assert.equal(book.ledger[0].why, "8% of the sleeve allocation");
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
  assert.ok(Math.abs(book.trades.at(-1).usd - 40) < 1e-9);

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
  assert.ok(Math.abs(book.sleeveCash.a - 480) < 1e-9);
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
  const capped = applyPrint(book, {
    id: "buy-a",
    ts: "2026-09-24T00:01:00Z",
    traderId: "a",
    side: "buy",
    mint: "MintC",
    symbol: "CCC",
    priceUsd: 1,
  }, { a: 500, b: 500 });
  assert.equal(capped.status, "buy");
  assert.ok(Math.abs(book.trades.at(-1).usd - 10) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.a) < 1e-9);
  assert.ok(Math.abs(book.sleeveCash.b - 80) < 1e-9);
  assert.equal(book.cashUsd, 80);
  const blocked = applyPrint(book, {
    id: "buy-a-2",
    ts: "2026-09-24T00:02:00Z",
    traderId: "a",
    side: "buy",
    mint: "MintD",
    symbol: "DDD",
    priceUsd: 1,
  }, { a: 500, b: 500 });
  assert.equal(blocked.status, "small");
  assert.ok(Math.abs(book.sleeveCash.b - 80) < 1e-9);
  assert.equal(book.cashUsd, 80);
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

test("a shifted leader sell closes the whole lot at the aligned mark and a mark does not", () => {
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
  assert.equal(closeOnMarks(book, { Mint111: entry * 2 * 1e6 }, "2026-09-24T00:01:00Z").length, 0);
  assert.ok(book.lots["wallet|Mint111"]);
  const closed = applyPrint(book, {
    id: "leader-shift",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: entry * 2 * 1e6,
    exitFraction: 1,
  }, { wallet: 250 });
  assert.equal(closed.status, "sell");
  const fill = book.trades.at(-1);
  assert.ok(Math.abs(fill.priceUsd - entry * 2) / entry < 1e-6);
  assert.ok(fill.priceUsd < entry * 100);
  assert.ok(Math.abs(fill.qty - openedQty) < 1e-8);
  assert.ok(Math.abs(fill.usd - fill.priceUsd * fill.qty) < 1e-6);
  assert.ok(Math.abs(fill.realizedUsd - (fill.usd - openedCost)) < 1e-6);
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

test("a partial leader exit sells that fraction, and a later full exit closes the rest", () => {
  const book = emptyBook();
  const sleeves = { wallet: 250 };
  applyPrint(book, {
    id: "buy",
    ts: "2026-09-24T00:00:00Z",
    traderId: "wallet",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 10,
  }, sleeves);
  const openedQty = book.lots["wallet|Mint111"][0].qty;
  const openedCost = book.lots["wallet|Mint111"][0].costUsd;
  const partial = applyPrint(book, {
    id: "sell-40",
    ts: "2026-09-24T00:01:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 11,
    exitFraction: 0.4,
    positionId: "trade-1",
  }, sleeves);
  assert.equal(partial.status, "sell");
  const first = book.trades.at(-1);
  assert.equal(first.reason, "partial");
  assert.ok(Math.abs(first.qty - openedQty * 0.4) < 1e-8);
  assert.ok(Math.abs(first.realizedUsd - (first.usd - openedCost * 0.4)) < 1e-6);
  assert.ok(Math.abs(book.lots["wallet|Mint111"][0].qty - openedQty * 0.6) < 1e-8);
  const again = applyPrint(book, {
    id: "sell-40-again",
    ts: "2026-09-24T00:01:30Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 11,
    exitFraction: 0.4,
    positionId: "trade-1",
  }, sleeves);
  assert.equal(again.status, "duplicate");
  assert.equal(book.trades.filter((trade) => trade.side === "sell").length, 1);
  const full = applyPrint(book, {
    id: "sell-100",
    ts: "2026-09-24T00:02:00Z",
    traderId: "wallet",
    side: "sell",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 9,
    exitFraction: 1,
    positionId: "trade-1",
  }, sleeves);
  assert.equal(full.status, "sell");
  const rest = book.trades.at(-1);
  assert.ok(Math.abs(rest.qty - openedQty * 0.6) < 1e-8);
  assert.ok(Math.abs(rest.realizedUsd - (rest.usd - openedCost * 0.6)) < 1e-6);
  assert.equal(book.lots["wallet|Mint111"], undefined);
});

test("a second buy of a mint already held does not open another slice", () => {
  const book = emptyBook();
  const sleeves = { wallet: 500 };
  const first = applyPrint(book, {
    id: "buy-1",
    ts: "2026-09-26T18:22:32.000Z",
    traderId: "wallet",
    side: "buy",
    mint: "MintValley",
    symbol: "VALLEY",
    priceUsd: 0.00001,
  }, sleeves);
  assert.equal(first.status, "buy");
  const usd = book.trades[0].usd;
  assert.ok(Math.abs(usd - 40) < 1e-9);
  const again = applyPrint(book, {
    id: "buy-2",
    ts: "2026-09-26T18:23:39.000Z",
    traderId: "wallet",
    side: "buy",
    mint: "MintValley",
    symbol: "VALLEY",
    priceUsd: 0.000012,
  }, sleeves);
  assert.equal(again.status, "held");
  assert.equal(book.lots["wallet|MintValley"].length, 1);
  assert.ok(Math.abs(book.lots["wallet|MintValley"][0].costUsd - usd) < 1e-9);
  assert.equal(book.trades.length, 1);
  assert.equal(book.ledger.at(-1).why, "Already holding this mint");
  assert.equal(book.cashUsd, 1_000 - usd);
});

test("stacked catch-up slices collapse to one lot and the extra cost returns to the sleeve", () => {
  const book = emptyBook();
  book.cashUsd = 1.42;
  book.startingUsd = 1_000;
  book.sleeveCash = { wallet: 0, other: 50 };
  book.trades = [{
    id: "old-stop",
    ts: "2026-09-24T18:00:00Z",
    side: "sell",
    traderId: "other",
    mint: "MintOld",
    symbol: "BLUE",
    qty: 1,
    usd: 8,
    priceUsd: 8,
    realizedUsd: -2,
    reason: "stop",
  }];
  book.ledger = [{
    id: "old-stop",
    ts: "2026-09-24T18:00:00Z",
    traderId: "other",
    mint: "MintOld",
    symbol: "BLUE",
    side: "sell",
    why: "DexScreener mark is 15% below entry",
    outcome: "closed",
    realizedUsd: -2,
    usd: 8,
  }];
  const slice = 34.43520990227558;
  book.lots = {
    "wallet|MintValley": [0, 1, 2, 3].map((n) => ({
      qty: 1000 + n,
      costUsd: slice,
      entryUsd: 0.00001,
      symbol: "VALLEY",
    })),
    "wallet|MintPump": [
      { qty: 10, costUsd: slice, entryUsd: 0.00002, symbol: "PUMP" },
      { qty: 11, costUsd: slice, entryUsd: 0.00002, symbol: "PUMP" },
      { qty: 4, costUsd: 13.54591137553949, entryUsd: 0.00002, symbol: "PUMP" },
    ],
    "wallet|MintStonk": [
      { qty: 10, costUsd: 36.32, entryUsd: 0.37, symbol: "STONK" },
      { qty: 8, costUsd: 11.53, entryUsd: 0.32, symbol: "STONK" },
    ],
  };
  collapseStackedCopies(book);
  assert.equal(book.lots["wallet|MintValley"].length, 1);
  assert.ok(Math.abs(book.lots["wallet|MintValley"][0].costUsd - slice) < 1e-9);
  assert.equal(book.lots["wallet|MintPump"].length, 1);
  assert.ok(Math.abs(book.lots["wallet|MintPump"][0].costUsd - slice) < 1e-9);
  assert.equal(book.lots["wallet|MintStonk"].length, 2);
  const refund = slice * 3 + slice + 13.54591137553949;
  assert.ok(Math.abs(book.sleeveCash.wallet - refund) < 1e-6);
  assert.equal(book.sleeveCash.other, 50);
  assert.ok(Math.abs(book.cashUsd - (1.42 + refund)) < 1e-6);
  assert.equal(book.startingUsd, 1_000);
  assert.equal(book.trades.length, 1);
  assert.equal(book.trades[0].id, "old-stop");
  assert.equal(book.ledger[0].why, "DexScreener mark is 15% below entry");
  const notes = book.ledger.filter((line) => line.outcome === "collapsed");
  assert.equal(notes.length, 2);
  assert.equal(notes[0].why, "Collapsed extra catch-up buys of this mint to one slice");
  collapseStackedCopies(book);
  assert.equal(book.ledger.filter((line) => line.outcome === "collapsed").length, 2);
  assert.ok(Math.abs(book.sleeveCash.wallet - refund) < 1e-6);
});

test("idle sleeve cash moves onto the current board and a new mint can open", () => {
  const book = emptyBook();
  book.cashUsd = 350;
  book.sleeveCash = { oldA: 200, oldB: 100, kept: 50 };
  book.lots = { "oldA|MintOld": [{ qty: 10, costUsd: 40, entryUsd: 4, symbol: "OLD" }] };
  book.trades = [{
    id: "old-buy",
    ts: "2026-09-24T00:00:00Z",
    side: "buy",
    traderId: "oldA",
    mint: "MintOld",
    symbol: "OLD",
    qty: 10,
    usd: 40,
    priceUsd: 4,
    realizedUsd: 0,
  }];
  book.ledger = [{
    id: "skipped-buy",
    ts: "2026-09-25T00:00:00Z",
    side: "buy",
    traderId: "new1",
    symbol: "AAA",
    why: "Sleeve slice is under $5",
    outcome: "skipped",
    usd: 0,
    realizedUsd: 0,
  }];
  book.seen = { "skipped-buy": "small" };
  const sleeves = { new1: 500, new2: 300, kept: 200 };
  const result = applyPrints(book, [{
    id: "skipped-buy",
    ts: "2026-09-25T00:00:00Z",
    side: "buy",
    traderId: "new1",
    mint: "Mint111",
    symbol: "AAA",
    priceUsd: 2,
  }, {
    id: "fresh-buy",
    ts: "2026-09-25T00:01:00Z",
    side: "buy",
    traderId: "new1",
    mint: "Mint222",
    symbol: "BBB",
    priceUsd: 2,
  }, {
    id: "fresh-add",
    ts: "2026-09-25T00:02:00Z",
    side: "buy",
    traderId: "new1",
    mint: "Mint222",
    symbol: "BBB",
    priceUsd: 2,
  }], sleeves);
  assert.equal(result.counts.buy, 1);
  assert.equal(result.counts.duplicate, 1);
  assert.equal(result.counts.held, 1);
  assert.equal(book.lots["new1|Mint111"], undefined);
  assert.equal(book.lots["new1|Mint222"].length, 1);
  assert.equal(book.lots["oldA|MintOld"][0].costUsd, 40);
  assert.equal(book.lots["oldA|MintOld"][0].qty, 10);
  assert.equal(book.sleeveCash.oldA, undefined);
  assert.equal(book.sleeveCash.oldB, undefined);
  assert.ok(Math.abs(book.sleeveCash.new1 - 110) < 1e-6);
  assert.ok(Math.abs(book.sleeveCash.new2 - 90) < 1e-6);
  assert.ok(Math.abs(book.sleeveCash.kept - 110) < 1e-6);
  assert.equal(book.trades.filter((trade) => trade.id === "old-buy").length, 1);
  assert.equal(book.ledger[0].outcome, "skipped");
  assert.equal(book.ledger.filter((line) => line.id === "skipped-buy").length, 1);
  assert.equal(book.ledger.some((line) => line.id === "fresh-buy" && line.outcome === "opened"), true);
  assert.ok(Math.abs(book.trades.at(-1).usd - 40) < 1e-6);
  assert.ok(Math.abs(book.cashUsd - 310) < 1e-6);
  assert.equal(parkIdleSleeves(book, sleeves).oldA, undefined);
});
