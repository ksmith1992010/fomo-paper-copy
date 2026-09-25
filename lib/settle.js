import { readSharedBook, withBook } from "./book-store.js";
import { quoteMints } from "./feed.js";
import { applyPrints, emptyBook, sanitizeBook, sleevesFor } from "./paper.js";

function sleevesFrom(feed) {
  const sleeves = {};
  for (const trader of feed?.traders || []) {
    if (Number(trader.sleeveUsd) > 0) sleeves[trader.id] = Number(trader.sleeveUsd);
  }
  if (!Object.keys(sleeves).length) Object.assign(sleeves, sleevesFor(feed?.traders || []));
  return sleeves;
}

function printsFrom(feed) {
  const prints = [];
  for (const trader of feed?.traders || []) prints.push(...(trader.prints || []));
  return prints;
}

function bookFromStore(saved) {
  if (!saved || typeof saved !== "object") return emptyBook();
  return sanitizeBook(structuredClone(saved));
}

function openMints(saved, dexMarks) {
  const mints = [];
  for (const key of Object.keys(saved?.lots || {})) {
    const mint = key.split("|")[1];
    if (!mint || Number(dexMarks?.[mint]) > 0 || mints.includes(mint)) continue;
    mints.push(mint);
  }
  return mints;
}

/** Apply fills on the one server book. Nothing in the request is treated as a book. */
export async function settleFeed(feed, options = {}) {
  const saved = await readSharedBook(options.store);
  const dexMarks = { ...(feed?.dexMarks || {}) };
  const tokenImages = { ...(feed?.tokenImages || {}) };
  let routes = [...(feed?.routes || [])];
  const missing = openMints(saved, dexMarks);
  if (missing.length) {
    const quoted = await quoteMints(missing, { fetchImpl: options.fetchImpl, routes });
    Object.assign(dexMarks, quoted.dexMarks);
    Object.assign(tokenImages, quoted.tokenImages);
    routes = quoted.routes;
  }
  const priced = { ...feed, dexMarks, tokenImages, routes };
  const book = await withBook(options.store, (stored) => {
    const book = bookFromStore(stored);
    applyPrints(book, printsFrom(priced), sleevesFrom(priced));
    return book;
  });
  return { ...priced, book };
}
