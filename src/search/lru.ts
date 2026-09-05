// A tiny least-recently-used map. `Map` keeps insertion order, so re-inserting a key on
// access makes the first entry the coldest one. Used for query vectors (64) and search results (32).

export interface Lru<K, V> {
  readonly size: number;
  readonly capacity: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
}

export function createLru<K, V>(capacity: number): Lru<K, V> {
  const cap = Math.max(1, Math.floor(capacity));
  const map = new Map<K, V>();
  return {
    get size() {
      return map.size;
    },
    capacity: cap,
    get(key) {
      const value = map.get(key);
      if (value === undefined && !map.has(key)) return undefined;
      map.delete(key);
      map.set(key, value as V);
      return value;
    },
    has(key) {
      return map.has(key);
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > cap) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}
