const WALLET_KEYS = ["walletAddress", "solanaAddress", "solanaWallet", "wallet", "ownerAddress", "publicKey", "address"];

export function isSolanaAddress(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function solanaWallet(trader) {
  if (!trader || typeof trader !== "object") return null;
  if (isSolanaAddress(trader.wallets?.solana)) return trader.wallets.solana;
  const sources = [trader, trader.user, trader.profile, trader.walletInfo];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of WALLET_KEYS) {
      if (isSolanaAddress(source[key])) return source[key];
    }
  }
  return null;
}

export function traderImage(trader) {
  const candidates = [trader?.avatar, trader?.image, trader?.profileImage, trader?.imageUrl];
  for (const value of candidates) {
    if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  }
  return null;
}

export function snapshotFromBoard(traders, savedAt = new Date().toISOString()) {
  const rows = [];
  for (const [index, trader] of (traders || []).entries()) {
    if (!trader?.userId) continue;
    rows.push({
      rank: trader.rank || index + 1,
      handle: trader.handle || trader.displayName || trader.userId,
      userId: trader.userId,
      wallet: solanaWallet(trader),
      image: traderImage(trader),
      pnlUsd: Number(trader.pnlUsd) || 0,
    });
    if (rows.length === 3) break;
  }
  if (!rows.length) return null;
  return { savedAt, traders: rows };
}

export function snapshotBanner(status, snapshot) {
  const why = status === 402
    ? "FOMO is out of credits."
    : status
      ? `FOMO leaderboard returned ${status}.`
      : "FOMO leaderboard did not answer.";
  if (!snapshot?.traders?.length) {
    return `${why} There is no saved snapshot, so this board is empty. No traders were invented.`;
  }
  const when = snapshot.savedAt ? ` saved ${snapshot.savedAt}` : "";
  const missing = snapshot.traders.some((trader) => !isSolanaAddress(trader.wallet));
  const walletNote = missing
    ? " A saved trader with no Solana wallet is listed and not followed."
    : " Buys and sells are that wallet's public Solana swaps, marked on DexScreener.";
  return `${why} This board is the last FOMO snapshot${when}, not a live leaderboard.${walletNote}`;
}
