/* =============================================================================
 *  engine/core/registry.mjs  —  the REGISTRY BASE + control inference (Story P2.2)
 *
 *  WHAT THIS IS: the kernel generalization of `prototype/vfx.js`'s `REGISTRY` +
 *  `register()` + `VFX.list()` + `inferControl` + `CONTROL_OVERRIDES` into a
 *  small, reusable registry base every pillar (`SceneRegistry`, `ObjectRegistry`,
 *  `DynamicsRegistry`, the existing `VfxRegistry`) is built on.
 *
 *  THE CONTRACT (architecture §Registry pattern / §API Contracts):
 *    register(desc)  is the ONLY way a capability becomes visible.
 *    list() -> [{ id, kind, category, params, controls, factory }]   (sorted, stable)
 *      - `controls` are INFERRED from the default `params` value shape, with a
 *        per-capability override table — exactly `vfx.js`'s inferControl + map.
 *      - the inferred control `type` stays WITHIN the FROZEN vocabulary
 *        contracts/control-types.json: number|color|vector|select|bool|text|
 *        colorList|numberList|list|ref (asserted by contracts/check_vocab.mjs).
 *
 *  CONTROL DESCRIPTOR SHAPES (the editor depends on these — same as vfx.js):
 *      number -> { type:'number', min, max, step, default }
 *      color  -> { type:'color',  default:[r,g,b] }              // r,g,b in 0..1
 *      vector -> { type:'vector', length:2|3, min, max, step, default:[...] }
 *      select -> { type:'select', options:[...], default }
 *      bool   -> { type:'bool',   default }
 *      text   -> { type:'text',   default }
 *      colorList / numberList / list -> list widgets ; ref -> nullable slot
 *
 *  Native ESM (D1); imports nothing app/vendor (INV-6). Pure, headless-safe.
 *  The control-type vocabulary is duplicated here as a plain constant (NOT
 *  imported from contracts/, which the firewall forbids) — contracts/ is the
 *  source of truth, drift is a breaking, semver-versioned change.
 * ========================================================================== */

/** The FROZEN control-type vocabulary (mirrors contracts/control-types.json).
 *  Every inferred descriptor's `.type` MUST be one of these. */
export const CONTROL_TYPES = Object.freeze([
  'number', 'color', 'vector', 'select', 'bool', 'text',
  'colorList', 'numberList', 'list', 'ref',
]);
const CONTROL_TYPE_SET = new Set(CONTROL_TYPES);

/* -----------------------------------------------------------------------------
 *  control inference — classify a flat default-param map into `controls` WITHOUT
 *  hand-authoring a descriptor per param (generalizes `vfx.js` inferControl).
 *  Heuristics are driven by the VALUE TYPE + the param KEY name (role).
 * ------------------------------------------------------------------------- */

/** keys whose [r,g,b]/hex value is a COLOUR (not a generic vector). */
const COLOR_KEY_RE = /(^|[^a-z])(color|colour|tint|rim|fill|edge ?color|outline ?color|base|palette)/i;
/** keys that read as a 0..1 normalised amount/mix/fraction. */
const UNIT_KEY_RE = /(opacity|mix|amount|intensity|weight|density|decay|saturation|threshold|spread|drag|flicker|hole|thickness|reveal|value|progress)/i;
/** keys that read as a small screen-space fraction (sub-pixel offsets, aperture). */
const FRACTION_KEY_RE = /(aperture|aberration|colorshift|maxblur|softness)/i;

function isNum(n) { return typeof n === 'number' && Number.isFinite(n); }
function allInUnit(arr) { for (let i = 0; i < arr.length; i++) { if (arr[i] < 0 || arr[i] > 1) return false; } return true; }
function cloneDefault(v) { return Array.isArray(v) ? v.slice() : v; }

/** hex number -> [r,g,b] in 0..1 (no THREE needed). */
function hexToRgb(n) { return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }

/** pick a numeric [min,max,step] from the key role + default magnitude. */
function numberRange(key, value) {
  const def = isNum(value) ? value : 0;
  if (UNIT_KEY_RE.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (FRACTION_KEY_RE.test(key)) return { min: 0, max: 0.05, step: 0.001 };
  if (/^(x|y)$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (/(speed|rate|pulsespeed|scanspeed|rippleSpeed)/i.test(key)) {
    const sMax = Math.max(10, Math.abs(def) * 4 || 10);
    return { min: 0, max: sMax, step: sMax > 100 ? 1 : 0.1 };
  }
  if (/(power|rimpower)/i.test(key)) return { min: 0.5, max: 8, step: 0.1 };
  if (/(count|max|samples|segments|steps|ghosts|width)/i.test(key)) {
    const cMax = Math.max(16, Math.ceil(Math.abs(def) * 4) || 16);
    return { min: 0, max: cMax, step: 1 };
  }
  if (/(duration|life|height|area)/i.test(key)) {
    const dMax = Math.max(10, Math.abs(def) * 4 || 10);
    return { min: 0, max: dMax, step: 0.05 };
  }
  const mag = Math.abs(def);
  const max = (mag <= 1) ? 2 : Math.ceil(mag * 4);
  const min = def < 0 ? -max : 0;
  const step = (max - min) <= 4 ? 0.01 : (max - min <= 100 ? 0.1 : 1);
  return { min, max, step };
}

/** pick min/max/step for each component of a numeric vector. */
function vectorRange(key, arr) {
  if (/gravity/i.test(key)) return { min: -40, max: 40, step: 0.1 };
  if (/(life|size)/i.test(key)) return { min: 0, max: 10, step: 0.01 };
  if (/(from|to|origin|world|position|center)/i.test(key)) return { min: -50, max: 50, step: 0.1 };
  if (/offset/i.test(key)) return { min: -500, max: 500, step: 1 };
  let mag = 1;
  for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i] || 0); if (a > mag) mag = a; }
  const max = Math.ceil(mag * 4);
  return { min: -max, max, step: (max <= 4 ? 0.01 : 0.1) };
}

/**
 * inferControl(key, value, enumOptions) — classify one param into a control
 * descriptor. `enumOptions` (optional) maps key -> [string,...] for select widgets.
 * Generalizes `vfx.js`'s inferControl; never produces a type outside CONTROL_TYPES.
 */
export function inferControl(key, value, enumOptions) {
  const enums = enumOptions || {};
  // explicit enum params first
  if (enums[key]) {
    const opts = enums[key].slice();
    return { type: 'select', options: opts, default: (typeof value === 'string' ? value : opts[0]) };
  }
  // booleans
  if (typeof value === 'boolean') return { type: 'bool', default: value };
  // numbers (incl. hex colour numbers, disambiguated by key name)
  if (typeof value === 'number') {
    if (COLOR_KEY_RE.test(key) && value > 255) return { type: 'color', default: hexToRgb(value) };
    const r = numberRange(key, value);
    return { type: 'number', min: r.min, max: r.max, step: r.step, default: value };
  }
  // strings -> free-form text
  if (typeof value === 'string') return { type: 'text', default: value };
  // arrays: colour [r,g,b], palette, numeric vector, generic numeric list, or list
  if (Array.isArray(value)) {
    if (/palette/i.test(key)) {
      const stops = value.map((c) => (typeof c === 'number' ? hexToRgb(c) : (Array.isArray(c) ? c.slice() : c)));
      return { type: 'colorList', default: stops };
    }
    if (value.length === 3 && COLOR_KEY_RE.test(key) && allInUnit(value)) return { type: 'color', default: cloneDefault(value) };
    if (value.length === 3 && /tint|color/i.test(key) && allInUnit(value)) return { type: 'color', default: cloneDefault(value) };
    if ((value.length === 2 || value.length === 3) && value.every(isNum)) {
      const vr = vectorRange(key, value);
      return { type: 'vector', length: value.length, min: vr.min, max: vr.max, step: vr.step, default: cloneDefault(value) };
    }
    if (value.every(isNum)) return { type: 'numberList', default: cloneDefault(value) };
    return { type: 'list', default: cloneDefault(value) };
  }
  // null / object (e.g. world:null, mesh:null) -> a nullable reference slot
  if (value === null || typeof value === 'object') return { type: 'ref', default: null };
  // last-resort
  return { type: 'text', default: String(value) };
}

/** merge an override descriptor over an inferred one (override wins per-key). */
function applyOverride(inferred, over) {
  if (!over) return inferred;
  const out = {};
  for (const k in inferred) if (Object.prototype.hasOwnProperty.call(inferred, k)) out[k] = inferred[k];
  for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
  if (out.default === undefined && inferred.default !== undefined) out.default = inferred.default;
  return out;
}

/**
 * controlsFor(params, overrides, enumOptions) — build the full `controls` map for
 * a flat default-param object. Per-id override beats the global '*' override
 * (exactly `vfx.js`'s `controlsFor`). Every descriptor `.type` is validated to be
 * within the frozen CONTROL_TYPES vocabulary; an out-of-vocabulary override falls
 * back to the inferred descriptor (the freeze cannot be silently broken).
 */
export function controlsFor(params, overrides, enumOptions) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  const over = overrides || {};
  for (const key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    let desc = inferControl(key, params[key], enumOptions);
    if (over[key]) desc = applyOverride(desc, over[key]);
    if (desc.default === undefined) desc.default = cloneDefault(params[key]);
    // freeze guard: never emit a type outside the frozen vocabulary.
    if (!CONTROL_TYPE_SET.has(desc.type)) desc = inferControl(key, params[key], enumOptions);
    out[key] = desc;
  }
  return out;
}

/* -----------------------------------------------------------------------------
 *  The Registry — register(desc) is the ONLY way a capability becomes visible.
 * ------------------------------------------------------------------------- */

/** merge defaults <- over into a fresh object (no shared mutation). */
function withDefaults(defaults, over) {
  const out = {};
  for (const k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = defaults[k];
  if (over) for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
  return out;
}

/**
 * createRegistry(opts) — a registry base.
 *
 * @param {{
 *   name?: string,                      // human label (e.g. 'ObjectRegistry')
 *   categoryFor?: (desc)=>string,       // central category derivation (vfx.js categoryFor)
 *   controlOverrides?: object,          // { '*': {key:desc}, <id>: {key:desc} } per-capability table
 *   enumOptions?: object,               // { key: [string,...] } for select inference
 * }} [opts]
 * @returns {{
 *   register(desc): void,               // the ONLY way a capability becomes visible
 *   has(id): boolean,
 *   get(id): object|undefined,          // a defensive copy of one descriptor (or undefined)
 *   list(): Array<{id,kind,category,params,controls,factory}>,  // sorted, stable
 *   ids(): string[],
 *   clear(): void,
 *   name: string
 * }}
 *
 * descriptor in: { id, kind?, category?, params?, factory?, controlOverrides?, enumOptions? }
 *   - `id` is required (a registration without an `id` is ignored — visibility
 *     requires an explicit register());
 *   - `controls` is DERIVED (never hand-set); per-desc controlOverrides/enumOptions
 *     extend the registry-level tables.
 */
export function createRegistry(opts = {}) {
  const o = opts || {};
  const name = o.name || 'Registry';
  const categoryFor = (typeof o.categoryFor === 'function') ? o.categoryFor : null;
  const globalOverrides = o.controlOverrides || {};
  const globalEnums = o.enumOptions || {};

  // the single source of truth; null-proto so no inherited keys leak in.
  const REGISTRY = Object.create(null);

  function deriveCategory(desc) {
    if (desc.category) return desc.category;
    if (categoryFor) { try { return categoryFor(desc) || 'General'; } catch { return 'General'; } }
    return 'General';
  }

  function register(desc) {
    if (!desc || !desc.id) return;            // id is mandatory — visibility requires register(id)
    const params = (desc.params && typeof desc.params === 'object') ? desc.params : {};
    REGISTRY[desc.id] = {
      id: desc.id,
      kind: desc.kind || '',
      category: deriveCategory(desc),
      params,
      factory: desc.factory || null,
      _overrides: desc.controlOverrides || null,
      _enums: desc.enumOptions || null,
    };
  }

  // per-id merged override/enum tables (registry-level '*' + per-id + per-desc).
  function overridesFor(d) {
    const starOver = globalOverrides['*'] || {};
    const idOver = globalOverrides[d.id] || {};
    const descOver = d._overrides || {};
    // precedence: desc > per-id > '*'  (later spread wins)
    return { ...starOver, ...idOver, ...descOver };
  }
  function enumsFor(d) {
    return { ...globalEnums, ...(d._enums || {}) };
  }

  function viewOf(d) {
    return {
      id: d.id,
      kind: d.kind,
      category: d.category,
      params: withDefaults(d.params, null),                 // copy so callers can't mutate defaults
      controls: controlsFor(d.params, overridesFor(d), enumsFor(d)),
      factory: d.factory,
    };
  }

  function list() {
    const out = [];
    for (const id in REGISTRY) out.push(viewOf(REGISTRY[id]));
    // stable ordering: category then id.
    out.sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return out;
  }

  return {
    name,
    register,
    has(id) { return !!REGISTRY[id]; },
    get(id) { const d = REGISTRY[id]; return d ? viewOf(d) : undefined; },
    list,
    ids() { return Object.keys(REGISTRY).sort(); },
    clear() { for (const id in REGISTRY) delete REGISTRY[id]; },
  };
}

export default createRegistry;
