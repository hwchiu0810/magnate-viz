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

/* engine/dynamics is OPTIONAL here (P5.2-visible). The static Data->Viz pipeline
 * (engine/data->transform->encode) does NOT need it; only the additive ANIMATE mode
 * (buildDataVizTrajectory + driveTrajectoryFrame) consumes it. We import it lazily +
 * guarded so dataviz.mjs degrades GRACEFULLY: if the dynamics ESM is absent/unloadable,
 * the static panel still works and the trajectory builder returns a safe empty result.
 * NEVER throws at module load. */
let _dyn = null;          // the resolved engine/dynamics module (or null if absent)
let _dynTried = false;    // memoize the (single) import attempt
async function loadDynamics() {
  if (_dynTried) return _dyn;
  _dynTried = true;
  try { _dyn = (await import('../engine/dynamics/index.mjs')); }
  catch (_e) { _dyn = null; }   // degrade gracefully — the static path is unaffected
  return _dyn;
}

/** Module identity. */
export const VERSION = '0.2.0-feat-data-to-viz-p5visible';
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

/** Synthetic TIMESERIES trajectory matrix [t, n, f]  (P5.2-VISIBLE).
 *  t = TIME steps (frames of the path), n = INSTANCES, f = 3 position features [x,y,z].
 *  Each instance n rides its OWN swirl/orbit: a circular orbit in the x/z plane whose
 *  radius + phase + tilt are seeded per-instance, with a gentle vertical bob — so the
 *  whole set reads as a flowing galaxy/orbit cloud. PURE + DETERMINISTIC (seeded
 *  mulberry32; NO Math.random, NO wall-clock). meta.t = 0 marks the time axis so the
 *  engine `trajectory` dynamic samples it as a [t,n,f] timeseries. The t=0 row is the
 *  RESTING frame the reduced-motion snapshot freezes. */
function buildOrbits() {
  const T = 64, n = 90, f = 3;                          // bounded (T<=SAMPLE_CAP, n<=FANOUT_CAP)
  const buf = new Float32Array(T * n * f);
  const rng = mulberry32(23);                           // explicit seed (INV-1)
  // per-instance orbit params, drawn ONCE (deterministic, no per-step RNG).
  const radius = new Float32Array(n), phase0 = new Float32Array(n),
        tilt = new Float32Array(n), spin = new Float32Array(n), bob = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    radius[i] = 4 + rng() * 14;                         // orbit radius 4..18
    phase0[i] = rng() * Math.PI * 2;                    // starting angle
    tilt[i]   = (rng() - 0.5) * 0.9;                    // orbital-plane tilt
    spin[i]   = 0.6 + rng() * 1.6;                       // angular speed multiplier
    bob[i]    = 1.5 + rng() * 3.5;                       // vertical bob amplitude
  }
  // stride: time-major [t][n][f]
  const sN = f, sT = n * f;
  for (let t = 0; t < T; t++) {
    const u = t / (T - 1);                              // [0,1] progress along the path
    const ang = u * Math.PI * 2;                        // ONE loop over the whole timeline
    for (let i = 0; i < n; i++) {
      const a = phase0[i] + ang * spin[i];
      const r = radius[i];
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = Math.sin(a + tilt[i]) * bob[i] + tilt[i] * r * 0.5;  // tilted bob
      const o = t * sT + i * sN;
      buf[o + 0] = x;
      buf[o + 1] = y;
      buf[o + 2] = z;
    }
  }
  return data.ndarray(buf, [T, n, f], {
    kind: 'timeseries',
    meta: { t: 0, axes: ['x', 'y', 'z'], instances: n, steps: T },
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

/* -----------------------------------------------------------------------------
 *  TIMESERIES (trajectory) DATASETS — the P5.2-VISIBLE animated matrices [t,n,f].
 *  Kept SEPARATE from SAMPLE_DATASETS so the static Data->Viz pipeline + its frozen
 *  conformance test stay byte-identical; these feed the additive ANIMATE mode only.
 * ------------------------------------------------------------------------- */
/** A trajectory descriptor: { name, kind:'timeseries', steps, instances, axes, build() }. */
function makeTrajectoryDataset(name, steps, instances, axes, builder) {
  let cached = null;
  return Object.freeze({
    name, kind: 'timeseries', steps, instances,
    axes: Object.freeze(axes.slice()),
    build() { if (cached === null) cached = builder(); return cached; },
  });
}

export const TIMESERIES_DATASETS = Object.freeze({
  orbits: makeTrajectoryDataset('orbits', 64, 90, ['x', 'y', 'z'], buildOrbits),
});

/** Names for a UI <select>. */
export function datasetNames() { return Object.keys(SAMPLE_DATASETS); }

/** Names of the animated trajectory matrices (the ANIMATE mode's <select>). */
export function trajectoryNames() { return Object.keys(TIMESERIES_DATASETS); }

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

/* =============================================================================
 *  P5.2-VISIBLE — the ANIMATE mode.  A TIMESERIES matrix [t,n,f] becomes MOTION
 *  through the REAL engine `trajectory` dynamic: positions are a PURE function of
 *  (data, elapsed) — the SAME determinism + reduced-motion + alloc-free discipline
 *  the dynamics conformance vectors freeze.
 *
 *  buildDataVizTrajectory(name, opts) — set up the animated build:
 *    - resolves the timeseries matrix (TIMESERIES_DATASETS[name]);
 *    - returns { count, instances, steps, k, restingFrame, channels:{position}, sample }
 *      where:
 *        * count        = N instances, CAPPED to MAX_COUNT (so the placed object set
 *                         matches the Builder's own bounded pick set — INV-4);
 *        * restingFrame = the t=0 position buffer (the reduced-motion snapshot frame);
 *        * sample(elapsed, out?) = a PURE per-frame sampler: writes the [count*3]
 *                         proportional position channel for `elapsed` into `out`
 *                         (a pre-sized Float32Array reused across frames — NO per-frame
 *                         new; the host passes ONE buffer it owns) and returns it.
 *
 *  The sampler drives the engine dynamic when the dynamics ESM is present, else falls
 *  back to a pure inline [t,n,f] interpolation with the SAME math (graceful degrade).
 *  PROPORTIONAL: channel = value · k (k defaults 1) — channel(value)/value is the single
 *  constant the parity check freezes. Returns a SAFE EMPTY result for any bad input.
 * ------------------------------------------------------------------------- */
async function buildDataVizTrajectory(name, opts = {}) {
  try {
    const desc = TIMESERIES_DATASETS[name];
    if (!desc) return emptyTrajectory();
    const matrix = desc.build();
    if (!data.isNDArray(matrix) || !Array.isArray(matrix.shape) || matrix.shape.length !== 3) return emptyTrajectory();

    const tAxis = (matrix.meta && Number.isInteger(matrix.meta.t)) ? matrix.meta.t : 0;
    const rest = [0, 1, 2].filter((a) => a !== tAxis);
    const instances = matrix.shape[rest[0]] | 0;
    const f = matrix.shape[rest[1]] | 0;
    const steps = matrix.shape[tAxis] | 0;
    const count = Math.min(instances, MAX_COUNT);        // bounded to the Builder pick set
    const k = (typeof opts.k === 'number' && Number.isFinite(opts.k)) ? opts.k : 1;
    const duration = (typeof opts.duration === 'number' && opts.duration > 0) ? opts.duration : 8;
    const loop = opts.loop !== false;

    // The engine `trajectory` dynamic (when present) is the source of truth; we keep a
    // pure inline fallback with identical math so the panel animates even if dynamics
    // is absent. Both write the SAME proportional [n*f] buffer for a given elapsed.
    const dyn = await loadDynamics();
    const sampleEngine = (dyn && typeof dyn.sampleTrajectory === 'function')
      ? (elapsed) => dyn.sampleTrajectory(matrix, elapsed, { k, duration, loop })
      : null;

    // PURE inline [t,n,f] sampler (the graceful-degrade twin of the engine dynamic).
    const off = (matrix.offset | 0) || 0;
    const st = matrix.stride;
    const tStride = st[tAxis], nStride = st[rest[0]], fStride = st[rest[1]];
    const T = Math.min(steps, 8192);
    const sampleInline = (elapsed) => {
      const out = new Float32Array(instances * f);
      writeTimeseries(out, matrix.data, off, T, instances, f, tStride, nStride, fStride, k, elapsed, duration, loop);
      return out;
    };
    const rawSample = sampleEngine || sampleInline;

    // sample(elapsed, out) — write the CAPPED [count*3] position channel in place.
    const sample = (elapsed, out) => {
      const want = count * 3;
      let dst = (out instanceof Float32Array && out.length === want) ? out : new Float32Array(want);
      const full = rawSample(+elapsed || 0);              // [instances*f] proportional channel
      const w = Math.min(3, f);
      for (let i = 0; i < count; i++) {
        const src = i * f, d = i * 3;
        dst[d + 0] = clampW(+full[src + 0] || 0, 1e4);
        dst[d + 1] = w > 1 ? clampW(+full[src + 1] || 0, 1e4) : 0;
        dst[d + 2] = w > 2 ? clampW(+full[src + 2] || 0, 1e4) : 0;
      }
      return dst;
    };

    const restingFrame = sample(0, new Float32Array(count * 3));   // t=0 = reduced-motion frame

    return {
      count, instances, steps, k, duration, loop,
      driver: sampleEngine ? 'engine' : 'inline',
      restingFrame,
      channels: { position: restingFrame.slice() },     // initial (resting) channel pack
      sample,                                            // PURE per-frame sampler (alloc-free if `out` reused)
    };
  } catch (_e) {
    return emptyTrajectory();
  }
}

/** PURE [t,n,f] interpolation (the engine-dynamic twin). Writes value·k in place. */
function writeTimeseries(out, dat, off, T, n, f, tStride, nStride, fStride, k, elapsed, duration, loop) {
  const dur = Math.max(1e-6, +duration || 1e-6);
  let u = (+elapsed || 0) / dur;
  if (loop) u = u - Math.floor(u); else u = Math.min(1, Math.max(0, u));
  const fi = u * (T - 1);
  const i0 = Math.min(T - 1, Math.floor(fi));
  const i1 = Math.min(T - 1, i0 + 1);
  const frac = fi - i0;
  const base0 = off + i0 * tStride, base1 = off + i1 * tStride;
  for (let inst = 0; inst < n; inst++) {
    const n0 = base0 + inst * nStride, n1 = base1 + inst * nStride, row = inst * f;
    for (let c = 0; c < f; c++) {
      const a = +dat[n0 + c * fStride] || 0;
      const b = +dat[n1 + c * fStride] || 0;
      out[row + c] = (a + (b - a) * frac) * k;            // PROPORTIONAL (channel = value·k)
    }
  }
}

/** A SAFE EMPTY animated result — count 0, an inert sampler. Never throws. */
function emptyTrajectory() {
  const sample = (_e, out) => (out instanceof Float32Array ? out : new Float32Array(0));
  return { count: 0, instances: 0, steps: 0, k: 1, duration: 8, loop: true, driver: 'none',
           restingFrame: new Float32Array(0), channels: { position: new Float32Array(0) }, sample };
}

/* -----------------------------------------------------------------------------
 *  The dataviz surface descriptor — plain, serializable, reflection-friendly.
 *  This is what the browser bridge stashes on window.__dataViz.
 * ------------------------------------------------------------------------- */
export { buildDataVizTrajectory };

export const dataviz = Object.freeze({
  name: NAME,
  version: VERSION,
  maxCount: MAX_COUNT,
  projections: PROJECTIONS,
  datasets: SAMPLE_DATASETS,
  datasetNames,
  buildSpec,
  buildDataViz,
  // P5.2-VISIBLE — the additive ANIMATE surface.
  trajectories: TIMESERIES_DATASETS,
  trajectoryNames,
  buildDataVizTrajectory,
});

export default dataviz;
