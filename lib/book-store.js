import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "snapshots", "paper-book.json");
const ROW_ID = "shared";

function queue(previous, run) {
  const next = previous.then(run, run);
  return [next.then(() => {}, () => {}), next];
}

let fileChain = Promise.resolve();

async function fileStore(mutator) {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    saved = null;
  }
  const next = await mutator(saved);
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next));
  return structuredClone(next);
}

function queuedFileStore(mutator) {
  const [chain, run] = queue(fileChain, () => fileStore(mutator));
  fileChain = chain;
  return run;
}

async function postgresStore(mutator) {
  const { getDatabase } = await import("@netlify/database");
  const db = getDatabase();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["paper-book-shared"]);
    const found = await client.query("SELECT book FROM paper_book WHERE id = $1 FOR UPDATE", [ROW_ID]);
    const next = await mutator(found.rows[0]?.book ?? null);
    const payload = JSON.stringify(next);
    if (found.rows.length) {
      await client.query("UPDATE paper_book SET book = $2::jsonb, updated_at = now() WHERE id = $1", [ROW_ID, payload]);
    } else {
      await client.query("INSERT INTO paper_book (id, book) VALUES ($1, $2::jsonb)", [ROW_ID, payload]);
    }
    await client.query("COMMIT");
    return next;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

async function defaultStore(mutator) {
  if (process.env.NETLIFY_DB_URL || process.env.NETLIFY) return postgresStore(mutator);
  return queuedFileStore(mutator);
}

/** One shared book. Pass a store in tests; production uses Postgres. */
export function withBook(store, mutator) {
  const impl = store || defaultStore;
  return impl(mutator);
}

async function readDefaultBook() {
  if (process.env.NETLIFY_DB_URL || process.env.NETLIFY) {
    const { getDatabase } = await import("@netlify/database");
    const db = getDatabase();
    const found = await db.pool.query("SELECT book FROM paper_book WHERE id = $1", [ROW_ID]);
    return found.rows[0]?.book ?? null;
  }
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function readSharedBook(store) {
  if (typeof store?.read === "function") return store.read();
  if (store) return null;
  return readDefaultBook();
}

export function memoryBookStore() {
  let book = null;
  let chain = Promise.resolve();
  const store = (mutator) => {
    const [nextChain, run] = queue(chain, async () => {
      const next = await mutator(book ? structuredClone(book) : null);
      book = structuredClone(next);
      return structuredClone(book);
    });
    chain = nextChain;
    return run;
  };
  store.read = async () => (book ? structuredClone(book) : null);
  return store;
}
