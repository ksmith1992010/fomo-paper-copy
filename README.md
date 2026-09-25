# Podium

A Jarvis-style command deck for one simulated book that mirrors the current top 3 traders on FOMO's 24h leaderboard. No orders are sent. No wallet keys.

## Run

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:4173. The page refreshes every 20 seconds. Use Refresh to pull again.

## Data source

The top 3 are FOMO's own 24h leaderboard. Set `FOMO_API_KEY` in the environment. The server sends it as `Authorization: Bearer`, and the key is not written into the repo.

- `GET https://api.fomoapi.io/v2/leaderboard/24h?limit=3`
- `GET https://api.fomoapi.io/v2/users/{userId}/trades?limit=10`

Traders are keyed by `userId`. Each trade row becomes a buy when it has a bought amount and entry price, and a sell when it has a sold amount and exit price. Marks come from `GET https://api.dexscreener.com/latest/dex/tokens/{mints}`. If DexScreener has no price, an open lot stays marked at its entry, so unrealized P&L is zero. Exits copy the leader. A DexScreener mark never closes a lot. A leader sell whose price is more than 100× the entry, or under 1/100 of it, is skipped. The browser talks only to `/api/feed`.

If the leaderboard returns 402 or does not answer, the desk keeps the last saved top 3 (handle, userId, and Solana wallet when FOMO sent one) and follows those wallets from public Solana transactions. DexScreener still supplies the mark. The page says that board is a snapshot, not a live leaderboard. With no saved snapshot, the board stays empty and says so. Traders are not invented.

## Paper rules

- Start with $1,000 of paper cash. The book lives in the browser under `paper-copy-v4`, so an older book is not reused.
- Each trader gets a sleeve weighted by their 24h PnL on the FOMO board. A sleeve is at least 15% and at most 50% of the book. The three sleeves are then adjusted so they sum to $1,000. If every PnL is zero or negative, the sleeves are equal. The sleeve size is shown on that trader's card.
- A new buy spends 8% of that trader's remaining sleeve (sleeve minus the cost of open lots), and never more than cash on hand. If that amount is under $5, or the sleeve is already spent, the buy is skipped.
- The desk sells only when that wallet sells a mint this sleeve holds. It closes the same fraction of our remaining quantity that they sold of theirs. A full exit closes our lot. There is no +20% take-profit and no −15% stop. A quote more than 100× the entry, or under 1/100 of it, does not close the lot. If that trader has no open lot, the sell is skipped. A close never exceeds the open quantity, and it does not touch another trader's lots in the same coin. Realized P&L is recorded only on those closes.
- A print id that was already applied is skipped. A saved book with a sell of a coin it did not hold, or with negative cash, is dropped and replaced with $1,000 and no positions.
- A copied buy is filled at that print's USD price per whole token. Open lots are then marked at the latest DexScreener price in the same unit. A DexScreener quote that is off by a power of ten (a raw price that skipped decimals) is scaled back before it is used. Leader PnL and volume are never used as a token price.
- P&L is equity minus $1,000. Equity is cash plus open lots at that mark. Unrealized P&L is (mark − entry) times quantity on open lots only.
- A saved book from before this mark fix is dropped and replaced with $1,000 and no positions.
- Live mode is a constant off switch. The page has no wallet connect, no exchange key, and no order route. A later arm would be a sandbox account separate from any main wallet.
- Each copy writes one ledger line: why it fired, the entry, the exit, and the outcome. A skipped sell is a line with no cash change. Size stays 8% of the remaining sleeve, never the leader's full print.
