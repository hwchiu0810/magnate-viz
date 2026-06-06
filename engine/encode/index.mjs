/* =============================================================================
 *  engine/encode/index.mjs  —  the declarative ENCODING GRAMMAR compiler
 *  (Story P3.3, ADR-D3; INV-1 determinism, INV-3 sub-white, INV-5 declarative)
 *
 *  WHAT THIS IS: the pure grammar-of-graphics compiler. It takes a DECLARATIVE
 *  EncodeSpec + a resolved data map and returns typed-array channel buffers over
 *  the CLOSED channel set ONLY — `encode.compile(spec, dataMap) -> {[channel]:
 *  TypedArray}`. Every visual becomes ONE pure `data -> channel` mapping: the
 *  exact unit the conformance harness FREEZES (D6) and the AI authors (D5).
 *
 *  EncodeSpec (D3 — fully DECLARATIVE, no serialized functions / eval):
 *    {
 *      data?:      <ref string — for the project doc; compile takes a dataMap>,
 *      transform?: [ ... ],     // PROJECTIONS/REDUCERS run in engine/transform
 *                               // BEFORE compile; compile consumes the RESULT.
 *      object?:    <string>,    // which ObjectRegistry factory consumes channels
 *      encode: {                // channel -> binding (the closed channel set ONLY)
 *        <channel>: {
 *          from?:  "@data.<col>" | "@proj.<k>" | "<dataKey>",  // a data accessor
 *          value?: <number | [..] | {r,g,b}>,                  // OR a constant
 *          scale?: { type, domain?, range?, ... },             // explicit scale
 *          components?: number                                  // override width
 *        }
 *      },
 *      dynamics?, vfx?          // carried-through (declarative; not compiled here)
 *    }
 *
 *  CLOSED CHANNEL SET (contracts/channels.json — keyed EXACTLY):
 *    position | scale | rotation | color | opacity | motion | effectParam
 *
 *  PURE + DETERMINISTIC (INV-1): NO I/O, NO GPU, NO DOM, NO wall-clock, NO global
 *  RNG. Same (spec, dataMap) -> BYTE-IDENTICAL buffers across runs (and reseeded).
 *  A bad spec -> NO encoding (encode.validate -> {ok:false, errors[]}), NEVER a
 *  partial/half result. Serialized functions / eval are REJECTED at validate.
 *
 *  SUB-WHITE (INV-3): the `color` channel rides the colormap sub-white clamp
 *  (<= 0.85) and `opacity` is clamped [0,1].  Transforms/projections run BEFORE
 *  compile (engine/transform), so compile is a pure scale-resolution pass.
 *
 *  FIREWALL (INV-6): imports ONLY engine/** (scales + data); NO THREE/Tweakpane;
 *  nothing from apps/**, editor/**, conformance/**. Native ESM (D1).
 * ========================================================================== */

import * as S from './scales.mjs';
import { isNDArray } from '../data/index.mjs';

/** Module identity (semver). */
export const VERSION = '0.1.0-p3.3-encode';
/** Human-readable module identity. */
export const NAME = 'engine/encode';

/** The CLOSED channel set (contracts/channels.json). Keyed EXACTLY. */
export const CHANNELS = Object.freeze([
  'position', 'scale', 'rotation', 'color', 'opacity', 'motion', 'effectParam',
]);

/** Default component WIDTH per channel (floats written per element). */
const CHANNEL_WIDTH = Object.freeze({
  position: 3, scale: 1, rotation: 3, color: 3, opacity: 1, motion: 1, effectParam: 1,
});

/** The frozen scale vocabulary (mirrors scales.SCALE_TYPES / D3). */
export const SCALE_TYPES = S.SCALE_TYPES;

/* -----------------------------------------------------------------------------
 *  Pure helpers.
 * ------------------------------------------------------------------------- */
function err(reason) { return { ok: false, reason }; }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function isFn(x) { return typeof x === 'function'; }

/** Detect a serialized-function / eval payload anywhere in a value (INV-5).
 *  A spec is DECLARATIVE only — a live function, or a string that smells like a
 *  function body / eval, is rejected. Bounded-depth, cycle-safe. */
const FN_STRING_RE = /(\bfunction\b|=>|\beval\b|new\s+Function|\brequire\s*\(|\bimport\s*\()/;
function findSerializedFn(value, depth, seen) {
  if (depth > 64) return null;
  if (isFn(value)) return 'a live function';
  if (typeof value === 'string') {
    // Only flag strings that are clearly code (not data accessors like "@data.x").
    if (FN_STRING_RE.test(value)) return `a function-like string ("${value.slice(0, 40)}")`;
    return null;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    for (const k of Object.keys(value)) {
      const hit = findSerializedFn(value[k], depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/* -----------------------------------------------------------------------------
 *  DATA ACCESSOR resolution — "@data.<col>" / "@proj.<k>" / "<dataKey>".
 *
 *  compile() receives a `dataMap` of already-resolved inputs (transforms /
 *  projections ran BEFORE compile in engine/transform). An accessor reads a
 *  COLUMN of length N from that map and returns a plain JS number[] of length N.
 *
 *  Supported source shapes:
 *    - a 1-D array / TypedArray            -> used directly (one value/element);
 *    - a 2-D NDArray + ".<col>" / "[j]"    -> column j (honours stride/offset);
 *    - an array-of-rows + ".<col>"         -> row[col] per row (col = index or key);
 *    - an array-of-objects + ".<key>"      -> row[key] per row.
 * ------------------------------------------------------------------------- */

/** Parse "@data.netWorth" / "@proj.0" / "rank" -> {root, key}. */
function parseAccessor(from) {
  if (typeof from !== 'string' || from.length === 0) return null;
  let s = from;
  if (s[0] === '@') s = s.slice(1);
  const dot = s.indexOf('.');
  if (dot < 0) return { root: s, key: null };
  return { root: s.slice(0, dot), key: s.slice(dot + 1) };
}

/** Read an NDArray 2-D column `j` (or a 1-D NDArray whole) -> number[]. */
function ndColumn(nd, key) {
  if (nd.shape.length === 1) {
    const out = new Array(nd.shape[0]);
    for (let i = 0; i < nd.shape[0]; i++) out[i] = nd.data[nd.offset + i * nd.stride[0]];
    return out;
  }
  if (nd.shape.length === 2) {
    const rows = nd.shape[0], cols = nd.shape[1];
    let j = 0;
    if (key !== null && key !== undefined && key !== '') {
      const n = Number(key);
      if (!Number.isInteger(n) || n < 0 || n >= cols) {
        return err(`encode: accessor column "${key}" out of range for NDArray [${rows},${cols}]`);
      }
      j = n;
    }
    const out = new Array(rows);
    for (let i = 0; i < rows; i++) out[i] = nd.data[nd.offset + i * nd.stride[0] + j * nd.stride[1]];
    return out;
  }
  return err(`encode: NDArray accessor requires a 1-D or 2-D view (got ${nd.shape.length}-D)`);
}

/** Resolve an accessor against the dataMap -> number[] (or {ok:false}). */
function resolveColumn(from, dataMap) {
  const a = parseAccessor(from);
  if (!a) return err(`encode: malformed accessor "${String(from)}"`);
  const src = dataMap ? dataMap[a.root] : undefined;
  if (src === undefined || src === null) return err(`encode: data source "${a.root}" not found in dataMap`);

  if (isNDArray(src)) return ndColumn(src, a.key);

  if (Array.isArray(src) || ArrayBuffer.isView(src)) {
    // 1-D array of scalars, OR array of rows (array/object) keyed by a.key.
    const n = src.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = src[i];
      if (a.key === null || a.key === undefined || a.key === '') {
        if (Array.isArray(row) || (row && typeof row === 'object')) {
          return err(`encode: accessor "@${a.root}" needs a ".col" for an array-of-rows source`);
        }
        out[i] = row;                                  // scalar column
      } else if (Array.isArray(row)) {
        const j = Number(a.key);
        if (!Number.isInteger(j)) return err(`encode: accessor key "${a.key}" must be an integer index for array rows`);
        out[i] = row[j];
      } else if (row && typeof row === 'object') {
        out[i] = row[a.key];
      } else {
        return err(`encode: accessor "@${a.root}.${a.key}" cannot index a scalar row at ${i}`);
      }
    }
    return out;
  }
  return err(`encode: data source "${a.root}" is neither an NDArray nor an array`);
}

/* -----------------------------------------------------------------------------
 *  VALIDATE — encode.validate(spec) -> {ok, errors[]}.
 *  DECLARATIVE-only: rejects serialized functions / eval; channels drawn ONLY
 *  from the closed set; scales drawn ONLY from the frozen vocabulary; each
 *  binding has EITHER a `from` accessor OR a constant `value`. A bad spec yields
 *  NO encoding (caught here) — never a partial result.
 * ------------------------------------------------------------------------- */
export function validate(spec) {
  const errors = [];
  if (!isPlainObject(spec)) {
    return { ok: false, errors: ['encode.validate: spec must be a plain object'] };
  }
  // INV-5: no serialized functions / eval anywhere in the spec.
  const fnHit = findSerializedFn(spec, 0, new WeakSet());
  if (fnHit) errors.push(`encode.validate: spec is not declarative — contains ${fnHit} (INV-5: no serialized functions / eval)`);

  if (!isPlainObject(spec.encode)) {
    errors.push('encode.validate: spec.encode must be an object of channel bindings');
    return { ok: errors.length === 0, errors };
  }
  const chans = Object.keys(spec.encode);
  if (chans.length === 0) errors.push('encode.validate: spec.encode has no channel bindings');

  for (const ch of chans) {
    if (!CHANNELS.includes(ch)) {
      errors.push(`encode.validate: channel "${ch}" is not in the closed set (${CHANNELS.join('|')})`);
      continue;
    }
    const b = spec.encode[ch];
    if (!isPlainObject(b)) { errors.push(`encode.validate: binding for "${ch}" must be an object`); continue; }
    const hasFrom = b.from !== undefined && b.from !== null;
    const hasValue = b.value !== undefined && b.value !== null;
    if (!hasFrom && !hasValue) {
      errors.push(`encode.validate: binding for "${ch}" must have a "from" accessor OR a constant "value"`);
    }
    if (hasFrom && typeof b.from !== 'string') {
      errors.push(`encode.validate: binding "${ch}".from must be a string accessor (e.g. "@data.col")`);
    }
    if (b.scale !== undefined) {
      if (!isPlainObject(b.scale)) {
        errors.push(`encode.validate: binding "${ch}".scale must be an object {type,...}`);
      } else if (!SCALE_TYPES.includes(b.scale.type)) {
        errors.push(`encode.validate: binding "${ch}".scale.type "${String(b.scale.type)}" not in (${SCALE_TYPES.join('|')})`);
      }
    }
    if (b.components !== undefined && (!Number.isInteger(b.components) || b.components < 1)) {
      errors.push(`encode.validate: binding "${ch}".components must be a positive integer`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/* -----------------------------------------------------------------------------
 *  COMPILE — encode.compile(spec, dataMap) -> {[channel]: Float32Array}.
 *
 *  A bad spec yields the typed {ok:false, errors[]} (NO partial channels). On
 *  success, returns ONE Float32Array per declared channel, length = N * width.
 *  N is the column length of the first data-driven binding (constants broadcast).
 * ------------------------------------------------------------------------- */
export function compile(spec, dataMap = {}) {
  const v = validate(spec);
  if (!v.ok) return { ok: false, errors: v.errors };

  const channels = Object.keys(spec.encode);

  // Resolve every data-driven column first (so a single bad accessor aborts with
  // NO partial output — INV-5). Determine N from the columns.
  const cols = {};
  let N = null;
  for (const ch of channels) {
    const b = spec.encode[ch];
    if (b.from !== undefined && b.from !== null) {
      const c = resolveColumn(b.from, dataMap);
      if (c && c.ok === false) return { ok: false, errors: [c.reason] };
      cols[ch] = c;
      if (N === null) N = c.length;
      else if (c.length !== N) {
        return { ok: false, errors: [`encode.compile: channel "${ch}" column length ${c.length} != N ${N} (all data-driven channels must agree)`] };
      }
    }
  }
  if (N === null) N = 1;                               // all-constant spec -> one element

  const out = {};
  for (const ch of channels) {
    const b = spec.encode[ch];
    const width = Number.isInteger(b.components) ? b.components : CHANNEL_WIDTH[ch];
    const buf = new Float32Array(N * width);
    const scaleType = b.scale && b.scale.type;
    const scaleOpts = (b.scale && isPlainObject(b.scale)) ? b.scale : {};

    if (ch === 'color') {
      // color -> {r,g,b} per element via colormap (default) or a constant rgb.
      // EMISSIVE sub-white (INV-3) is the DEFAULT: each channel rides <= 0.85.
      // A binding may opt into raw albedo (subWhite:false) for a non-emissive
      // surface — then channels are clamped only to [0,1]. The colormap scale
      // already applied the chosen clamp, so honour the SAME flag at write-out.
      const subWhite = scaleOpts.subWhite !== false;
      const clampCh = subWhite ? clamp01Max : clamp01;
      for (let i = 0; i < N; i++) {
        let rgb;
        if (cols[ch]) {
          const val = cols[ch][i];
          if (scaleType === 'colormap' || scaleType === undefined) {
            rgb = S.colormap(val, scaleOpts);
          } else {
            const s = S.apply(scaleType, val, scaleOpts);   // scalar -> grey
            rgb = { r: s, g: s, b: s };
          }
        } else {
          rgb = normalizeRgb(b.value);
        }
        buf[i * 3 + 0] = clampCh(rgb.r);
        buf[i * 3 + 1] = clampCh(rgb.g);
        buf[i * 3 + 2] = clampCh(rgb.b);
      }
    } else if (ch === 'opacity') {
      for (let i = 0; i < N; i++) {
        const raw = cols[ch] ? cols[ch][i] : scalarValue(b.value);
        const scaled = scaleType ? S.apply(scaleType, raw, scaleOpts) : raw;
        buf[i] = S.opacity(scaled);                    // [0,1] clamp (INV-3/INV-4)
      }
    } else {
      // position | scale | rotation | motion | effectParam — numeric channels.
      for (let i = 0; i < N; i++) {
        if (cols[ch]) {
          const raw = cols[ch][i];
          const scaled = scaleType ? S.apply(scaleType, raw, scaleOpts) : raw;
          if (width === 1) {
            buf[i] = num(scaled);
          } else {
            // broadcast a scalar across the width, OR a per-element vector value.
            for (let k = 0; k < width; k++) buf[i * width + k] = num(scaled);
          }
        } else {
          const cv = b.value;
          if (Array.isArray(cv)) {
            for (let k = 0; k < width; k++) buf[i * width + k] = num(cv[k] !== undefined ? cv[k] : cv[0]);
          } else {
            const s = scaleType ? S.apply(scaleType, scalarValue(cv), scaleOpts) : scalarValue(cv);
            for (let k = 0; k < width; k++) buf[i * width + k] = num(s);
          }
        }
      }
    }
    out[ch] = buf;
  }
  return out;
}

/* -----------------------------------------------------------------------------
 *  Constant-value + numeric coercion helpers (pure, deterministic).
 * ------------------------------------------------------------------------- */
function clamp01Max(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  return v > S.EMISSIVE_MAX ? S.EMISSIVE_MAX : v;
}
function clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  return v > 1 ? 1 : v;
}
function num(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
function scalarValue(v) { return Array.isArray(v) ? v[0] : v; }
function normalizeRgb(v) {
  if (Array.isArray(v)) return { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0 };
  if (v && typeof v === 'object') return { r: v.r ?? 0, g: v.g ?? 0, b: v.b ?? 0 };
  const s = num(v);
  return { r: s, g: s, b: s };
}

/* -----------------------------------------------------------------------------
 *  The engine/encode surface descriptor — plain, serializable.
 * ------------------------------------------------------------------------- */
export const encode = Object.freeze({
  name: NAME,
  version: VERSION,
  channels: CHANNELS,
  scaleTypes: SCALE_TYPES,
  EMISSIVE_MAX: S.EMISSIVE_MAX,
  compile, validate, scales: S.scales,
});

export default encode;
