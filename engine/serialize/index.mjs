/* =============================================================================
 *  engine/serialize/index.mjs  —  project-document schema-v1 skeleton (ADR-D4)
 *
 *  The serialization-first surface (INV-5): every scene/object/dynamic/effect IS
 *  its declarative spec; the runtime handle is DERIVED from the spec, never the
 *  reverse. This single versioned JSON document is the load/save surface, the
 *  AI-mutation target, and the conformance-vector input.
 *
 *  HEADLESS-SAFE / GPU-FREE by construction:
 *    - imports NOTHING from apps/**, editor/**, conformance/** (INV-6 firewall);
 *    - NO hard import of THREE / Tweakpane (vendor arrives via init({THREE,...}));
 *    - NO app-specific (Magnate) names — engine-only vocabulary;
 *    - pure functions over plain JSON; touches no GPU/DOM, never throws on bad
 *      input (returns a typed {ok:false, reason}), never returns a partial doc.
 *
 *  Public surface:
 *    validate(doc)        -> { ok:true, doc } | { ok:false, reason }
 *    migrate(doc)         -> { ok:true, doc } | { ok:false, reason }   (forward chain STUB)
 *    saveProject(state)   -> { ok:true, doc } | { ok:false, reason }   (registry ids + params)
 *    loadProject(doc, opts) -> { ok:true, state, report? } | { ok:false, reason } (no live GPU objects)
 *    clampProject(doc, controlTables) -> { ok:true, doc, report } | { ok:false, reason }  (P7.4 security closure)
 *    SCHEMA_VERSION, FORMAT, CHANNELS, DATA_KINDS, SCALE_TYPES, DTYPES (frozen vocab)
 *
 *  P7.4 SECURITY CLOSURE (ADDITIVE — §Security Architecture). On loadProject/validate
 *  of UNTRUSTED input, `clampProject` sanitizes every section's `params`: numerics
 *  clamped to their control descriptor (min/max/step), counts to caps (INV-4),
 *  colours sub-white (<=0.85, INV-3); "code in data" dropped (INV-5, already
 *  rejected at the whole-doc grain by validate() — clampProject is defence in depth
 *  at the per-binding grain); non-allowlisted asset URLs rejected (no-op on
 *  404/absent). The clamp NEVER throws and hands back a SAFE handle. The clamp math
 *  lives in ./clamp.mjs (pure, headless, firewall-clean).
 * ========================================================================== */

import {
  clampParams as _clampParams, clampValue as _clampValue,
  isAllowedAssetUrl as _isAllowedAssetUrl, ASSET_ORIGINS, COLOR_SUBWHITE_MAX,
} from './clamp.mjs';

/* ---- frozen vocabularies (mirror project.schema.json + Consistency Rules) -- */
export const FORMAT = 'magnate-viz-project';
export const SCHEMA_VERSION = '1.0.0';

/** Closed channel set (Consistency Rules). */
export const CHANNELS = Object.freeze(['position', 'scale', 'rotation', 'color', 'opacity', 'motion', 'effectParam']);
/** Frozen data-kind vocabulary. */
export const DATA_KINDS = Object.freeze(['field', 'timeseries', 'graph', 'points', 'paramspace']);
/** Frozen scale vocabulary (ADR-D3). */
export const SCALE_TYPES = Object.freeze(['linear', 'log', 'sqrt', 'ordinal', 'colormap']);
/** NDArray element types (ADR-D2). */
export const DTYPES = Object.freeze(['f32', 'f64', 'i32', 'u8']);

/** The five top-level spec arrays — the exact document shape (ADR-D4). */
const ARRAY_KEYS = Object.freeze(['data', 'scenes', 'objects', 'dynamics', 'effects']);
const TOP_KEYS = Object.freeze(['format', 'schemaVersion', ...ARRAY_KEYS]);

const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ID_RE = /^[A-Za-z0-9._:/+-]+$/;

/* --------------------------------------------------------------------------- */
/* small pure helpers                                                          */
/* --------------------------------------------------------------------------- */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reject any serialized logic (functions / code) anywhere in a value tree (INV-5). */
function hasNoFunctions(v, depth = 0) {
  if (depth > 64) return false; // bounded recursion (INV-4-style guard); deny pathological nesting
  if (typeof v === 'function') return false;
  if (Array.isArray(v)) {
    for (const e of v) if (!hasNoFunctions(e, depth + 1)) return false;
    return true;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) if (!hasNoFunctions(v[k], depth + 1)) return false;
    return true;
  }
  return true; // scalars (string/number/bool/null/undefined) are fine
}

function fail(reason) { return { ok: false, reason }; }

/* --------------------------------------------------------------------------- */
/* per-section structural validators (declarative; no throw)                   */
/* --------------------------------------------------------------------------- */
function validateDataSource(d, i) {
  if (!isPlainObject(d)) return `data[${i}] must be an object`;
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) return `data[${i}].id missing or malformed`;
  if (!DATA_KINDS.includes(d.kind)) return `data[${i}].kind not in {${DATA_KINDS.join('|')}}`;
  if ('dtype' in d && !DTYPES.includes(d.dtype)) return `data[${i}].dtype not in {${DTYPES.join('|')}}`;
  if ('shape' in d && (!Array.isArray(d.shape) || d.shape.some((n) => !Number.isInteger(n) || n < 0)))
    return `data[${i}].shape must be an array of non-negative integers`;
  return null;
}

function validateEncodeSpec(enc, where) {
  if (enc === undefined) return null; // optional
  if (!isPlainObject(enc)) return `${where}.encode must be an object`;
  if ('encode' in enc) {
    const map = enc.encode;
    if (!isPlainObject(map)) return `${where}.encode.encode must be an object`;
    for (const ch of Object.keys(map)) {
      if (!CHANNELS.includes(ch)) return `${where}.encode.encode has channel "${ch}" outside the closed set {${CHANNELS.join('|')}}`;
      const b = map[ch];
      if (!isPlainObject(b)) return `${where}.encode.encode.${ch} must be a binding object`;
      if (b.scale !== undefined) {
        if (!isPlainObject(b.scale) || !SCALE_TYPES.includes(b.scale.type))
          return `${where}.encode.encode.${ch}.scale.type not in {${SCALE_TYPES.join('|')}}`;
      }
    }
  }
  return null;
}

function validateObject(o, where) {
  if (!isPlainObject(o)) return `${where} must be an object`;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return `${where}.id missing or malformed`;
  if (typeof o.registryId !== 'string' || !ID_RE.test(o.registryId)) return `${where}.registryId missing or malformed`;
  if ('params' in o && !isPlainObject(o.params)) return `${where}.params must be an object`;
  const encErr = validateEncodeSpec(o.encode, where);
  if (encErr) return encErr;
  if ('dynamics' in o) {
    if (!Array.isArray(o.dynamics)) return `${where}.dynamics must be an array`;
    for (let j = 0; j < o.dynamics.length; j++) { const e = validateDynamic(o.dynamics[j], `${where}.dynamics[${j}]`); if (e) return e; }
  }
  if ('effects' in o) {
    if (!Array.isArray(o.effects)) return `${where}.effects must be an array`;
    for (let j = 0; j < o.effects.length; j++) { const e = validateEffect(o.effects[j], `${where}.effects[${j}]`); if (e) return e; }
  }
  return null;
}

/** Declarative ORCHESTRATION vocabularies (ADR-D4 / INV-5). A multi-object
 *  orchestration block (Story P5.3) is a DECLARATIVE parameter map embedded in a
 *  dynamics[] entry's `params.spec` — triggers/dependencies/conditions are plain
 *  data, NEVER serialized functions. These closed sets mirror engine/dynamics'
 *  orchestrator + day/night and are duplicated here as plain constants (the
 *  firewall forbids importing engine/dynamics). A drift is a breaking, versioned
 *  change keyed by the conformance suite. */
export const ORCH_TRIGGER_KINDS = Object.freeze(['always', 'at', 'after', 'while']);
export const ORCH_CONDITION_OPS = Object.freeze(['lt', 'lte', 'gt', 'gte', 'eq', 'between']);

/** Validate a declarative Condition `{signal, op, value|min,max}` (no functions). */
function validateCondition(c, where) {
  if (!isPlainObject(c)) return `${where} must be an object`;
  if (typeof c.signal !== 'string' || !c.signal) return `${where}.signal must be a non-empty string`;
  if (!ORCH_CONDITION_OPS.includes(c.op)) return `${where}.op not in {${ORCH_CONDITION_OPS.join('|')}}`;
  if (c.op === 'between') {
    if (typeof c.min !== 'number' || typeof c.max !== 'number') return `${where} (op "between") needs numeric min+max`;
  } else if (typeof c.value !== 'number') {
    return `${where} (op "${c.op}") needs a numeric value`;
  }
  return null;
}

/** Validate ONE declarative orchestration node. Triggers/deps/condition are plain
 *  parameter maps — embedded EncodeSpec-style declarative data, NO functions (INV-5). */
function validateOrchNode(node, where) {
  if (!isPlainObject(node)) return `${where} must be an object`;
  if (typeof node.id !== 'string' || !ID_RE.test(node.id)) return `${where}.id missing or malformed`;
  if (typeof node.registryId !== 'string' || !ID_RE.test(node.registryId)) return `${where}.registryId missing or malformed`;
  if ('params' in node && !isPlainObject(node.params)) return `${where}.params must be an object`;
  if ('dependsOn' in node) {
    if (!Array.isArray(node.dependsOn)) return `${where}.dependsOn must be an array of node ids`;
    for (let i = 0; i < node.dependsOn.length; i++) {
      if (typeof node.dependsOn[i] !== 'string' || !ID_RE.test(node.dependsOn[i])) return `${where}.dependsOn[${i}] must be a node-id string`;
    }
  }
  if ('trigger' in node && node.trigger !== null) {
    const tr = node.trigger;
    if (!isPlainObject(tr)) return `${where}.trigger must be an object`;
    if (!ORCH_TRIGGER_KINDS.includes(tr.kind)) return `${where}.trigger.kind not in {${ORCH_TRIGGER_KINDS.join('|')}}`;
    if (tr.kind === 'at' && typeof tr.t !== 'number') return `${where}.trigger (kind "at") needs a numeric t`;
    if (tr.kind === 'after' && (typeof tr.ref !== 'string' || !ID_RE.test(tr.ref))) return `${where}.trigger (kind "after") needs a node-id ref`;
    if (tr.kind === 'while') { const e = validateCondition(tr.cond, `${where}.trigger.cond`); if (e) return e; }
  }
  if ('condition' in node && node.condition !== null) { const e = validateCondition(node.condition, `${where}.condition`); if (e) return e; }
  return null;
}

/** Validate an embedded declarative orchestration spec `{nodes:[...]}` (if present).
 *  ADDITIVE: only runs when a dynamics[] entry carries `params.spec.nodes` — a plain
 *  declarative graph. Confirms it is serialization-first (no functions; closed
 *  trigger/condition vocabularies), re-creatable by the factory on load (INV-5). */
function validateOrchestrationSpec(spec, where) {
  if (spec === undefined) return null;                  // optional block
  if (!isPlainObject(spec)) return `${where} must be an object`;
  if (!('nodes' in spec)) return null;                  // a spec without nodes is a no-op graph (valid)
  if (!Array.isArray(spec.nodes)) return `${where}.nodes must be an array`;
  for (let i = 0; i < spec.nodes.length; i++) { const e = validateOrchNode(spec.nodes[i], `${where}.nodes[${i}]`); if (e) return e; }
  return null;
}

function validateDynamic(d, where) {
  if (!isPlainObject(d)) return `${where} must be an object`;
  if (typeof d.registryId !== 'string' || !ID_RE.test(d.registryId)) return `${where}.registryId missing or malformed`;
  if ('id' in d && (typeof d.id !== 'string' || !ID_RE.test(d.id))) return `${where}.id malformed`;
  if ('params' in d && !isPlainObject(d.params)) return `${where}.params must be an object`;
  // ADDITIVE (P5.3): if this dynamic embeds a declarative orchestration spec, validate
  // the declarative trigger/dependsOn/condition graph (no functions — INV-5).
  if (isPlainObject(d.params) && 'spec' in d.params) {
    const e = validateOrchestrationSpec(d.params.spec, `${where}.params.spec`);
    if (e) return e;
  }
  return null;
}

function validateEffect(e, where) {
  if (!isPlainObject(e)) return `${where} must be an object`;
  if (typeof e.registryId !== 'string' || !ID_RE.test(e.registryId)) return `${where}.registryId missing or malformed`;
  if ('id' in e && (typeof e.id !== 'string' || !ID_RE.test(e.id))) return `${where}.id malformed`;
  if ('params' in e && !isPlainObject(e.params)) return `${where}.params must be an object`;
  if ('quarks' in e && !isPlainObject(e.quarks)) return `${where}.quarks must be an object (three.quarks JSON)`;
  return null;
}

function validateScene(s, where) {
  if (!isPlainObject(s)) return `${where} must be an object`;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return `${where}.id missing or malformed`;
  if (typeof s.registryId !== 'string' || !ID_RE.test(s.registryId)) return `${where}.registryId missing or malformed`;
  if ('params' in s && !isPlainObject(s.params)) return `${where}.params must be an object`;
  if ('objects' in s) {
    if (!Array.isArray(s.objects)) return `${where}.objects must be an array`;
    for (let j = 0; j < s.objects.length; j++) { const e = validateObject(s.objects[j], `${where}.objects[${j}]`); if (e) return e; }
  }
  return null;
}

/* --------------------------------------------------------------------------- */
/* validate(doc) -> {ok:true, doc} | {ok:false, reason}  (never a partial doc)  */
/* --------------------------------------------------------------------------- */
export function validate(doc) {
  if (!isPlainObject(doc)) return fail('document must be a JSON object');

  // exact top-level shape: exactly the seven keys, no more, no less.
  for (const k of TOP_KEYS) if (!(k in doc)) return fail(`missing required key "${k}"`);
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) return fail(`unexpected top-level key "${k}"`);

  if (doc.format !== FORMAT) return fail(`format must be "${FORMAT}"`);
  if (typeof doc.schemaVersion !== 'string' || !SEMVER_RE.test(doc.schemaVersion))
    return fail('schemaVersion must be a semver string "MAJOR.MINOR.PATCH"');

  for (const k of ARRAY_KEYS) if (!Array.isArray(doc[k])) return fail(`"${k}" must be an array`);

  // INV-5: no serialized functions / code anywhere in the document.
  if (!hasNoFunctions(doc)) return fail('document contains serialized functions (INV-5: declarative parameter maps only)');

  // per-section structural validation.
  for (let i = 0; i < doc.data.length; i++) { const e = validateDataSource(doc.data[i], i); if (e) return fail(e); }
  for (let i = 0; i < doc.scenes.length; i++) { const e = validateScene(doc.scenes[i], `scenes[${i}]`); if (e) return fail(e); }
  for (let i = 0; i < doc.objects.length; i++) { const e = validateObject(doc.objects[i], `objects[${i}]`); if (e) return fail(e); }
  for (let i = 0; i < doc.dynamics.length; i++) { const e = validateDynamic(doc.dynamics[i], `dynamics[${i}]`); if (e) return fail(e); }
  for (let i = 0; i < doc.effects.length; i++) { const e = validateEffect(doc.effects[i], `effects[${i}]`); if (e) return fail(e); }

  return { ok: true, doc };
}

/* --------------------------------------------------------------------------- */
/* migrate(doc) -> forward-migration chain STUB (ADR-D4)                        */
/*  v1.0.0 passes through UNCHANGED. Future versions register a step here.      */
/* --------------------------------------------------------------------------- */

/**
 * Forward-migration chain. Each entry migrates FROM the keyed version to the
 * next. v1.0.0 is the schema-v1 baseline and has NO predecessor migration, so
 * it passes through unchanged. (STUB: no real migrations exist yet.)
 * @type {Record<string, (doc:object)=>object>}
 */
const MIGRATIONS = Object.freeze({
  // '1.0.0': (doc) => ({ ...doc, schemaVersion: '1.1.0', /* ...transform... */ }),
});

export function migrate(doc) {
  if (!isPlainObject(doc)) return fail('document must be a JSON object');
  if (typeof doc.schemaVersion !== 'string' || !SEMVER_RE.test(doc.schemaVersion))
    return fail('schemaVersion must be a semver string to migrate');

  let cur = doc;
  const seen = new Set();
  // walk the forward chain until no migration applies (bounded to avoid cycles).
  while (Object.prototype.hasOwnProperty.call(MIGRATIONS, cur.schemaVersion)) {
    if (seen.has(cur.schemaVersion)) return fail(`migration cycle detected at ${cur.schemaVersion}`);
    seen.add(cur.schemaVersion);
    const step = MIGRATIONS[cur.schemaVersion];
    cur = step(cur);
    if (!isPlainObject(cur)) return fail('migration step produced a non-object');
  }

  // the migrated document must still validate.
  const v = validate(cur);
  if (!v.ok) return v;
  return { ok: true, doc: cur };
}

/* --------------------------------------------------------------------------- */
/* saveProject(state) / loadProject(doc)  — round-trip STUBS (INV-5)            */
/*  Serialize registry ids + params + encode/quarks JSON ONLY.                  */
/*  NEVER live GPU objects; loadProject re-creates declarative state, no handles.*/
/* --------------------------------------------------------------------------- */

/**
 * Serialize an in-memory authoring STATE into a project document. The state is
 * already a plain declarative object in this skeleton (registry ids + params +
 * embedded EncodeSpec / three.quarks JSON); saveProject normalizes its shape,
 * stamps format + schemaVersion, and validates. It serializes NO live GPU
 * objects (no THREE handles, no buffers) — only ids + params.
 */
export function saveProject(state) {
  if (!isPlainObject(state)) return fail('state must be an object');

  const doc = {
    format: FORMAT,
    schemaVersion: typeof state.schemaVersion === 'string' ? state.schemaVersion : SCHEMA_VERSION,
  };
  for (const k of ARRAY_KEYS) {
    const arr = state[k];
    doc[k] = Array.isArray(arr) ? arr : [];
  }

  // deep-clone through JSON to guarantee no live handles / functions leak in.
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(doc));
  } catch {
    return fail('state is not JSON-serializable (live objects / cycles not allowed)');
  }

  return validate(plain);
}

/**
 * Load a project document into an in-memory authoring STATE. In this P1 skeleton
 * the "state" is the validated, migrated declarative document itself (the
 * runtime would later derive handles by calling registry factories with these
 * params). It re-creates NO live GPU objects.
 *
 * P7.4 (ADDITIVE, OPT-IN): pass `opts.clamp:true` (+ optional `opts.controlTables`)
 * to CLAMP-ON-INGEST untrusted input — numerics to control min/max/step, counts to
 * caps (INV-4), colours sub-white (INV-3), non-allowlisted asset URLs rejected, and
 * "code in data" dropped (INV-5). The default (no opts) is the unchanged P1 behavior
 * so the existing round-trip stays byte-identical. The clamped load NEVER throws and
 * returns the safe `state` plus a `report` of every clamp (audit). When clamping, a
 * doc that does not even validate still hands back a typed reject (never a partial).
 *
 * @param {object} doc
 * @param {{clamp?:boolean, controlTables?:object}} [opts]
 *   controlTables: { <registryId>: { <paramKey>: <controlDescriptor> }, ... } — the
 *   registry `list()` controls, supplied by the caller so engine/serialize stays
 *   firewall-clean (it never imports a registry).
 */
export function loadProject(doc, opts) {
  if (opts && opts.clamp) {
    const c = clampProject(doc, opts.controlTables || {});
    if (!c.ok) return c;                                  // typed reject — never a partial
    const state = JSON.parse(JSON.stringify(c.doc));
    return { ok: true, state, report: c.report };
  }
  const m = migrate(doc);
  if (!m.ok) return m;
  // a defensive deep clone so the returned state shares no reference with the input.
  const state = JSON.parse(JSON.stringify(m.doc));
  return { ok: true, state };
}

/* --------------------------------------------------------------------------- */
/* clampProject(doc, controlTables)  — P7.4 SECURITY CLOSURE                    */
/*  "tolerate garbage, never throw, hand back a SAFE handle" on untrusted input. */
/*  Migrate + validate first (typed reject on a malformed/forbidden doc), THEN  */
/*  clamp every section's `params` (numbers/counts/colours/asset-urls) and DROP  */
/*  any "code in data" at the per-binding grain. Returns the safe doc + a report */
/*  of every clamp (audit). NEVER widens a value; NEVER invents one.            */
/* --------------------------------------------------------------------------- */

/** the param-bearing sections of the doc whose `params` are clamped on ingest. */
const CLAMP_SECTIONS = Object.freeze(['scenes', 'objects', 'dynamics', 'effects']);

/** clamp ONE section entry's params in place on a fresh clone; record changes. */
function clampSectionEntry(entry, controlTables, where, report) {
  if (!isPlainObject(entry)) return entry;
  const out = {};
  for (const k of Object.keys(entry)) out[k] = entry[k];
  const regId = typeof entry.registryId === 'string' ? entry.registryId : null;
  const table = (regId && isPlainObject(controlTables) && isPlainObject(controlTables[regId])) ? controlTables[regId] : {};
  if (isPlainObject(entry.params)) {
    const r = _clampParams(entry.params, table);
    out.params = r.params;
    for (const ch of r.changes) report.push({ where: `${where}.params`, registryId: regId, ...ch });
  }
  // nested objects[] inside a scene are clamped recursively (same discipline).
  if (Array.isArray(entry.objects)) {
    out.objects = entry.objects.map((o, j) => clampSectionEntry(o, controlTables, `${where}.objects[${j}]`, report));
  }
  // an object's embedded dynamics[] / effects[] params are clamped too.
  if (Array.isArray(entry.dynamics)) {
    out.dynamics = entry.dynamics.map((d, j) => clampSectionEntry(d, controlTables, `${where}.dynamics[${j}]`, report));
  }
  if (Array.isArray(entry.effects)) {
    out.effects = entry.effects.map((e, j) => clampSectionEntry(e, controlTables, `${where}.effects[${j}]`, report));
  }
  return out;
}

export function clampProject(doc, controlTables = {}) {
  // migrate + validate first: a malformed/forbidden doc gets the SAME typed reject
  // as the unclamped path (no partial; the security pass does not loosen validation).
  const m = migrate(doc);
  if (!m.ok) return m;
  const report = [];
  const safe = { format: m.doc.format, schemaVersion: m.doc.schemaVersion };
  // `data` carries no clampable control params (shape/src only) — passed through.
  safe.data = Array.isArray(m.doc.data) ? JSON.parse(JSON.stringify(m.doc.data)) : [];
  for (const section of CLAMP_SECTIONS) {
    const arr = Array.isArray(m.doc[section]) ? m.doc[section] : [];
    safe[section] = arr.map((entry, i) => clampSectionEntry(entry, controlTables, `${section}[${i}]`, report));
  }
  // the clamped doc must STILL validate (clamping never produces an invalid doc).
  const v = validate(safe);
  if (!v.ok) return v;
  return { ok: true, doc: v.doc, report };
}

export { ASSET_ORIGINS, COLOR_SUBWHITE_MAX };
/** Re-export the asset-URL guard so the host loader can pre-check a URL (no-op on 404). */
export function isAllowedAssetUrl(url, policy) { return _isAllowedAssetUrl(url, policy); }
/** Re-export the per-value clamp for the copilot re-apply path (defence in depth, P7.4). */
export function clampValue(key, value, control) { return _clampValue(key, value, control); }

export default { FORMAT, SCHEMA_VERSION, CHANNELS, DATA_KINDS, SCALE_TYPES, DTYPES, ORCH_TRIGGER_KINDS, ORCH_CONDITION_OPS, ASSET_ORIGINS, COLOR_SUBWHITE_MAX, validate, migrate, saveProject, loadProject, clampProject, clampValue, isAllowedAssetUrl };
