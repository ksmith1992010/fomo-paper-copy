import assert from "node:assert/strict";
import test from "node:test";
import {
  STARTING_CASH,
  applyPrint,
  applyPrints,
  closeOnMarks,
  emptyBook,
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
