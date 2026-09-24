import assert from "node:assert/strict";
import test from "node:test";
import {
  STARTING_CASH,
  applyPrint,
  applyPrints,
  bookNeedsReset,
  closeOnMarks,
  emptyBook,
  sanitizeBook,
  sleeveSizes,
  snapshot,
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

test("DexScreener +20% and -15% close the lot and realize P&L", () => {
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
  assert.equal(closeOnMarks(book, { Mint111: 11.9 }, "2026-09-24T00:02:00Z").length, 0);

  const target = closeOnMarks(book, { Mint111: 12 }, "2026-09-24T00:03:00Z");
  assert.equal(target.length, 1);
  assert.equal(target[0].reason, "target");
  assert.ok(target[0].realizedUsd > 0);
  assert.equal(snapshot(book, {}).positions.length, 0);

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
});
