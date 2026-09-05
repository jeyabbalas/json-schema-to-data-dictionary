// Vector caches. Keys are content hashes (embedding space + template version + text hash), so
// nothing ever needs explicit invalidation: a changed description or a different model simply
// misses. Values are bare Float32Arrays — no schema text is persisted.
//
// The IndexedDB cache (v2) stores ONE record per database — `"current"` = `{ v: 2, dims, keys,
// matrix }`, the whole dictionary as a single ArrayBuffer — instead of one record per vector:
// a 13k × 768-d dictionary is one ~40 MB structured clone (~30 ms) rather than 13k puts, and a
// reload is one `get`. An in-memory mirror is loaded lazily on the first `getMany`; `putMany`
// updates the mirror and coalesces writes (one serialised write per flush); `retainOnly`
// prunes, writes and drops the mirror once every pending write has committed (the index holds
// its own copy by then, and a `putMany` that landed meanwhile still gets persisted). Vectors of
// a different length replace the record outright: the cache holds one embedding space at a time.
// Opening a v1 database (per-vector `vectors` store) deletes that store — those vectors were
// keyed by the v1 text template anyway.

import type { VectorCache } from "./types";
import { cyrb53 } from "./hash";
import { EMBED_TEXT_VERSION } from "./text";

/** Content key of one text (hash + length); shared by cache keys and vector snapshots. */
export function textKey(text: string): string {
  return `${cyrb53(text)}:${text.length}`;
}

/** Cache key of one text within an embedding space (embedder `spaceId`, or `id`). */
export function cacheKey(space: string, text: string): string {
  return `${space}|v${EMBED_TEXT_VERSION}|${textKey(text)}`;
}

export function createMemoryVectorCache(): VectorCache {
  const map = new Map<string, Float32Array>();
  return {
    async getMany(keys) {
      const out = new Map<string, Float32Array>();
      for (const key of keys) {
        const v = map.get(key);
        if (v) out.set(key, v);
      }
      return out;
    },
    async putMany(entries) {
      for (const [key, vector] of entries) map.set(key, vector.slice());
    },
    async retainOnly(keys) {
      const keep = new Set(keys);
      for (const key of map.keys()) if (!keep.has(key)) map.delete(key);
    },
    async clear() {
      map.clear();
    }
  };
}

export interface IndexedDbVectorCacheOptions {
  /** Default: "jsdd-semantic". */
  dbName?: string | undefined;
  /** Default: "dictionaries". */
  storeName?: string | undefined;
}

const DB_VERSION = 2;
const RECORD_KEY = "current";
const OPEN_TIMEOUT_MS = 8000;

interface StoredRecord {
  v: 2;
  dims: number;
  keys: string[];
  matrix: ArrayBuffer;
}

interface Mirror {
  dims: number;
  keys: string[];
  index: Map<string, number>;
  /** Exactly `keys.length × dims` floats (no slack), so its buffer is the record payload. */
  matrix: Float32Array;
}

function emptyMirror(dims: number): Mirror {
  return { dims, keys: [], index: new Map(), matrix: new Float32Array(0) };
}

function parseRecord(value: unknown): Mirror | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Partial<StoredRecord>;
  if (r.v !== 2 || typeof r.dims !== "number" || !Array.isArray(r.keys) || !(r.matrix instanceof ArrayBuffer)) return undefined;
  const dims = Math.floor(r.dims);
  if (dims <= 0 || r.matrix.byteLength !== r.keys.length * dims * 4) return undefined;
  const keys = r.keys.filter((k): k is string => typeof k === "string");
  if (keys.length !== r.keys.length) return undefined;
  const index = new Map<string, number>();
  keys.forEach((k, i) => index.set(k, i));
  return { dims, keys, index, matrix: new Float32Array(r.matrix) };
}

export function createIndexedDbVectorCache(options: IndexedDbVectorCacheOptions = {}): VectorCache {
  const dbName = options.dbName ?? "jsdd-semantic";
  const storeName = options.storeName ?? "dictionaries";
  let dbPromise: Promise<IDBDatabase> | undefined;

  // A failed open stays rejected so later calls fail fast instead of retrying every time.
  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is not available"));
        return;
      }
      const timer = setTimeout(() => reject(new Error("indexedDB.open timed out")), OPEN_TIMEOUT_MS);
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(dbName, DB_VERSION);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        // v1 kept one record per vector in a `vectors` store; drop every old store.
        const names: string[] = [];
        for (let i = 0; i < db.objectStoreNames.length; i += 1) {
          const name = db.objectStoreNames.item(i);
          if (name !== null) names.push(name);
        }
        for (const name of names) db.deleteObjectStore(name);
        db.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = undefined;
        };
        resolve(db);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error ?? new Error("indexedDB.open failed"));
      };
    });
    return dbPromise;
  };

  const transact = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          let result: T | undefined;
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
          const req = run(tx.objectStore(storeName));
          if (req) {
            req.onsuccess = () => {
              result = req.result;
            };
          }
        })
    );

  const readRecord = (): Promise<unknown> => transact<unknown>("readonly", (store) => store.get(RECORD_KEY));
  const writeRecord = (record: StoredRecord): Promise<void> =>
    transact("readwrite", (store) => {
      store.put(record, RECORD_KEY);
      return undefined;
    }).then(() => undefined);
  const deleteRecord = (): Promise<void> =>
    transact("readwrite", (store) => {
      store.delete(RECORD_KEY);
      return undefined;
    }).then(() => undefined);

  // Every database operation runs through one FIFO queue, so reads never observe a write that
  // was requested earlier but has not committed yet, and writes never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  let mirror: Mirror | undefined;
  let mirrorPromise: Promise<void> | undefined;
  const loadMirror = (): Promise<void> => {
    mirrorPromise ??= enqueue(async () => {
      if (!mirror) mirror = parseRecord(await readRecord()) ?? emptyMirror(0);
    }).finally(() => {
      mirrorPromise = undefined;
    });
    return mirrorPromise;
  };
  // Always the CURRENT mirror: callers that shared one load must not act on a stale object
  // (and a `retainOnly` may have dropped it while they waited).
  const withMirror = (): Promise<Mirror> => (mirror ? Promise.resolve(mirror) : loadMirror().then(withMirror));

  // One write per flush: the first putMany after a write schedules the next one; putMany calls
  // arriving before it starts are folded into it (the snapshot is taken when it runs).
  // `retainOnly` asks for the mirror to be dropped afterwards; that happens only once no write
  // is pending, so a putMany that landed on the mirror meanwhile is still persisted by its own
  // write instead of that write finding no mirror.
  let pendingWrite: Promise<void> | undefined;
  let dropRequested = false;
  const dropIfIdle = (): void => {
    if (dropRequested && !pendingWrite) {
      mirror = undefined;
      dropRequested = false;
    }
  };
  const scheduleWrite = (): Promise<void> => {
    pendingWrite ??= enqueue(async () => {
      pendingWrite = undefined;
      const m = mirror;
      if (!m) return;
      if (m.keys.length === 0) {
        await deleteRecord();
        return;
      }
      await writeRecord({ v: 2, dims: m.dims, keys: m.keys.slice(), matrix: m.matrix.buffer as ArrayBuffer });
    }).finally(dropIfIdle);
    return pendingWrite;
  };

  /** Merge `entries` into `m` in place (a different vector length replaces everything). */
  const apply = (m: Mirror, entries: ReadonlyArray<readonly [key: string, vector: Float32Array]>): void => {
    const dims = (entries[entries.length - 1] as readonly [string, Float32Array])[1].length;
    if (m.dims !== dims) {
      m.dims = dims;
      m.keys = [];
      m.index = new Map();
      m.matrix = new Float32Array(0);
    }
    const fresh = new Map<string, Float32Array>();
    const overwrite: Array<[number, Float32Array]> = [];
    for (const [key, v] of entries) {
      if (v.length !== dims || dims === 0) continue;
      const at = m.index.get(key);
      if (at !== undefined) overwrite.push([at, v]);
      else fresh.set(key, v);
    }
    for (const [at, v] of overwrite) m.matrix.set(v, at * dims);
    if (fresh.size > 0) {
      // A new buffer: an in-flight write keeps the old one it captured, consistent with its keys.
      const matrix = new Float32Array((m.keys.length + fresh.size) * dims);
      matrix.set(m.matrix);
      for (const [key, v] of fresh) {
        const row = m.keys.length;
        matrix.set(v, row * dims);
        m.keys.push(key);
        m.index.set(key, row);
      }
      m.matrix = matrix;
    }
  };

  return {
    getMany(keys) {
      const out = new Map<string, Float32Array>();
      if (keys.length === 0) return Promise.resolve(out);
      return withMirror().then((m) => {
        for (const key of keys) {
          const i = m.index.get(key);
          if (i !== undefined) out.set(key, m.matrix.subarray(i * m.dims, (i + 1) * m.dims));
        }
        return out;
      });
    },
    putMany(entries) {
      if (entries.length === 0) return Promise.resolve();
      return withMirror().then((m) => {
        apply(m, entries);
        return scheduleWrite();
      });
    },
    retainOnly(keys) {
      const keep = new Set<string>(keys);
      return withMirror().then((m) => {
        const kept: number[] = [];
        m.keys.forEach((key, i) => {
          if (keep.has(key)) kept.push(i);
        });
        const pruned = kept.length !== m.keys.length;
        if (pruned) {
          const matrix = new Float32Array(kept.length * m.dims);
          const names: string[] = [];
          const index = new Map<string, number>();
          kept.forEach((from, row) => {
            matrix.set(m.matrix.subarray(from * m.dims, (from + 1) * m.dims), row * m.dims);
            const key = m.keys[from] as string;
            names.push(key);
            index.set(key, row);
          });
          m.keys = names;
          m.index = index;
          m.matrix = matrix;
        }
        // Unchanged since the last committed write: nothing to persist.
        const write = pruned || pendingWrite ? scheduleWrite() : Promise.resolve();
        // Release the mirror (the index holds its own copy by then) — but never from under a
        // write that a later putMany scheduled: that write releases it once it has committed.
        return write.finally(() => {
          dropRequested = true;
          dropIfIdle();
        });
      });
    },
    clear() {
      return enqueue(async () => {
        mirror = emptyMirror(0);
        await deleteRecord();
      });
    }
  };
}

let defaultCache: VectorCache | undefined;

/** IndexedDB when available (browsers), otherwise an in-memory cache. Memoized. */
export function createDefaultVectorCache(): VectorCache {
  defaultCache ??= typeof indexedDB !== "undefined" ? createIndexedDbVectorCache() : createMemoryVectorCache();
  return defaultCache;
}
