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

Traders are keyed by `userId`. Each trade row becomes a buy when it has a bought amount and entry price, and a sell when it has a sold amount and exit price. Marks come from `GET https://api.dexscreener.com/latest/dex/tokens/{mints}`. If DexScreener has no price, equity falls back to the FOMO price. The +20% and −15% exits use the DexScreener mark only. The browser talks only to `/api/feed`.

## Paper rules

- Start with $1,000 of paper cash. The book lives in the browser under `paper-copy-v3`, so an older $10,000 book is not reused.
- Each trader gets a sleeve weighted by their 24h PnL on the FOMO board. A sleeve is at least 15% and at most 50% of the book. The three sleeves are then adjusted so they sum to $1,000. If every PnL is zero or negative, the sleeves are equal. The sleeve size is shown on that trader's card.
- A new buy spends 8% of that trader's remaining sleeve (sleeve minus the cost of open lots), and never more than cash on hand. If that amount is under $5, or the sleeve is already spent, the buy is skipped.
- A lot closes when the DexScreener mark is 20% above its entry, or 15% below it. A FOMO sell also closes that trader's lot in the token. Realized P&L is recorded only on those closes.
- A print id that was already applied is skipped.
- P&L is equity minus $1,000. Equity is cash plus open lots at the latest mark.
