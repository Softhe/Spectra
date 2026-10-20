// Result cache: re-dropped files skip decode + DSP entirely.
// Identity is a sampled content hash (first/mid/last 256 KB + byte size),
// so renames and re-exports hit while different audio never collides.
// objectUrls are per-session and never persisted.
import type { Analysis } from "./types";

/** Bump whenever detection constants OR the stored shape change. */
export const DSP_VERSION = 6;

const DB_NAME = "spectra-analyses";
const STORE = "analyses";
const SAVED_AT_INDEX = "by-savedAt";
const MAX_ENTRIES = 50;
const SAMPLE = 256 * 1024;

type StoredEntry = {
  key: string;
  version: number;
  savedAt: number;
  analysis: Omit<Analysis, "objectUrl"> & { objectUrl: "" };
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** FNV-1a 32-bit — weak, but only ever used when crypto.subtle is absent. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export async function cacheKeyForFile(file: File): Promise<string | null> {
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
    // Insecure contexts (LAN testing, hardened browsers) expose no
    // crypto.subtle; falling back to null would silently disable the
    // identical-file tie, so degrade to a sampled FNV key instead.
    if (typeof crypto?.subtle?.digest !== "function") {
      const tag = new TextEncoder().encode(`${file.name}\u0000${file.lastModified}\u0000`);
      return `v${DSP_VERSION}:w:${fnv1a(tag)}:${fnv1a(joined)}`;
    }
    const digest = await crypto.subtle.digest("SHA-256", joined.buffer as ArrayBuffer);
    return `v${DSP_VERSION}:${hex(digest)}`;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(STORE)
          ? req.transaction!.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: "key" });
        if (!store.indexNames.contains(SAVED_AT_INDEX)) {
          store.createIndex(SAVED_AT_INDEX, "savedAt", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // A blocked upgrade (another tab holding the old version) must never
      // hang an analysis: skip the cache instead.
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheGet(key: string): Promise<StoredEntry["analysis"] | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const entry: StoredEntry | undefined = await new Promise((resolve) => {
      // Every exit (success, request error, tx error/abort, a synchronous
      // throw) settles the promise and closes the DB — a read never hangs.
      let result: StoredEntry | undefined;
      const finish = () => {
        db.close();
        resolve(result);
      };
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => {
          result = req.result as StoredEntry | undefined;
        };
        tx.oncomplete = finish;
        tx.onerror = finish;
        tx.onabort = finish;
      } catch {
        finish();
      }
    });
    if (!entry || entry.version !== DSP_VERSION) return null;
    return entry.analysis;
  } catch {
    return null;
  }
}

export async function cachePut(key: string, analysis: Analysis): Promise<void> {
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
      // A quota failure ABORTS the transaction (no error event on the tx), so
      // complete, error and abort all settle; close() is idempotent.
      const finish = () => {
        db.close();
        resolve();
      };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch {
        finish();
        return;
      }
      const store = tx.objectStore(STORE);
      // LRU eviction BEFORE the put: delete the oldest entries past budget
      // via the savedAt index cursor, so the write itself can never be a
      // victim and we never deserialize the whole store (the old getAll
      // pulled ~1 MB × entries on every save).
      const counted = store.count();
      counted.onsuccess = () => {
        let over = counted.result - MAX_ENTRIES + 1;
        if (over <= 0) {
          store.put(entry);
          return;
        }
        const cursorReq = store.index(SAVED_AT_INDEX).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            store.put(entry);
            return;
          }
          // Entries from an older DSP_VERSION can never be read again —
          // they are dead weight, not history. They predate every current
          // entry (versions only bump on deploy), so the savedAt cursor frees
          // them first; each was in the count, so it pays down `over` too
          // instead of costing a current entry its slot.
          if ((cursor.value as StoredEntry | undefined)?.version !== DSP_VERSION) {
            cursor.delete();
            over--;
            cursor.continue();
            return;
          }
          if (over <= 0) {
            store.put(entry);
            return;
          }
          cursor.delete();
          over--;
          cursor.continue();
        };
        cursorReq.onerror = () => {
          store.put(entry);
        };
      };
      counted.onerror = () => {
        store.put(entry);
      };
      tx.oncomplete = finish;
      tx.onerror = finish;
      tx.onabort = finish;
    });
  } catch {
    // Quota or privacy mode: analysis just re-runs next time.
  }
}
