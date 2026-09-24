import assert from "node:assert/strict";
import test from "node:test";
import { memoryBookStore } from "../lib/book-store.js";
import { STARTING_CASH, snapshot } from "../lib/paper.js";
import { settleFeed } from "../lib/settle.js";

const feed = {
  ok: true,
  fetchedAt: "2026-09-24T18:00:00Z",
  dexMarks: { MintA: 2 },
  traders: [{
    id: "ada",
    sleeveUsd: 1000,
    prints: [{
      id: "buy-1",
      ts: "2026-09-24T17:00:00Z",
      traderId: "ada",
      traderName: "ada",
      side: "buy",
      mint: "MintA",
      symbol: "AAA",
      priceUsd: 2,
    }],
  }],
};

test("a missing server book starts at $1,000 and two clients share it", async () => {
  const store = memoryBookStore();
  const [first, second] = await Promise.all([
    settleFeed(feed, { store }),
    settleFeed({ ...feed, book: { cashUsd: 1, lots: {}, seen: {}, trades: [] } }, { store }),
  ]);
  assert.equal(first.book.startingUsd, STARTING_CASH);
  assert.equal(first.book.trades.length, 1);
  assert.equal(second.book.trades.length, 1);
  const left = snapshot(first.book, feed.dexMarks);
  const right = snapshot(second.book, feed.dexMarks);
  assert.equal(left.equityUsd, right.equityUsd);
  assert.equal(left.cashUsd, right.cashUsd);
  assert.deepEqual(first.book.sleeveCash, second.book.sleeveCash);
  assert.equal(first.book.ledger.length, second.book.ledger.length);
  assert.ok(left.equityUsd !== 1);
});

test("an open lot is marked from DexScreener on the same feed", async () => {
  const store = memoryBookStore();
  await settleFeed(feed, { store });
  const marked = await settleFeed({
    ...feed,
    dexMarks: {},
    traders: [{ id: "ada", sleeveUsd: 1000, prints: [] }],
  }, {
    store,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pairs: [{
          baseToken: { address: "MintA", symbol: "AAA" },
          priceUsd: "2.1",
          liquidity: { usd: 5000 },
        }],
      }),
    }),
  });
  const { positions } = await import("../lib/paper.js");
  const row = positions(marked.book, marked.dexMarks).find((item) => item.mint === "MintA");
  assert.equal(row.markUsd, 2.1);
  assert.ok(Math.abs(row.unrealizedUsd - (2.1 - 2) * row.qty) < 1e-9);
});
