/* =============================================================================
 *  engine/serialize/clamp.mjs  —  SECURITY CLOSURE: clamp-on-ingest + asset
 *  origin allowlist  (Story P7.4, ADR-D4; INV-3 sub-white, INV-4 caps, INV-5
 *  declarative, INV-6 firewall).
 *
 *  WHAT THIS IS: the "tolerate garbage, never throw, hand back a SAFE handle"
 *  sanitizer the architecture's §Security Architecture mandates for untrusted
 *  imported project / quarks JSON. It is PURE, deterministic, headless, and
 *  firewall-clean (imports NOTHING — not even contracts/, which the firewall
 *  forbids the engine from importing; the asset-origin allowlist is duplicated
 *  here as a plain constant, contracts/asset-origins.json is the source of truth
 *  and a drift is a breaking, semver-versioned change keyed by the conformance
 *  suite).
 *
 *  THE CLAMP-ON-INGEST CONTRACT (architecture §Security Architecture):
 *    - Every numeric is range-clamped to its control descriptor (min/max/step)
 *      carried by the registry `list()` — passed in as a per-registryId control
 *      table so this module stays engine-firewall-clean (no registry import).
 *    - Counts are clamped to caps (INV-4): any param whose control role is a
 *      "count/instances/segments/samples/..." is clamped to its descriptor max
 *      (the descriptor max IS the documented cap).
 *    - Colours are clamped SUB-WHITE (INV-3): a `color`-typed control's [r,g,b]
 *      (or hex) is clamped so every channel <= COLOR_SUBWHITE_MAX (0.85).
 *    - "Code in data" is REJECTED (INV-5): a live function or a function-like
 *      string anywhere is dropped (never executed) — verified, the existing
 *      validate() already rejects whole-doc functions; this is defence in depth
 *      at the per-binding granularity so a clamp result is declarative-only.
 *    - Asset URLs (glTF / LUT / texture) are ORIGIN-ALLOWLISTED: a param whose
 *      control role is an asset-URL (url/src/map/texture/envMap/...) is checked
 *      against the allowlist; a non-allowlisted URL is REJECTED (replaced with
 *      "" so the guarded host loader no-ops — the prototype's GLTFLoader path
 *      already no-ops on 404/absent).
 *
 *  NEVER THROWS, NEVER PARTIAL: clampValue/clampParams always return a value;
 *  clampProject returns { ok:true, doc, report } with a structured list of every
 *  clamp/rejection (audit), or { ok:false, reason } only when the input is not a
 *  plain object (it then hands back nothing to act on — the caller keeps the
 *  validate() typed reject contract). A clamp NEVER widens a value or invents one.
 *
 *  FIREWALL (INV-6): imports NOTHING. Native ESM (D1). GPU-free / DOM-free.
 * ========================================================================== */

/** INV-3 sub-white emissive/colour ceiling (mirrors engine/encode scales EMISSIVE_MAX). */
export const COLOR_SUBWHITE_MAX = 0.85;

/* -----------------------------------------------------------------------------
 *  ASSET ORIGIN ALLOWLIST — duplicated from contracts/asset-origins.json (the
 *  firewall forbids importing contracts/). contracts/ is the source of truth;
 *  a drift is a breaking, semver-versioned change keyed by the conformance suite
 *  (conformance/coverage.mjs cross-checks this constant against the contract file).
 * ------------------------------------------------------------------------- */
export const ASSET_ORIGINS = Object.freeze({
  allowSchemes: Object.freeze(['https']),
  allowRelative: true,
  denyDataUri: true,
  origins: Object.freeze([
    'https://cdnjs.cloudflare.com',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://threejs.org',
  ]),
});

/** Param KEY roles (by name) — drive count/colour/asset-url clamping when no
 *  explicit control descriptor pins the role. Conservative + name-based so a
 *  table-free clamp still enforces the caps/sub-white/allowlist invariants. */
const COUNT_KEY_RE = /(count|instances|segments|samples|ghosts|particles|max|nodes|links|stops)/i;
const COLOR_KEY_RE = /(^|[^a-z])(color|colour|tint|emissive|albedo|fill|rim|base|palette)/i;
const ASSET_URL_KEY_RE = /(url|src|map|texture|envmap|normalmap|roughnessmap|lut|gltf|glb|font|image|asset)/i;

/* -----------------------------------------------------------------------------
 *  small pure helpers (NEVER throw).
 * ------------------------------------------------------------------------- */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isFn(v) { return typeof v === 'function'; }
function num(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }

/** A function-like string (mirrors engine/encode findSerializedFn) — "code in data". */
const FN_STRING_RE = /(\bfunction\b|=>|\beval\b|new\s+Function|\brequire\s*\(|\bimport\s*\()/;
function isCodeString(s) { return typeof s === 'string' && FN_STRING_RE.test(s); }

/** Clamp x into [lo,hi] (no widening; finite-safe). */
function clampN(x, lo, hi) {
  const v = num(x);
  if (lo !== undefined && lo !== null && v < lo) return lo;
  if (hi !== undefined && hi !== null && v > hi) return hi;
  return v;
}

/** Snap x to the nearest `step` grid (offset by min), deterministic; step<=0 -> no snap. */
function snapStep(x, min, step) {
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return x;
  const base = (typeof min === 'number' && Number.isFinite(min)) ? min : 0;
  const k = Math.round((x - base) / step);
  // round to avoid float dust from the division (deterministic, stable).
  const snapped = base + k * step;
  return Math.round(snapped * 1e6) / 1e6;
}

/** hex number -> [r,g,b] in 0..1. */
function hexToRgb(n) { return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }

/* -----------------------------------------------------------------------------
 *  ASSET-URL allowlist check — returns true iff `url` is allowed to load.
 *  Relative URLs (no scheme, no protocol-relative '//') are allowed when
 *  allowRelative (same-origin app assets). data: URIs are denied by default.
 *  An absolute URL must (a) use an allowed scheme and (b) have an allowlisted
 *  origin (scheme://host[:port]). NEVER throws (a malformed URL -> rejected).
 * ------------------------------------------------------------------------- */
export function isAllowedAssetUrl(url, policy = ASSET_ORIGINS) {
  if (typeof url !== 'string' || url.length === 0) return true; // empty/no URL -> nothing to fetch (guarded no-op)
  const u = url.trim();
  if (u.length === 0) return true;
  const lower = u.toLowerCase();
  if (lower.startsWith('data:')) return policy.denyDataUri === false; // default deny
  if (lower.startsWith('blob:') || lower.startsWith('javascript:') || lower.startsWith('file:')) return false;
  // protocol-relative ("//host/...") — treat as the default scheme; check origin.
  if (u.startsWith('//')) {
    const host = u.slice(2).split('/')[0].toLowerCase();
    return policy.origins.some((o) => originHost(o) === host);
  }
  // relative path (no scheme) — same-origin app asset.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return policy.allowRelative !== false;
  // absolute URL: scheme + origin must both be allowlisted.
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)/i.exec(u);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  const origin = (scheme + '://' + m[2]).toLowerCase().replace(/\/+$/, '');
  if (!policy.allowSchemes.includes(scheme)) return false;
  return policy.origins.some((o) => o.toLowerCase().replace(/\/+$/, '') === origin);
}
function originHost(origin) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(origin);
  return m ? m[1].toLowerCase() : String(origin).toLowerCase();
}

/* -----------------------------------------------------------------------------
 *  clampValue(key, value, control) — clamp ONE param value to its control
 *  descriptor (number min/max/step), sub-white (color), count cap (count role),
 *  and asset-URL allowlist. Returns { value, changes:[{kind,...}] } — never throws,
 *  never widens, always returns a usable value. `control` is the registry control
 *  descriptor for this key (optional; falls back to key-name role heuristics).
 * ------------------------------------------------------------------------- */
export function clampValue(key, value, control) {
  const changes = [];
  const c = isPlainObject(control) ? control : null;
  const type = c && typeof c.type === 'string' ? c.type : null;

  // INV-5: "code in data" — a live function / function-like string is dropped.
  if (isFn(value)) { changes.push({ kind: 'code-rejected', key, was: 'function' }); return { value: null, changes }; }
  if (isCodeString(value)) { changes.push({ kind: 'code-rejected', key, was: 'fn-string' }); return { value: '', changes }; }

  // ASSET URL (string) — allowlist check (control type 'text' w/ url-ish key, or url-ish key).
  if (typeof value === 'string' && (type === null || type === 'text') && ASSET_URL_KEY_RE.test(key) && value) {
    if (!isAllowedAssetUrl(value)) {
      changes.push({ kind: 'asset-url-rejected', key, was: value });
      return { value: '', changes }; // guarded host loader no-ops on "" (404/absent path)
    }
    return { value, changes };
  }

  // COLOUR (sub-white, INV-3) — color-typed control OR a colour-ish key with an
  // [r,g,b]/hex value. Clamp every channel to [0, COLOR_SUBWHITE_MAX].
  const looksColor = type === 'color' || (COLOR_KEY_RE.test(key) && (Array.isArray(value) || (typeof value === 'number' && value > 255)));
  if (looksColor) {
    let rgb;
    if (Array.isArray(value)) rgb = [num(value[0]), num(value[1]), num(value[2])];
    else if (typeof value === 'number') rgb = hexToRgb(value);
    else if (isPlainObject(value) && typeof value.r === 'number') rgb = [num(value.r), num(value.g), num(value.b)];
    else return { value, changes };
    const out = rgb.map((ch) => clampN(ch, 0, COLOR_SUBWHITE_MAX));
    if (out.some((ch, i) => ch !== rgb[i])) changes.push({ kind: 'color-subwhite', key, max: COLOR_SUBWHITE_MAX });
    return { value: out, changes };
  }

  // NUMBER — clamp to control min/max (the max IS the documented cap, INV-4), snap to step.
  if (typeof value === 'number' && Number.isFinite(value)) {
    let v = value;
    const min = c && typeof c.min === 'number' ? c.min : undefined;
    const max = c && typeof c.max === 'number' ? c.max : undefined;
    const step = c && typeof c.step === 'number' ? c.step : undefined;
    const before = v;
    if (min !== undefined || max !== undefined) v = clampN(v, min, max);
    if (step !== undefined) v = clampN(snapStep(v, min, step), min, max);
    if (v !== before) {
      const isCount = (c && /count|instances|segments|samples|ghosts|particles|max/i.test(key)) || COUNT_KEY_RE.test(key);
      changes.push({ kind: isCount ? 'count-capped' : 'number-clamped', key, from: before, to: v });
    }
    return { value: v, changes };
  }
  // a non-finite number (NaN/Infinity from JSON edge) -> 0 (safe handle).
  if (typeof value === 'number') { changes.push({ kind: 'number-nonfinite', key, to: 0 }); return { value: 0, changes }; }

  // arrays / objects / strings without a clamp rule -> pass through (recursion at the param-map level handles nested).
  return { value, changes };
}

/* -----------------------------------------------------------------------------
 *  clampParams(params, controls) — clamp a FLAT param map against the control
 *  table (per-key descriptors). Returns { params, changes }. Nested objects/arrays
 *  are walked for "code in data" but only top-level keys carry control descriptors.
 * ------------------------------------------------------------------------- */
export function clampParams(params, controls) {
  const changes = [];
  if (!isPlainObject(params)) return { params: {}, changes };
  const ctrl = isPlainObject(controls) ? controls : {};
  const out = {};
  for (const key of Object.keys(params)) {
    const r = clampValue(key, params[key], ctrl[key]);
    out[key] = r.value;
    for (const ch of r.changes) changes.push(ch);
  }
  return { params: out, changes };
}

export const clamp = Object.freeze({
  COLOR_SUBWHITE_MAX, ASSET_ORIGINS,
  isAllowedAssetUrl, clampValue, clampParams,
});

export default clamp;
