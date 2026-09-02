// Vector caches. Keys are content hashes (embedder id + template version + text hash), so
// nothing ever needs explicit invalidation: a changed description or a different model simply
// misses. Values are bare Float32Arrays — no schema text is persisted.

import type { VectorCache } from "./types";
import { cyrb53 } from "./hash";
import { EMBED_TEXT_VERSION } from "./text";

export function cacheKey(embedderId: string, text: string): string {
  return `${embedderId}|v${EMBED_TEXT_VERSION}|${cyrb53(text)}:${text.length}`;
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
    async clear() {
      map.clear();
    }
  };
}

export interface IndexedDbVectorCacheOptions {
  /** Default: "jsdd-semantic". */
  dbName?: string | undefined;
  /** Default: "vectors". */
  storeName?: string | undefined;
}

const OPEN_TIMEOUT_MS = 8000;

export function createIndexedDbVectorCache(options: IndexedDbVectorCacheOptions = {}): VectorCache {
  const dbName = options.dbName ?? "jsdd-semantic";
  const storeName = options.storeName ?? "vectors";
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
        req = indexedDB.open(dbName, 1);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
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

  const transact = (mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void> =>
    open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
          run(tx.objectStore(storeName));
        })
    );

  return {
    getMany(keys) {
      const out = new Map<string, Float32Array>();
      if (keys.length === 0) return Promise.resolve(out);
      return transact("readonly", (store) => {
        for (const key of keys) {
          const req = store.get(key);
          req.onsuccess = () => {
            const value: unknown = req.result;
            if (value instanceof Float32Array) out.set(key, value);
          };
        }
      }).then(() => out);
    },
    putMany(entries) {
      if (entries.length === 0) return Promise.resolve();
      // slice(): structured clone of a view would copy its whole underlying buffer.
      return transact("readwrite", (store) => {
        for (const [key, vector] of entries) store.put(vector.slice(), key);
      });
    },
    clear() {
      return transact("readwrite", (store) => {
        store.clear();
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
