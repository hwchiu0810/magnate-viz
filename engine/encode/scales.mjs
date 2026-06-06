/* =============================================================================
 *  engine/encode/scales.mjs  —  the 5 FROZEN scales as PURE domain->range maps
 *  (Story P3.4, ADR-D3; INV-1 determinism, INV-2 a11y, INV-3 sub-white)
 *
 *  WHAT THIS IS: the closed scale vocabulary (contracts/.. D3) implemented as
 *  PURE, deterministic, headless functions — `linear | log | sqrt | ordinal |
 *  colormap`. Each is a `domain -> range` map with NO I/O, NO GPU, NO DOM, NO
 *  wall-clock, NO global RNG. Same input -> byte-identical output.
 *
 *    linear(value, {domain:[d0,d1], range:[r0,r1], clamp?})   -> number
 *    log   (value, {domain:[d0,d1], range:[r0,r1], base?, clamp?}) -> number
 *    sqrt  (value, {domain:[d0,d1], range:[r0,r1], clamp?})   -> number
 *    ordinal(value, {domain:[...keys], range:[...vals], unknown?}) -> range elt
 *    colormap(value, {domain:[d0,d1], range?:stops|name, lut?, clamp?})
 *           -> {r,g,b}  with EVERY channel rounded to a sub-white emissive band.
 *
 *  SUB-WHITE (INV-3 / NFR3): colormap output rides a sub-white clamp so an
 *  emissive use of the ramp cannot blow the bloom composer to white. The clamp
 *  is `EMISSIVE_MAX = 0.85` (the architecture's emissive ceiling) — applied as
 *  a hard ceiling on each RGB channel. The DEFAULT ramp is a colour-blind-safe,
 *  perceptually-uniform VIRIDIS-class Lut (INV-2 / NFR2) — colour is never the
 *  sole signal (the encode layer pairs it with a second channel).
 *
 *  OPACITY: a dedicated `opacity` scale clamps to [0,1] (INV-3/INV-4 bound).
 *
 *  FIREWALL (INV-6): imports NOTHING from apps/**, editor/**, conformance/**,
 *  and NO THREE / Tweakpane — pure JS numerics only. Native ESM (D1).
 * ========================================================================== */

/** Module identity (semver). */
export const VERSION = '0.1.0-p3.4-scales';
/** Human-readable module identity. */
export const NAME = 'engine/encode/scales';

/** The frozen scale vocabulary (mirrors the D3 closed scale set). */
export const SCALE_TYPES = Object.freeze(['linear', 'log', 'sqrt', 'ordinal', 'colormap']);

/** INV-3 sub-white emissive ceiling — every colormap channel <= this. */
export const EMISSIVE_MAX = 0.85;

/* -----------------------------------------------------------------------------
 *  Small pure helpers.
 * ------------------------------------------------------------------------- */

/** Clamp x into [lo,hi]. */
function clampN(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

/** A finite number, or fall back to `f`. */
function fin(x, f) { return Number.isFinite(x) ? x : f; }

/** Linear interpolation between a and b by t in [0,1]. */
function lerp(a, b, t) { return a + (b - a) * t; }

/* =============================================================================
 *  linear — affine domain -> range.
 *    value in [d0,d1]  ->  [r0,r1].  A zero-width domain maps to r0 (no div0).
 *    clamp (default true) holds the output inside [min(r),max(r)].
 * ========================================================================== */
export function linear(value, opts = {}) {
  const [d0, d1] = opts.domain || [0, 1];
  const [r0, r1] = opts.range || [0, 1];
  const clamp = opts.clamp !== false;
  const span = d1 - d0;
  let t = span === 0 ? 0 : (value - d0) / span;
  let out = lerp(r0, r1, t);
  if (clamp) out = clampN(out, Math.min(r0, r1), Math.max(r0, r1));
  return out;
}

/* =============================================================================
 *  log — log-domain affine. Domain/value mapped through log_base, then linear.
 *    Requires d0>0, d1>0, value>0 (a non-positive input clamps to the domain
 *    floor d0 — never NaN/Infinity). base default e.
 * ========================================================================== */
export function log(value, opts = {}) {
  const [d0r, d1r] = opts.domain || [1, 10];
  const [r0, r1] = opts.range || [0, 1];
  const clamp = opts.clamp !== false;
  const base = opts.base && opts.base > 0 && opts.base !== 1 ? opts.base : Math.E;
  const lb = Math.log(base);
  const d0 = d0r > 0 ? d0r : Number.MIN_VALUE;
  const d1 = d1r > 0 ? d1r : Number.MIN_VALUE;
  const v = value > 0 ? value : d0;                  // non-positive -> domain floor
  const ld0 = Math.log(d0) / lb, ld1 = Math.log(d1) / lb, lv = Math.log(v) / lb;
  const span = ld1 - ld0;
  let t = span === 0 ? 0 : (lv - ld0) / span;
  let out = lerp(r0, r1, t);
  if (clamp) out = clampN(out, Math.min(r0, r1), Math.max(r0, r1));
  return out;
}

/* =============================================================================
 *  sqrt — square-root-domain affine (area-true sizing). value, domain mapped
 *    through sqrt(abs) preserving sign, then linear into range.
 * ========================================================================== */
export function sqrt(value, opts = {}) {
  const [d0, d1] = opts.domain || [0, 1];
  const [r0, r1] = opts.range || [0, 1];
  const clamp = opts.clamp !== false;
  const sq = (x) => (x < 0 ? -Math.sqrt(-x) : Math.sqrt(x));
  const sd0 = sq(d0), sd1 = sq(d1), sv = sq(value);
  const span = sd1 - sd0;
  let t = span === 0 ? 0 : (sv - sd0) / span;
  let out = lerp(r0, r1, t);
  if (clamp) out = clampN(out, Math.min(r0, r1), Math.max(r0, r1));
  return out;
}

/* =============================================================================
 *  ordinal — discrete domain key -> discrete range value (rank/category).
 *    {domain:[keys...], range:[vals...]}: value's index in domain selects the
 *    same index in range. If range is shorter it wraps (cyclic palette). An
 *    unknown key returns opts.unknown (default the first range value).
 *  Convenience: if NO domain is given but range is, value is treated as a 0-based
 *    INDEX into range (the leaderboard rank->slot use).
 * ========================================================================== */
export function ordinal(value, opts = {}) {
  const range = Array.isArray(opts.range) ? opts.range : [];
  const domain = Array.isArray(opts.domain) ? opts.domain : null;
  if (range.length === 0) return opts.unknown;
  if (domain) {
    const i = domain.indexOf(value);
    if (i < 0) return ('unknown' in opts) ? opts.unknown : range[0];
    return range[((i % range.length) + range.length) % range.length];
  }
  // index mode: value is a (possibly 1-based via offset) index into range.
  const off = Number.isInteger(opts.offset) ? opts.offset : 0;
  const idx = Math.trunc(value) - off;
  if (!Number.isInteger(idx) || idx < 0 || idx >= range.length) {
    return ('unknown' in opts) ? opts.unknown : range[clampN(idx, 0, range.length - 1)];
  }
  return range[idx];
}

/* =============================================================================
 *  opacity — a dedicated [0,1] clamp (INV-3/INV-4 bound). Used by the encode
 *  layer for the `opacity` channel so it can never escape [0,1].
 * ========================================================================== */
export function opacity(value) { return clampN(fin(value, 0), 0, 1); }

/* -----------------------------------------------------------------------------
 *  COLOUR LOOKUP TABLES (Lut), each a list of [t, r, g, b] stops in [0,1].
 *
 *  - 'viridis'   : the DEFAULT — a colour-blind-safe, perceptually-uniform ramp
 *                  (8-anchor sampling of the canonical viridis colormap). INV-2.
 *  - 'twinheat'  : the prototype's FROZEN jet fallback ramp (twinHeatColor):
 *                  blue->cyan->green->yellow->red. Reproduced EXACTLY (the P1.3
 *                  twin-heat-color-ramp anchors) so encode.compile subsumes it.
 *                  ALSO registered under 'jet' / 'rainbow' (the prototype names).
 * ------------------------------------------------------------------------- */

/** Canonical viridis anchors (colour-blind-safe, perceptually uniform). */
const VIRIDIS = Object.freeze([
  [0.00, 0.267004, 0.004874, 0.329415],
  [0.142857, 0.275191, 0.194905, 0.496005],
  [0.285714, 0.212395, 0.359683, 0.551710],
  [0.428571, 0.153364, 0.497000, 0.557724],
  [0.571429, 0.122312, 0.633153, 0.530398],
  [0.714286, 0.288921, 0.758394, 0.428426],
  [0.857143, 0.626579, 0.854645, 0.223353],
  [1.00, 0.993248, 0.906157, 0.143936],
]);

/** The prototype's FROZEN twinHeatColor fallback ramp (jet). EXACT anchors. */
const TWINHEAT = Object.freeze([
  [0.00, 0.05, 0.10, 0.55],
  [0.25, 0.10, 0.75, 0.85],
  [0.50, 0.15, 0.85, 0.45],
  [0.75, 0.95, 0.80, 0.20],
  [1.00, 0.95, 0.18, 0.12],
]);

/** Named, frozen LUTs. The DEFAULT is viridis (INV-2 colour-blind-safe). */
export const LUTS = Object.freeze({
  viridis: VIRIDIS,
  twinheat: TWINHEAT,
  jet: TWINHEAT,         // prototype alias
  rainbow: TWINHEAT,     // prototype alias (the THREE.Lut('rainbow') fallback path)
});

/** Default colormap ramp name (colour-blind-safe). */
export const DEFAULT_LUT = 'viridis';

/** Is `r` a list of [t,r,g,b] stops? */
function isStops(r) {
  return Array.isArray(r) && r.length >= 2 && Array.isArray(r[0]) && r[0].length === 4;
}

/** Resolve a ramp spec (name | stops | undefined) to a stops array. */
function resolveLut(spec) {
  if (isStops(spec)) return spec;
  if (typeof spec === 'string' && LUTS[spec]) return LUTS[spec];
  return LUTS[DEFAULT_LUT];
}

/** Sample a stops ramp at normalized t in [0,1] (piecewise-linear in RGB). */
function sampleStops(stops, t) {
  const x = clampN(fin(t, 0), 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (x >= a[0] && x <= b[0]) {
      const f = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);   // matches prototype guard
      return { r: a[1] + (b[1] - a[1]) * f, g: a[2] + (b[2] - a[2]) * f, b: a[3] + (b[3] - a[3]) * f };
    }
  }
  const last = stops[stops.length - 1];
  return { r: last[1], g: last[2], b: last[3] };
}

/* =============================================================================
 *  colormap — normalized value -> {r,g,b} via a colour-blind-safe Lut.
 *    opts: { domain:[d0,d1]?, range?: name|stops, lut?: name|stops, emissive?,
 *            subWhite? }.
 *    - the value is normalized to [0,1] across `domain` (default [0,1]) FIRST;
 *    - `range`/`lut` selects the ramp (DEFAULT viridis, colour-blind-safe);
 *    - output RGB is clamped sub-white (each channel <= EMISSIVE_MAX) when the
 *      ramp is used for emissive (the default — INV-3). Set subWhite:false ONLY
 *      to reproduce a raw ramp that already rides <= EMISSIVE_MAX (the frozen
 *      twinheat ramp peaks at 0.95 albedo, but its EMISSIVE use is separately
 *      clamped <= 0.85; see encode/index.mjs).
 * ========================================================================== */
export function colormap(value, opts = {}) {
  const [d0, d1] = opts.domain || [0, 1];
  const span = d1 - d0;
  const t = span === 0 ? 0 : clampN((value - d0) / span, 0, 1);
  const stops = resolveLut(opts.range !== undefined ? opts.range : opts.lut);
  const c = sampleStops(stops, t);
  const subWhite = opts.subWhite !== false;            // default ON (INV-3)
  if (subWhite) {
    c.r = clampN(c.r, 0, EMISSIVE_MAX);
    c.g = clampN(c.g, 0, EMISSIVE_MAX);
    c.b = clampN(c.b, 0, EMISSIVE_MAX);
  } else {
    c.r = clampN(c.r, 0, 1); c.g = clampN(c.g, 0, 1); c.b = clampN(c.b, 0, 1);
  }
  return c;
}

/* -----------------------------------------------------------------------------
 *  Uniform dispatch — apply(type, value, opts). Continuous scales return a
 *  number; colormap returns {r,g,b}; ordinal returns a range element.
 * ------------------------------------------------------------------------- */
export function apply(type, value, opts = {}) {
  switch (type) {
    case 'linear': return linear(value, opts);
    case 'log': return log(value, opts);
    case 'sqrt': return sqrt(value, opts);
    case 'ordinal': return ordinal(value, opts);
    case 'colormap': return colormap(value, opts);
    default: return { ok: false, reason: `scales.apply: unknown scale type "${String(type)}"` };
  }
}

export const scales = Object.freeze({
  name: NAME,
  version: VERSION,
  types: SCALE_TYPES,
  EMISSIVE_MAX,
  DEFAULT_LUT,
  LUTS,
  linear, log, sqrt, ordinal, colormap, opacity, apply,
});

export default scales;
