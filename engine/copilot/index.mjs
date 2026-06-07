/* =============================================================================
 *  engine/copilot/index.mjs  —  the typed COPILOT TOOL-API  (Epic P6, ADR-D5)
 *
 *  WHAT THIS IS: the typed, validated COPILOT TOOL-API whose action space is
 *  EXACTLY the four registries (Scene/Object/Dynamics/VFX) + the encoding grammar
 *  (engine/encode) + the data spine (engine/data) + the project document
 *  (engine/serialize). It VALIDATES every call BEFORE dispatch and emits a
 *  SERIALIZABLE DIFF to the in-memory project document. Every action is replayable
 *  (the diff log is the audit trail / undo source); rejects are TYPED.
 *
 *  THE TOOL-API IS THE SOLE AUTHZ SURFACE (INV-6 / §Security Architecture):
 *    - the copilot can do ONLY what these typed actions allow;
 *    - it CANNOT reach the renderer, the DOM, the network, or any host app —
 *      there is no such verb in the action space (unrepresentable, not merely
 *      denied);
 *    - every action is a declarative project mutation; the runtime handle is
 *      DERIVED from the resulting spec, never the reverse (INV-5);
 *    - the action space is the SAME surface a human uses in editor/ — no
 *      privileged path.
 *
 *  TYPED REJECTS (the closed reject vocabulary, §Error Handling):
 *    UNKNOWN_ID | PARAM_OUT_OF_RANGE | BAD_CHANNEL | SHAPE_MISMATCH
 *  plus the structural NOT_FOUND / BAD_REQUEST for malformed calls. A reject is a
 *  RETURNED VALUE `{ ok:false, code, reason }` — NEVER a throw, NEVER a partial
 *  or silent mutation.
 *
 *  FIREWALL (INV-6): imports ONLY engine/** (encode + serialize + data) and the
 *  local prompt parser. It hard-imports NO THREE / NO Tweakpane, and NOTHING from
 *  apps/**, editor/**, conformance/**. The four registries are INJECTED as plain
 *  `list()` descriptor arrays via createCopilot({ capabilities }) — engine/copilot
 *  never imports a pillar registry directly (VFX in particular lives in the
 *  browser prototype, not in engine/), so the copilot stays generic + headless.
 *
 *  AI RUNTIME (D5, CORRECTED — supersedes the retired "server seam"): the AI
 *  runtime is the **Claude CLI** — the developer's Claude Code session, developer-
 *  in-the-loop. There is NO in-app model, NO API key, NO network, NO live-LLM call
 *  in this module or this repo. The frontend prompt generator (./generate.mjs)
 *  emits a PRELIMINARY markdown prompt the developer copies into the Claude CLI,
 *  refines, and implements locally. This Tool-API is the DETERMINISTIC APPLY path
 *  the CLI can emit: applyToolCalls() RE-VALIDATES + RE-APPLIES tool calls through
 *  this exact surface, so an implemented change is replayable + serializable. The
 *  local DSL path (runPrompt) is the same deterministic apply path. See
 *  ./runtime-doc.mjs for the runtime model statement.
 * ========================================================================== */

import * as encode from '../encode/index.mjs';
import * as serialize from '../serialize/index.mjs';
import { isNDArray } from '../data/index.mjs';
import { clampValue } from '../serialize/clamp.mjs';
import { suggestEncoding as _suggestEncoding, describeShape } from './suggest.mjs';
import { parsePrompt } from './prompt.mjs';
import { generatePrompt as _generatePrompt } from './generate.mjs';

/** Module identity (semver). */
export const VERSION = '0.1.0-p6.1-copilot';
/** Human-readable module identity. */
export const NAME = 'engine/copilot';

/** The closed channel set (mirrors engine/encode CHANNELS — keyed exactly). */
export const CHANNELS = encode.CHANNELS;

/** The closed TYPED-REJECT vocabulary (§Error Handling). */
export const REJECT_CODES = Object.freeze([
  'UNKNOWN_ID', 'PARAM_OUT_OF_RANGE', 'BAD_CHANNEL', 'SHAPE_MISMATCH',
  'NOT_FOUND', 'BAD_REQUEST',
]);

/** The four pillars the action space spans (each a `list()` descriptor array). */
export const PILLARS = Object.freeze(['scene', 'object', 'dynamics', 'effect']);

/** The complete tool-name set — the ENTIRE action space (FR9). */
export const TOOL_NAMES = Object.freeze([
  'createScene', 'addObject', 'bindData', 'setDynamics', 'applyEffect', 'setParams',
  'projectData', 'removeObject', 'removeEffect', 'listCapabilities', 'suggestEncoding',
  'explain', 'critique', 'saveProject', 'loadProject',
]);

/* -----------------------------------------------------------------------------
 *  Pure helpers + the typed reject constructors.
 * ------------------------------------------------------------------------- */
function reject(code, reason) { return { ok: false, code, reason }; }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
const ID_RE = /^[A-Za-z0-9._:/+-]+$/;

/** A deterministic, seedable id minter (NO global RNG / NO wall-clock — INV-1).
 *  ids are `<prefix>-<counter>` so a replay of the same call sequence reproduces
 *  the same ids bit-identically. */
function makeMinter() {
  const counters = Object.create(null);
  return function mint(prefix) {
    const n = (counters[prefix] = (counters[prefix] || 0) + 1);
    return `${prefix}-${n}`;
  };
}

/* -----------------------------------------------------------------------------
 *  Capability index — built ONCE from the injected `list()` descriptor arrays.
 *  This is the copilot's read-model of the registries. It carries id -> {pillar,
 *  controls, params, kind, category} so validation never needs the live registry.
 * ------------------------------------------------------------------------- */
function indexCapabilities(capabilities) {
  const cap = isPlainObject(capabilities) ? capabilities : {};
  const byId = Object.create(null);
  const byPillar = Object.create(null);
  const lists = {
    scene: Array.isArray(cap.scene) ? cap.scene : [],
    object: Array.isArray(cap.object) ? cap.object : [],
    dynamics: Array.isArray(cap.dynamics) ? cap.dynamics : [],
    effect: Array.isArray(cap.effect) ? cap.effect : [],
  };
  for (const pillar of PILLARS) {
    byPillar[pillar] = [];
    for (const desc of lists[pillar]) {
      if (!desc || typeof desc.id !== 'string') continue;
      const entry = {
        pillar,
        id: desc.id,
        kind: desc.kind || '',
        category: desc.category || 'General',
        params: isPlainObject(desc.params) ? desc.params : {},
        controls: isPlainObject(desc.controls) ? desc.controls : {},
      };
      // a pillar-qualified key disambiguates a (rare) id collision across pillars.
      byPillar[pillar].push(entry);
      if (!byId[desc.id]) byId[desc.id] = entry;        // first registration wins per bare id
      byId[`${pillar}:${desc.id}`] = entry;             // always available pillar-qualified
    }
  }
  return { byId, byPillar };
}

/* -----------------------------------------------------------------------------
 *  PARAM RANGE VALIDATION — params within the `controls` min/max/step ranges.
 *  Returns null (ok) or a {key, reason} on the FIRST out-of-range param so the
 *  whole call rejects with NO partial mutation. Numbers checked against
 *  min/max; vectors element-wise; selects against options; bools against type;
 *  colours against [0,1] (sub-white is enforced separately at apply via clamp).
 * ------------------------------------------------------------------------- */
function checkParams(params, controls) {
  if (!isPlainObject(params)) return null;              // no params is fine (defaults apply)
  for (const key of Object.keys(params)) {
    const c = controls[key];
    const v = params[key];
    if (!c) continue;                                   // unknown param key -> no range to check (dropped/ignored downstream)
    if (c.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { key, reason: `param "${key}" must be a finite number` };
      if (typeof c.min === 'number' && v < c.min) return { key, reason: `param "${key}"=${v} below min ${c.min}` };
      if (typeof c.max === 'number' && v > c.max) return { key, reason: `param "${key}"=${v} above max ${c.max}` };
    } else if (c.type === 'vector') {
      if (!Array.isArray(v)) return { key, reason: `param "${key}" must be a numeric vector` };
      if (typeof c.length === 'number' && v.length !== c.length) return { key, reason: `param "${key}" must have length ${c.length}` };
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return { key, reason: `param "${key}"[${i}] must be a finite number` };
        if (typeof c.min === 'number' && v[i] < c.min) return { key, reason: `param "${key}"[${i}]=${v[i]} below min ${c.min}` };
        if (typeof c.max === 'number' && v[i] > c.max) return { key, reason: `param "${key}"[${i}]=${v[i]} above max ${c.max}` };
      }
    } else if (c.type === 'select') {
      if (Array.isArray(c.options) && !c.options.includes(v)) return { key, reason: `param "${key}"="${String(v)}" not in options ${JSON.stringify(c.options)}` };
    } else if (c.type === 'bool') {
      if (typeof v !== 'boolean') return { key, reason: `param "${key}" must be a boolean` };
    } else if (c.type === 'color') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (typeof v[i] !== 'number' || v[i] < 0 || v[i] > 1) return { key, reason: `param "${key}"[${i}] colour channel must be in [0,1]` };
      } else if (typeof v !== 'number') {
        return { key, reason: `param "${key}" must be an [r,g,b] array or a hex number` };
      }
    }
    // colorList/numberList/list/text/ref: structural only — no numeric range.
  }
  return null;
}

/* =============================================================================
 *  createCopilot({ capabilities, project?, dataMap? }) — the Tool-API instance.
 *
 *  capabilities: { scene:[...], object:[...], dynamics:[...], effect:[...] } —
 *    each a registry `list()` descriptor array (INJECTED; the firewall forbids
 *    importing the pillar registries here).
 *  project:  an OPTIONAL starting project document (validated on construct; a bad
 *    doc is a TYPED reject returned by `errors()` — construction never throws).
 *  dataMap:  an OPTIONAL map of dataRef -> NDArray|array for suggestEncoding /
 *    projectData / bindData shape checks (headless; no GPU).
 * ========================================================================== */
export function createCopilot(opts = {}) {
  const o = isPlainObject(opts) ? opts : {};
  const caps = indexCapabilities(o.capabilities);
  const mint = makeMinter();
  const dataMap = isPlainObject(o.dataMap) ? { ...o.dataMap } : {};

  // The in-memory project document — the AUTHORITATIVE serialization-first state.
  let doc = {
    format: serialize.FORMAT,
    schemaVersion: serialize.SCHEMA_VERSION,
    data: [], scenes: [], objects: [], dynamics: [], effects: [],
  };
  let constructError = null;
  if (o.project !== undefined) {
    const v = serialize.validate(o.project);
    if (!v.ok) constructError = reject('BAD_REQUEST', `initial project invalid: ${v.reason}`);
    else doc = JSON.parse(JSON.stringify(v.doc));
  }

  // The serializable DIFF LOG — every applied action, in order, replayable (INV-5).
  const diffs = [];

  /** record a serializable diff + return it inside the success envelope. */
  function emit(op, path, value, result) {
    const diff = { op, path, value: JSON.parse(JSON.stringify(value ?? null)) };
    diffs.push(diff);
    return { ok: true, ...result, diff };
  }

  /** locate a target object/effect/dynamic by id across the doc. */
  function findObject(objectId) {
    for (let i = 0; i < doc.objects.length; i++) if (doc.objects[i].id === objectId) return { arr: doc.objects, i, kind: 'object' };
    for (let s = 0; s < doc.scenes.length; s++) {
      const objs = doc.scenes[s].objects;
      if (Array.isArray(objs)) for (let i = 0; i < objs.length; i++) if (objs[i].id === objectId) return { arr: objs, i, kind: 'object', scene: s };
    }
    return null;
  }
  function findScene(sceneId) {
    for (let i = 0; i < doc.scenes.length; i++) if (doc.scenes[i].id === sceneId) return { arr: doc.scenes, i };
    return null;
  }
  function findEffect(effectInstanceId) {
    for (let i = 0; i < doc.effects.length; i++) if (doc.effects[i].id === effectInstanceId) return { arr: doc.effects, i };
    // also search per-object embedded effects
    const objs = allObjects();
    for (const ref of objs) {
      const eff = ref.obj.effects;
      if (Array.isArray(eff)) for (let i = 0; i < eff.length; i++) if (eff[i].id === effectInstanceId) return { arr: eff, i, host: ref };
    }
    return null;
  }
  function allObjects() {
    const out = [];
    for (const obj of doc.objects) out.push({ obj });
    for (const sc of doc.scenes) if (Array.isArray(sc.objects)) for (const obj of sc.objects) out.push({ obj, scene: sc });
    return out;
  }
  function capFor(id, pillar) {
    if (pillar && caps.byId[`${pillar}:${id}`]) return caps.byId[`${pillar}:${id}`];
    return caps.byId[id] || null;
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: createScene(spec) -> { sceneId } | typed reject
   *    spec.registryId ∈ SceneRegistry.list(); params range-checked.
   * ------------------------------------------------------------------------- */
  function createScene(spec) {
    if (!isPlainObject(spec)) return reject('BAD_REQUEST', 'createScene: spec must be an object');
    const regId = spec.registryId;
    if (typeof regId !== 'string') return reject('BAD_REQUEST', 'createScene: spec.registryId must be a string');
    const cap = capFor(regId, 'scene');
    if (!cap || cap.pillar !== 'scene') return reject('UNKNOWN_ID', `createScene: scene registryId "${regId}" not in SceneRegistry`);
    const pr = checkParams(spec.params, cap.controls);
    if (pr) return reject('PARAM_OUT_OF_RANGE', `createScene: ${pr.reason}`);
    const sceneId = (typeof spec.id === 'string' && ID_RE.test(spec.id)) ? spec.id : mint('scene');
    if (findScene(sceneId)) return reject('BAD_REQUEST', `createScene: scene id "${sceneId}" already exists`);
    const entry = { id: sceneId, registryId: regId, params: isPlainObject(spec.params) ? { ...spec.params } : {}, objects: [] };
    doc.scenes.push(entry);
    return emit('add', `scenes/${sceneId}`, entry, { sceneId });
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: addObject(sceneId, spec) -> { objectId } | typed reject
   * ------------------------------------------------------------------------- */
  function addObject(sceneId, spec) {
    const sc = findScene(sceneId);
    if (!sc) return reject('NOT_FOUND', `addObject: scene "${sceneId}" not found`);
    if (!isPlainObject(spec)) return reject('BAD_REQUEST', 'addObject: spec must be an object');
    const regId = spec.registryId;
    const cap = capFor(regId, 'object');
    if (!cap || cap.pillar !== 'object') return reject('UNKNOWN_ID', `addObject: object registryId "${String(regId)}" not in ObjectRegistry`);
    const pr = checkParams(spec.params, cap.controls);
    if (pr) return reject('PARAM_OUT_OF_RANGE', `addObject: ${pr.reason}`);
    // an embedded encode spec (optional) must validate clean (no half-encoded object).
    if (spec.encode !== undefined) {
      const ev = encode.validate(spec.encode.encode ? spec.encode : { encode: {}, ...spec.encode });
      if (!ev.ok) return reject('SHAPE_MISMATCH', `addObject: embedded encode invalid: ${ev.errors.join('; ')}`);
    }
    const objectId = (typeof spec.id === 'string' && ID_RE.test(spec.id)) ? spec.id : mint('object');
    if (findObject(objectId)) return reject('BAD_REQUEST', `addObject: object id "${objectId}" already exists`);
    const entry = { id: objectId, registryId: regId, params: isPlainObject(spec.params) ? { ...spec.params } : {} };
    if (spec.encode !== undefined) entry.encode = JSON.parse(JSON.stringify(spec.encode));
    doc.scenes[sc.i].objects.push(entry);
    return emit('add', `scenes/${sceneId}/objects/${objectId}`, entry, { objectId });
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: bindData(targetId, binding) -> { ok } | typed reject
   *    binding is the D3 EncodeSpec; channels ∈ closed set, scales ∈ vocab,
   *    and (if dataMap present) the accessor shape is compile-checked.
   * ------------------------------------------------------------------------- */
  function bindData(targetId, binding) {
    const t = findObject(targetId);
    if (!t) return reject('NOT_FOUND', `bindData: target object "${targetId}" not found`);
    if (!isPlainObject(binding)) return reject('BAD_REQUEST', 'bindData: binding (EncodeSpec) must be an object');
    const spec = binding.encode ? binding : { encode: binding };
    const ev = encode.validate(spec);
    if (!ev.ok) {
      // distinguish a bad channel from other shape errors for the typed code.
      const badChan = ev.errors.find((e) => /not in the closed set/.test(e));
      if (badChan) return reject('BAD_CHANNEL', `bindData: ${badChan}`);
      return reject('SHAPE_MISMATCH', `bindData: ${ev.errors.join('; ')}`);
    }
    // if we have the data, compile it headless to confirm the accessor shape matches.
    if (Object.keys(dataMap).length > 0) {
      const compiled = encode.compile(spec, dataMap);
      if (compiled && compiled.ok === false) return reject('SHAPE_MISMATCH', `bindData: ${compiled.errors.join('; ')}`);
    }
    t.arr[t.i].encode = JSON.parse(JSON.stringify(spec));
    return emit('set', `objects/${targetId}/encode`, spec, {});
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: setDynamics(targetId, spec) -> { ok } | typed reject
   *    spec.registryId ∈ DynamicsRegistry.list(); params range-checked.
   * ------------------------------------------------------------------------- */
  function setDynamics(targetId, spec) {
    const t = findObject(targetId);
    if (!t) return reject('NOT_FOUND', `setDynamics: target object "${targetId}" not found`);
    if (!isPlainObject(spec)) return reject('BAD_REQUEST', 'setDynamics: spec must be an object');
    const regId = spec.registryId;
    const cap = capFor(regId, 'dynamics');
    if (!cap || cap.pillar !== 'dynamics') return reject('UNKNOWN_ID', `setDynamics: dynamics registryId "${String(regId)}" not in DynamicsRegistry`);
    const pr = checkParams(spec.params, cap.controls);
    if (pr) return reject('PARAM_OUT_OF_RANGE', `setDynamics: ${pr.reason}`);
    const entry = { registryId: regId, params: isPlainObject(spec.params) ? { ...spec.params } : {} };
    if (typeof spec.id === 'string' && ID_RE.test(spec.id)) entry.id = spec.id;
    const obj = t.arr[t.i];
    if (!Array.isArray(obj.dynamics)) obj.dynamics = [];
    obj.dynamics.push(entry);
    return emit('add', `objects/${targetId}/dynamics`, entry, {});
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: applyEffect(targetId, effectId, params) -> { effectInstanceId }
   *    effectId ∈ VFX.list(); params range-checked; counts/colours CLAMPED ON
   *    INGEST (INV-3/INV-4 — same clamp-on-ingest discipline as imported files).
   * ------------------------------------------------------------------------- */
  function applyEffect(targetId, effectId, params) {
    const t = findObject(targetId);
    if (!t) return reject('NOT_FOUND', `applyEffect: target object "${targetId}" not found`);
    const cap = capFor(effectId, 'effect');
    if (!cap || cap.pillar !== 'effect') return reject('UNKNOWN_ID', `applyEffect: effect id "${String(effectId)}" not in VfxRegistry`);
    const pr = checkParams(params, cap.controls);
    if (pr) return reject('PARAM_OUT_OF_RANGE', `applyEffect: ${pr.reason}`);
    // clamp-on-ingest: counts to caps (INV-4) + colours sub-white (INV-3) + no code-in-data (INV-5).
    const safeParams = {};
    if (isPlainObject(params)) {
      for (const k of Object.keys(params)) {
        const r = clampValue(k, params[k], cap.controls[k]);
        safeParams[k] = r.value;
      }
    }
    const effectInstanceId = mint('effect');
    const entry = { id: effectInstanceId, registryId: effectId, params: safeParams, target: targetId };
    doc.effects.push(entry);
    return emit('add', `effects/${effectInstanceId}`, entry, { effectInstanceId });
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: setParams(instanceId, params) -> { ok } | typed reject
   *    range-checked against the target's controls; counts/colours clamped.
   *    instanceId may name an object, a scene, or an effect instance.
   * ------------------------------------------------------------------------- */
  function setParams(instanceId, params) {
    if (!isPlainObject(params)) return reject('BAD_REQUEST', 'setParams: params must be an object');
    let ref = null, pillar = null, path = null;
    const o2 = findObject(instanceId);
    if (o2) { ref = o2.arr[o2.i]; pillar = 'object'; path = `objects/${instanceId}/params`; }
    if (!ref) { const s = findScene(instanceId); if (s) { ref = s.arr[s.i]; pillar = 'scene'; path = `scenes/${instanceId}/params`; } }
    if (!ref) { const e = findEffect(instanceId); if (e) { ref = e.arr[e.i]; pillar = 'effect'; path = `effects/${instanceId}/params`; } }
    if (!ref) return reject('NOT_FOUND', `setParams: instance "${instanceId}" not found`);
    const cap = capFor(ref.registryId, pillar);
    if (!cap) return reject('UNKNOWN_ID', `setParams: registryId "${ref.registryId}" not in a registry`);
    const pr = checkParams(params, cap.controls);
    if (pr) return reject('PARAM_OUT_OF_RANGE', `setParams: ${pr.reason}`);
    const merged = { ...(isPlainObject(ref.params) ? ref.params : {}) };
    for (const k of Object.keys(params)) {
      const r = clampValue(k, params[k], cap.controls[k]);
      merged[k] = r.value;
    }
    ref.params = merged;
    return emit('set', path, merged, {});
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: projectData(dataRef, opts) -> { dataRef } | typed reject
   *    EXPOSES the transform layer declaratively: records a transform request as
   *    a data[] entry (op/components/seed). It does NOT run the projection here
   *    (engine/transform is the runner) — it validates + records the declarative
   *    request so the result is reproducible + serializable.
   * ------------------------------------------------------------------------- */
  const PROJECTIONS = Object.freeze(['pca', 'mds', 'umap', 'tsne', 'identity', 'slice']);
  function projectData(dataRef, opts = {}) {
    if (typeof dataRef !== 'string') return reject('BAD_REQUEST', 'projectData: dataRef must be a string id');
    const op = isPlainObject(opts) ? opts.op : undefined;
    if (!PROJECTIONS.includes(op)) return reject('UNKNOWN_ID', `projectData: op "${String(op)}" not in (${PROJECTIONS.join('|')})`);
    const src = dataMap[dataRef];
    if (src !== undefined && isNDArray(src)) {
      const comps = opts.components;
      if (comps !== undefined && (!Number.isInteger(comps) || comps < 1 || comps > (src.shape[src.shape.length - 1] || 1))) {
        return reject('SHAPE_MISMATCH', `projectData: components ${comps} invalid for shape [${src.shape.join(',')}]`);
      }
    }
    const outRef = `${dataRef}__${op}`;
    const entry = {
      id: outRef, kind: 'paramspace',
      transform: { op, components: Number.isInteger(opts.components) ? opts.components : 2, seed: Number.isInteger(opts.seed) ? opts.seed : 1, from: dataRef },
    };
    // replace an existing same-id entry (idempotent re-project) else append.
    const existing = doc.data.findIndex((d) => d.id === outRef);
    if (existing >= 0) doc.data[existing] = entry; else doc.data.push(entry);
    return emit('set', `data/${outRef}`, entry, { dataRef: outRef });
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: removeObject(objectId) / removeEffect(effectInstanceId) -> { ok }
   * ------------------------------------------------------------------------- */
  function removeObject(objectId) {
    const t = findObject(objectId);
    if (!t) return reject('NOT_FOUND', `removeObject: object "${objectId}" not found`);
    t.arr.splice(t.i, 1);
    return emit('remove', `objects/${objectId}`, null, {});
  }
  function removeEffect(effectInstanceId) {
    const e = findEffect(effectInstanceId);
    if (!e) return reject('NOT_FOUND', `removeEffect: effect "${effectInstanceId}" not found`);
    e.arr.splice(e.i, 1);
    return emit('remove', `effects/${effectInstanceId}`, null, {});
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: listCapabilities(pillar?) -> Desc[]  (READ-ONLY reflection)
   * ------------------------------------------------------------------------- */
  function listCapabilities(pillar) {
    if (pillar !== undefined) {
      if (!PILLARS.includes(pillar)) return reject('UNKNOWN_ID', `listCapabilities: pillar "${String(pillar)}" not in (${PILLARS.join('|')})`);
      return caps.byPillar[pillar].map((e) => ({ pillar: e.pillar, id: e.id, kind: e.kind, category: e.category, params: e.params, controls: e.controls }));
    }
    const out = [];
    for (const p of PILLARS) for (const e of caps.byPillar[p]) out.push({ pillar: e.pillar, id: e.id, kind: e.kind, category: e.category, params: e.params, controls: e.controls });
    return out;
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: suggestEncoding(dataRef) -> EncodeSpec | typed reject
   *    DETERMINISTIC heuristic over the data shape/kind (NO LLM). The returned
   *    spec validates clean against encode.validate.
   * ------------------------------------------------------------------------- */
  function suggestEncoding(dataRef) {
    let shape = dataRef;
    let dataKey;
    if (typeof dataRef === 'string') {
      const src = dataMap[dataRef];
      if (src === undefined) return reject('NOT_FOUND', `suggestEncoding: dataRef "${dataRef}" not in dataMap`);
      shape = src;
      dataKey = dataRef;            // accessors reference the named ref ("@<dataRef>.col")
    }
    return _suggestEncoding(shape, dataKey ? { dataKey } : undefined);
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: explain(targetId) -> string  (READ-ONLY; mutates nothing)
   * ------------------------------------------------------------------------- */
  function explain(targetId) {
    const o2 = findObject(targetId);
    if (o2) {
      const obj = o2.arr[o2.i];
      const cap = capFor(obj.registryId, 'object');
      const chans = obj.encode && obj.encode.encode ? Object.keys(obj.encode.encode) : [];
      const dyn = Array.isArray(obj.dynamics) ? obj.dynamics.map((d) => d.registryId) : [];
      return `Object "${targetId}" is a ${cap ? cap.kind || cap.id : obj.registryId} (registry "${obj.registryId}"), `
        + (chans.length ? `encoding channels [${chans.join(', ')}]` : 'with no data binding yet')
        + (dyn.length ? `, dynamics [${dyn.join(', ')}]` : '') + '.';
    }
    const s = findScene(targetId);
    if (s) {
      const sc = s.arr[s.i];
      const n = Array.isArray(sc.objects) ? sc.objects.length : 0;
      return `Scene "${targetId}" (registry "${sc.registryId}") holds ${n} object${n === 1 ? '' : 's'}.`;
    }
    const e = findEffect(targetId);
    if (e) { const eff = e.arr[e.i]; return `Effect "${targetId}" applies "${eff.registryId}" to target "${eff.target || '?'}".`; }
    return reject('NOT_FOUND', `explain: target "${targetId}" not found`);
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: critique(sceneId) -> Finding[]  (READ-ONLY; mutates nothing)
   *    Reads registries + project doc and returns findings. View-only — mirrors
   *    the headless probes that "mutate NOTHING".
   * ------------------------------------------------------------------------- */
  function critique(sceneId) {
    const s = findScene(sceneId);
    if (!s) return reject('NOT_FOUND', `critique: scene "${sceneId}" not found`);
    const sc = s.arr[s.i];
    const findings = [];
    const objs = Array.isArray(sc.objects) ? sc.objects : [];
    if (objs.length === 0) findings.push({ level: 'warn', code: 'empty-scene', message: `Scene "${sceneId}" has no objects.` });
    let colourOnly = 0, unbound = 0;
    for (const obj of objs) {
      const enc = obj.encode && obj.encode.encode ? obj.encode.encode : null;
      if (!enc) { unbound++; continue; }
      const chans = Object.keys(enc);
      // accessibility (INV-2): colour must not be the SOLE channel.
      if (chans.includes('color') && chans.length === 1) colourOnly++;
    }
    if (unbound > 0) findings.push({ level: 'info', code: 'unbound-objects', message: `${unbound} object(s) have no data binding.` });
    if (colourOnly > 0) findings.push({ level: 'warn', code: 'colour-only', message: `${colourOnly} object(s) encode COLOUR as the sole channel — pair with a second channel (INV-2 a11y).` });
    if (findings.length === 0) findings.push({ level: 'ok', code: 'clean', message: `Scene "${sceneId}" looks well-formed.` });
    return findings;
  }

  /* ---------------------------------------------------------------------------
   *  TOOL: saveProject() -> ProjectFile | typed reject
   *         loadProject(file) -> { ok } | typed reject
   *    Both go THROUGH engine/serialize (the same surface a human/import uses).
   * ------------------------------------------------------------------------- */
  function saveProject() {
    const r = serialize.saveProject(doc);
    if (!r.ok) return reject('BAD_REQUEST', `saveProject: ${r.reason}`);
    return { ok: true, doc: r.doc };
  }
  function loadProject(file, loadOpts) {
    // DEFENSE IN DEPTH (D5): re-validate + re-clamp through engine/serialize. A
    // malformed / untrusted file cannot inject non-declarative or out-of-range
    // state — the host re-applies via this exact path.
    const controlTables = buildControlTables();
    const r = serialize.loadProject(file, { clamp: true, controlTables, ...(isPlainObject(loadOpts) ? loadOpts : {}) });
    if (!r.ok) return reject('BAD_REQUEST', `loadProject: ${r.reason}`);
    doc = JSON.parse(JSON.stringify(r.state));
    diffs.push({ op: 'replace', path: '/', value: 'project loaded (re-validated + clamped)' });
    return { ok: true, report: r.report || [] };
  }

  /** Build the controlTables engine/serialize needs (registryId -> controls). */
  function buildControlTables() {
    const tables = {};
    for (const p of PILLARS) for (const e of caps.byPillar[p]) tables[e.id] = e.controls;
    return tables;
  }

  /* ---------------------------------------------------------------------------
   *  applyToolCalls(calls) — the DETERMINISTIC APPLY path (D5, defense in depth).
   *    Takes a sequence of { tool, args } objects (the SAME shape runPrompt emits
   *    AND the same shape a Claude-CLI-implemented change would emit), RE-VALIDATES
   *    each through this surface, and applies them in order. A reject ABORTS the
   *    remaining calls (no partial trust) and is returned typed. Every implemented
   *    change flows through this re-validation — see ./runtime-doc.mjs.
   * ------------------------------------------------------------------------- */
  function applyToolCalls(calls) {
    if (!Array.isArray(calls)) return reject('BAD_REQUEST', 'applyToolCalls: calls must be an array of {tool, args}');
    const results = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (!isPlainObject(call) || typeof call.tool !== 'string') return reject('BAD_REQUEST', `applyToolCalls: call[${i}] must be { tool, args }`);
      if (!TOOL_NAMES.includes(call.tool)) return reject('UNKNOWN_ID', `applyToolCalls: tool "${call.tool}" is not in the action space`);
      const fn = api[call.tool];
      const args = Array.isArray(call.args) ? call.args : [];
      const res = fn(...args);
      results.push({ tool: call.tool, result: res });
      if (res && res.ok === false) return { ok: false, code: res.code, reason: `applyToolCalls aborted at call[${i}] (${call.tool}): ${res.reason}`, results };
    }
    return { ok: true, results };
  }

  /* ---------------------------------------------------------------------------
   *  runPrompt(text) — the LOCAL DSL apply path (fully deterministic).
   *    Parses a command/DSL into a tool-call sequence (./prompt.mjs) and applies
   *    it through applyToolCalls (the SAME deterministic apply path). NO LLM.
   * ------------------------------------------------------------------------- */
  function runPrompt(text) {
    const parsed = parsePrompt(text, { capabilities: caps, dataMap });
    if (!parsed.ok) return reject('BAD_REQUEST', `runPrompt: ${parsed.reason}`);
    const applied = applyToolCalls(parsed.calls);
    return { ...applied, calls: parsed.calls };
  }

  /* ---------------------------------------------------------------------------
   *  generatePrompt(selection, context) — the Claude-CLI PROMPT GENERATOR.
   *    DETERMINISTIC, PURE, NEVER THROWS. Produces a preliminary markdown prompt
   *    naming the target + effect + current params + intent + the relevant tool-
   *    API action(s) + suggestEncoding(data) if data-driven + the file/section
   *    context + the guardrails. The developer COPIES it into their Claude CLI
   *    session, refines it, and Claude Code implements the change locally. This is
   *    a LOCAL DEV/AUTHORING AID — it executes NOTHING and is build-excluded from
   *    the production artifact. App-specifics arrive via `context` (the engine
   *    stays generic). If the selection omits an effect's current params but names
   *    a known effect/target instance, they are filled from the project doc.
   * ------------------------------------------------------------------------- */
  function generatePrompt(selection, context) {
    const sel = isPlainObject(selection) ? { ...selection } : {};
    // Enrich the selection from the in-memory doc when params are absent (best-
    // effort, deterministic): a named effect instance's current params, etc.
    if (isPlainObject(sel.effect) && typeof sel.effect.id === 'string' &&
        !isPlainObject(sel.effect.params)) {
      const e = findEffect(sel.effect.id);
      if (e && isPlainObject(e.arr[e.i].params)) {
        sel.effect = { ...sel.effect, params: e.arr[e.i].params };
      }
    }
    return _generatePrompt(sel, context);
  }

  /* ---------------------------------------------------------------------------
   *  Introspection — the diff log, the current doc snapshot, construct errors.
   * ------------------------------------------------------------------------- */
  function getDiffs() { return diffs.map((d) => JSON.parse(JSON.stringify(d))); }
  function getProject() { return JSON.parse(JSON.stringify(doc)); }
  function errors() { return constructError; }

  const api = {
    // the typed Tool-API (the SOLE authz surface) ---------------------------
    createScene, addObject, bindData, setDynamics, applyEffect, setParams,
    projectData, removeObject, removeEffect, listCapabilities, suggestEncoding,
    explain, critique, saveProject, loadProject,
    // DSL apply path + the deterministic re-apply (Claude-CLI APPLY path) ----
    runPrompt, applyToolCalls,
    // the Claude-CLI PROMPT GENERATOR (local dev/authoring aid) --------------
    generatePrompt,
    // introspection ---------------------------------------------------------
    getDiffs, getProject, errors,
    // identity --------------------------------------------------------------
    name: NAME, version: VERSION, toolNames: TOOL_NAMES, rejectCodes: REJECT_CODES,
  };
  return api;
}

/** Re-exports so a host can build the deterministic spec / prompt without an instance. */
export { describeShape };
export const suggestEncoding = _suggestEncoding;
export const generatePrompt = _generatePrompt;

export const copilot = Object.freeze({
  name: NAME, version: VERSION, CHANNELS, REJECT_CODES, PILLARS, TOOL_NAMES,
  createCopilot, suggestEncoding: _suggestEncoding, describeShape, generatePrompt: _generatePrompt,
});

export default copilot;
