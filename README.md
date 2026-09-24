# Paper copy trader

A single simulated book that mirrors the three busiest wallets on the public Solana tape. No orders are sent. No wallet keys.

## Run

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:4173. The page refreshes every 20 seconds. Use Refresh to pull again.

## Data source

FOMO's own leaderboard (`GET https://prod-api.fomo.family/v2/leaderboard/24h`) answers `unauthorized` without a session. Solana Tracker's leaderboard (`GET https://data.solanatracker.io/v2/pnl/leaderboard/top`) answers `API key is required`. Neither key is in this repo.

The top 3 are therefore the wallets with the most USD volume on recent prints from GeckoTerminal's Solana trending pools:

- `GET https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h`
- `GET https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/trades`

Marks come from `GET https://api.dexscreener.com/latest/dex/tokens/{mints}`. SOL/USD comes from a Jupiter lite quote, `GET https://lite-api.jup.ag/swap/v1/quote` (SOL to USDC). Birdeye's price route returned 401 without a key, and Helius is skipped because no key is set. The browser talks only to `/api/feed`, which proxies those calls.

## Paper rules

- Start with $10,000 of paper cash.
- Three traders share the book in equal slices of $3,333.33. One trader cannot spend another trader's slice.
- A mirrored trade's size is that print's share of the trader's taped volume, times the slice: `slice * (printUsd / traderVolumeUsd)`, capped by cash and by slice still unused.
- Buys spend cash and open a position. Sells close only that trader's lots and realize P&L. Sells with no lot are skipped.
- Prints under $25, and paper fills under $1, are dust and are skipped. A print id that was already applied is skipped.
- P&L is equity minus $10,000. Equity is cash plus open quantity marked at the latest DexScreener price.
