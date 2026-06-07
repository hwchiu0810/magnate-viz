/* =============================================================================
 *  builder-core.js  —  OBJECT + VFX BUILDER core (window.BuilderCore)
 *
 *  WHAT THIS IS
 *  ------------
 *  The deterministic, headless-safe CORE behind the Object + VFX Builder that
 *  lives in the VFX Lab (Scene Edit Mode) of prototype/magnate-3d-three.html.
 *  It realizes three user workflows over ONE small ACTION LAYER:
 *    1. select VFX effects for objects / stages / scenes,
 *    2. place objects into the stage guided by a FORMULA or a PROMPT,
 *    3. select EXISTING stage objects and apply VFX / transform via a simple
 *       FORMULA or a dynamic PROMPT.
 *
 *  This is the concrete instance of the platform tool-API (ADR-D5) + the formula
 *  generalization of the encoding grammar (ADR-D3): the hard-wired prototype
 *  encodings (twinHeatColor(load), tower-height ∝ net-worth) become a declarative,
 *  user-editable formula over the CLOSED channel set
 *  (position|scale|rotation|color|opacity|motion|effectParam — contracts/channels.json).
 *
 *  PILLARS / ARCHITECTURE
 *  ----------------------
 *    - ACTION LAYER (createBuilder(host)): placeObjects / selectTarget /
 *      applyEffect / transform / removeObject / clear — the SAME calls BOTH the
 *      DOM front-end (buttons) AND the PROMPT front-end (runPrompt) drive. This is
 *      the v1 in-Lab home of engine/objects + engine/encode (migrates at P3/P4).
 *    - FORMULA EVALUATOR (compileFormula): a SAFE, deterministic expression
 *      evaluator over a whitelisted scope { i, n, t, value, Math.*, placement
 *      helpers, rand(i) }. NO globals / window / document / eval-of-arbitrary-JS;
 *      a bad formula is an inert no-op (returns a safe default, never throws).
 *    - PROMPT DSL (parsePrompt / runPrompt): a tiny command grammar mapping
 *      "place 60 sphere spiral; apply fire; scale = 1+0.3*sin(t)" to action calls.
 *      runPrompt(text) is the SEAM the server-side Claude copilot (ADR-D5 option A)
 *      later emits the SAME action sequence through (see PROMPT SEAM below).
 *
 *  INVARIANTS (held by construction; asserted by conformance/builder.test.mjs)
 *  --------------------------------------------------------------------------
 *    INV-1 DETERMINISM: same (formula, i, n, t) -> same output, bit-identically.
 *      `t` is the ONLY time input; rand(i) is a per-INDEX seeded mulberry32 PRNG
 *      (NOT Math.random, NOT wall-clock). Frozen under reduceMotion (t held).
 *    INV-3 SUB-WHITE: emissive channels routed through vfx.js stay sub-white; the
 *      core never raises emissive above the VFX clamp.
 *    INV-4 BOUNDED / DISPOSE: object count capped (MAX_OBJECTS=300) and concurrent
 *      effects capped (MAX_EFFECTS=120); removeObject()/clear() dispose + free.
 *    HEADLESS-SAFE: THREE + VFX arrive ONLY via the injected host; with neither
 *      present every entry point is an inert no-op that never throws — so the page
 *      and the Node harness run with no GPU/DOM (mirrors vfx.js).
 *    ADDITIVE / VIEW-ONLY: the builder operates on its OWN stage objects and its
 *      OWN raycast set; it never touches the economy, the economy `pickables`
 *      array (stays length 2), econ-core, viz-panels, vfx.js, or the 9 sections.
 *
 *  Loaded as a sibling <script> (like vfx.js / viz-panels.js); offline / absent
 *  ⇒ window.BuilderCore stays undefined ⇒ every Builder.* call in the app is
 *  guarded (typeof BuilderCore !== 'undefined') ⇒ no crash, no behaviour change.
 * ========================================================================== */
(function (root) {
  'use strict';

  /* ---- bounded caps (INV-4) -------------------------------------------- */
  var MAX_OBJECTS = 300;     // hard cap on builder stage objects
  var MAX_EFFECTS = 120;     // hard cap on concurrent attached effects
  var MAX_PLACE   = 300;     // a single placeObjects() can request at most this

  /* ---- shape palette (the small object palette + the sample shapes) ----- */
  var SHAPES = ['box', 'sphere', 'cone', 'torus', 'icosa', 'torusKnot', 'cylinder'];

  /* =========================================================================
   *  mulberry32 — a per-index SEEDED PRNG (INV-1). This is explicitly NOT the
   *  global RNG and NOT wall-clock-seeded: rand(i) returns a value in [0,1)
   *  derived ONLY from the integer index i, so the same i always yields the
   *  same number across runs / machines. (Same family as vfx.js makeRng.)
   * ====================================================================== */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // rand(i): a deterministic [0,1) value seeded by the integer index i (mixed with
  // a fixed constant so index 0 is not a degenerate seed). One draw per call.
  function randForIndex(i) {
    var seed = ((Math.floor(i) | 0) ^ 0x9E3779B9) >>> 0;
    return mulberry32(seed)();
  }

  /* =========================================================================
   *  PLACEMENT HELPERS — pure functions (i, n, ...) -> a 3-vector [x,y,z].
   *  These are the building blocks a position formula composes; they are also
   *  the targets of the preset buttons (grid / ring / spiral / sphere).
   *  Deterministic + alloc-light; clamp their own args so garbage is inert.
   * ====================================================================== */
  function grid(i, n, cols, gap) {
    i = Math.floor(i) || 0; n = Math.max(1, Math.floor(n) || 1);
    cols = Math.max(1, Math.floor(cols) || Math.ceil(Math.sqrt(n)));
    gap = (typeof gap === 'number' && isFinite(gap)) ? gap : 10;
    var rows = Math.ceil(n / cols);
    var cx = (cols - 1) / 2, cz = (rows - 1) / 2;
    var col = i % cols, rowi = Math.floor(i / cols);
    return [(col - cx) * gap, 0, (rowi - cz) * gap];
  }
  function ring(i, n, r) {
    i = Math.floor(i) || 0; n = Math.max(1, Math.floor(n) || 1);
    r = (typeof r === 'number' && isFinite(r)) ? r : 30;
    var a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, 0, Math.sin(a) * r];
  }
  function spiral(i, n, r, turns, rise) {
    i = Math.floor(i) || 0; n = Math.max(1, Math.floor(n) || 1);
    r = (typeof r === 'number' && isFinite(r)) ? r : 30;
    turns = (typeof turns === 'number' && isFinite(turns)) ? turns : 3;
    rise = (typeof rise === 'number' && isFinite(rise)) ? rise : 0.6;
    var f = n > 1 ? i / (n - 1) : 0;
    var a = f * Math.PI * 2 * turns;
    var rr = r * (0.25 + 0.75 * f);
    return [Math.cos(a) * rr, f * (n * rise), Math.sin(a) * rr];
  }
  function sphere(i, n, r) {
    i = Math.floor(i) || 0; n = Math.max(1, Math.floor(n) || 1);
    r = (typeof r === 'number' && isFinite(r)) ? r : 30;
    // Fibonacci sphere — even, deterministic distribution.
    var off = 2 / n;
    var inc = Math.PI * (3 - Math.sqrt(5));
    var y = i * off - 1 + off / 2;
    var rad = Math.sqrt(Math.max(0, 1 - y * y));
    var phi = i * inc;
    return [Math.cos(phi) * rad * r, y * r, Math.sin(phi) * rad * r];
  }

  /* =========================================================================
   *  THE SAFE FORMULA EVALUATOR (compileFormula).
   *  ------------------------------------------------------------------------
   *  Compiles a user expression STRING into a pure function f(i, n, t, value)
   *  evaluated over a STRICTLY WHITELISTED scope:
   *      i, n, t, value   — the four bound vars (index, count, elapsed s, datum)
   *      PI, E, TAU        — constants
   *      sin cos tan asin acos atan atan2 sqrt cbrt abs sign min max pow exp log
   *      floor ceil round trunc hypot clamp lerp mix smoothstep step mod fract saw tri
   *      grid ring spiral sphere   — placement helpers (return 3-vectors)
   *      rand              — rand(i): per-index seeded PRNG (INV-1; NOT global RNG)
   *  Returns a NUMBER or a 3-element VECTOR (array). On ANY problem (parse error,
   *  forbidden token, throw at eval, NaN/Infinity result) it returns the supplied
   *  default — it NEVER throws and NEVER crashes the frame.
   *
   *  SAFETY MODEL: we never touch window/document/globalThis. The expression is
   *  compiled once with `new Function(argNames, 'return (' + expr + ')')` whose
   *  ONLY free identifiers are the whitelisted scope passed as arguments — but
   *  FIRST we reject any source containing a forbidden token (so even if a name
   *  leaked, the source could not reference it). Property access (`.`), the
   *  `[`/`]` index/array-literal ambiguity beyond our needs, and assignment are
   *  all blocked. This keeps the evaluator a pure math sandbox.
   * ====================================================================== */

  // The exact identifiers the scope provides (the ONLY names an expression may use).
  var SCOPE_NAMES = [
    'i', 'n', 't', 'value',
    'PI', 'E', 'TAU',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
    'sqrt', 'cbrt', 'abs', 'sign', 'min', 'max', 'pow', 'exp', 'log',
    'floor', 'ceil', 'round', 'trunc', 'hypot',
    'clamp', 'lerp', 'mix', 'smoothstep', 'step', 'mod', 'fract', 'saw', 'tri',
    'grid', 'ring', 'spiral', 'sphere', 'rand'
  ];

  // A scope object of pure helpers; built once, shared (none of them close over time/globals).
  function buildScope() {
    var s = {
      PI: Math.PI, E: Math.E, TAU: Math.PI * 2,
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
      sqrt: function (x) { return Math.sqrt(Math.abs(x)); }, // sqrt of |x| — never NaN
      cbrt: Math.cbrt || function (x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3); },
      abs: Math.abs, sign: Math.sign || function (x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); },
      min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp,
      log: function (x) { return Math.log(Math.max(1e-9, x)); },
      floor: Math.floor, ceil: Math.ceil, round: Math.round,
      trunc: Math.trunc || function (x) { return x < 0 ? Math.ceil(x) : Math.floor(x); },
      hypot: Math.hypot || function () { var s = 0, k; for (k = 0; k < arguments.length; k++) s += arguments[k] * arguments[k]; return Math.sqrt(s); },
      clamp: function (x, a, b) { return Math.max(a, Math.min(b, x)); },
      lerp: function (a, b, u) { return a + (b - a) * u; },
      mix: function (a, b, u) { return a + (b - a) * u; },
      step: function (edge, x) { return x < edge ? 0 : 1; },
      smoothstep: function (e0, e1, x) { var u = Math.max(0, Math.min(1, (x - e0) / ((e1 - e0) || 1e-9))); return u * u * (3 - 2 * u); },
      mod: function (a, b) { return ((a % b) + b) % b; },
      fract: function (x) { return x - Math.floor(x); },
      saw: function (x) { return x - Math.floor(x); },          // 0..1 sawtooth
      tri: function (x) { var f = x - Math.floor(x); return 1 - Math.abs(2 * f - 1); }, // 0..1 triangle
      grid: grid, ring: ring, spiral: spiral, sphere: sphere,
      rand: randForIndex
    };
    return s;
  }
  var SHARED_SCOPE = buildScope();

  // Reject any source that contains a token outside the safe set. We tokenize
  // identifiers and reject forbidden keywords / property access / assignment so a
  // formula can ONLY be pure math over the whitelisted scope.
  var FORBIDDEN_RE = /(=>|\bfunction\b|\breturn\b|\bnew\b|\bthis\b|\bwindow\b|\bdocument\b|\bglobalThis\b|\beval\b|\bFunction\b|\bconstructor\b|\bprototype\b|\b__proto__\b|\brequire\b|\bimport\b|\bexport\b|\bawait\b|\basync\b|\byield\b|\bdelete\b|\bvoid\b|\btypeof\b|\binstanceof\b|`|;|\{|\}|\[|\])/;
  // a single '=' that is not part of == <= >= != is an assignment → forbidden.
  function hasBareAssignment(src) {
    return /(^|[^=<>!])=([^=]|$)/.test(src);
  }
  // every identifier the source references must be in the whitelist.
  function identifiersAllowed(src) {
    var ids = src.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
    for (var k = 0; k < ids.length; k++) {
      if (SCOPE_NAMES.indexOf(ids[k]) < 0) return false;
    }
    return true;
  }

  // Compile an expression once into f(i,n,t,value) -> number | [x,y,z].
  // `def` is the safe default returned on any failure. `expectVec` only documents
  // intent; the returned function returns whatever the expression evaluates to
  // (number or 3-vector), and the caller coerces.
  function compileFormula(expr, def) {
    var fallback = (def === undefined) ? 0 : def;
    var safeFallback = function () { return fallback; };
    if (typeof expr === 'number' && isFinite(expr)) {
      var c = expr; return wrap(function () { return c; }, fallback);
    }
    if (typeof expr !== 'string') return wrap(safeFallback, fallback);
    var src = expr.trim();
    if (!src) return wrap(safeFallback, fallback);
    // STATIC REJECTS (forbidden tokens / property access / assignment / non-whitelisted ids).
    if (src.indexOf('.') >= 0) {
      // allow ONLY numeric decimals like 3.14 / .5 — reject any identifier.property access.
      if (/[A-Za-z_$)\]]\s*\./.test(src) || /\.\s*[A-Za-z_$]/.test(src)) return wrap(safeFallback, fallback);
    }
    if (FORBIDDEN_RE.test(src)) return wrap(safeFallback, fallback);
    if (hasBareAssignment(src)) return wrap(safeFallback, fallback);
    if (!identifiersAllowed(src)) return wrap(safeFallback, fallback);
    var fn = null;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(SCOPE_NAMES.join(','), '"use strict";return (' + src + ');');
    } catch (e) { return wrap(safeFallback, fallback); }
    var compiled = function (i, n, t, value) {
      var S = SHARED_SCOPE;
      return fn(
        i, n, t, value,
        S.PI, S.E, S.TAU,
        S.sin, S.cos, S.tan, S.asin, S.acos, S.atan, S.atan2,
        S.sqrt, S.cbrt, S.abs, S.sign, S.min, S.max, S.pow, S.exp, S.log,
        S.floor, S.ceil, S.round, S.trunc, S.hypot,
        S.clamp, S.lerp, S.mix, S.smoothstep, S.step, S.mod, S.fract, S.saw, S.tri,
        S.grid, S.ring, S.spiral, S.sphere, S.rand
      );
    };
    return wrap(compiled, fallback);
  }

  // Wrap a raw evaluator so it NEVER throws and NEVER returns NaN/Infinity:
  // returns the default for any non-finite scalar / malformed vector.
  function wrap(rawFn, fallback) {
    return function (i, n, t, value) {
      var out;
      try { out = rawFn(i || 0, n || 1, t || 0, (value === undefined ? 0 : value)); }
      catch (e) { return fallback; }
      if (Array.isArray(out)) {
        if (out.length < 1) return fallback;
        var v = [num(out[0], 0), num(out[1], 0), num(out[2], 0)];
        return v;
      }
      if (typeof out === 'number' && isFinite(out)) return out;
      if (typeof out === 'boolean') return out ? 1 : 0;
      return fallback;
    };
  }
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  // Coerce any evaluator output to a 3-vector (a scalar becomes [s,0,0] only for
  // position helpers we never want that — so position formulas should return a vec;
  // a scalar position is treated as y-less x). Callers that want a vector use this.
  function toVec3(out) {
    if (Array.isArray(out)) return [num(out[0], 0), num(out[1], 0), num(out[2], 0)];
    var s = num(out, 0); return [s, 0, 0];
  }

  /* =========================================================================
   *  PROMPT COMMAND DSL — parsePrompt(text) -> [{ action, ...args }]
   *  ------------------------------------------------------------------------
   *  A tiny, local (NO server) grammar. Statements are separated by ';' or
   *  newlines. Recognized verbs:
   *      place <count> <shape> [<preset|formula>]   -> { action:'place', ... }
   *      apply <effect> [<param>=<value-or-formula> ...]
   *                                                 -> { action:'apply', ... }
   *      select <id|stage|scene>                    -> { action:'select', ... }
   *      <channel> = <value-or-formula>             -> { action:'transform', ... }
   *         channel ∈ scale|rotationY|rotation|color|opacity (closed set subset)
   *      transform <channel> = <formula>            -> same as above (explicit)
   *      clear                                      -> { action:'clear' }
   *      remove <id>                                -> { action:'remove', id }
   *  Unknown / malformed lines parse to { action:'noop', raw } (inert, surfaced).
   *  This is the SAME action sequence the DOM front-end and the copilot emit.
   * ====================================================================== */
  var TRANSFORM_CHANNELS = ['scale', 'rotationY', 'rotation', 'color', 'opacity'];
  var PRESETS = ['grid', 'ring', 'spiral', 'sphere'];

  function parsePrompt(text) {
    var out = [];
    if (typeof text !== 'string' || !text.trim()) return out;
    var lines = text.split(/[\n;]+/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      var stmt = parseStatement(line);
      if (stmt) out.push(stmt);
    }
    return out;
  }

  function parseStatement(line) {
    // channel-assignment form:  scale = 1+0.3*sin(t)
    var assign = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/);
    if (assign && TRANSFORM_CHANNELS.indexOf(assign[1]) >= 0) {
      return { action: 'transform', channel: assign[1], formula: assign[2].trim(), raw: line };
    }
    var parts = line.split(/\s+/);
    var verb = (parts[0] || '').toLowerCase();

    if (verb === 'place') {
      // place <count> <shape> [preset|formula...]
      var count = parseInt(parts[1], 10);
      if (!isFinite(count)) count = 0;
      var shape = (parts[2] || 'box').toLowerCase();
      if (SHAPES.indexOf(shape) < 0) shape = 'box';
      var rest = parts.slice(3).join(' ').trim();
      var position;
      if (!rest) position = 'grid(i,n)';
      else if (PRESETS.indexOf(rest.toLowerCase()) >= 0) position = presetFormula(rest.toLowerCase());
      else position = rest;
      return { action: 'place', shape: shape, count: count, position: position, raw: line };
    }
    if (verb === 'apply') {
      var effect = parts[1] || '';
      var params = {};
      for (var k = 2; k < parts.length; k++) {
        var m = parts[k].match(/^([A-Za-z][A-Za-z0-9]*)=(.+)$/);
        if (m) params[m[1]] = coerceParam(m[2]);
      }
      // also fold any "key=val" that contained spaces — re-scan with a regex over the tail
      var tail = parts.slice(2).join(' ');
      var pre = /([A-Za-z][A-Za-z0-9]*)\s*=\s*([^=]+?)(?=(?:\s+[A-Za-z][A-Za-z0-9]*\s*=)|$)/g, mm;
      while ((mm = pre.exec(tail)) !== null) { params[mm[1]] = coerceParam(mm[2].trim()); }
      return { action: 'apply', effect: effect, params: params, raw: line };
    }
    if (verb === 'select') {
      var ref = parts[1] || '';
      if (ref === 'stage' || ref === 'scene') return { action: 'select', ref: ref, raw: line };
      var idn = parseInt(ref, 10);
      return { action: 'select', ref: isFinite(idn) ? idn : ref, raw: line };
    }
    if (verb === 'transform') {
      // transform <channel> = <formula>
      var rejoined = parts.slice(1).join(' ');
      var tm = rejoined.match(/^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/);
      if (tm && TRANSFORM_CHANNELS.indexOf(tm[1]) >= 0) {
        return { action: 'transform', channel: tm[1], formula: tm[2].trim(), raw: line };
      }
      return { action: 'noop', raw: line };
    }
    if (verb === 'clear') return { action: 'clear', raw: line };
    if (verb === 'remove') {
      var rid = parseInt(parts[1], 10);
      return { action: 'remove', id: isFinite(rid) ? rid : null, raw: line };
    }
    return { action: 'noop', raw: line };
  }

  function presetFormula(preset) {
    if (preset === 'grid') return 'grid(i,n)';
    if (preset === 'ring') return 'ring(i,n,30)';
    if (preset === 'spiral') return 'spiral(i,n,30,3,0.6)';
    if (preset === 'sphere') return 'sphere(i,n,30)';
    return 'grid(i,n)';
  }
  // A param value from the DSL is either a plain number, a [r,g,b]/[x,y,z] list,
  // or a formula string (left as-is for the action layer to compile per-frame).
  function coerceParam(s) {
    s = String(s).trim();
    var n = Number(s);
    if (s !== '' && isFinite(n)) return n;
    return s; // formula or token — compiled / mapped downstream
  }

  /* =========================================================================
   *  THE ACTION LAYER — createBuilder(host) -> { placeObjects, selectTarget,
   *  applyEffect, transform, removeObject, clear, runPrompt, update, ... }
   *  ------------------------------------------------------------------------
   *  `host` injects the live environment (all OPTIONAL; absent ⇒ headless no-op):
   *    { THREE, group, VFX, sampleWorld, reduceMotion }
   *      THREE       — window.THREE (geometry/material/mesh); absent ⇒ logical-only
   *      group       — a THREE.Group the builder owns + adds objects to (its stage)
   *      VFX         — window.VFX (applyEffect routes here; absent ⇒ effect is a stub)
   *      sampleWorld — () => [x,y,z] origin for emitter effects (defaults [0,0,0])
   *      reduceMotion— () => bool  (freeze t; INV-2)
   *  The builder keeps a LOGICAL model (ids + transforms + effects) even with no
   *  THREE, so the headless harness can assert positions/effects without a GPU.
   *  Picking is a SEPARATE raycast set (host owns the THREE objects) — the economy
   *  `pickables` array is never touched (stays length 2).
   * ====================================================================== */
  function createBuilder(host) {
    host = host || {};
    var THREE = host.THREE || null;
    var group = host.group || null;
    var VFX = host.VFX || null;
    var sampleWorld = (typeof host.sampleWorld === 'function') ? host.sampleWorld : function () { return [0, 0, 0]; };
    var reduceMotion = (typeof host.reduceMotion === 'function') ? host.reduceMotion : function () { return false; };

    var objects = [];   // { id, shape, mesh, base:{pos,scale,rotY}, transforms:{}, effects:[] }
    var effects = [];   // flat list of attached effect handles (for cap + dispose)
    var nextId = 1;
    var selected = 'stage';   // current target: an object id | 'stage' | 'scene'
    // world-space anchor added to every placed object's formula position. Default [0,0,0] keeps placement
    // byte-identical to the formula (the golden tests rely on this); the host re-points it per section so
    // objects land in the ACTIVE scene. Applies to BOTH UI placeObjects and prompt-DSL `place`.
    var placeOrigin = [0, 0, 0];

    function findObj(id) { for (var k = 0; k < objects.length; k++) if (objects[k].id === id) return objects[k]; return null; }
    function effectCount() { return effects.length; }

    /* ---- geometry palette (THREE only; logical-only when absent) -------- */
    function makeGeometry(shape) {
      if (!THREE) return null;
      try {
        switch (shape) {
          case 'sphere':    return new THREE.SphereGeometry(2.4, 24, 18);
          case 'cone':      return new THREE.ConeGeometry(2.4, 5, 22);
          case 'torus':     return new THREE.TorusGeometry(2.4, 0.8, 14, 36);
          case 'torusKnot': return new THREE.TorusKnotGeometry(2.0, 0.6, 90, 14);
          case 'cylinder':  return new THREE.CylinderGeometry(1.8, 1.8, 5, 22);
          case 'icosa':     return THREE.IcosahedronGeometry ? new THREE.IcosahedronGeometry(2.6, 0) : new THREE.SphereGeometry(2.6, 12, 8);
          case 'box':
          default:          return new THREE.BoxGeometry(3.4, 3.4, 3.4);
        }
      } catch (e) { return null; }
    }
    function makeMaterial() {
      if (!THREE) return null;
      try {
        var c = (THREE.Color ? new THREE.Color(0x3fb6b2) : { r: 0.25, g: 0.71, b: 0.7 });
        return new THREE.MeshStandardMaterial({
          color: c, emissive: (THREE.Color ? new THREE.Color(0x123a52) : c),
          emissiveIntensity: 0.18, roughness: 0.4, metalness: 0.45, transparent: true, opacity: 1
        });
      } catch (e) { return null; }
    }

    /* ---- placeObjects: create up to a CAPPED N objects at formula positions --
     * opts = { shape, count, position (formula string | vec | fn), params? }
     * Returns the array of created ids. Position is evaluated per-index at t=0
     * (the static placement frame); per-frame motion is a TRANSFORM, not place. */
    function placeObjects(opts) {
      opts = opts || {};
      var shape = (SHAPES.indexOf(opts.shape) >= 0) ? opts.shape : 'box';
      var count = Math.floor(opts.count) || 0;
      if (count < 0) count = 0;
      // BOUNDED (INV-4): clamp this call to MAX_PLACE and to remaining headroom.
      count = Math.min(count, MAX_PLACE, Math.max(0, MAX_OBJECTS - objects.length));
      var posFormula = compilePosition(opts.position);
      var created = [];
      // explicit per-call origin wins; otherwise the section placeOrigin (default [0,0,0] = no offset).
      var origin = (opts.origin && opts.origin.length === 3)
        ? [num(opts.origin[0], 0), num(opts.origin[1], 0), num(opts.origin[2], 0)] : placeOrigin;
      for (var i = 0; i < count; i++) {
        var p = posFormula(i, count, 0, 0);   // t=0 placement frame
        var pos = toVec3(p);
        if (origin[0] || origin[1] || origin[2]) pos = [pos[0] + origin[0], pos[1] + origin[1], pos[2] + origin[2]];
        var id = nextId++;
        var mesh = null;
        if (THREE && group) {
          var geo = makeGeometry(shape), mat = makeMaterial();
          if (geo && mat) {
            try {
              mesh = new THREE.Mesh(geo, mat);
              if (mesh.position && mesh.position.set) mesh.position.set(pos[0], pos[1], pos[2]);
              mesh.userData = mesh.userData || {};
              mesh.userData.builderId = id;     // tag for the builder-only raycast set
              // NOTE: NEVER set userData.firmId and NEVER push to the economy pickables.
              if (group.add) group.add(mesh);
            } catch (e) { mesh = null; }
          }
        }
        objects.push({
          id: id, shape: shape, mesh: mesh,
          base: { pos: pos.slice(), scale: 1, rotY: 0 },
          transforms: {},     // channel -> compiled formula fn
          effects: []
        });
        created.push(id);
      }
      return created;
    }
    // Accept a formula string, a 3-vector, or a function; always return f(i,n,t,value)->vec-ish.
    function compilePosition(position) {
      if (typeof position === 'function') {
        return function (i, n, t, v) { try { return position(i, n, t, v); } catch (e) { return [0, 0, 0]; } };
      }
      if (Array.isArray(position)) {
        var v = [num(position[0], 0), num(position[1], 0), num(position[2], 0)];
        return function () { return v; };
      }
      if (typeof position === 'string' && position.trim()) {
        return compileFormula(position, [0, 0, 0]);
      }
      // default placement = a square grid
      return function (i, n) { return grid(i, n); };
    }

    /* ---- selectTarget: an object id | 'stage' | 'scene' ----------------- */
    function selectTarget(ref) {
      if (ref === 'stage' || ref === 'scene') { selected = ref; return ref; }
      var id = (typeof ref === 'number') ? ref : parseInt(ref, 10);
      if (isFinite(id) && findObj(id)) { selected = id; return id; }
      return selected;   // unknown ref → keep current selection (inert)
    }
    function getSelected() { return selected; }
    function selectedObjects() {
      if (selected === 'stage' || selected === 'scene') return objects.slice();
      var o = findObj(selected); return o ? [o] : [];
    }

    /* ---- applyEffect: attach a vfx.js effect to a target ----------------
     * target = id | 'stage' | 'scene'. effectName MUST be a real VFX.list() key.
     * Each param value may be a NUMBER or a FORMULA string (compiled, evaluated
     * per-frame as f(i,t,value)). Returns an effect-instance descriptor, or null. */
    function applyEffect(target, effectName, params) {
      if (effectCount() >= MAX_EFFECTS) return null;       // BOUNDED (INV-4)
      var key = resolveEffectKey(effectName);
      if (!key) return null;                                // not a real VFX effect
      params = params || {};
      // split params into static numbers vs. per-frame formulas
      var staticParams = {}, dynParams = {};
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        var val = params[k];
        if (typeof val === 'string' && isFormula(val)) dynParams[k] = compileFormula(val, 0);
        else staticParams[k] = val;
      }
      var inst = {
        id: nextId++, type: 'effect', effect: key, target: target,
        staticParams: staticParams, dynParams: dynParams, handle: null
      };
      // route to VFX if present; otherwise the instance is a logical-only descriptor.
      if (VFX) {
        try { inst.handle = spawnVfx(key, staticParams); } catch (e) { inst.handle = null; }
      }
      effects.push(inst);
      // record on each targeted object (so removeObject disposes its effects too)
      if (target !== 'stage' && target !== 'scene') {
        var o = findObj(target); if (o) o.effects.push(inst.id);
      }
      return inst;
    }
    // map a name to a real VFX.list() key (case-insensitive); null if unknown / VFX absent.
    function resolveEffectKey(name) {
      if (typeof name !== 'string' || !name) return null;
      var list = vfxKeys();
      if (!list.length) return null;
      if (list.indexOf(name) >= 0) return name;
      var low = name.toLowerCase();
      for (var k = 0; k < list.length; k++) if (list[k].toLowerCase() === low) return list[k];
      return null;
    }
    function vfxKeys() {
      if (!VFX || typeof VFX.list !== 'function') return [];
      var arr = [];
      try { arr = VFX.list() || []; } catch (e) { arr = []; }
      var out = [];
      for (var k = 0; k < arr.length; k++) if (arr[k] && arr[k].name) out.push(arr[k].name);
      return out;
    }
    // Spawn a VFX effect by family (mirrors the VFX Lab makeHandle routing). Best-effort.
    function spawnVfx(key, params) {
      if (!VFX) return null;
      var desc = null;
      try { var L = VFX.list() || []; for (var k = 0; k < L.length; k++) if (L[k].name === key) { desc = L[k]; break; } } catch (e) {}
      var fam = desc && desc.family;
      var origin = sampleWorld();
      try {
        if (fam === 'post') return VFX.post && VFX.post.enable ? VFX.post.enable(key, params) : null;
        if (fam === 'emitter') { var o = clone(params); o.origin = origin.slice(); return VFX.spawn ? VFX.spawn(key, o) : null; }
        if (fam === 'infographic') { var fn = VFX.infographic && VFX.infographic[key]; var oi = clone(params); oi.world = origin.slice(); return (typeof fn === 'function') ? fn(oi) : null; }
        // material needs a mesh; fall back to spawn for unknown families
        if (VFX.spawn) return VFX.spawn(key, params);
      } catch (e) { return null; }
      return null;
    }

    /* ---- transform: drive channels per-frame via number-or-formula -----
     * spec = { scale?, rotationY?, color?, opacity?, position?, ... } each a
     * number or a FORMULA string. Stored compiled on each targeted object; the
     * frame loop's update() evaluates them as f(i, t, value). Closed channel set. */
    function transform(target, spec) {
      spec = spec || {};
      var targets = (target === 'stage' || target === 'scene')
        ? objects.slice()
        : (function () { var o = findObj(target); return o ? [o] : []; })();
      for (var ti = 0; ti < targets.length; ti++) {
        var o = targets[ti];
        for (var ch in spec) {
          if (!Object.prototype.hasOwnProperty.call(spec, ch)) continue;
          var f = spec[ch];
          if (ch === 'color') {
            // color may be a [r,g,b], a hex number, or a formula (scalar 0..1 → ramp).
            o.transforms.color = compileColorChannel(f);
          } else {
            o.transforms[ch] = compileFormula(f, channelDefault(ch));
          }
        }
      }
      return targets.length;
    }
    function channelDefault(ch) {
      if (ch === 'scale') return 1;
      if (ch === 'opacity') return 1;
      return 0;   // rotationY / rotation / motion / effectParam
    }
    function compileColorChannel(f) {
      if (Array.isArray(f)) { var v = [num(f[0], 1), num(f[1], 1), num(f[2], 1)]; return function () { return v; }; }
      if (typeof f === 'number') { return function () { return f; }; }   // hex/scalar handled at apply time
      return compileFormula(f, 0);
    }

    /* ---- removeObject / clear: dispose + free (INV-4) ------------------- */
    function removeObject(id) {
      var idx = -1;
      for (var k = 0; k < objects.length; k++) if (objects[k].id === id) { idx = k; break; }
      if (idx < 0) return false;
      var o = objects[idx];
      // dispose its effects
      for (var e = 0; e < o.effects.length; e++) disposeEffectInstance(o.effects[e]);
      // dispose the mesh (geometry + material) and detach
      disposeMesh(o.mesh);
      objects.splice(idx, 1);
      if (selected === id) selected = 'stage';
      return true;
    }
    function clear() {
      for (var e = effects.length - 1; e >= 0; e--) {
        try { var inst = effects[e]; if (inst.handle && inst.handle.dispose) inst.handle.dispose(); } catch (x) {}
      }
      effects = [];
      for (var k = objects.length - 1; k >= 0; k--) disposeMesh(objects[k].mesh);
      objects = [];
      selected = 'stage';
      // also clear any post passes the builder may have enabled
      if (VFX && typeof VFX.reset === 'function') { try { VFX.reset(); } catch (x) {} }
    }
    function disposeEffectInstance(instId) {
      for (var e = 0; e < effects.length; e++) {
        if (effects[e].id === instId) {
          try { if (effects[e].handle && effects[e].handle.dispose) effects[e].handle.dispose(); } catch (x) {}
          effects.splice(e, 1); return;
        }
      }
    }
    function disposeMesh(mesh) {
      if (!mesh) return;
      try {
        if (mesh.parent && mesh.parent.remove) mesh.parent.remove(mesh);
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) { for (var k = 0; k < mesh.material.length; k++) if (mesh.material[k].dispose) mesh.material[k].dispose(); }
          else if (mesh.material.dispose) mesh.material.dispose();
        }
      } catch (e) { /* swallow — never throw across the host boundary */ }
    }

    /* ---- per-frame update: drive every object's transform channels -----
     * `elapsed` is the ONLY time input (INV-1); frozen under reduceMotion (INV-2).
     * Alloc-free scalar maths writing onto pre-built meshes. */
    function update(dt, elapsed) {
      var t = reduceMotion() ? 0 : (num(elapsed, 0));
      var n = objects.length;
      for (var i = 0; i < n; i++) {
        var o = objects[i];
        var tr = o.transforms;
        if (!tr) continue;
        var mesh = o.mesh;
        // SCALE
        if (tr.scale) {
          var sv = tr.scale(i, n, t, o.base.scale);
          if (typeof sv === 'number' && mesh && mesh.scale && mesh.scale.set) mesh.scale.set(sv, sv, sv);
        }
        // ROTATION (Y)
        if (tr.rotationY || tr.rotation) {
          var rf = tr.rotationY || tr.rotation;
          var rv = rf(i, n, t, o.base.rotY);
          if (typeof rv === 'number' && mesh && mesh.rotation) mesh.rotation.y = rv;
        }
        // OPACITY
        if (tr.opacity && mesh && mesh.material) {
          var ov = tr.opacity(i, n, t, 1);
          if (typeof ov === 'number') { mesh.material.opacity = Math.max(0, Math.min(1, ov)); mesh.material.transparent = true; }
        }
        // COLOR (scalar formula → cyan↔amber ramp; or a static [r,g,b])
        if (tr.color && mesh && mesh.material && mesh.material.color) {
          var cv = tr.color(i, n, t, 0);
          var rgb = colorFromChannel(cv);
          if (mesh.material.color.setRGB) mesh.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
        }
      }
      // per-frame dynamic effect params (formula → effect.setParams), bounded loop
      for (var e = 0; e < effects.length; e++) {
        var inst = effects[e];
        if (!inst.handle || !inst.handle.setParams) continue;
        var dyn = inst.dynParams; if (!dyn) continue;
        var patch = null;
        for (var key in dyn) {
          if (!Object.prototype.hasOwnProperty.call(dyn, key)) continue;
          var pv = dyn[key](0, 1, t, 0);
          if (typeof pv === 'number') { patch = patch || {}; patch[key] = pv; }
        }
        if (patch) { try { inst.handle.setParams(patch); } catch (x) {} }
      }
    }
    // map a channel value to [r,g,b] 0..1. Array → as-is; number in [0,1] → a sub-white
    // cyan→amber ramp (so emissive paths stay under the vfx.js clamp, INV-3).
    function colorFromChannel(cv) {
      if (Array.isArray(cv)) return [clamp01(cv[0]), clamp01(cv[1]), clamp01(cv[2])];
      var u = clamp01(num(cv, 0));
      // cyan (#3fb6b2) -> amber (#e0a23c), both sub-white
      var a = [0.25, 0.71, 0.70], b = [0.88, 0.64, 0.24];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
    function clamp01(x) { x = num(x, 0); return x < 0 ? 0 : (x > 1 ? 1 : x); }

    /* ---- runPrompt: parse a DSL prompt → emit the action sequence ------
     * The SEAM (ADR-D5): the real server-side Claude copilot (option A) returns
     * the SAME action objects parsePrompt() produces; runActions() dispatches
     * either source identically. Returns the executed action list (for the UI log
     * + the conformance test). */
    function runPrompt(text) {
      var actions = parsePrompt(text);
      runActions(actions);
      return actions;
    }
    // Dispatch a parsed/copilot-emitted action sequence over the action layer.
    function runActions(actions) {
      if (!Array.isArray(actions)) return;
      for (var a = 0; a < actions.length; a++) {
        var act = actions[a];
        if (!act || !act.action) continue;
        try {
          if (act.action === 'place') placeObjects({ shape: act.shape, count: act.count, position: act.position });
          else if (act.action === 'apply') applyEffect(getSelected(), act.effect, act.params || {});
          else if (act.action === 'select') selectTarget(act.ref);
          else if (act.action === 'transform') { var sp = {}; sp[act.channel] = act.formula; transform(getSelected(), sp); }
          else if (act.action === 'remove') { if (act.id != null) removeObject(act.id); }
          else if (act.action === 'clear') clear();
          // 'noop' is intentionally ignored (surfaced in the returned list)
        } catch (e) { /* one bad action never breaks the batch */ }
      }
    }

    function clone(p) { var o = {}; if (!p) return o; for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = Array.isArray(p[k]) ? p[k].slice() : p[k]; return o; }
    // a param value is a per-frame FORMULA when it is a non-empty string that is
    // NOT a plain numeric literal (so "0.5" is static, "0.5+0.5*sin(t)" is dynamic).
    function isFormula(v) {
      if (typeof v !== 'string') return false;
      var s = v.trim();
      if (!s) return false;
      var nn = Number(s);
      return !(isFinite(nn) && String(nn) === s) && /[a-zA-Z()+\-*/]/.test(s);
    }

    /* ---- introspection (used by the DOM panel + the headless probe) ----- */
    function snapshot() {
      return {
        count: objects.length,
        effectCount: effects.length,
        selected: selected,
        objects: objects.map(function (o) {
          return { id: o.id, shape: o.shape, pos: o.base.pos.slice(),
                   channels: Object.keys(o.transforms),
                   effects: o.effects.slice() };
        }),
        effects: effects.map(function (e) { return { id: e.id, effect: e.effect, target: e.target, live: !!e.handle }; })
      };
    }

    return {
      // the ACTION LAYER (the typed surface both front-ends + the copilot use)
      placeObjects: placeObjects,
      // set the world-space anchor that subsequent placements are offset by (lets the host place objects
      // into the ACTIVE section's scene). Returns the resolved origin. Does NOT move existing objects.
      setPlaceOrigin: function (v) { if (v && v.length === 3) placeOrigin = [num(v[0], 0), num(v[1], 0), num(v[2], 0)]; return placeOrigin.slice(); },
      selectTarget: selectTarget,
      applyEffect: applyEffect,
      transform: transform,
      removeObject: removeObject,
      clear: clear,
      // the PROMPT seam + the raw action dispatcher the copilot reuses
      runPrompt: runPrompt,
      runActions: runActions,
      // per-frame driver (gated by reduceMotion; the host calls it from the rAF loop)
      update: update,
      // introspection / state
      getSelected: getSelected,
      selectedObjects: selectedObjects,
      objects: function () { return objects.slice(); },
      effectKeys: vfxKeys,
      resolveEffectKey: resolveEffectKey,
      snapshot: snapshot,
      // caps (so the UI can show / clamp)
      caps: function () { return { maxObjects: MAX_OBJECTS, maxEffects: MAX_EFFECTS, maxPlace: MAX_PLACE }; }
    };
  }

  /* ---- public surface --------------------------------------------------- */
  var BuilderCore = {
    VERSION: '1.0.0',
    SHAPES: SHAPES.slice(),
    PRESETS: PRESETS.slice(),
    TRANSFORM_CHANNELS: TRANSFORM_CHANNELS.slice(),
    MAX_OBJECTS: MAX_OBJECTS,
    MAX_EFFECTS: MAX_EFFECTS,
    MAX_PLACE: MAX_PLACE,
    // the formula evaluator + placement helpers (pure, deterministic, headless)
    compileFormula: compileFormula,
    toVec3: toVec3,
    rand: randForIndex,
    grid: grid, ring: ring, spiral: spiral, sphere: sphere,
    // the prompt DSL
    parsePrompt: parsePrompt,
    presetFormula: presetFormula,
    // the action-layer factory
    createBuilder: createBuilder
  };

  // attach to window (browser) AND module.exports / globalThis (node:vm harness),
  // mirroring how vfx.js exposes window.VFX headless-safely.
  if (root) root.BuilderCore = BuilderCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = BuilderCore;
  if (typeof globalThis !== 'undefined') globalThis.BuilderCore = BuilderCore;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
