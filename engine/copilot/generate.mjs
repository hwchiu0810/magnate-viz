/* =============================================================================
 *  engine/copilot/generate.mjs  —  the DETERMINISTIC Claude-CLI PROMPT GENERATOR
 *  (Story P6.1b — supersedes the live-LLM server-seam framing of ADR-D5)
 *
 *  WHAT THIS IS — THE CORRECTED P6 MODEL: the AI runtime is the **Claude CLI**
 *  (the developer's Claude Code session) — NOT an Anthropic API, NOT a server,
 *  NOT an in-app model. There is NO API key, NO network call, NO live-LLM call
 *  anywhere in engine/copilot.
 *
 *  This module is a PROMPT GENERATOR: given a SELECTED target (an object id /
 *  section / stage / effect-instance) + an effect (from VFX.list) + an optional
 *  free-text intent (+ an optional data ref), it produces a PRELIMINARY, well-
 *  structured PROMPT (human-readable markdown) that DESCRIBES the change. The
 *  developer COPIES that prompt into their Claude Code session, REFINES it, and
 *  Claude Code implements the change locally. The generated prompt is a STARTING
 *  DRAFT — not an executed action.
 *
 *  THE PROMPT NAMES (deterministically, from `selection` + `context`):
 *    - the TARGET (id / kind / section);
 *    - the EFFECT (id) + its CURRENT PARAMS;
 *    - the free-text INTENT (verbatim, if given);
 *    - the relevant ENGINE TOOL-API action(s) the CLI can emit
 *      (applyEffect / bindData / setDynamics / setParams / …) — the deterministic
 *      APPLY path that yields a serializable diff;
 *    - suggestEncoding(data)'s RECOMMENDATION when the change is data-driven;
 *    - the FILE / SECTION context (injected by the caller so the engine stays
 *      generic — engine/copilot names no app);
 *    - the GUARDRAILS to keep (merge gate `node conformance/ci.mjs` green;
 *      economy/probes byte-identical; additive only; deterministic/headless).
 *
 *  PURE / DETERMINISTIC / HEADLESS (INV-1): no DOM, no THREE, no network, no
 *  wall-clock, no global RNG. The SAME `selection` + `context` -> a BYTE-IDENTICAL
 *  prompt string. It NEVER throws — partial / garbage input degrades to a safe,
 *  well-formed draft (with explicit "(unspecified)" placeholders), never an
 *  exception.
 *
 *  LOCAL DEV/AUTHORING AID — NOT SHIPPED: the prompt generator is a dev-flag-gated
 *  authoring aid. The PRODUCTION build artifact (the visualization) excludes it;
 *  only the visualization deploys. See ./runtime-doc.mjs for the runtime model.
 *
 *  FIREWALL (INV-6): imports ONLY engine/copilot's own sibling `suggest.mjs`
 *  (deterministic suggestEncoding, which itself imports only engine/data +
 *  engine/encode). NO THREE / NO Tweakpane / NO app modules / NO network.
 * ========================================================================== */

import { suggestEncoding as _suggestEncoding } from './suggest.mjs';

/** Module identity (semver). */
export const VERSION = '0.2.0-p6.1b-prompt-generator';
export const NAME = 'engine/copilot/generate';

/** The tool-API action(s) the CLI can emit for a given selection kind/intent.
 *  This is the DETERMINISTIC mapping from "what is selected + what is asked" to
 *  the engine's serializable APPLY verbs (the same closed action space the
 *  copilot Tool-API exposes — there is no verb outside it). */
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

/** Stable JSON for params/recommendations (sorted keys -> byte-identical output). */
function stableJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/** Coerce ANY input to a trimmed, single-line, safe string (never throws). */
function safeStr(x) {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  try { return JSON.stringify(x); } catch { return String(x); }
}

/** The closed set of engine tool-API actions a generated prompt may reference. */
const TOOL_API_ACTIONS = Object.freeze([
  'createScene', 'addObject', 'bindData', 'setDynamics', 'applyEffect', 'setParams',
  'projectData', 'removeObject', 'removeEffect', 'suggestEncoding',
]);

/**
 * pickActions(selection) -> string[] of the relevant tool-API actions.
 *   - an effect on a target            -> applyEffect (+ setParams to tune)
 *   - a data ref present               -> bindData (+ suggestEncoding, projectData if high-D)
 *   - a section/stage target           -> createScene / addObject context
 *   - nothing decidable                -> setParams (the generic tune verb)
 * Deterministic + total (always returns at least one action).
 */
function pickActions(selection) {
  const s = isPlainObject(selection) ? selection : {};
  const actions = [];
  const kind = isPlainObject(s.target) ? safeStr(s.target.kind) : '';
  const hasEffect = isPlainObject(s.effect) && safeStr(s.effect.id) !== '';
  const hasData = isPlainObject(s.data) && safeStr(s.data.ref) !== '';

  if (hasData) {
    actions.push('bindData');
    actions.push('suggestEncoding');
    const dk = safeStr(s.data.kind);
    if (dk === 'paramspace') actions.push('projectData');
  }
  if (hasEffect) {
    actions.push('applyEffect');
    actions.push('setParams');
  }
  if (kind === 'scene' || kind === 'section') {
    actions.push('createScene');
    actions.push('addObject');
  }
  if (kind === 'dynamic' || kind === 'stage') {
    actions.push('setDynamics');
  }
  if (actions.length === 0) actions.push('setParams');
  // de-dup preserving first-seen order; intersect with the closed set (no escape).
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    if (TOOL_API_ACTIONS.includes(a) && !seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out;
}

/* -----------------------------------------------------------------------------
 *  generatePrompt(selection, context) -> a PRELIMINARY Claude-CLI prompt (string).
 *
 *  selection = {
 *    target: { id, kind, section? },            // the selected target
 *    effect?: { id, params },                    // an effect from VFX.list (+ current params)
 *    intent?: string,                            // optional free-text intent
 *    data?: { ref, kind, shape }                 // optional data ref (drives suggestEncoding)
 *  }
 *  context = { appName?, file?, notes? }          // app-specifics INJECTED by the caller
 *
 *  Pure, deterministic, total: same input -> byte-identical markdown; never throws.
 * ------------------------------------------------------------------------- */
export function generatePrompt(selection, context) {
  const s = isPlainObject(selection) ? selection : {};
  const ctx = isPlainObject(context) ? context : {};
  const target = isPlainObject(s.target) ? s.target : {};
  const effect = isPlainObject(s.effect) ? s.effect : null;
  const data = isPlainObject(s.data) ? s.data : null;

  const targetId = safeStr(target.id) || '(unspecified target)';
  const targetKind = safeStr(target.kind) || '(unspecified kind)';
  const section = safeStr(target.section);
  const intent = safeStr(s.intent).trim();

  const appName = safeStr(ctx.appName).trim();
  const file = safeStr(ctx.file).trim();
  const notes = safeStr(ctx.notes).trim();

  const actions = pickActions(s);

  // suggestEncoding recommendation — only when the change is data-driven. The
  // suggest heuristic is deterministic + never throws (it returns a typed reject
  // object for an unsupported shape, which we render as a note rather than fail).
  let encodingBlock = null;
  if (data && safeStr(data.ref) !== '') {
    const shapeDesc = buildShapeDescriptor(data);
    const rec = safeSuggest(shapeDesc, safeStr(data.ref));
    encodingBlock = renderEncodingBlock(data, rec);
  }

  const lines = [];
  lines.push('# Claude Code prompt — preliminary draft (copy into your Claude CLI session, refine, then implement)');
  lines.push('');
  lines.push('> Runtime model: the AI runtime is the **Claude CLI** (this developer Claude Code session).');
  lines.push('> There is NO in-app model, NO API key, NO server, NO live-LLM call. This text is a STARTING');
  lines.push('> DRAFT generated locally; review and adjust it before asking Claude Code to implement.');
  lines.push('');

  // ---- Target -------------------------------------------------------------
  lines.push('## Target');
  lines.push(`- **id:** \`${targetId}\``);
  lines.push(`- **kind:** \`${targetKind}\``);
  if (section) lines.push(`- **section:** \`${section}\``);
  if (appName) lines.push(`- **app:** ${appName}`);
  lines.push('');

  // ---- Effect + current params -------------------------------------------
  if (effect) {
    const effId = safeStr(effect.id) || '(unspecified effect)';
    lines.push('## Effect');
    lines.push(`- **effect id:** \`${effId}\` (from \`VFX.list()\`)`);
    lines.push('- **current params:**');
    lines.push('');
    lines.push('```json');
    lines.push(stableJson(isPlainObject(effect.params) ? effect.params : {}));
    lines.push('```');
    lines.push('');
  }

  // ---- Intent -------------------------------------------------------------
  lines.push('## Intent');
  lines.push(intent ? intent : '_(no free-text intent supplied — describe the desired change here)_');
  lines.push('');

  // ---- Engine tool-API action(s) -----------------------------------------
  lines.push('## Engine tool-API action(s) to emit');
  lines.push('The change maps to the deterministic, validated engine tool-API (each call yields a');
  lines.push('serializable diff to the project document — the APPLY path Claude Code can emit):');
  lines.push('');
  for (const a of actions) lines.push(`- \`${a}(...)\` — ${describeAction(a)}`);
  lines.push('');

  // ---- Data / suggestEncoding --------------------------------------------
  if (encodingBlock) {
    for (const l of encodingBlock) lines.push(l);
    lines.push('');
  }

  // ---- File / section context --------------------------------------------
  lines.push('## File / section context');
  if (file) lines.push(`- **file:** \`${file}\``);
  if (section) lines.push(`- **section:** \`${section}\``);
  if (!file && !section) lines.push('- _(no file/section context injected by the caller)_');
  if (notes) { lines.push('- **notes:**'); lines.push(`  ${notes}`); }
  lines.push('');

  // ---- Guardrails (always) -----------------------------------------------
  lines.push('## Guardrails (keep these green)');
  lines.push('- Keep the merge gate green: `node conformance/ci.mjs` must stay GREEN.');
  lines.push('- Keep the economy + headless probes **byte-identical** (no change to `econ-core.js`,');
  lines.push('  `viz-panels.js`, `vfx.js`, or the FROZEN conformance vectors).');
  lines.push('- The change must be **additive** and **deterministic/headless** (no wall-clock, no');
  lines.push('  global RNG; same inputs -> same outputs).');
  lines.push('- Stay inside the engine firewall: no app-specific imports into `engine/**`,');
  lines.push('  no hard THREE/Tweakpane import (vendor arrives via `init({THREE,...})`).');
  lines.push('');

  return lines.join('\n');
}

/** Map an action name -> a short, deterministic description for the prompt. */
function describeAction(a) {
  switch (a) {
    case 'createScene': return 'create the scene/section from a SceneRegistry id';
    case 'addObject': return 'add the object (ObjectRegistry id) to the scene';
    case 'bindData': return 'bind the target to data via an EncodeSpec (closed channel set)';
    case 'setDynamics': return 'attach a dynamic (DynamicsRegistry id) to the target';
    case 'applyEffect': return 'apply the VFX effect to the target (counts/colours clamped on ingest)';
    case 'setParams': return 'range-checked param update on the instance (the generic tune verb)';
    case 'projectData': return 'record a declarative projection of the data ref (e.g. PCA for paramspace)';
    case 'removeObject': return 'remove the object by id';
    case 'removeEffect': return 'remove the effect instance by id';
    case 'suggestEncoding': return 'recommend an EncodeSpec from the data shape (deterministic)';
    default: return 'engine tool-API action';
  }
}

/** Build a {kind, shape, axes} descriptor suggestEncoding accepts (total/safe). */
function buildShapeDescriptor(data) {
  const desc = {};
  const kind = safeStr(data.kind);
  if (kind) desc.kind = kind;
  if (Array.isArray(data.shape)) desc.shape = data.shape.filter((n) => Number.isFinite(n));
  return desc;
}

/** Call suggestEncoding without ever throwing; return its result (spec or reject). */
function safeSuggest(shapeDesc, dataKey) {
  try {
    if (!shapeDesc || typeof shapeDesc.kind !== 'string') return null;
    return _suggestEncoding(shapeDesc, { dataKey });
  } catch {
    return null;
  }
}

/** Render the data / suggestEncoding section as markdown lines. */
function renderEncodingBlock(data, rec) {
  const lines = [];
  lines.push('## Data-driven encoding (suggestEncoding recommendation)');
  lines.push(`- **data ref:** \`${safeStr(data.ref)}\``);
  if (safeStr(data.kind)) lines.push(`- **kind:** \`${safeStr(data.kind)}\``);
  if (Array.isArray(data.shape)) lines.push(`- **shape:** \`[${data.shape.join(', ')}]\``);
  lines.push('');
  if (rec && rec.ok === false) {
    lines.push(`> suggestEncoding could not recommend a spec for this shape (${safeStr(rec.reason)}).`);
    lines.push('> Describe the intended channel mapping manually in the Intent above.');
  } else if (rec && (rec.encode || rec.transform)) {
    lines.push('Recommended **EncodeSpec** (deterministic; colour is never the sole channel — INV-2):');
    lines.push('');
    lines.push('```json');
    lines.push(stableJson(rec));
    lines.push('```');
  } else {
    lines.push('> No deterministic encoding recommendation available; describe the mapping in the Intent.');
  }
  return lines;
}

export const generate = Object.freeze({ NAME, VERSION, generatePrompt });
export default generate;
