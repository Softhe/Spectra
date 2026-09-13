// Result cache: re-dropped files skip decode + DSP entirely.
// Identity is a sampled content hash (first/mid/last 256 KB + byte size),
// so renames and re-exports hit while different audio never collides.
// objectUrls are per-session and never persisted.
import type { Analysis } from "./types";

/** Bump whenever detection constants change; old entries are evicted. */
export const DSP_VERSION = 2;

const DB_NAME = "spectra-analyses";
const STORE = "analyses";
const MAX_ENTRIES = 50;
const SAMPLE = 256 * 1024;

type StoredEntry = {
  key: string;
  version: number;
  savedAt: number;
  analysis: Omit<Analysis, "objectUrl"> & { objectUrl: "" };
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function cacheKeyForFile(file: Blob): Promise<string | null> {
  try {
    const size = file.size;
    const slices: Blob[] = [file.slice(0, SAMPLE)];
    if (size > SAMPLE * 2) {
      const mid = Math.max(0, Math.floor(size / 2 - SAMPLE / 2));
      slices.push(file.slice(mid, mid + SAMPLE));
    }
    if (size > SAMPLE) {
      slices.push(file.slice(Math.max(0, size - SAMPLE), size));
    }
    const parts: Uint8Array[] = [];
    for (const s of slices) {
      parts.push(new Uint8Array(await s.arrayBuffer()));
    }
    const sizeBytes = new TextEncoder().encode(`:${size}:`);
    const total = parts.reduce((n, p) => n + p.length, 0) + sizeBytes.length;
    const joined = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      joined.set(p, off);
      off += p.length;
    }
    joined.set(sizeBytes, off);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      joined.buffer as ArrayBuffer,
    );
    return `v${DSP_VERSION}:${hex(digest)}`;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheGet(
  key: string,
): Promise<StoredEntry["analysis"] | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const entry: StoredEntry | undefined = await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as StoredEntry | undefined);
      req.onerror = () => resolve(undefined);
      tx.oncomplete = () => db.close();
    });
    if (!entry || entry.version !== DSP_VERSION) return null;
    return entry.analysis;
  } catch {
    return null;
  }
}

export async function cachePut(
  key: string,
  analysis: Analysis,
): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const { objectUrl: _drop, ...rest } = analysis;
    const entry: StoredEntry = {
      key,
      version: DSP_VERSION,
      savedAt: Date.now(),
      analysis: { ...rest, objectUrl: "" },
    };
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(entry);
      // LRU eviction: keep the newest MAX_ENTRIES.
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result as StoredEntry[]).sort(
          (x, y) => y.savedAt - x.savedAt,
        );
        for (const extra of rows.slice(MAX_ENTRIES)) {
          store.delete(extra.key);
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  } catch {
    // Quota or privacy mode: analysis just re-runs next time.
  }
}
