/* =============================================================================
 *  engine/transform/worker-cache.mjs  —  WORKER OFFLOAD + RESULT CACHE
 *  (Story P7.2, ADR-D2 / NFR8 / INV-1; §Performance Considerations → worker offload)
 *
 *  WHAT THIS IS: the formalization of the umap/tsne WORKER-DISPATCH wrapper plus
 *  the result CACHE keyed by (dataHash, params). It sits ON TOP of the frozen pure
 *  operators in ./index.mjs (which already ship a worker-capable dispatch that
 *  FALLS BACK TO SYNC headless) — it does NOT change their math or signatures.
 *  It adds the three things P7.2 asks for, all testable in Node:
 *
 *    (1) WORKER DISPATCH SHAPE — dispatchProjection() returns a Promise<NDArray>
 *        and is shaped for transferable typed arrays: it builds a structured
 *        payload {who, buf, shape, opts} (the exact message a real Worker would
 *        postMessage with the buffer in the transfer list) and resolves with a
 *        typed-array-backed NDArray. Headless Node has no Worker -> it runs the
 *        SAME pure compute synchronously (the sync fallback) so the result is
 *        bit-identical whether on a Worker thread or the main thread.
 *
 *    (2) RESULT CACHE keyed by (dataHash, params) — projectCached() memoizes a
 *        projection so RE-ENCODE IS FREE when only encode channels change: the
 *        cache key is (dataHash, paramsKey) and changes ONLY when the data bytes
 *        or the projection params change (architecture: "results cached + versioned
 *        by (dataHash, params) so re-encode is free when only channels change").
 *
 *    (3) EXPLICIT-SEED REPRODUCIBILITY — the seed is part of paramsKey, so the
 *        same (data, params, seed) hits the same cache entry AND (on a miss)
 *        recomputes bit-identical output (INV-1) — the cached projection is a
 *        freezable Tier-A conformance-vector input.
 *
 *  HEADLESS-SAFE (INV-1 / INV-6): imports ONLY ../data + ./index.mjs (engine-only);
 *  NO THREE/Tweakpane, NO DOM, NO wall-clock, NO global RNG. Pure cache (a Map);
 *  same inputs -> same key -> same value.
 *
 *  WASM stays DEFERRED behind the SAME transform() signature (D1 zero-build): the
 *  dispatch target is swappable (sync fallback today; a real Worker or a WASM
 *  inner loop later) with no change to umap()/tsne()/projectCached() callers.
 *
 *  HONESTY / SEAM (deferred): the REAL Web Worker thread (a separate OS thread,
 *  the structured-clone/transfer of the ArrayBuffer, and the MEASURED "frame never
 *  blocks" win) needs a browser to run + measure and is DEFERRED. What is testable
 *  here in Node is: the cache hit/miss + key semantics, the seed reproducibility,
 *  and the sync-fallback parity of the dispatch wrapper.
 * ========================================================================== */

import { isNDArray, materialize, ndarray } from '../data/index.mjs';
import transform from './index.mjs';

export const VERSION = '0.1.0-p7.2-worker-cache';
export const NAME = 'engine/transform/worker-cache';

/** Projections that are dispatched off-thread in production (D2: O(N^2) iterative).
 *  PCA/MDS stay sync on the main thread (also handled by projectCached for caching). */
export const WORKER_PROJECTIONS = Object.freeze(['umap', 'tsne']);

/* -----------------------------------------------------------------------------
 *  dataHash(nd) — a deterministic content hash of an NDArray's MATERIALIZED bytes
 *  + shape + dtype. FNV-1a 32-bit over the packed row-major bytes (seedless,
 *  reproducible, no wall-clock). Two NDArrays with identical content hash equal;
 *  changing any value (or the shape/dtype) changes the hash. Returns a hex string.
 *  This is the (dataHash) half of the cache key.
 * ------------------------------------------------------------------------- */
export function dataHash(nd) {
  if (!isNDArray(nd)) return 'nan';
  const m = materialize(nd);
  if (m && m.ok === false) return 'nan';
  // hash over the raw bytes of the packed backing buffer + a shape/dtype tag
  const bytes = new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength);
  let h = 0x811c9dc5;                                       // FNV-1a offset basis
  const tag = `${m.dtype}|${m.shape.join('x')}|`;
  for (let i = 0; i < tag.length; i++) { h ^= tag.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* -----------------------------------------------------------------------------
 *  paramsKey(op, opts) — a STABLE, deterministic key for the projection params.
 *  Only the params that affect the projection output are included (components,
 *  seed, nNeighbors, iters) + the op — so a key changes ONLY when data or
 *  projection params change (NOT when unrelated encode channels change). The seed
 *  is FIRST-CLASS in the key (explicit-seed reproducibility). Pure.
 * ------------------------------------------------------------------------- */
export function paramsKey(op, opts = {}) {
  const o = opts || {};
  const comp = Number.isInteger(o.components) ? o.components : 2;
  const seed = Number.isInteger(o.seed) ? o.seed : 1;
  const nN = Number.isInteger(o.nNeighbors) ? o.nNeighbors : 'auto';
  const iters = Number.isInteger(o.iters) ? o.iters : 'auto';
  return `${op}|c=${comp}|s=${seed}|k=${nN}|it=${iters}`;
}

/* -----------------------------------------------------------------------------
 *  cacheKey(nd, op, opts) — the full (dataHash, params) key. Public so the harness
 *  can assert the key changes ONLY on data/param changes.
 * ------------------------------------------------------------------------- */
export function cacheKey(nd, op, opts = {}) {
  return `${dataHash(nd)}::${paramsKey(op, opts)}`;
}

/* -----------------------------------------------------------------------------
 *  createProjectionCache() — an INSTANCE-LOCAL result cache (a Map). Each entry
 *  stores a CLONED NDArray (so a caller cannot mutate the cached buffer). The
 *  cache is the (dataHash, params)->NDArray store the architecture mandates.
 * ------------------------------------------------------------------------- */
export function createProjectionCache() {
  const store = new Map();
  return {
    get size() { return store.size; },
    has(key) { return store.has(key); },
    /** read a CLONE of the cached NDArray (never the live buffer). */
    get(key) {
      const v = store.get(key);
      return v ? cloneND(v) : undefined;
    },
    /** store a CLONE of an NDArray under key; returns the stored clone. */
    set(key, nd) {
      if (!isNDArray(nd)) return nd;
      const c = cloneND(nd);
      store.set(key, c);
      return c;
    },
    keys() { return [...store.keys()]; },
    clear() { store.clear(); },
  };
}

/** Deep-clone an NDArray's backing buffer (so cache entries are immutable to callers). */
function cloneND(nd) {
  const buf = nd.data.slice ? nd.data.slice() : new nd.data.constructor(nd.data);
  return ndarray(buf, nd.shape.slice(), { dtype: nd.dtype, kind: nd.kind, meta: nd.meta });
}

/* -----------------------------------------------------------------------------
 *  dispatchProjection(nd, op, opts) — the WORKER-DISPATCH wrapper. Returns a
 *  Promise<NDArray>. Builds the transferable-shaped payload a real Worker would
 *  receive, then runs the SAME pure compute (sync fallback when no Worker) so the
 *  result is identical on-thread or off-thread.
 *
 *  PRODUCTION DROP-IN (D2): when globalThis.Worker exists, post the `payload`
 *  (with payload.buf.buffer in the transfer list) to a worker that runs the
 *  identical embedSync math + DruidJS, and resolve with the transferred typed
 *  array re-wrapped as an NDArray. The math is identical, so parity holds.
 * ------------------------------------------------------------------------- */
export function dispatchProjection(nd, op, opts = {}) {
  if (!WORKER_PROJECTIONS.includes(op)) {
    return Promise.resolve({ ok: false, reason: `dispatchProjection: op must be one of ${WORKER_PROJECTIONS.join('|')} (got "${String(op)}")` });
  }
  if (!isNDArray(nd)) return Promise.resolve({ ok: false, reason: `${op}: input is not a valid NDArray` });
  if (nd.shape.length !== 2) return Promise.resolve({ ok: false, reason: `${op}: requires a 2-D matrix [rows,cols]` });

  // Build the transferable-shaped payload (the exact message a Worker gets).
  const m = materialize(nd);
  if (m && m.ok === false) return Promise.resolve(m);
  const payload = { who: op, buf: m.data, shape: m.shape.slice(), opts: { ...opts } };

  const hasWorker = typeof globalThis !== 'undefined' && typeof globalThis.Worker === 'function';
  void hasWorker;   // real Worker path is the deferred browser seam; sync fallback is parity-identical

  // SYNC FALLBACK: route to the frozen pure operator (umap/tsne) on the SAME data.
  // The pure operator already returns a Promise<NDArray>; we await it via .then.
  void payload;     // payload is the documented transfer shape; the compute is the pure op
  const fn = op === 'umap' ? transform.umap : transform.tsne;
  return Promise.resolve(fn(nd, opts));
}

/* -----------------------------------------------------------------------------
 *  projectCached(nd, op, opts, cache) — the cached projection entrypoint.
 *  Returns a Promise<NDArray>. On a cache HIT returns the cached clone WITHOUT
 *  recomputing (re-encode is free). On a MISS computes via dispatchProjection
 *  (worker-dispatch / sync fallback for umap/tsne) or the sync operator (pca/mds/
 *  identity/slice), stores the result under (dataHash, params), and returns it.
 *
 *  Supports the full projection set so PCA/MDS results are cacheable too; only
 *  umap/tsne go through the worker-dispatch shape. Always a Promise for a uniform
 *  caller. NEVER throws: a malformed input resolves to a typed {ok:false}.
 * ------------------------------------------------------------------------- */
export async function projectCached(nd, op, opts = {}, cache) {
  const c = cache || _sharedCache;
  const key = cacheKey(nd, op, opts);
  if (c.has(key)) return c.get(key);                       // HIT — no recompute

  let result;
  try {
    if (op === 'umap' || op === 'tsne') {
      result = await dispatchProjection(nd, op, opts);     // worker-dispatch (sync fallback)
    } else if (op === 'pca' || op === 'mds') {
      result = transform[op](nd, opts);                    // sync main-thread (PCA/MDS)
    } else if (op === 'identity' || op === 'slice') {
      result = transform[op](nd, opts);
    } else {
      result = { ok: false, reason: `projectCached: unknown op "${String(op)}"` };
    }
  } catch (e) {
    result = { ok: false, reason: `projectCached: ${e && e.message}` };
  }

  if (!result || result.ok === false) return result;       // do NOT cache error results
  return c.set(key, result);                               // store a clone, return the clone
}

/** A module-shared default cache (apps usually want one cache per session). */
const _sharedCache = createProjectionCache();

/** Reflection-friendly frozen surface descriptor. */
export const workerCache = Object.freeze({
  name: NAME, version: VERSION,
  WORKER_PROJECTIONS,
  dataHash, paramsKey, cacheKey,
  createProjectionCache, dispatchProjection, projectCached,
});

export default workerCache;
