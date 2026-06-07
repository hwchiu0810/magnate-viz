/* =============================================================================
 *  engine/copilot/prompt.mjs  —  the LOCAL prompt path (Option B, Story P6.2)
 *
 *  WHAT THIS IS: a PURE, DETERMINISTIC parser that turns a command / DSL string
 *  into a TOOL-CALL SEQUENCE — `[{ tool, args }, ...]` — the SAME shape the live
 *  Claude server (Option A, D5) would emit, and the SAME shape applyToolCalls()
 *  re-validates + applies. This is the fully-local, no-LLM authoring path: it
 *  GENERALIZES a Builder-DSL into the typed action space.
 *
 *  NO LLM, NO RNG, NO wall-clock, NO I/O. Same text -> byte-identical call list.
 *  The parser ONLY produces calls whose `tool` is in the action space; it CANNOT
 *  invent a verb outside it (the firewall is structural — there is no escape
 *  hatch). It does NOT validate id/param ranges itself — that is applyToolCalls'
 *  job (single validation surface), so a bad id flows through to a TYPED reject.
 *
 *  THE DSL (one statement per line / per ";"). Case-insensitive verbs:
 *
 *    scene <registryId> [as <id>]                      -> createScene
 *    object <registryId> [as <id>] [in <sceneId>]      -> addObject
 *    bind <objectId> <channel>=<accessor>[ <ch>=<acc>] -> bindData (EncodeSpec)
 *    dynamics <registryId> on <objectId>               -> setDynamics
 *    effect <effectId> on <objectId> [k=v ...]         -> applyEffect
 *    set <instanceId> k=v [k=v ...]                     -> setParams
 *    project <dataRef> <op> [components=N] [seed=N]     -> projectData
 *    suggest <dataRef>                                  -> suggestEncoding
 *    remove object <objectId> / remove effect <id>      -> removeObject/removeEffect
 *    explain <targetId> / critique <sceneId>            -> explain/critique
 *    list [pillar] / save / load                        -> listCapabilities/save/load
 *
 *  A k=v VALUE is parsed deterministically: a JSON-ish scalar (number/true/false),
 *  a [a,b,c] vector, or a bare string. An accessor (bind) is a "@root.col" string.
 *
 *  FIREWALL (INV-6): imports NOTHING. Pure string -> structured calls.
 * ========================================================================== */

/** The verbs this DSL recognizes -> their target tool (the action space). */
export const DSL_VERBS = Object.freeze({
  scene: 'createScene', object: 'addObject', bind: 'bindData', dynamics: 'setDynamics',
  effect: 'applyEffect', set: 'setParams', project: 'projectData', suggest: 'suggestEncoding',
  remove: 'remove', explain: 'explain', critique: 'critique', list: 'listCapabilities',
  save: 'saveProject', load: 'loadProject',
});

const CHANNELS = ['position', 'scale', 'rotation', 'color', 'opacity', 'motion', 'effectParam'];

function reject(reason) { return { ok: false, reason }; }

/** Parse a single scalar token -> number | boolean | string (deterministic). */
function parseScalar(tok) {
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (tok === 'null') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
  return tok;
}

/** Parse a value token: "[1,2,3]" -> array, else a scalar. */
function parseValue(tok) {
  if (tok.length >= 2 && tok[0] === '[' && tok[tok.length - 1] === ']') {
    const inner = tok.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => parseScalar(s.trim()));
  }
  return parseScalar(tok);
}

/** Parse trailing `k=v` tokens into a params object. */
function parseKv(tokens) {
  const params = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    params[k] = parseValue(v);
  }
  return params;
}

/** Tokenize a statement, respecting [..] bracket groups so "[1,2,3]" is one token. */
function tokenize(line) {
  const toks = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '[') { depth++; buf += ch; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (/\s/.test(ch) && depth === 0) { if (buf) { toks.push(buf); buf = ''; } continue; }
    buf += ch;
  }
  if (buf) toks.push(buf);
  return toks;
}

/* -----------------------------------------------------------------------------
 *  parseStatement(line) -> { tool, args } | { ok:false, reason }
 * ------------------------------------------------------------------------- */
function parseStatement(line) {
  const toks = tokenize(line.trim());
  if (toks.length === 0) return null;                    // blank -> skipped
  const verb = toks[0].toLowerCase();
  const rest = toks.slice(1);

  if (!Object.prototype.hasOwnProperty.call(DSL_VERBS, verb)) {
    return reject(`unknown command "${toks[0]}" (verbs: ${Object.keys(DSL_VERBS).join(', ')})`);
  }

  switch (verb) {
    case 'scene': {
      if (rest.length < 1) return reject('scene needs a <registryId>');
      const registryId = rest[0];
      const asIdx = rest.indexOf('as');
      const spec = { registryId };
      if (asIdx >= 0 && rest[asIdx + 1]) spec.id = rest[asIdx + 1];
      // any trailing k=v become params.
      const kv = parseKv(rest.slice(1).filter((t) => t.includes('=')));
      if (Object.keys(kv).length) spec.params = kv;
      return { tool: 'createScene', args: [spec] };
    }
    case 'object': {
      if (rest.length < 1) return reject('object needs a <registryId>');
      const registryId = rest[0];
      const asIdx = rest.indexOf('as');
      const inIdx = rest.indexOf('in');
      const spec = { registryId };
      if (asIdx >= 0 && rest[asIdx + 1]) spec.id = rest[asIdx + 1];
      const sceneId = (inIdx >= 0 && rest[inIdx + 1]) ? rest[inIdx + 1] : null;
      const kv = parseKv(rest.filter((t) => t.includes('=')));
      if (Object.keys(kv).length) spec.params = kv;
      if (!sceneId) return reject('object needs "in <sceneId>"');
      return { tool: 'addObject', args: [sceneId, spec] };
    }
    case 'bind': {
      if (rest.length < 2) return reject('bind needs <objectId> <channel>=<accessor> ...');
      const objectId = rest[0];
      const encodeMap = {};
      for (const t of rest.slice(1)) {
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const ch = t.slice(0, eq);
        const acc = t.slice(eq + 1);
        if (!CHANNELS.includes(ch)) {
          // keep the (bad) channel so applyToolCalls returns a TYPED BAD_CHANNEL reject.
          encodeMap[ch] = { from: acc };
        } else if (acc[0] === '@') {
          encodeMap[ch] = { from: acc, scale: ch === 'color' ? { type: 'colormap' } : { type: 'linear' } };
        } else {
          encodeMap[ch] = { value: parseValue(acc) };
        }
      }
      return { tool: 'bindData', args: [objectId, { encode: encodeMap }] };
    }
    case 'dynamics': {
      const onIdx = rest.indexOf('on');
      if (rest.length < 1 || onIdx < 0 || !rest[onIdx + 1]) return reject('dynamics needs <registryId> on <objectId>');
      const registryId = rest[0];
      const objectId = rest[onIdx + 1];
      const kv = parseKv(rest.filter((t) => t.includes('=')));
      const spec = { registryId };
      if (Object.keys(kv).length) spec.params = kv;
      return { tool: 'setDynamics', args: [objectId, spec] };
    }
    case 'effect': {
      const onIdx = rest.indexOf('on');
      if (rest.length < 1 || onIdx < 0 || !rest[onIdx + 1]) return reject('effect needs <effectId> on <objectId>');
      const effectId = rest[0];
      const objectId = rest[onIdx + 1];
      const kv = parseKv(rest.filter((t) => t.includes('=')));
      return { tool: 'applyEffect', args: [objectId, effectId, kv] };
    }
    case 'set': {
      if (rest.length < 2) return reject('set needs <instanceId> k=v ...');
      const instanceId = rest[0];
      const kv = parseKv(rest.slice(1));
      return { tool: 'setParams', args: [instanceId, kv] };
    }
    case 'project': {
      if (rest.length < 2) return reject('project needs <dataRef> <op>');
      const dataRef = rest[0];
      const op = rest[1];
      const kv = parseKv(rest.slice(2));
      return { tool: 'projectData', args: [dataRef, { op, ...kv }] };
    }
    case 'suggest': {
      if (rest.length < 1) return reject('suggest needs <dataRef>');
      return { tool: 'suggestEncoding', args: [rest[0]] };
    }
    case 'remove': {
      if (rest.length < 2) return reject('remove needs "object <id>" or "effect <id>"');
      const what = rest[0].toLowerCase();
      if (what === 'object') return { tool: 'removeObject', args: [rest[1]] };
      if (what === 'effect') return { tool: 'removeEffect', args: [rest[1]] };
      return reject(`remove "${rest[0]}" — expected "object" or "effect"`);
    }
    case 'explain': {
      if (rest.length < 1) return reject('explain needs <targetId>');
      return { tool: 'explain', args: [rest[0]] };
    }
    case 'critique': {
      if (rest.length < 1) return reject('critique needs <sceneId>');
      return { tool: 'critique', args: [rest[0]] };
    }
    case 'list': {
      return { tool: 'listCapabilities', args: rest[0] ? [rest[0]] : [] };
    }
    case 'save': return { tool: 'saveProject', args: [] };
    case 'load': return { tool: 'loadProject', args: [] };
    default:
      return reject(`unhandled verb "${verb}"`);
  }
}

/* -----------------------------------------------------------------------------
 *  parsePrompt(text, ctx?) -> { ok:true, calls:[{tool,args}] } | { ok:false, reason }
 *    Splits on newlines and ";", parses each statement, and returns the call
 *    sequence. The FIRST malformed statement aborts with a typed reason (no
 *    partial sequence). ctx is reserved (capabilities/dataMap) for richer NL
 *    resolution; the deterministic DSL needs no context to parse.
 * ------------------------------------------------------------------------- */
export function parsePrompt(text, _ctx) {
  if (typeof text !== 'string') return reject('prompt must be a string');
  const statements = text.split(/[\n;]+/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('#'));
  if (statements.length === 0) return reject('prompt is empty');
  const calls = [];
  for (let i = 0; i < statements.length; i++) {
    const r = parseStatement(statements[i]);
    if (r === null) continue;
    if (r.ok === false) return reject(`statement ${i + 1} ("${statements[i]}"): ${r.reason}`);
    calls.push(r);
  }
  if (calls.length === 0) return reject('prompt produced no tool calls');
  return { ok: true, calls };
}

export const prompt = Object.freeze({ parsePrompt, DSL_VERBS });
export default prompt;
