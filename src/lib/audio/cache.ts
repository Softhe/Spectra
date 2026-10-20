// Result cache: re-dropped files skip decode + DSP entirely.
// Identity is a content hash that depends ONLY on the bytes (never the file
// name or mtime), so renames and re-exports hit. Files up to FULL_HASH_MAX
// are hashed in full; larger ones hash a dense stripe sample (head, tail and
// evenly spaced stripes + byte size) to stay fast. A sampled key can in
// theory collide for same-length files edited only between stripes, so the
// "identical files" check never trusts a key alone — see filesIdentical().
// objectUrls are per-session and never persisted.
import type { Analysis } from "./types";

/** Bump whenever detection constants OR the stored shape change. */
export const DSP_VERSION = 7;

const DB_NAME = "spectra-analyses";
const STORE = "analyses";
const SAVED_AT_INDEX = "by-savedAt";
const MAX_ENTRIES = 50;
/** On a quota failure, free this many more (oldest) entries, then retry once. */
const QUOTA_EVICT = 10;
/**
 * Files at or below this size are hashed in full: every lossy file and
 * nearly all FLAC / 16-bit WAV. Above it (long hi-res WAV/AIFF) a dense
 * stripe sample keeps re-drops fast; the residual risk is two same-length
 * files differing only between stripes (an edit shorter than ~1/256 of the
 * file), which would share a cache entry.
 */
const FULL_HASH_MAX = 128 * 1024 * 1024;
const EDGE_SAMPLE = 256 * 1024;
const STRIPES = 256;
const STRIPE = 32 * 1024;
const COMPARE_CHUNK = 4 * 1024 * 1024;

type StoredEntry = {
  key: string;
  version: number;
  savedAt: number;
  analysis: Omit<Analysis, "objectUrl"> & { objectUrl: "" };
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Incremental 64-bit (two independent 32-bit lanes: FNV-1a + a murmur-style
 * mix) — weak against adversaries, but only ever used when crypto.subtle is
 * absent (insecure contexts), and collisions are vanishingly rare for the
 * ≤50 entries the cache holds.
 */
class WeakHash {
  private h1 = 0x811c9dc5;
  private h2 = 0x9747b28c;
  update(bytes: Uint8Array) {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      h1 ^= b;
      h1 = Math.imul(h1, 0x01000193);
      h2 = Math.imul(h2 ^ b, 0x5bd1e995);
      h2 ^= h2 >>> 15;
    }
    this.h1 = h1 >>> 0;
    this.h2 = h2 >>> 0;
  }
  digest(): string {
    return this.h1.toString(16).padStart(8, "0") + this.h2.toString(16).padStart(8, "0");
  }
}

/** Byte ranges hashed for a file too large to hash in full. */
function sampleRanges(size: number): [number, number][] {
  const ranges: [number, number][] = [[0, Math.min(size, EDGE_SAMPLE)]];
  const lo = EDGE_SAMPLE;
  const hi = size - EDGE_SAMPLE;
  const span = hi - lo;
  if (span > 0) {
    for (let i = 0; i < STRIPES; i++) {
      const start = lo + Math.floor(((span - STRIPE) * (i + 0.5)) / STRIPES);
      ranges.push([Math.max(lo, start), Math.min(hi, start + STRIPE)]);
    }
  }
  if (size > EDGE_SAMPLE) ranges.push([Math.max(EDGE_SAMPLE, size - EDGE_SAMPLE), size]);
  return ranges;
}

export async function cacheKeyForFile(file: File): Promise<string | null> {
  try {
    const size = file.size;
    const full = size <= FULL_HASH_MAX;
    const tag = full ? "f" : "s";
    const sizeBytes = new TextEncoder().encode(`:${size}:`);
    const hasSubtle = typeof crypto?.subtle?.digest === "function";

    if (!hasSubtle) {
      // Insecure contexts (LAN testing, hardened browsers) expose no
      // crypto.subtle; degrade to a content-only weak hash, streamed in
      // chunks so it never holds the whole file.
      const h = new WeakHash();
      const ranges: [number, number][] = full
        ? Array.from({ length: Math.ceil(size / COMPARE_CHUNK) }, (_, i) => [
            i * COMPARE_CHUNK,
            Math.min(size, (i + 1) * COMPARE_CHUNK),
          ])
        : sampleRanges(size);
      for (const [s, e] of ranges) {
        h.update(new Uint8Array(await file.slice(s, e).arrayBuffer()));
      }
      h.update(sizeBytes);
      return `v${DSP_VERSION}:w${tag}:${h.digest()}`;
    }

    if (full) {
      // The whole content already fixes the size; hash the buffer in place
      // (no concatenated copy of a file up to 128 MB).
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return `v${DSP_VERSION}:${tag}:${hex(digest)}`;
    }
    const parts: Uint8Array[] = [];
    for (const [s, e] of sampleRanges(size)) {
      parts.push(new Uint8Array(await file.slice(s, e).arrayBuffer()));
    }
    const total = parts.reduce((n, p) => n + p.length, 0) + sizeBytes.length;
    const joined = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      joined.set(p, off);
      off += p.length;
    }
    joined.set(sizeBytes, off);
    const digest = await crypto.subtle.digest("SHA-256", joined.buffer as ArrayBuffer);
    return `v${DSP_VERSION}:${tag}:${hex(digest)}`;
  } catch {
    return null;
  }
}

function bytesEqual(x: ArrayBuffer, y: ArrayBuffer): boolean {
  if (x.byteLength !== y.byteLength) return false;
  const words = x.byteLength >>> 2;
  const wx = new Uint32Array(x, 0, words);
  const wy = new Uint32Array(y, 0, words);
  for (let i = 0; i < words; i++) {
    if (wx[i] !== wy[i]) return false;
  }
  const bx = new Uint8Array(x);
  const by = new Uint8Array(y);
  for (let i = words * 4; i < bx.length; i++) {
    if (bx[i] !== by[i]) return false;
  }
  return true;
}

/**
 * Exact byte-for-byte equality of two files, compared in 4 MB chunks so two
 * huge files are never both held in memory. Unreadable files (moved or
 * modified on disk since the drop) and an aborted check report `false`.
 */
export async function filesIdentical(a: Blob, b: Blob, signal?: AbortSignal): Promise<boolean> {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  try {
    for (let off = 0; off < a.size; off += COMPARE_CHUNK) {
      if (signal?.aborted) return false;
      const end = Math.min(a.size, off + COMPARE_CHUNK);
      const [x, y] = await Promise.all([
        a.slice(off, end).arrayBuffer(),
        b.slice(off, end).arrayBuffer(),
      ]);
      if (!bytesEqual(x, y)) return false;
    }
    return !signal?.aborted;
  } catch {
    return false;
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

/**
 * Settles when a readwrite transaction ends; resolves the abort/error reason
 * (or null on commit). Every exit settles — a write never hangs.
 */
function runTx(
  db: IDBDatabase,
  body: (store: IDBObjectStore) => void,
): Promise<DOMException | null | "failed"> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve("failed");
      return;
    }
    tx.oncomplete = () => resolve(null);
    // A quota failure ABORTS the transaction; tx.error carries the reason.
    tx.onabort = () => resolve(tx.error ?? "failed");
    tx.onerror = () => {
      // Followed by abort unless prevented; abort settles with the reason.
    };
    try {
      body(tx.objectStore(STORE));
    } catch {
      try {
        tx.abort();
      } catch {
        resolve("failed");
      }
    }
  });
}

/**
 * LRU eviction in its OWN transaction: frees entries from older DSP versions
 * (dead weight) plus the oldest current ones so one slot opens under
 * MAX_ENTRIES, plus `extra` more. Because it commits independently, a
 * later quota failure on the put can no longer roll the deletes back.
 */
function evict(db: IDBDatabase, extra: number): Promise<DOMException | null | "failed"> {
  return runTx(db, (store) => {
    const counted = store.count();
    counted.onsuccess = () => {
      let over = counted.result - MAX_ENTRIES + 1 + extra;
      // Walk the savedAt index (never deserializes the whole store).
      const cursorReq = store.index(SAVED_AT_INDEX).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        // Entries from an older DSP_VERSION can never be read again. They
        // predate every current entry (versions only bump on deploy), so the
        // savedAt cursor reaches them first; each was in the count, so it
        // pays down `over` too instead of costing a current entry its slot.
        if ((cursor.value as StoredEntry | undefined)?.version !== DSP_VERSION) {
          cursor.delete();
          over--;
          cursor.continue();
          return;
        }
        if (over <= 0) return;
        cursor.delete();
        over--;
        cursor.continue();
      };
    };
  });
}

function isQuota(err: DOMException | null | "failed"): boolean {
  return typeof err === "object" && err !== null && err.name === "QuotaExceededError";
}

export async function cachePut(key: string, analysis: Analysis): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    if (!db) return;
    const { objectUrl: _drop, ...rest } = analysis;
    const entry: StoredEntry = {
      key,
      version: DSP_VERSION,
      savedAt: Date.now(),
      analysis: { ...rest, objectUrl: "" },
    };
    const conn = db;
    // Eviction BEFORE the put, committed separately, so the write itself is
    // never a victim and a failed put cannot undo the freed space.
    await evict(conn, 0);
    const put = () => runTx(conn, (store) => void store.put(entry));
    const err = await put();
    if (isQuota(err)) {
      // Storage is full even within budget (big entries, or the origin's
      // quota shrank): free the oldest few in a fresh transaction, retry once.
      await evict(conn, QUOTA_EVICT);
      await put();
    }
  } catch {
    // Quota or privacy mode: analysis just re-runs next time (best-effort).
  } finally {
    db?.close();
  }
}
