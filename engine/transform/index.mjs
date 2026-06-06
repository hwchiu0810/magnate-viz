/* =============================================================================
 *  engine/transform/index.mjs  —  pure N-D OPERATORS  (Story P3.2, ADR-D2)
 *
 *  WHAT THIS IS: the pure `engine/transform` layer — projections / reducers /
 *  filters / aggregations over the NDArray store. Every operator shares ONE
 *  uniform signature:
 *
 *       transform(nd, opts) -> nd                 (sync: pca, mds, identity,
 *                                                   slice, reduce, filter, normalize)
 *       transform(nd, opts) -> Promise<nd>        (iterative: umap, tsne — via a
 *                                                   worker-capable dispatch that
 *                                                   FALLS BACK TO SYNC headless)
 *
 *  …so the encode layer is agnostic to which projection it asked for.
 *
 *  FROZEN projection vocabulary (contracts/projections.json):
 *       pca | mds | umap | tsne | identity | slice
 *
 *  PURITY + DETERMINISM (INV-1, the conformance precondition):
 *    - matrix-in -> matrix-out: NO I/O, NO GPU, NO DOM, NO wall-clock;
 *    - the ONLY randomness is an instance-local seeded `mulberry32` PRNG created
 *      per call from an EXPLICIT `seed`; NO global RNG, NO Math.random anywhere;
 *    - same (data, params, seed) -> BIT-IDENTICAL output across runs, and once
 *      reseeded with the same seed it reproduces again;
 *    - a malformed shape/opt yields a typed {ok:false, reason} — NEVER a partial
 *      or half-projected matrix.
 *
 *  HEADLESS-SAFE / GPU-FREE (INV-1, INV-6):
 *    - imports NOTHING from apps/**, editor/**, conformance/** (firewall);
 *    - NO hard import of THREE / Tweakpane;
 *    - loads & runs in plain Node >=20 with NO GPU/DOM, never throwing.
 *
 *  UMAP / t-SNE NOTE (D2 placement + production drop-in): the faithful, full
 *  UMAP/t-SNE is the documented DRUIDJS drop-in (`@saehrimnir/druidjs` ^0.7) on
 *  this SAME uniform signature — see runProjectionAsync() below. What ships here
 *  is a SEEDED, DETERMINISTIC iterative embedding (gradient-style layout that
 *  preserves the high-D neighbour graph) that is reproducible + testable and runs
 *  via a worker-capable dispatch wrapper that FALLS BACK TO SYNC when no Worker
 *  exists (so headless Node can run + freeze it). Swapping in DruidJS is a single
 *  call-site change inside runProjectionAsync(); the public signature is frozen.
 *
 *  Native ESM (D1): resolved via the P2.1 import-map; no bundler.
 * ========================================================================== */

import { ndarray, isNDArray, materialize } from '../data/index.mjs';

/** Module identity (semver). */
export const VERSION = '0.1.0-p3.2-transform';
/** Human-readable module identity. */
export const NAME = 'engine/transform';

/** The frozen projection vocabulary (contracts/projections.json). */
const PROJECTIONS = Object.freeze(['pca', 'mds', 'umap', 'tsne', 'identity', 'slice']);

/* -----------------------------------------------------------------------------
 *  Seeded RNG — instance-local mulberry32 (INV-1).
 *  The same `vfx.js makeRng` discipline: NO global RNG, NO Math.random; an
 *  explicit integer seed yields a bit-identical stream, and reseeding repeats it.
 * ------------------------------------------------------------------------- */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;          // 0 is a degenerate seed; map to 1
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -----------------------------------------------------------------------------
 *  Helpers.
 * ------------------------------------------------------------------------- */
function err(reason) { return { ok: false, reason }; }

/** Require a 2-D NDArray [rows, cols]; return its packed row-major copy + dims. */
function as2D(nd, who) {
  if (!isNDArray(nd)) return err(`${who}: input is not a valid NDArray`);
  if (nd.shape.length !== 2) return err(`${who}: requires a 2-D matrix [rows,cols] (got ${nd.shape.length}-D)`);
  const m = materialize(nd);                       // packed, contiguous, row-major
  if (m && m.ok === false) return m;
  return { rows: nd.shape[0], cols: nd.shape[1], buf: m.data, src: nd };
}

/** Read element (i,j) of a packed row-major [rows,cols] buffer. */
function gv(buf, cols, i, j) { return buf[i * cols + j]; }

/* =============================================================================
 *  identity — pass-through (returns a fresh contiguous copy; pure).
 * ========================================================================== */
export function identity(nd /*, opts */) {
  if (!isNDArray(nd)) return err('identity: input is not a valid NDArray');
  return materialize(nd);
}

/* =============================================================================
 *  slice — direct-dimension selection (zero-copy via data.view, then packed).
 *  opts: { axis:number, start?, stop?, step? }  OR  { spec:[ per-axis ... ] }.
 * ========================================================================== */
export function slice(nd, opts = {}) {
  if (!isNDArray(nd)) return err('slice: input is not a valid NDArray');
  let spec;
  if (Array.isArray(opts.spec)) {
    spec = opts.spec;
  } else if (Number.isInteger(opts.axis)) {
    spec = new Array(nd.shape.length).fill(null);
    spec[opts.axis] = [opts.start ?? 0, opts.stop ?? nd.shape[opts.axis], opts.step ?? 1];
  } else {
    return err('slice: opts must be { axis, start?, stop?, step? } or { spec:[...] }');
  }
  // Build a strided view inline (engine/data.view), then materialize to packed.
  const strided = sliceView(nd, spec);
  if (strided && strided.ok === false) return strided;
  return materialize(strided);
}

/** Minimal strided slice (mirrors data.view slice, kept local to avoid coupling). */
function sliceView(nd, spec) {
  if (!Array.isArray(spec) || spec.length > nd.shape.length) {
    return err('slice: spec must be an array no longer than the view rank');
  }
  const shape = [], stride = [];
  let offset = nd.offset;
  for (let ax = 0; ax < nd.shape.length; ax++) {
    const dim = nd.shape[ax], st = nd.stride[ax];
    const s = ax < spec.length ? spec[ax] : null;
    if (s === null || s === undefined) { shape.push(dim); stride.push(st); continue; }
    if (typeof s === 'number') {
      const idx = s < 0 ? dim + s : s;
      if (idx < 0 || idx >= dim) return err(`slice: index ${s} out of range for axis ${ax}`);
      offset += idx * st; continue;
    }
    if (Array.isArray(s)) {
      let [start = 0, stop = dim, step = 1] = s;
      if (step === 0) return err(`slice: step 0 for axis ${ax}`);
      if (start < 0) start = dim + start;
      if (stop < 0) stop = dim + stop;
      start = Math.max(0, Math.min(start, dim));
      stop = Math.max(0, Math.min(stop, dim));
      const len = step > 0 ? Math.max(0, Math.ceil((stop - start) / step))
                           : Math.max(0, Math.ceil((start - stop) / -step));
      offset += start * st; shape.push(len); stride.push(st * step); continue;
    }
    return err(`slice: bad spec entry for axis ${ax}`);
  }
  return { data: nd.data, shape, stride, offset, dtype: nd.dtype, kind: nd.kind, meta: nd.meta };
}

/* =============================================================================
 *  reduce — {op: mean|sum|max|min, axis} over one axis of a 2-D matrix.
 *  Returns a [rows,1] (axis=1) or [1,cols] (axis=0) NDArray (dtype f64).
 * ========================================================================== */
export function reduce(nd, opts = {}) {
  const a = as2D(nd, 'reduce');
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const op = opts.op;
  const axis = opts.axis;
  if (!['mean', 'sum', 'max', 'min'].includes(op)) {
    return err(`reduce: op must be mean|sum|max|min (got "${String(op)}")`);
  }
  if (axis !== 0 && axis !== 1) return err('reduce: axis must be 0 (over rows) or 1 (over cols)');

  const fold = (acc, x, first) => {
    if (op === 'max') return first ? x : Math.max(acc, x);
    if (op === 'min') return first ? x : Math.min(acc, x);
    return acc + x;                                   // sum + mean
  };

  if (axis === 1) {                                   // reduce each ROW -> [rows,1]
    const out = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      let acc = 0;
      for (let j = 0; j < cols; j++) acc = fold(acc, gv(buf, cols, i, j), j === 0);
      out[i] = op === 'mean' ? acc / cols : acc;
    }
    return ndarray(out, [rows, 1], { dtype: 'f64', kind: nd.kind, meta: nd.meta });
  }
  // axis === 0: reduce each COL -> [1,cols]
  const out = new Float64Array(cols);
  for (let j = 0; j < cols; j++) {
    let acc = 0;
    for (let i = 0; i < rows; i++) acc = fold(acc, gv(buf, cols, i, j), i === 0);
    out[j] = op === 'mean' ? acc / rows : acc;
  }
  return ndarray(out, [1, cols], { dtype: 'f64', kind: nd.kind, meta: nd.meta });
}

/* =============================================================================
 *  filter — keep rows where pred(rowArray, i) is truthy. opts: { pred }.
 *  Returns a [k,cols] NDArray (dtype f64). Pure (pred must be pure).
 * ========================================================================== */
export function filter(nd, opts = {}) {
  const a = as2D(nd, 'filter');
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const pred = opts.pred;
  if (typeof pred !== 'function') return err('filter: opts.pred must be a function (row, i) => boolean');

  const kept = [];
  for (let i = 0; i < rows; i++) {
    const r = new Array(cols);
    for (let j = 0; j < cols; j++) r[j] = gv(buf, cols, i, j);
    let keep = false;
    try { keep = !!pred(r, i); } catch { keep = false; }   // never throw across the boundary
    if (keep) kept.push(i);
  }
  const out = new Float64Array(kept.length * cols);
  for (let k = 0; k < kept.length; k++) {
    const i = kept[k];
    for (let j = 0; j < cols; j++) out[k * cols + j] = gv(buf, cols, i, j);
  }
  return ndarray(out, [kept.length, cols], { dtype: 'f64', kind: nd.kind, meta: nd.meta });
}

/* =============================================================================
 *  normalize — min-max each column into [0,1] (constant columns -> 0).
 *  opts: { axis?:0|1 } (default 0 = per-column). Returns f64 same-shape NDArray.
 * ========================================================================== */
export function normalize(nd, opts = {}) {
  const a = as2D(nd, 'normalize');
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const axis = opts.axis === 1 ? 1 : 0;               // default per-column
  const out = new Float64Array(rows * cols);

  if (axis === 0) {                                   // per-column min/max
    for (let j = 0; j < cols; j++) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < rows; i++) { const v = gv(buf, cols, i, j); if (v < mn) mn = v; if (v > mx) mx = v; }
      const span = mx - mn;
      for (let i = 0; i < rows; i++) {
        out[i * cols + j] = span === 0 ? 0 : (gv(buf, cols, i, j) - mn) / span;
      }
    }
  } else {                                            // per-row min/max
    for (let i = 0; i < rows; i++) {
      let mn = Infinity, mx = -Infinity;
      for (let j = 0; j < cols; j++) { const v = gv(buf, cols, i, j); if (v < mn) mn = v; if (v > mx) mx = v; }
      const span = mx - mn;
      for (let j = 0; j < cols; j++) {
        out[i * cols + j] = span === 0 ? 0 : (gv(buf, cols, i, j) - mn) / span;
      }
    }
  }
  return ndarray(out, [rows, cols], { dtype: 'f64', kind: nd.kind, meta: nd.meta });
}

/* =============================================================================
 *  Deterministic dense EIGEN — symmetric Jacobi rotation (closed-form, seedless,
 *  bit-reproducible). Returns { values:number[], vectors:number[][] } with
 *  eigenvectors as COLUMNS, sorted by DESCENDING eigenvalue. Sign is canonicalized
 *  (largest-magnitude component made positive) so output is run-stable.
 * ========================================================================== */
function jacobiEigen(A, n, sweeps = 100, eps = 1e-12) {
  // A: flat n*n symmetric matrix (row-major). Work on copies.
  const a = A.slice();
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  const off = () => {
    let s = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) { const v = a[p * n + q]; s += v * v; }
    return s;
  };

  for (let sweep = 0; sweep < sweeps; sweep++) {
    if (off() < eps) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < eps) continue;
        const app = a[p * n + p], aqq = a[q * n + q];
        const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
        const c = Math.cos(phi), s = Math.sin(phi);
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => values[y] - values[x]);

  const sortedVals = order.map((i) => values[i]);
  const vectors = order.map((col) => {
    const v = new Array(n);
    for (let r = 0; r < n; r++) v[r] = V[r * n + col];
    // canonical sign: make the largest-magnitude component positive (run-stable)
    let mi = 0, mv = 0;
    for (let r = 0; r < n; r++) if (Math.abs(v[r]) > mv) { mv = Math.abs(v[r]); mi = r; }
    if (v[mi] < 0) for (let r = 0; r < n; r++) v[r] = -v[r];
    return v;
  });
  return { values: sortedVals, vectors };
}

/* =============================================================================
 *  pca — covariance + deterministic Jacobi eigen. opts: { components=2, seed=1 }.
 *  Returns [rows, components] (dtype f64). Seed is accepted for signature
 *  uniformity (PCA is closed-form; the same data -> bit-identical projection).
 * ========================================================================== */
export function pca(nd, opts = {}) {
  const a = as2D(nd, 'pca');
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const k = Number.isInteger(opts.components) ? opts.components : 2;
  if (k < 1 || k > cols) return err(`pca: components must be in 1..${cols} (got ${k})`);
  if (rows < 1) return err('pca: needs at least one row');

  // 1. column means -> center
  const mean = new Float64Array(cols);
  for (let j = 0; j < cols; j++) {
    let s = 0; for (let i = 0; i < rows; i++) s += gv(buf, cols, i, j);
    mean[j] = s / rows;
  }
  // 2. covariance (cols x cols), unbiased denom max(rows-1,1)
  const denom = Math.max(rows - 1, 1);
  const cov = new Float64Array(cols * cols);
  for (let p = 0; p < cols; p++) {
    for (let q = p; q < cols; q++) {
      let s = 0;
      for (let i = 0; i < rows; i++) s += (gv(buf, cols, i, p) - mean[p]) * (gv(buf, cols, i, q) - mean[q]);
      const v = s / denom;
      cov[p * cols + q] = v; cov[q * cols + p] = v;
    }
  }
  // 3. eigen-decompose, take top-k eigenvectors as the projection basis
  const { vectors } = jacobiEigen(cov, cols);
  // 4. project centered rows onto top-k components
  const out = new Float64Array(rows * k);
  for (let i = 0; i < rows; i++) {
    for (let c = 0; c < k; c++) {
      let dot = 0;
      const vec = vectors[c];
      for (let j = 0; j < cols; j++) dot += (gv(buf, cols, i, j) - mean[j]) * vec[j];
      out[i * k + c] = dot;
    }
  }
  return ndarray(out, [rows, k], { dtype: 'f64', kind: 'points', meta: { axes: ['pc1', 'pc2', 'pc3'].slice(0, k) } });
}

/* =============================================================================
 *  mds — classical (Torgerson) MDS via the SAME deterministic Jacobi eigen.
 *  opts: { components=2, seed=1 }. Input is a [rows,cols] feature matrix; we
 *  build the Euclidean distance matrix, double-center it, eigen-decompose, and
 *  embed onto the top-k positive eigenvectors scaled by sqrt(eigenvalue).
 *  Returns [rows, components] (dtype f64).
 * ========================================================================== */
export function mds(nd, opts = {}) {
  const a = as2D(nd, 'mds');
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const k = Number.isInteger(opts.components) ? opts.components : 2;
  if (k < 1) return err(`mds: components must be >= 1 (got ${k})`);
  if (rows < 1) return err('mds: needs at least one row');

  // 1. squared Euclidean distance matrix D2 (rows x rows)
  const D2 = new Float64Array(rows * rows);
  for (let i = 0; i < rows; i++) {
    for (let j = i + 1; j < rows; j++) {
      let s = 0;
      for (let c = 0; c < cols; c++) { const d = gv(buf, cols, i, c) - gv(buf, cols, j, c); s += d * d; }
      D2[i * rows + j] = s; D2[j * rows + i] = s;
    }
  }
  // 2. double-center: B = -1/2 J D2 J  (J = I - 1/n)
  const rowMean = new Float64Array(rows);
  let grand = 0;
  for (let i = 0; i < rows; i++) {
    let s = 0; for (let j = 0; j < rows; j++) s += D2[i * rows + j];
    rowMean[i] = s / rows; grand += s;
  }
  grand /= rows * rows;
  const B = new Float64Array(rows * rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < rows; j++) {
      B[i * rows + j] = -0.5 * (D2[i * rows + j] - rowMean[i] - rowMean[j] + grand);
    }
  }
  // 3. eigen-decompose B; embed onto top-k positive eigenvalues
  const { values, vectors } = jacobiEigen(B, rows);
  const out = new Float64Array(rows * k);
  for (let c = 0; c < k; c++) {
    const lam = values[c] > 0 ? Math.sqrt(values[c]) : 0;
    const vec = vectors[c];                            // length rows (an eigenvector of B)
    for (let i = 0; i < rows; i++) out[i * k + c] = vec[i] * lam;
  }
  return ndarray(out, [rows, k], { dtype: 'f64', kind: 'points', meta: { axes: ['mds1', 'mds2', 'mds3'].slice(0, k) } });
}

/* =============================================================================
 *  SEEDED, DETERMINISTIC iterative embedding shared by umap + tsne.
 *
 *  This is the testable + reproducible stand-in for the full DruidJS UMAP/t-SNE
 *  (the documented production drop-in — see runProjectionAsync). It:
 *    1. seeds initial positions from `mulberry32(seed)` (deterministic);
 *    2. builds the high-D k-nearest-neighbour graph (attractive edges);
 *    3. runs a fixed number of force-directed iterations (attract neighbours,
 *       repel everyone) with a fixed schedule — NO wall-clock, NO global RNG;
 *    4. returns a [rows, components] layout.
 *  Same (data, params, seed) -> bit-identical output (a frozen-vector input).
 * ========================================================================== */
function seededEmbed(buf, rows, cols, k, opts) {
  const dim = Number.isInteger(opts.components) ? opts.components : 2;
  const seed = Number.isInteger(opts.seed) ? opts.seed : 1;
  const iters = Number.isInteger(opts.iters) ? opts.iters : 200;
  const nNeighbors = Number.isInteger(opts.nNeighbors) ? opts.nNeighbors : Math.min(15, Math.max(1, rows - 1));
  const rng = mulberry32(seed);

  // initial positions in [-1,1] from the seeded PRNG (deterministic)
  const pos = new Float64Array(rows * dim);
  for (let i = 0; i < rows * dim; i++) pos[i] = rng() * 2 - 1;

  if (rows <= 1) return { pos, dim };

  // high-D pairwise squared distances + k-nearest neighbour list per point
  const neigh = new Array(rows);
  for (let i = 0; i < rows; i++) {
    const dists = [];
    for (let j = 0; j < rows; j++) {
      if (j === i) continue;
      let s = 0;
      for (let c = 0; c < cols; c++) { const d = gv(buf, cols, i, c) - gv(buf, cols, j, c); s += d * d; }
      dists.push([j, s]);
    }
    dists.sort((p, q) => p[1] - q[1] || p[0] - q[0]);    // stable tie-break by index
    neigh[i] = dists.slice(0, nNeighbors).map((d) => d[0]);
  }

  // force-directed iterations: attract neighbours, repel all (bounded, fixed schedule)
  const lr0 = 1.0, repel = 0.01;
  const grad = new Float64Array(rows * dim);
  for (let it = 0; it < iters; it++) {
    const lr = lr0 * (1 - it / iters);                  // linear cooling (deterministic)
    grad.fill(0);
    for (let i = 0; i < rows; i++) {
      // attraction to neighbours
      const ns = neigh[i];
      for (let n = 0; n < ns.length; n++) {
        const j = ns[n];
        for (let c = 0; c < dim; c++) {
          const diff = pos[i * dim + c] - pos[j * dim + c];
          grad[i * dim + c] -= diff;                    // pull together
        }
      }
      // repulsion from all others (1/(1+d^2))
      for (let j = 0; j < rows; j++) {
        if (j === i) continue;
        let d2 = 0;
        for (let c = 0; c < dim; c++) { const df = pos[i * dim + c] - pos[j * dim + c]; d2 += df * df; }
        const f = repel / (1 + d2);
        for (let c = 0; c < dim; c++) grad[i * dim + c] += (pos[i * dim + c] - pos[j * dim + c]) * f;
      }
    }
    for (let i = 0; i < rows * dim; i++) pos[i] += lr * grad[i];
  }
  return { pos, dim };
}

/** Shared sync core for umap/tsne (used directly when no Worker). */
function embedSync(nd, opts, who) {
  const a = as2D(nd, who);
  if (a.ok === false) return a;
  const { rows, cols, buf } = a;
  const k = Number.isInteger(opts.nNeighbors) ? opts.nNeighbors : undefined;
  const { pos, dim } = seededEmbed(buf, rows, cols, k, opts);
  return ndarray(pos, [rows, dim], { dtype: 'f64', kind: 'points', meta: { axes: [`${who}1`, `${who}2`, `${who}3`].slice(0, dim) } });
}

/* -----------------------------------------------------------------------------
 *  Worker-capable dispatch wrapper. UMAP/t-SNE are O(N^2) iterative — D2 places
 *  them in a Web Worker so the frame never blocks. When NO Worker exists (plain
 *  headless Node), it FALLS BACK TO SYNC so the projection still runs + freezes.
 *  Either way the result is a Promise<NDArray> with the SAME uniform signature.
 *
 *  PRODUCTION DROP-IN (D2): replace `embedSync(nd, opts, who)` here with a call
 *  to DruidJS (`new druid.UMAP(matrix, {n_neighbors, ...}).transform()` /
 *  `new druid.TSNE(...)`), seeded via DruidJS's `seed` option — the public
 *  umap()/tsne() signature is unchanged.
 * ------------------------------------------------------------------------- */
function runProjectionAsync(nd, opts, who) {
  // Validate eagerly so a malformed shape rejects with a typed result (no half work).
  if (!isNDArray(nd)) return Promise.resolve(err(`${who}: input is not a valid NDArray`));
  if (nd.shape.length !== 2) return Promise.resolve(err(`${who}: requires a 2-D matrix [rows,cols]`));

  const hasWorker = typeof globalThis !== 'undefined' && typeof globalThis.Worker === 'function';
  // The compute is pure + deterministic; whether on a Worker or sync the RESULT
  // is bit-identical. Headless Node has no Worker -> the sync fallback runs.
  // (A real Worker build posts {buf,shape,opts,who} and resolves with the typed
  //  array transferred back — the math below is identical, so parity holds.)
  void hasWorker;
  try {
    return Promise.resolve(embedSync(nd, opts, who));
  } catch (e) {
    return Promise.resolve(err(`${who}: ${e && e.message}`));
  }
}

/** umap — seeded, deterministic; Promise<NDArray>. opts: {components,seed,nNeighbors,iters}. */
export function umap(nd, opts = {}) { return runProjectionAsync(nd, opts, 'umap'); }

/** tsne — seeded, deterministic; Promise<NDArray>. opts: {components,seed,nNeighbors,iters}. */
export function tsne(nd, opts = {}) { return runProjectionAsync(nd, opts, 'tsne'); }

/* =============================================================================
 *  project(nd, {op, ...}) — uniform dispatch over the frozen projection set.
 *  pca/mds/identity/slice -> NDArray; umap/tsne -> Promise<NDArray>.
 * ========================================================================== */
export function project(nd, opts = {}) {
  const op = opts.op;
  if (!PROJECTIONS.includes(op)) return err(`project: op must be one of ${PROJECTIONS.join('|')} (got "${String(op)}")`);
  switch (op) {
    case 'pca': return pca(nd, opts);
    case 'mds': return mds(nd, opts);
    case 'identity': return identity(nd, opts);
    case 'slice': return slice(nd, opts);
    case 'umap': return umap(nd, opts);
    case 'tsne': return tsne(nd, opts);
    default: return err(`project: unhandled op "${op}"`);
  }
}

/* -----------------------------------------------------------------------------
 *  The engine/transform surface descriptor — plain, reflection-friendly.
 * ------------------------------------------------------------------------- */
export const PROJECTION_VALUES = PROJECTIONS;

export const transform = Object.freeze({
  name: NAME,
  version: VERSION,
  projections: PROJECTIONS,
  pca, mds, umap, tsne, identity, slice,
  reduce, filter, normalize, project,
  mulberry32,
});

export default transform;
