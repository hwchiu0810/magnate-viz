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
 *    loadProject(doc)     -> { ok:true, state } | { ok:false, reason } (no live GPU objects)
 *    SCHEMA_VERSION, FORMAT, CHANNELS, DATA_KINDS, SCALE_TYPES, DTYPES (frozen vocab)
 * ========================================================================== */

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

function validateDynamic(d, where) {
  if (!isPlainObject(d)) return `${where} must be an object`;
  if (typeof d.registryId !== 'string' || !ID_RE.test(d.registryId)) return `${where}.registryId missing or malformed`;
  if ('id' in d && (typeof d.id !== 'string' || !ID_RE.test(d.id))) return `${where}.id malformed`;
  if ('params' in d && !isPlainObject(d.params)) return `${where}.params must be an object`;
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
 */
export function loadProject(doc) {
  const m = migrate(doc);
  if (!m.ok) return m;
  // a defensive deep clone so the returned state shares no reference with the input.
  const state = JSON.parse(JSON.stringify(m.doc));
  return { ok: true, state };
}

export default { FORMAT, SCHEMA_VERSION, CHANNELS, DATA_KINDS, SCALE_TYPES, DTYPES, validate, migrate, saveProject, loadProject };
