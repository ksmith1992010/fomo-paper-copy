import { withBook } from "./book-store.js";
import { applyPrints, closeOnMarks, emptyBook, sanitizeBook, sleevesFor } from "./paper.js";

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

/** Apply fills on the one server book. Nothing in the request is treated as a book. */
export async function settleFeed(feed, options = {}) {
  const book = await withBook(options.store, (saved) => {
    const book = bookFromStore(saved);
    applyPrints(book, printsFrom(feed), sleevesFrom(feed));
    closeOnMarks(book, feed?.dexMarks || {}, feed?.fetchedAt || new Date().toISOString());
    return book;
  });
  return { ...feed, book };
}
