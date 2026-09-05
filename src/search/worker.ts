// A tiny postMessage RPC so an Embedder can live in a Web Worker (or any MessagePort).
// `serveEmbedder` runs on the worker side, `createWorkerEmbedder` on the main thread.
// Vectors cross the boundary as one transferred ArrayBuffer per embed() call.
//
// The protocol is additive: `described` and the `load` → `done` reply may carry `spaceId` and
// `info` (and `done` the final `embedderId`), because an embedder's identity is only final
// after `load()` resolves its runtime. The proxy refreshes its `id`/`spaceId`/`info` from that
// reply; peers built against the older protocol simply leave them undefined.

import type { EmbedKind, Embedder, EmbedderInfo } from "./types";

/** Structural port type satisfied by Worker, MessagePort and a worker's global scope. */
export interface EmbedderPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** MessagePort needs start() when messages are consumed via addEventListener. */
  start?(): void;
  close?(): void;
}

type RequestBody =
  | { t: "describe" }
  | { t: "load" }
  | { t: "embed"; texts: string[]; kind: EmbedKind }
  | { t: "dispose" };
type Request = RequestBody & { jsdd: 1; id: number };

interface Identity {
  embedderId?: string;
  spaceId?: string;
  info?: EmbedderInfo;
}

type Response =
  | ({ jsdd: 1; id: number; t: "described"; embedderId: string; minScore?: number } & Identity)
  | { jsdd: 1; id: number; t: "progress"; fraction: number }
  | ({ jsdd: 1; id: number; t: "done" } & Identity)
  | { jsdd: 1; id: number; t: "vectors"; buffer: ArrayBuffer; dims: number; count: number }
  | { jsdd: 1; id: number; t: "error"; message: string };

function isEnvelope(value: unknown): value is { jsdd: 1; id: number; t: string } {
  return typeof value === "object" && value !== null && (value as { jsdd?: unknown }).jsdd === 1;
}

/** The embedder's current identity, as plain data (structured-cloneable). */
function identityOf(embedder: Embedder): Identity {
  return {
    embedderId: embedder.id,
    ...(embedder.spaceId !== undefined ? { spaceId: embedder.spaceId } : {}),
    ...(embedder.info !== undefined ? { info: { ...embedder.info } } : {})
  };
}

/**
 * Serve an embedder over a port (default: the worker's own global scope). Attaches its
 * listener synchronously, so call it at the top level of the worker script. Returns a
 * function that detaches it.
 */
export function serveEmbedder(embedder: Embedder, port: EmbedderPort = globalThis as unknown as EmbedderPort): () => void {
  const reply = (message: Response, transfer?: Transferable[]): void => {
    if (transfer) port.postMessage(message, transfer);
    else port.postMessage(message);
  };

  const handle = async (req: Request): Promise<void> => {
    const id = req.id;
    switch (req.t) {
      case "describe":
        reply({
          jsdd: 1,
          id,
          t: "described",
          ...identityOf(embedder),
          embedderId: embedder.id,
          ...(embedder.minScore !== undefined ? { minScore: embedder.minScore } : {})
        });
        return;
      case "load":
        if (embedder.load) await embedder.load((fraction) => reply({ jsdd: 1, id, t: "progress", fraction }));
        // Identity may have changed while loading (resolved device/dtype): send it along.
        reply({ jsdd: 1, id, t: "done", ...identityOf(embedder) });
        return;
      case "embed": {
        const vectors = await embedder.embed(req.texts, req.kind);
        const dims = vectors[0]?.length ?? 0;
        const packed = new Float32Array(vectors.length * dims);
        vectors.forEach((v, i) => {
          if (v.length !== dims) throw new Error("Embedder returned vectors of different lengths");
          packed.set(v, i * dims);
        });
        reply({ jsdd: 1, id, t: "vectors", buffer: packed.buffer, dims, count: vectors.length }, [packed.buffer]);
        return;
      }
      case "dispose":
        await embedder.dispose?.();
        reply({ jsdd: 1, id, t: "done" });
        return;
      default:
        throw new Error(`Unknown request ${(req as { t: string }).t}`);
    }
  };

  const onMessage = (event: Event): void => {
    const data: unknown = (event as MessageEvent).data;
    if (!isEnvelope(data)) return;
    const req = data as Request;
    handle(req).catch((err: unknown) => reply({ jsdd: 1, id: req.id, t: "error", message: err instanceof Error ? err.message : String(err) }));
  };

  port.addEventListener("message", onMessage);
  port.start?.();
  return () => port.removeEventListener("message", onMessage);
}

interface Pending {
  resolve: (value: Response) => void;
  reject: (err: Error) => void;
  onProgress?: ((fraction: number) => void) | undefined;
}

/**
 * Create an Embedder that forwards to one served by `serveEmbedder` on the other side of
 * `port` (a Worker or MessagePort). Resolves once the remote embedder has described itself.
 * `id`, `spaceId` and `info` refresh after `load()` (the remote runtime resolves then).
 * `dispose()` disposes the remote embedder and closes a MessagePort; it never terminates a
 * Worker — the caller owns it.
 */
export async function createWorkerEmbedder(port: EmbedderPort): Promise<Embedder> {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const onMessage = (event: Event): void => {
    const data: unknown = (event as MessageEvent).data;
    if (!isEnvelope(data)) return;
    const res = data as Response;
    const p = pending.get(res.id);
    if (!p) return;
    if (res.t === "progress") {
      p.onProgress?.(res.fraction);
      return;
    }
    pending.delete(res.id);
    if (res.t === "error") p.reject(new Error(res.message));
    else p.resolve(res);
  };
  const onError = (event: Event): void => {
    const message = (event as ErrorEvent).message || "Worker error";
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };

  const request = (req: RequestBody, onProgress?: (fraction: number) => void): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      port.postMessage({ jsdd: 1, id, ...req });
    });

  port.addEventListener("message", onMessage);
  port.addEventListener("error", onError);
  port.start?.();

  const described = await request({ t: "describe" });
  if (described.t !== "described") throw new Error("Unexpected reply from embedder worker");

  const remote: { id: string; spaceId: string | undefined; info: EmbedderInfo | undefined } = {
    id: described.embedderId,
    spaceId: described.spaceId,
    info: described.info
  };
  const refresh = (identity: Identity): void => {
    if (typeof identity.embedderId === "string") remote.id = identity.embedderId;
    if (typeof identity.spaceId === "string") remote.spaceId = identity.spaceId;
    if (identity.info && typeof identity.info === "object") remote.info = identity.info;
  };

  const progressListeners = new Set<(fraction: number) => void>();
  let loading: Promise<void> | undefined;

  const embedder: Embedder = {
    get id() {
      return remote.id;
    },
    get spaceId() {
      return remote.spaceId;
    },
    get info() {
      return remote.info;
    },
    ...(described.minScore !== undefined ? { minScore: described.minScore } : {}),
    load(onProgress) {
      if (onProgress) progressListeners.add(onProgress);
      loading ??= request({ t: "load" }, (fraction) => {
        for (const listener of progressListeners) listener(fraction);
      }).then(
        (res) => {
          if (res.t === "done") refresh(res);
          progressListeners.clear();
        },
        (err: unknown) => {
          progressListeners.clear();
          loading = undefined;
          throw err;
        }
      );
      return loading;
    },
    async embed(texts, kind) {
      const res = await request({ t: "embed", texts: [...texts], kind });
      if (res.t !== "vectors") throw new Error("Unexpected reply from embedder worker");
      const all = new Float32Array(res.buffer);
      const out: Float32Array[] = [];
      for (let i = 0; i < res.count; i += 1) out.push(all.slice(i * res.dims, (i + 1) * res.dims));
      return out;
    },
    async dispose() {
      try {
        await request({ t: "dispose" });
      } finally {
        port.removeEventListener("message", onMessage);
        port.removeEventListener("error", onError);
        port.close?.();
      }
    }
  };
  return embedder;
}
