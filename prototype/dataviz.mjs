/* =============================================================================
 *  prototype/dataviz.mjs  —  the VISIBLE Data->Viz pipeline  (FEAT-data-to-viz)
 *
 *  WHAT THIS IS: the thin, PURE, deterministic glue that turns a MATRIX into the
 *  channel buffers a 3D scene draws — by running the REAL P3 grammar end-to-end:
 *
 *       engine/data.ndarray   (a [rows,cols] matrix VIEW)
 *         -> engine/transform  (pca | mds | identity — position projection)
 *         -> engine/encode.compile(spec, dataMap)   (declarative channel buffers)
 *
 *  It exports SAMPLE_DATASETS (>= 2 matrices) and buildDataViz(name, spec) which
 *  returns a bounded, valid channel pack:
 *       { count, channels: { position:Float32Array, scale:Float32Array,
 *                            color:Float32Array, opacity?:Float32Array } }
 *  consumed by the VFX-Lab "Data -> Viz" panel (it PLACES `count` builder-stage
 *  objects and writes position/scale/color from these buffers).
 *
 *  PURE + DETERMINISTIC + HEADLESS (INV-1): NO DOM, NO THREE, NO wall-clock, NO
 *  global RNG. The ONLY randomness is the seeded synthetic-dataset generator and
 *  the engine's own seeded projection. Same (name, spec) -> BYTE-IDENTICAL pack.
 *  A garbage/empty spec yields a SAFE EMPTY result (count 0, zero-length buffers)
 *  — it NEVER throws across the boundary.
 *
 *  This file lives in prototype/ (NOT engine/) — it is an APP-side consumer of the
 *  engine, so it may import the engine via relative '../engine/...' paths. It is
 *  NOT under the engine import-firewall (INV-6 scans engine/** only).
 *
 *  Native ESM (D1). In the browser it is reached via a <script type="module">
 *  bridge that stashes it on window.__dataViz; in Node it imports directly.
 * ========================================================================== */

import data from '../engine/data/index.mjs';
import transform from '../engine/transform/index.mjs';
import encode from '../engine/encode/index.mjs';

/** Module identity. */
export const VERSION = '0.1.0-feat-data-to-viz';
export const NAME = 'prototype/dataviz';

/** Hard cap on placed objects (bounded — INV-4; matches BuilderCore.MAX_OBJECTS). */
export const MAX_COUNT = 300;

/** The projections the panel offers (a subset of the frozen transform vocabulary). */
export const PROJECTIONS = Object.freeze(['pca', 'mds', 'identity']);

/* -----------------------------------------------------------------------------
 *  Seeded synthetic-data generator (mulberry32 — the SAME discipline as
 *  engine/transform; NO Math.random, NO wall-clock). Re-uses the engine PRNG so
 *  the sample matrices are byte-reproducible across runs.
 * ------------------------------------------------------------------------- */
const mulberry32 = transform.mulberry32;

/* -----------------------------------------------------------------------------
 *  SAMPLE_DATASETS — each entry is a lazily-built, CACHED descriptor:
 *    { name, kind, rows, cols, axes:[...], build() -> NDArray }
 *  Built once + frozen so buildDataViz is pure (same input -> same matrix).
 * ------------------------------------------------------------------------- */

/** Synthetic 'companies' [120,4] with axes [netWorth, load, tradeVolume, speed].
 *  Mirrors the architecture's Data-Architecture worked example. Deterministic. */
function buildCompanies() {
  const rows = 120, cols = 4;
  const buf = new Float32Array(rows * cols);
  const rng = mulberry32(7);                          // explicit seed (INV-1)
  for (let i = 0; i < rows; i++) {
    // three latent clusters so PCA/MDS produce visible structure (not a blob)
    const cluster = i % 3;
    const cx = cluster === 0 ? 0.2 : cluster === 1 ? 0.55 : 0.85;
    const netWorth = clampUnit(cx + (rng() - 0.5) * 0.25) * 1_000_000;     // money
    const load = clampUnit(cx * 0.8 + (rng() - 0.5) * 0.30);               // 0..1 utilization
    const tradeVolume = clampUnit((1 - cx) + (rng() - 0.5) * 0.30) * 5000;  // anti-correlated
    const speed = clampUnit(0.3 + cluster * 0.2 + (rng() - 0.5) * 0.20) * 10;
    buf[i * cols + 0] = netWorth;
    buf[i * cols + 1] = load;
    buf[i * cols + 2] = tradeVolume;
    buf[i * cols + 3] = speed;
  }
  return data.ndarray(buf, [rows, cols], {
    kind: 'paramspace',
    meta: { axes: ['netWorth', 'load', 'tradeVolume', 'speed'] },
  });
}

/** Synthetic 'lattice' point-cloud [N,3] — three drifting gaussian blobs in 3-D.
 *  kind:'points'; axes [x,y,z]. Deterministic. */
function buildLattice() {
  const rows = 96, cols = 3;
  const buf = new Float32Array(rows * cols);
  const rng = mulberry32(11);
  const centers = [[-1, 0.5, -1], [1, -0.2, 0.6], [0.1, 1.0, 1.1]];
  for (let i = 0; i < rows; i++) {
    const c = centers[i % centers.length];
    for (let j = 0; j < cols; j++) {
      buf[i * cols + j] = c[j] + (rng() - 0.5) * 0.8;
    }
  }
  return data.ndarray(buf, [rows, cols], {
    kind: 'points',
    meta: { axes: ['x', 'y', 'z'] },
  });
}

function clampUnit(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

/** The registry: descriptor + a memoized matrix builder (pure once built). */
function makeDataset(name, kind, rows, cols, axes, builder) {
  let cached = null;
  return Object.freeze({
    name, kind, rows, cols, axes: Object.freeze(axes.slice()),
    build() { if (cached === null) cached = builder(); return cached; },
  });
}

export const SAMPLE_DATASETS = Object.freeze({
  companies: makeDataset('companies', 'paramspace', 120, 4,
    ['netWorth', 'load', 'tradeVolume', 'speed'], buildCompanies),
  lattice: makeDataset('lattice', 'points', 96, 3,
    ['x', 'y', 'z'], buildLattice),
});

/** Names for a UI <select>. */
export function datasetNames() { return Object.keys(SAMPLE_DATASETS); }

/* -----------------------------------------------------------------------------
 *  A SAFE EMPTY result — returned for any garbage/empty spec, never a throw.
 * ------------------------------------------------------------------------- */
function emptyResult() {
  return {
    count: 0,
    channels: {
      position: new Float32Array(0),
      scale: new Float32Array(0),
      color: new Float32Array(0),
      opacity: new Float32Array(0),
    },
  };
}

function isErr(x) { return x && x.ok === false; }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

/* -----------------------------------------------------------------------------
 *  buildSpec(datasetDesc, ui) — turn the small panel UI into a real EncodeSpec.
 *
 *  ui = {
 *    projection: 'pca' | 'mds' | 'identity',   // position source
 *    scaleColumn: <axis name | index>,         // scale <- a column
 *    scaleType:   'sqrt' | 'linear',
 *    colorColumn: <axis name | index>,         // color <- colormap of a column
 *  }
 *  The position channel binds @proj (the projection output); scale/color bind
 *  @data.<col>. This is EXACTLY the D3 EncodeSpec shape (the worked example).
 *  Returns a plain declarative spec object (no functions — INV-5 safe).
 * ------------------------------------------------------------------------- */
export function buildSpec(datasetDesc, ui = {}) {
  const axes = datasetDesc.axes;
  // resolve a column reference (name -> index, or a raw index) to a @data.<idx>.
  const colIndex = (ref, fallback) => {
    if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < axes.length) return ref;
    if (typeof ref === 'string') {
      const byName = axes.indexOf(ref);
      if (byName >= 0) return byName;
      const n = Number(ref);
      if (Number.isInteger(n) && n >= 0 && n < axes.length) return n;
    }
    return fallback;
  };
  const scaleCol = colIndex(ui.scaleColumn, 0);
  const colorCol = colIndex(ui.colorColumn, Math.min(1, axes.length - 1));
  const scaleType = ui.scaleType === 'linear' ? 'linear' : 'sqrt';

  return {
    object: 'instancedBox',
    encode: {
      // position <- the projection's first 2 components packed into x/z (width 3,
      // y filled from the projection broadcast — visible layout from real PCA/MDS).
      position: { from: '@proj', components: 3,
                  scale: { type: 'linear', domain: [-1, 1], range: [-1, 1] } },
      // scale <- a data column via sqrt (area-true) or linear.
      scale: { from: '@data.' + scaleCol,
               scale: { type: scaleType, range: [0.4, 3.0] } },
      // color <- colormap of a data column (sub-white viridis by default — INV-3).
      color: { from: '@data.' + colorCol,
               scale: { type: 'colormap' } },
      // opacity <- the same color column, gently scaled (always legible).
      opacity: { from: '@data.' + colorCol,
                 scale: { type: 'linear', range: [0.55, 0.95] } },
    },
  };
}

/* -----------------------------------------------------------------------------
 *  buildDataViz(datasetName, spec) — the WHOLE pipeline.
 *
 *  `spec` is EITHER a full declarative EncodeSpec OR a small UI object (see
 *  buildSpec). When it carries an `encode` block it is treated as a full spec;
 *  otherwise it is treated as UI and compiled into a spec via buildSpec.
 *
 *  Steps (all pure + deterministic):
 *    1. resolve the dataset matrix (engine/data NDArray);
 *    2. PROJECT (engine/transform: pca | mds | identity) -> @proj [rows, k];
 *    3. COMPILE (engine/encode.compile(spec, {data:matrix, proj})) -> channels;
 *    4. pack + CAP to MAX_COUNT, normalize position domain to a viewable cube.
 *
 *  Returns { count, channels:{position,scale,color,opacity} } or, for any
 *  garbage/empty/invalid input, the SAFE EMPTY result. NEVER throws.
 * ------------------------------------------------------------------------- */
/** Per-column [min,max] from the matrix (direct NDArray read; row-major-safe). */
function colExtent(matrix, idx) {
  try {
    const rows = matrix.shape[0], cols = matrix.shape[1];
    const off = matrix.offset || 0;
    const sr = (matrix.stride && matrix.stride[0]) || cols;
    const sc = (matrix.stride && matrix.stride[1]) || 1;
    if (idx < 0 || idx >= cols) return null;
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < rows; r++) {
      const v = matrix.data[off + r * sr + idx * sc];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return (hi > lo) ? [lo, hi] : [lo, lo + 1];   // degenerate-column guard
  } catch { return null; }
}

/** Fill an ABSENT scale.domain on each `@data.<col>` binding with that column's real
 *  [min,max], so a large-magnitude column (e.g. netWorth ~1e6) maps across the range
 *  instead of clamping flat to the engine's default [0,1]. Explicit domains (a full
 *  spec) are respected. Pure + guarded; never throws. */
function fillDataDomains(spec, matrix) {
  try {
    if (!spec || typeof spec.encode !== 'object' || !spec.encode) return;
    for (const ch in spec.encode) {
      if (!Object.prototype.hasOwnProperty.call(spec.encode, ch)) continue;
      const b = spec.encode[ch];
      if (!b || !b.scale || b.scale.domain) continue;   // respect explicit domains
      const m = /^@data\.(\d+)$/.exec(typeof b.from === 'string' ? b.from : '');
      if (!m) continue;
      const ext = colExtent(matrix, +m[1]);
      if (ext) b.scale.domain = ext;
    }
  } catch { /* swallowed — leave the spec as-is */ }
}

export function buildDataViz(datasetName, spec = {}) {
  try {
    const desc = SAMPLE_DATASETS[datasetName];
    if (!desc) return emptyResult();

    const matrix = desc.build();
    if (!data.isNDArray(matrix)) return emptyResult();

    // Determine the projection op (default identity) + the EncodeSpec.
    let projection = 'identity';
    let encodeSpec = null;
    if (isPlainObject(spec) && isPlainObject(spec.encode)) {
      // a full declarative spec; honour spec.projection if given, else default.
      projection = PROJECTIONS.includes(spec.projection) ? spec.projection : 'identity';
      encodeSpec = spec;
    } else if (isPlainObject(spec)) {
      projection = PROJECTIONS.includes(spec.projection) ? spec.projection : 'pca';
      encodeSpec = buildSpec(desc, spec);
    } else {
      return emptyResult();
    }

    // AUTO-DOMAIN: bind each @data.<col> scale to that column's actual [min,max] so a
    // large-magnitude column (e.g. netWorth ~1e6) maps across the range instead of
    // clamping flat to the default [0,1]. Only fills an ABSENT domain (explicit domains
    // in a full spec are respected). Pure + guarded; never throws.
    fillDataDomains(encodeSpec, matrix);

    // 1+2. PROJECT cols -> a 2-D layout (@proj). pca/mds/identity are synchronous.
    //      For identity we still produce a [rows, k] points matrix.
    let proj;
    if (projection === 'pca') proj = transform.pca(matrix, { components: 2, seed: 7 });
    else if (projection === 'mds') proj = transform.mds(matrix, { components: 2, seed: 7 });
    else proj = transform.identity(matrix);            // identity -> the matrix itself
    if (isErr(proj) || !data.isNDArray(proj)) return emptyResult();

    // Normalize the projection columns into [-1,1] so the layout is viewable
    // regardless of PCA/MDS scale (pure min-max per column via engine/transform).
    const projN = transform.normalize(proj, { axis: 0 });   // -> [0,1] per column
    const projView = (isErr(projN) || !data.isNDArray(projN)) ? proj : projN;

    // 3. COMPILE the declarative spec against {data, proj}. encode resolves
    //    @data.<col> against the matrix and @proj.<k> against the projection.
    const dataMap = { data: matrix, proj: projView };
    const channels = encode.compile(encodeSpec, dataMap);
    if (isErr(channels)) return emptyResult();

    // 4. PACK + CAP. N is the matrix row count (encode used it for every channel).
    const rows = matrix.shape[0];
    const count = Math.min(rows, MAX_COUNT);

    const pos = sliceChannel(channels.position, count, 3);
    const scl = sliceChannel(channels.scale, count, 1);
    const col = sliceChannel(channels.color, count, 3);
    const opa = channels.opacity ? sliceChannel(channels.opacity, count, 1) : undefined;

    // Lay the position channel out as a real 2-D scatter lifted into 3-D: x <-
    // projection component 0, z <- projection component 1 (the two PCA/MDS axes),
    // y <- a small offset so points clear the plane. Read straight from the
    // normalized projection so x/z are distinct axes (not encode's broadcast).
    spreadPosition(pos, count, projView);

    const out = { count, channels: { position: pos, scale: scl, color: col } };
    if (opa) out.channels.opacity = opa;
    return out;
  } catch (_e) {
    // HONESTY: any unexpected error degrades to the safe empty result (no throw).
    return emptyResult();
  }
}

/** Copy the first `count*width` floats of a channel buffer into a fresh
 *  Float32Array (so the cap is real + the buffer is independent of the engine). */
function sliceChannel(buf, count, width) {
  const n = count * width;
  const out = new Float32Array(n);
  if (buf && buf.length) {
    const m = Math.min(n, buf.length);
    for (let i = 0; i < m; i++) out[i] = buf[i];
  }
  return out;
}

/** Lay out the packed [count*3] position buffer from the (normalized in [0,1])
 *  projection NDArray as a viewable x/y/z world scatter. Pure + deterministic:
 *    x <- projection component 0 (PC1),  z <- projection component 1 (PC2),
 *    y <- a small lift from the index parity so the cloud has depth.
 *  Bounded to [-WORLD, WORLD]. Falls back to the buffer's own value when the
 *  projection has fewer than 2 columns (identity on a 1-col matrix, etc.). */
function spreadPosition(pos, count, projNd) {
  const WORLD = 28;
  const cols = (projNd && Array.isArray(projNd.shape) && projNd.shape.length === 2) ? projNd.shape[1] : 0;
  const cell = (i, j) => projNd.data[projNd.offset + i * projNd.stride[0] + j * projNd.stride[1]];
  for (let i = 0; i < count; i++) {
    let c0, c1;
    if (cols >= 2) { c0 = cell(i, 0); c1 = cell(i, 1); }
    else if (cols === 1) { c0 = cell(i, 0); c1 = 0.5; }
    else { c0 = pos[i * 3 + 0]; c1 = pos[i * 3 + 1]; }   // safety fallback
    // c0,c1 are normalized in [0,1] -> centre to [-1,1] -> scale to the cube.
    pos[i * 3 + 0] = clampW((c0 * 2 - 1) * WORLD, WORLD);              // x <- PC1
    pos[i * 3 + 1] = clampW((((i % 5) - 2) / 2) * (WORLD * 0.30), WORLD); // y <- gentle lift
    pos[i * 3 + 2] = clampW((c1 * 2 - 1) * WORLD, WORLD);              // z <- PC2
  }
}
function clampW(x, w) { return x < -w ? -w : (x > w ? w : x); }

/* -----------------------------------------------------------------------------
 *  The dataviz surface descriptor — plain, serializable, reflection-friendly.
 *  This is what the browser bridge stashes on window.__dataViz.
 * ------------------------------------------------------------------------- */
export const dataviz = Object.freeze({
  name: NAME,
  version: VERSION,
  maxCount: MAX_COUNT,
  projections: PROJECTIONS,
  datasets: SAMPLE_DATASETS,
  datasetNames,
  buildSpec,
  buildDataViz,
});

export default dataviz;
