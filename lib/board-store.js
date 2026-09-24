import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(process.cwd(), "snapshots", "fomo-board.json");

function usable(value) {
  return Array.isArray(value?.traders) && value.traders.length > 0;
}

async function blobStore() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "fomo-snapshot", consistency: "strong" });
  } catch {
    return null;
  }
}

export async function readBoardSnapshot() {
  try {
    const store = await blobStore();
    const saved = store ? await store.get("board", { type: "json" }) : null;
    if (usable(saved)) return saved;
  } catch {
    /* local dev has no blob credentials */
  }
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8"));
    if (usable(parsed)) return parsed;
  } catch {
    /* no file yet */
  }
  return null;
}

export async function writeBoardSnapshot(snapshot) {
  if (!usable(snapshot)) return;
  try {
    const store = await blobStore();
    if (store) await store.setJSON("board", snapshot);
  } catch {
    /* keep the file copy */
  }
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    /* the function bundle is read-only */
  }
}
