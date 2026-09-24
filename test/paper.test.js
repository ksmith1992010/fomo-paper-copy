import assert from "node:assert/strict";
import test from "node:test";
import { applyPrints, emptyBook, snapshot, SLICE_USD } from "../lib/paper.js";

test("a buy and a sell update cash, position, and P&L", () => {
  const book = emptyBook();
  const traderNotionalUsd = 1_000;
  applyPrints(book, [
    {
      id: "buy-1",
      ts: "2026-09-23T00:00:00Z",
      traderId: "wallet-a",
      side: "buy",
      mint: "Mint111",
      symbol: "AAA",
      usd: 300,
      priceUsd: 2,
      traderNotionalUsd,
    },
    {
      id: "sell-1",
      ts: "2026-09-23T00:01:00Z",
      traderId: "wallet-a",
      side: "sell",
      mint: "Mint111",
      symbol: "AAA",
      usd: traderNotionalUsd,
      priceUsd: 3,
      traderNotionalUsd,
    },
  ]);

  const view = snapshot(book, { Mint111: 3 });
  const spent = SLICE_USD * 0.3;
  assert.equal(view.trades.length, 2);
  assert.ok(view.cashUsd > 10_000 - spent);
  assert.equal(view.positions.length, 0);
  assert.ok(Math.abs(view.pnlUsd - spent * 0.5) < 1e-6);
  assert.ok(view.realizedUsd > 0);
});

test("dust and duplicates are skipped", () => {
  const book = emptyBook();
  const print = {
    id: "same",
    ts: "2026-09-23T00:00:00Z",
    traderId: "wallet-a",
    side: "buy",
    mint: "Mint111",
    symbol: "AAA",
    usd: 10,
    priceUsd: 1,
    traderNotionalUsd: 100,
  };
  const big = { ...print, id: "big", usd: 100, priceUsd: 1 };
  const first = applyPrints(book, [print, big, big]);
  assert.equal(first.counts.dust, 1);
  assert.equal(first.counts.buy, 1);
  assert.equal(first.counts.duplicate, 1);
  assert.equal(snapshot(book, { Mint111: 1 }).positions.length, 1);
});

test("one trader cannot spend more than one third of the book", () => {
  const book = emptyBook();
  applyPrints(book, [
    {
      id: "all",
      ts: "2026-09-23T00:00:00Z",
      traderId: "wallet-a",
      side: "buy",
      mint: "Mint111",
      symbol: "AAA",
      usd: 5_000,
      priceUsd: 1,
      traderNotionalUsd: 5_000,
    },
  ]);
  const view = snapshot(book, { Mint111: 1 });
  assert.ok(view.positions[0].costUsd <= SLICE_USD + 1e-6);
  assert.ok(view.cashUsd >= 10_000 - SLICE_USD - 1e-6);
});
