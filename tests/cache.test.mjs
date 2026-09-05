import test from "node:test";
import assert from "node:assert/strict";

// fake-indexeddb provides a pure-JS IndexedDB (skipped if absent).
let fakeIdb = false;
try {
  await import("fake-indexeddb/auto");
  fakeIdb = true;
} catch {
  fakeIdb = false;
}
const skip = fakeIdb ? false : "fake-indexeddb not installed";

const { createIndexedDbVectorCache, createMemoryVectorCache, cacheKey, textKey, EMBED_TEXT_VERSION } = await import("../dist/index.js");

let n = 0;
const freshDbName = () => `jsdd-cache-test-${Date.now()}-${n++}`;

/** Open `dbName` at its current version (or `version`, running `upgrade`) and run `fn(db)`. */
function withDb(dbName, fn, { version, upgrade } = {}) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => {
      const db = req.result;
      Promise.resolve()
        .then(() => fn(db))
        .then((v) => { db.close(); resolve(v); }, (e) => { db.close(); reject(e); });
    };
    req.onerror = () => reject(req.error);
  });
}

/** Store names, DB version and the `current` record of the `dictionaries` store (if any). */
function inspect(dbName) {
  return withDb(dbName, (db) => new Promise((resolve, reject) => {
    const stores = [...db.objectStoreNames];
    if (!stores.includes("dictionaries")) { resolve({ version: db.version, stores, record: undefined, count: 0 }); return; }
    const store = db.transaction("dictionaries").objectStore("dictionaries");
    const get = store.get("current");
    const count = store.count();
    count.onsuccess = () => resolve({ version: db.version, stores, record: get.result, count: count.result });
    count.onerror = () => reject(count.error);
  }));
}

function countPuts(fn) {
  const proto = IDBObjectStore.prototype;
  const original = proto.put;
  let puts = 0;
  proto.put = function (...args) { puts += 1; return original.apply(this, args); };
  return Promise.resolve().then(fn).then(
    (v) => { proto.put = original; return { value: v, puts }; },
    (e) => { proto.put = original; throw e; }
  );
}

test("textKey is the content key inside cacheKey", () => {
  assert.match(textKey("abc"), /^[0-9a-z]+:3$/);
  assert.equal(cacheKey("space", "abc"), `space|v${EMBED_TEXT_VERSION}|${textKey("abc")}`);
  assert.notEqual(textKey("abc"), textKey("abd"));
});

test("IndexedDB v2: one blob record per database; a fresh instance reads it back", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  const big = new Float32Array([9, 9, 4, 5, 6, 7, 9]);
  await cache.putMany([
    ["a", new Float32Array([1, 2, 3, 4])],
    ["view", big.subarray(2, 6)]
  ]);

  const { version, stores, record, count } = await inspect(dbName);
  assert.equal(version, 2);
  assert.deepEqual(stores, ["dictionaries"]);
  assert.equal(count, 1, "exactly one record");
  assert.equal(record.v, 2);
  assert.equal(record.dims, 4);
  assert.deepEqual(record.keys, ["a", "view"]);
  assert.ok(record.matrix instanceof ArrayBuffer);
  assert.equal(record.matrix.byteLength, 2 * 4 * 4);
  assert.deepEqual([...new Float32Array(record.matrix)], [1, 2, 3, 4, 4, 5, 6, 7]);

  const again = createIndexedDbVectorCache({ dbName });
  const got = await again.getMany(["a", "view", "missing"]);
  assert.deepEqual([...got.get("a")], [1, 2, 3, 4]);
  assert.deepEqual([...got.get("view")], [4, 5, 6, 7], "a view is stored as its own vector");
  assert.equal(got.has("missing"), false);
  assert.equal(got.get("a").length, 4);
  assert.equal((await again.getMany([])).size, 0);
});

test("IndexedDB v2: concurrent putMany calls coalesce into one write", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  const { puts } = await countPuts(() =>
    Promise.all([
      cache.putMany([["a", new Float32Array([1, 1])]]),
      cache.putMany([["b", new Float32Array([2, 2])], ["c", new Float32Array([3, 3])]]),
      cache.putMany([["a", new Float32Array([9, 9])]])
    ])
  );
  assert.equal(puts, 1, "three putMany calls, one record write");
  const { record, count } = await inspect(dbName);
  assert.equal(count, 1);
  assert.deepEqual(record.keys, ["a", "b", "c"]);
  assert.deepEqual([...new Float32Array(record.matrix)], [9, 9, 2, 2, 3, 3], "the later value of a re-put key wins");

  const second = await countPuts(() => cache.putMany([["d", new Float32Array([4, 4])]]));
  assert.equal(second.puts, 1, "a later flush is its own write");
  assert.deepEqual((await inspect(dbName)).record.keys, ["a", "b", "c", "d"]);
});

test("IndexedDB v2: retainOnly prunes the record, drops the mirror, and skips no-op writes", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  await cache.putMany([["a", new Float32Array([1, 0])], ["b", new Float32Array([0, 1])], ["c", new Float32Array([1, 1])]]);

  const pruned = await countPuts(() => cache.retainOnly(["c", "a", "missing"]));
  assert.equal(pruned.puts, 1);
  const { record } = await inspect(dbName);
  assert.deepEqual(record.keys, ["a", "c"], "kept in stored order");
  assert.deepEqual([...new Float32Array(record.matrix)], [1, 0, 1, 1]);

  const got = await cache.getMany(["a", "b", "c"]);
  assert.deepEqual([...got.keys()], ["a", "c"], "reloaded from IndexedDB after the mirror was dropped");
  assert.deepEqual([...got.get("c")], [1, 1]);

  const noop = await countPuts(() => cache.retainOnly(["a", "c"]));
  assert.equal(noop.puts, 0, "nothing pruned and nothing pending: no write");

  await cache.retainOnly([]);
  assert.equal((await inspect(dbName)).count, 0, "retaining nothing deletes the record");
});

test("IndexedDB v2: clear deletes the record and the cache keeps working", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  await cache.putMany([["a", new Float32Array([1, 2])]]);
  await cache.clear();
  assert.equal((await inspect(dbName)).count, 0);
  assert.equal((await cache.getMany(["a"])).size, 0);
  await cache.putMany([["b", new Float32Array([3, 4])]]);
  assert.deepEqual((await inspect(dbName)).record.keys, ["b"]);
  assert.deepEqual([...(await createIndexedDbVectorCache({ dbName }).getMany(["b"])).get("b")], [3, 4]);
});

test("IndexedDB v2: vectors of another length replace the record", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  await cache.putMany([["a", new Float32Array([1, 2, 3, 4])], ["b", new Float32Array([5, 6, 7, 8])]]);
  await cache.putMany([["c", new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])]]);
  const { record, count } = await inspect(dbName);
  assert.equal(count, 1);
  assert.equal(record.dims, 8);
  assert.deepEqual(record.keys, ["c"]);
  const got = await cache.getMany(["a", "b", "c"]);
  assert.deepEqual([...got.keys()], ["c"]);

  // Mixed lengths in one call: the newest length wins, other entries are dropped.
  await cache.putMany([["d", new Float32Array([1, 1])], ["e", new Float32Array([2, 2, 2])]]);
  const mixed = (await inspect(dbName)).record;
  assert.equal(mixed.dims, 3);
  assert.deepEqual(mixed.keys, ["e"]);
});

test("IndexedDB v1 -> v2 migration deletes the per-vector `vectors` store", { skip }, async () => {
  const dbName = freshDbName();
  await withDb(dbName, (db) => new Promise((resolve, reject) => {
    const tx = db.transaction("vectors", "readwrite");
    tx.objectStore("vectors").put(new Float32Array([1, 2, 3]), "old-key");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }), { version: 1, upgrade: (db) => db.createObjectStore("vectors") });
  assert.deepEqual((await inspect(dbName)).stores, ["vectors"]);

  const cache = createIndexedDbVectorCache({ dbName });
  assert.equal((await cache.getMany(["old-key"])).size, 0, "v1 vectors are gone (they used the v1 text template)");
  const { version, stores, count } = await inspect(dbName);
  assert.equal(version, 2);
  assert.deepEqual(stores, ["dictionaries"]);
  assert.equal(count, 0);
  await cache.putMany([["k", new Float32Array([1])]]);
  assert.deepEqual((await inspect(dbName)).record.keys, ["k"]);
});

test("IndexedDB v2: malformed records are ignored and overwritten", { skip }, async () => {
  const dbName = freshDbName();
  const cache = createIndexedDbVectorCache({ dbName });
  await cache.putMany([["a", new Float32Array([1, 2])]]);
  await withDb(dbName, (db) => new Promise((resolve, reject) => {
    const tx = db.transaction("dictionaries", "readwrite");
    tx.objectStore("dictionaries").put({ v: 2, dims: 2, keys: ["a", "b"], matrix: new ArrayBuffer(4) }, "current");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
  const fresh = createIndexedDbVectorCache({ dbName });
  assert.equal((await fresh.getMany(["a", "b"])).size, 0, "a record whose matrix does not match keys × dims is ignored");
  await fresh.putMany([["c", new Float32Array([3, 3])]]);
  assert.deepEqual((await inspect(dbName)).record.keys, ["c"]);
});

test("memory cache: retainOnly and clear", async () => {
  const cache = createMemoryVectorCache();
  await cache.putMany([["a", new Float32Array([1])], ["b", new Float32Array([2])]]);
  await cache.retainOnly(["b", "missing"]);
  assert.deepEqual([...(await cache.getMany(["a", "b"])).keys()], ["b"]);
  await cache.clear();
  assert.equal((await cache.getMany(["b"])).size, 0);
});
