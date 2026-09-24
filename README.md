# Paper copy trader

A single simulated book that mirrors the current top 3 traders on FOMO's 24h leaderboard. No orders are sent. No wallet keys.

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

Traders are keyed by `userId`. Each trade row becomes a buy when it has a bought amount and entry price, and a sell when it has a sold amount and exit price. If FOMO does not include a usable token price, the mark comes from `GET https://api.dexscreener.com/latest/dex/tokens/{mints}`. The browser talks only to `/api/feed`.

## Paper rules

- Start with $10,000 of paper cash.
- Three traders share the book in equal slices of $3,333.33. One trader cannot spend another trader's slice.
- A mirrored trade's size is that print's share of the trader's taped volume, times the slice: `slice * (printUsd / traderVolumeUsd)`, capped by cash and by slice still unused.
- Buys spend cash and open a position. Sells close only that trader's lots and realize P&L. Sells with no lot are skipped.
- Prints under $25, and paper fills under $1, are dust and are skipped. A print id that was already applied is skipped.
- P&L is equity minus $10,000. Equity is cash plus open quantity marked at FOMO's price, or DexScreener when FOMO has no usable price.
