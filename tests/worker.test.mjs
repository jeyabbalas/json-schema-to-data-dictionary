import test from "node:test";
import assert from "node:assert/strict";
import { createFakeEmbedder } from "./_fakeEmbedder.mjs";

const { serveEmbedder, createWorkerEmbedder } = await import("../dist/index.js");

/** An embedder whose identity is only final after load() (like the Transformers.js adapter). */
function resolvingEmbedder() {
  const state = { dtype: "auto", device: undefined, loads: 0 };
  return {
    state,
    get id() {
      return `fake:${state.dtype}`;
    },
    spaceId: "fake-space",
    minScore: 0.3,
    get info() {
      return { model: "fake", device: state.device, dtype: state.device ? state.dtype : undefined, pooling: "mean", dims: 4, maxLength: 256, license: "MIT" };
    },
    async load(onProgress) {
      state.loads += 1;
      onProgress?.(0.5);
      state.dtype = "q8";
      state.device = "wasm";
      onProgress?.(1);
    },
    async embed(texts) {
      return texts.map((t) => new Float32Array([t.length, 1, 0, 0]));
    }
  };
}

test("worker proxy: id/spaceId/info refresh after load() over a MessageChannel", async () => {
  const served = resolvingEmbedder();
  const { port1, port2 } = new MessageChannel();
  const stop = serveEmbedder(served, port1);
  try {
    const remote = await createWorkerEmbedder(port2);
    assert.equal(remote.id, "fake:auto", "before load: the unresolved identity");
    assert.equal(remote.spaceId, "fake-space");
    assert.equal(remote.minScore, 0.3);
    assert.deepEqual(remote.info, { model: "fake", device: undefined, dtype: undefined, pooling: "mean", dims: 4, maxLength: 256, license: "MIT" });

    const progress = [];
    await Promise.all([remote.load((p) => progress.push(p)), remote.load()]);
    assert.deepEqual(progress, [0.5, 1]);
    assert.equal(served.state.loads, 1, "load is forwarded once");
    assert.equal(remote.id, "fake:q8", "after load: the resolved identity");
    assert.equal(remote.spaceId, "fake-space");
    assert.deepEqual(remote.info, served.info);
    assert.deepEqual(remote.info, { model: "fake", device: "wasm", dtype: "q8", pooling: "mean", dims: 4, maxLength: 256, license: "MIT" });

    const [a, b] = await remote.embed(["abc", "de"], "document");
    assert.deepEqual([...a], [3, 1, 0, 0]);
    assert.deepEqual([...b], [2, 1, 0, 0]);
    await remote.dispose();
  } finally {
    stop();
    port1.close();
  }
});

test("worker proxy: the plain fake embedder round-trips, errors propagate, no spaceId/info when absent", async () => {
  const fake = createFakeEmbedder({ minScore: 0.42, failOn: "boom" });
  const { port1, port2 } = new MessageChannel();
  const stop = serveEmbedder(fake, port1);
  try {
    const remote = await createWorkerEmbedder(port2);
    assert.equal(remote.id, fake.id);
    assert.equal(remote.spaceId, undefined);
    assert.equal(remote.info, undefined);
    assert.equal(remote.minScore, 0.42);
    await remote.load();
    assert.equal(remote.id, fake.id, "unchanged identity stays");
    const [v] = await remote.embed(["tobacco use"], "document");
    const [expected] = await fake.embed(["tobacco use"], "document");
    assert.deepEqual([...v], [...expected]);
    await assert.rejects(remote.embed(["boom"], "query"), /fail: boom/);
    await remote.dispose();
  } finally {
    stop();
    port1.close();
  }
});

test("protocol compatibility: an old-style server (no identity fields) and an old-style client", async () => {
  // Old server: `described` without spaceId/info, `done` without identity.
  const oldServer = new MessageChannel();
  oldServer.port1.addEventListener("message", (event) => {
    const req = event.data;
    if (req?.jsdd !== 1) return;
    if (req.t === "describe") oldServer.port1.postMessage({ jsdd: 1, id: req.id, t: "described", embedderId: "old:v1", minScore: 0.2 });
    else if (req.t === "load") oldServer.port1.postMessage({ jsdd: 1, id: req.id, t: "done" });
    else if (req.t === "dispose") oldServer.port1.postMessage({ jsdd: 1, id: req.id, t: "done" });
  });
  oldServer.port1.start();
  const remote = await createWorkerEmbedder(oldServer.port2);
  assert.equal(remote.id, "old:v1");
  assert.equal(remote.spaceId, undefined);
  assert.equal(remote.info, undefined);
  await remote.load();
  assert.equal(remote.id, "old:v1", "a done reply without identity keeps the id");
  await remote.dispose();
  oldServer.port1.close();

  // Old client: sends describe/load and reads only the fields it knows; extra fields are additive.
  const served = resolvingEmbedder();
  const { port1, port2 } = new MessageChannel();
  const stop = serveEmbedder(served, port1);
  try {
    const replies = [];
    const request = (body) => new Promise((resolve) => {
      const id = replies.length + 1;
      const onMessage = (event) => {
        if (event.data?.id !== id || event.data.t === "progress") return;
        port2.removeEventListener("message", onMessage);
        replies.push(event.data);
        resolve(event.data);
      };
      port2.addEventListener("message", onMessage);
      port2.start();
      port2.postMessage({ jsdd: 1, id, ...body });
    });
    const described = await request({ t: "describe" });
    assert.equal(described.t, "described");
    assert.equal(described.embedderId, "fake:auto");
    assert.equal(described.minScore, 0.3);
    assert.equal(described.spaceId, "fake-space");
    assert.equal(described.info.model, "fake");
    const done = await request({ t: "load" });
    assert.equal(done.t, "done");
    assert.equal(done.embedderId, "fake:q8");
    assert.equal(done.spaceId, "fake-space");
    assert.equal(done.info.dtype, "q8");
  } finally {
    stop();
    port1.close();
    port2.close();
  }
});
