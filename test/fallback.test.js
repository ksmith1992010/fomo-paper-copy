import assert from "node:assert/strict";
import test from "node:test";
import { isSolanaAddress, snapshotBanner, snapshotFromBoard } from "../lib/board-snapshot.js";
import { loadFeed, printsFromTrades } from "../lib/feed.js";
import { LIVE_MODE } from "../lib/paper.js";
import { swapFromTransaction } from "../lib/solana-swaps.js";

const WALLET = "Ggb7o1osAQjv4PrAaFzF9UKRW9qYkfCtSZs56BgcAffa";
const MINT = "MintMintMintMintMintMintMintMintMintMintMint";
const USER = "6d8c0bf3-5d42-506c-a0ea-9e1e75ff38af";

test("a saved board keeps handle, user id, and a Solana wallet", () => {
  assert.equal(isSolanaAddress(WALLET), true);
  assert.equal(isSolanaAddress(USER), false);
  const snapshot = snapshotFromBoard([{
    rank: 1,
    userId: USER,
    handle: "pointfarmcap",
    pnlUsd: 100,
    walletAddress: WALLET,
    address: "not-a-wallet",
  }]);
  assert.equal(snapshot.traders[0].handle, "pointfarmcap");
  assert.equal(snapshot.traders[0].userId, USER);
  assert.equal(snapshot.traders[0].wallet, WALLET);
  const nested = snapshotFromBoard([{
    userId: "c39caec4-ae30-5388-ba86-c4c10b5f2d42",
    handle: "AviFelman",
    wallets: { solana: "BA3nKHc4DoSANRrx4FcCupExzs6cWzw1wkPpqjnqJaCN" },
  }]);
  assert.equal(nested.traders[0].wallet, "BA3nKHc4DoSANRrx4FcCupExzs6cWzw1wkPpqjnqJaCN");
  assert.match(snapshotBanner(402, null), /no saved snapshot/);
  assert.match(snapshotBanner(402, snapshot), /last FOMO snapshot/);
  assert.doesNotMatch(snapshotBanner(402, snapshot), /invented/);
});

test("a public swap is a buy or sell only when a token balance changes", () => {
  const buy = swapFromTransaction({
    meta: {
      fee: 5000,
      preBalances: [2_000_000_000],
      postBalances: [1_000_005_000],
      preTokenBalances: [],
      postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "10" } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  }, WALLET, 100);
  assert.equal(buy.side, "buy");
  assert.equal(buy.mint, MINT);
  assert.ok(Math.abs(buy.priceUsd - 10) < 0.01);

  const transfer = swapFromTransaction({
    meta: {
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [],
      postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "4" } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  }, WALLET, 100);
  assert.equal(transfer, null);

  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const partial = swapFromTransaction({
    meta: {
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [
        { owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "10" } },
        { owner: WALLET, mint: USDC, uiTokenAmount: { uiAmountString: "0" } },
      ],
      postTokenBalances: [
        { owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "6" } },
        { owner: WALLET, mint: USDC, uiTokenAmount: { uiAmountString: "4" } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  }, WALLET, 100);
  assert.equal(partial.side, "sell");
  assert.ok(Math.abs(partial.exitFraction - 0.4) < 1e-9);
  assert.equal(partial.heldQty, 10);
  assert.equal(partial.soldQty, 4);

  const exited = swapFromTransaction({
    meta: {
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [
        { owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "10" } },
        { owner: WALLET, mint: USDC, uiTokenAmount: { uiAmountString: "0" } },
      ],
      postTokenBalances: [
        { owner: WALLET, mint: USDC, uiTokenAmount: { uiAmountString: "8" } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  }, WALLET, 100);
  assert.equal(exited.side, "sell");
  assert.equal(exited.exitFraction, 1);
});

test("a FOMO sell copies the fraction sold, and a closed position is a full exit", () => {
  const partial = printsFromTrades(USER, {
    trades: [{
      tradeId: "t1",
      createdAt: "2026-09-24T00:00:00Z",
      token: { address: MINT, symbol: "AAA" },
      boughtAmount: 100,
      soldAmount: 40,
      avgEntryPrice: 2,
      avgExitPrice: 3,
    }],
  }).find((print) => print.side === "sell");
  assert.equal(partial.exitFraction, 0.4);
  assert.equal(partial.positionId, "t1");
  assert.equal(partial.priceUsd, 3);

  const full = printsFromTrades(USER, {
    trades: [{
      tradeId: "t2",
      createdAt: "2026-09-24T00:00:00Z",
      closedAt: "2026-09-24T00:05:00Z",
      token: { address: MINT, symbol: "AAA" },
      boughtAmount: 100,
      soldAmount: 100,
      avgEntryPrice: 2,
      avgExitPrice: 1,
    }],
  }).find((print) => print.side === "sell");
  assert.equal(full.exitFraction, 1);
});

test("a 402 with no snapshot stays empty and does not invent traders", async () => {
  const urls = [];
  const feed = await loadFeed({
    fresh: true,
    fomoKey: "test-key",
    readSnapshot: async () => null,
    writeSnapshot: async () => {},
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: "credits_exhausted" }), { status: 402 });
    },
  });
  assert.equal(feed.ok, false);
  assert.deepEqual(feed.traders, []);
  assert.match(feed.banner, /no saved snapshot/);
  assert.match(feed.banner, /No traders were invented/);
  assert.equal(urls.some((url) => url.includes("fomo.family")), false);
  assert.equal(urls.some((url) => url.includes("/trades")), false);
  assert.equal(feed.live.enabled, false);
  assert.equal(LIVE_MODE, false);
});

test("a 402 follows the saved wallet from public swaps", async () => {
  const urls = [];
  const snapshot = {
    savedAt: "2026-09-24T00:00:00.000Z",
    traders: [{ rank: 1, handle: "pointfarmcap", userId: USER, wallet: WALLET, pnlUsd: 100 }],
  };
  const tx = {
    meta: {
      fee: 5000,
      preBalances: [2_000_000_000],
      postBalances: [1_000_005_000],
      preTokenBalances: [],
      postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { uiAmountString: "10" } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  };
  const feed = await loadFeed({
    fresh: true,
    fomoKey: "test-key",
    readSnapshot: async () => snapshot,
    writeSnapshot: async () => { throw new Error("snapshot should not be rewritten on a failure"); },
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (String(url).includes("leaderboard")) {
        return new Response(JSON.stringify({ error: "credits_exhausted" }), { status: 402 });
      }
      if (String(url).includes("dexscreener.com") && String(url).includes("So111")) {
        return Response.json({ pairs: [{ baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" }, priceUsd: "100", liquidity: { usd: 1000 } }] });
      }
      if (String(url).includes("dexscreener.com")) {
        return Response.json({ pairs: [{ baseToken: { address: MINT, symbol: "AAA" }, priceUsd: "11", liquidity: { usd: 1000 } }] });
      }
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") {
        return Response.json({ result: [{ signature: "sig1", blockTime: 1_700_000_000, err: null }] });
      }
      if (body.method === "getTransaction") return Response.json({ result: tx });
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(feed.stale, true);
  assert.match(feed.banner, /last FOMO snapshot/);
  assert.equal(feed.traders.length, 1);
  assert.equal(feed.traders[0].handle, "pointfarmcap");
  assert.equal(feed.traders[0].userId, USER);
  assert.equal(feed.traders[0].prints.length, 1);
  assert.equal(feed.traders[0].prints[0].side, "buy");
  assert.equal(feed.traders[0].prints[0].symbol, "AAA");
  assert.equal(feed.traders[0].prints[0].traderId, USER);
  assert.equal(urls.some((url) => url.includes("fomo.family")), false);
  assert.equal(urls.some((url) => url.includes("/trades")), false);
  assert.equal(feed.live.armed, false);
});
