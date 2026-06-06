/* =============================================================================
 *  engine/dynamics/index.mjs  —  the DynamicsRegistry pillar  (Story P2.3, Pillar 3)
 *
 *  WHAT THIS IS: the MULTIPLE-OBJECT DYNAMICS pillar — a `register(desc)`/`list()`
 *  registry of GENERIC `create(host, {target, ...}) -> handle` dynamic factories,
 *  built on the engine/core kernel (P2.2) and matching `prototype/vfx.js`'s
 *  `VFX.list()` shape so ONE editor reflection path (P4) serves all four pillars.
 *
 *  GENERIC ONLY (INV-6 firewall): app-AGNOSTIC motion primitives that drive a
 *  bound `target` transform — `spin` (constant angular velocity), `orbit` (circular
 *  path), `keyframe` (timeline of value stops), `trajectory` (a matrix → path over
 *  time), and `flow` (advance a flow phase). NO Magnate vocabulary (no economy
 *  day/night, no trade-volume packets, no firm motion) — Magnate binds meaning to
 *  these generic dynamics at P2.5 via apps/magnate/bindings.
 *
 *  THE FACTORY CONTRACT (architecture §Factory pattern, dynamics flavor):
 *    create(host, { target, ...params }) -> {
 *      update(dt, elapsed),         // MUTATES the target IN PLACE — zero per-frame alloc
 *      setParams(p),                // merges via withDefaults into a FRESH object
 *      dispose(),                   // detaches the binding (swallowed-safe + idempotent)
 *    }
 *  A `target` is anything with a mutable `{position?, rotation?, scale?}` (a THREE
 *  Object3D, an engine object handle's `group`, or a plain headless node) — the
 *  dynamic NEVER allocates per frame; it writes existing fields in place.
 *
 *  HEADLESS + DETERMINISTIC (INV-1): with THREE absent (or a missing target) every
 *  factory returns a valid INERT handle that never throws; any randomness is the
 *  seeded engine/core makeRng (no wall-clock, no global RNG); update() is
 *  reduceMotion-gated (a static resting frame — never an animation advance).
 *
 *  BOUNDED (INV-4): the multi-target fan-out is CAPPED (`FANOUT_CAP`) and the
 *  trajectory sample count is CAPPED (`SAMPLE_CAP`); both documented in descriptors.
 *
 *  Native ESM (D1); imports ONLY from ../core (the P2.2 kernel) + nothing app/vendor.
 * ========================================================================== */

import { createRegistry, makeRng, reduceMotion } from '../core/index.mjs';

export const VERSION = '0.1.0-p2.3-dynamics';
export const NAME = 'engine/dynamics';

/** Hard CAP on a dynamic's multi-target fan-out (INV-4). A dynamic bound to an
 *  array of targets drives at most this many; documented in the descriptor. */
export const FANOUT_CAP = 1024;
/** Hard CAP on the trajectory sample count read from a matrix (INV-4). */
export const SAMPLE_CAP = 8192;

/** merge defaults <- over into a FRESH object (no shared mutation). */
function withDefaults(defaults, over) {
  const out = {};
  for (const k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = Array.isArray(defaults[k]) ? defaults[k].slice() : defaults[k];
  if (over) for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = Array.isArray(over[k]) ? over[k].slice() : over[k];
  return out;
}

/** Resolve the params (everything on the create arg except `target`/`targets`). */
function paramsOf(arg) {
  const a = arg || {};
  const p = {};
  for (const k in a) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
    if (k === 'target' || k === 'targets') continue;
    p[k] = a[k];
  }
  return p;
}

/** Resolve a CAPPED array of drive targets from the create arg (single or many). */
function targetsOf(arg) {
  const a = arg || {};
  let list = [];
  if (Array.isArray(a.targets)) list = a.targets.slice(0, FANOUT_CAP);
  else if (a.target) list = [a.target];
  return list;
}

/** A node's mutable position-ish vector ({x,y,z} or {set}), or null. We write
 *  fields IN PLACE — never allocate a new vector per frame. */
function posOf(t) { return t && t.position ? t.position : (t && typeof t.x === 'number' ? t : null); }
function rotOf(t) { return t && t.rotation ? t.rotation : null; }
function scaleOf(t) { return t && t.scale ? t.scale : null; }

/**
 * wrapDynamic(host, defaults, arg, opts) — the uniform dynamics handle.
 * opts.step(host, targets, dt, elapsed, p, state) is the per-frame body, called
 * ONLY when motion is allowed (reduceMotion-gated). `state` is a private object
 * pre-allocated ONCE (no per-frame new). dispose() drops the binding (idempotent).
 */
function wrapDynamic(host, defaults, arg, opts) {
  const o = opts || {};
  let current = withDefaults(defaults, paramsOf(arg));
  const targets = targetsOf(arg);
  const state = (typeof o.initState === 'function') ? (o.initState(current) || {}) : {};
  let disposed = false;

  const handle = {
    get params() { return current; },
    get targets() { return targets; },

    update(dt, elapsed) {
      if (disposed) return;
      if (reduceMotion(host)) return;                  // static resting frame (INV-2)
      if (typeof o.step === 'function') {
        try { o.step(host, targets, +dt || 0, +elapsed || 0, current, state); } catch { /* swallowed */ }
      }
    },

    setParams(p) {
      if (disposed) return;
      current = withDefaults(current, p);              // fresh object; no shared mutation
      if (typeof o.onParams === 'function') { try { o.onParams(current, state); } catch { /* swallowed */ } }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // dynamics own no GPU resources (they DRIVE targets); just drop the binding.
      targets.length = 0;
    },
  };
  return handle;
}

/* =============================================================================
 *  GENERIC DYNAMIC FACTORIES — each create(host, {target, ...}) -> handle.
 *  Every update() mutates target fields IN PLACE; NO per-frame allocation.
 * ========================================================================== */

/* ---- spin: constant angular velocity about an axis ------------------------ */
function createSpin(host, arg) {
  return wrapDynamic(host, DEFAULTS.spin, arg, {
    step(h, targets, dt, elapsed, p) {
      const ax = p.axis || 'y';
      const d = (p.speed || 0) * dt;
      for (let i = 0; i < targets.length; i++) {
        const r = rotOf(targets[i]);
        if (r && typeof r[ax] === 'number') r[ax] += d;   // in place (no alloc)
      }
    },
  });
}

/* ---- orbit: drive position around a circular path ------------------------- */
function createOrbit(host, arg) {
  return wrapDynamic(host, DEFAULTS.orbit, arg, {
    initState(p) { return { phase: +p.startAngle || 0 }; },
    step(h, targets, dt, elapsed, p, st) {
      st.phase += (p.speed || 0) * dt;                     // advance in place
      const cx = (p.center && p.center[0]) || 0;
      const cy = (p.center && p.center[1]) || 0;
      const cz = (p.center && p.center[2]) || 0;
      const x = cx + Math.cos(st.phase) * p.radius;
      const z = cz + Math.sin(st.phase) * p.radius;
      for (let i = 0; i < targets.length; i++) {
        const ps = posOf(targets[i]);
        if (ps && ps.set) ps.set(x, cy, z);
        else if (ps) { ps.x = x; ps.y = cy; ps.z = z; }   // in place (no alloc)
      }
    },
  });
}

/* ---- keyframe: a timeline of {t, value} stops driving one channel --------- */
function createKeyframe(host, arg) {
  return wrapDynamic(host, DEFAULTS.keyframe, arg, {
    initState(p) { return { time: 0, keys: normalizeKeys(p.keys) }; },
    onParams(p, st) { st.keys = normalizeKeys(p.keys); },
    step(h, targets, dt, elapsed, p, st) {
      const keys = st.keys;
      if (!keys.length) return;
      st.time += dt;
      const dur = keys[keys.length - 1].t || 1;
      let tt = st.time;
      if (p.loop) tt = dur > 0 ? (tt % dur) : 0;
      else tt = Math.min(tt, dur);
      const v = sampleKeys(keys, tt);                      // scalar in place
      const ch = p.channel || 'y';
      const space = p.space || 'position';
      for (let i = 0; i < targets.length; i++) {
        const node = (space === 'rotation') ? rotOf(targets[i]) : (space === 'scale') ? scaleOf(targets[i]) : posOf(targets[i]);
        if (node && typeof node[ch] === 'number') node[ch] = v;  // in place (no alloc)
      }
    },
  });
}
/** sort keys by t, slice to a sane bound. */
function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const out = keys.filter((k) => k && typeof k.t === 'number' && typeof k.value === 'number').slice(0, SAMPLE_CAP);
  out.sort((a, b) => a.t - b.t);
  return out;
}
/** piecewise-linear sample of a sorted keys array at time tt. */
function sampleKeys(keys, tt) {
  if (tt <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (tt >= last.t) return last.value;
  for (let i = 1; i < keys.length; i++) {
    if (tt <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const span = (b.t - a.t) || 1;
      const f = (tt - a.t) / span;
      return a.value + (b.value - a.value) * f;
    }
  }
  return last.value;
}

/* ---- trajectory: a matrix (rows of [x,y,z]) → a path over time ------------ */
function createTrajectory(host, arg) {
  return wrapDynamic(host, DEFAULTS.trajectory, arg, {
    initState(p) { return { time: 0, path: normalizePath(p.matrix, p.stride) }; },
    onParams(p, st) { st.path = normalizePath(p.matrix, p.stride); },
    step(h, targets, dt, elapsed, p, st) {
      const path = st.path;                                // [{x,y,z},...] (pre-built once)
      const n = path.length;
      if (n === 0) return;
      st.time += dt;
      const dur = Math.max(1e-6, p.duration);
      let u = st.time / dur;                               // 0..1 progress
      if (p.loop) u = u - Math.floor(u);
      else u = Math.min(1, Math.max(0, u));
      // sample the path at u (piecewise-linear between rows) — scalars in place.
      const fi = u * (n - 1);
      const i0 = Math.min(n - 1, Math.floor(fi));
      const i1 = Math.min(n - 1, i0 + 1);
      const f = fi - i0;
      const a = path[i0], b = path[i1];
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const z = a.z + (b.z - a.z) * f;
      for (let i = 0; i < targets.length; i++) {
        const ps = posOf(targets[i]);
        if (ps && ps.set) ps.set(x, y, z);
        else if (ps) { ps.x = x; ps.y = y; ps.z = z; }     // in place (no alloc)
      }
    },
  });
}
/** turn a flat/typed-array matrix into a CAPPED array of {x,y,z} rows (built ONCE). */
function normalizePath(matrix, stride) {
  const st = (stride === 2) ? 2 : 3;
  if (!matrix || typeof matrix.length !== 'number') return [];
  const rows = Math.min(SAMPLE_CAP, Math.floor(matrix.length / st));
  const out = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const o = r * st;
    out[r] = { x: +matrix[o] || 0, y: st === 3 ? (+matrix[o + 1] || 0) : 0, z: st === 3 ? (+matrix[o + 2] || 0) : (+matrix[o + 1] || 0) };
  }
  return out;
}

/* ---- flow: advance a scalar flow phase (e.g. a belt/stream offset) -------- */
function createFlow(host, arg) {
  return wrapDynamic(host, DEFAULTS.flow, arg, {
    initState(p) {
      // seeded per-target jitter, computed ONCE (deterministic, no per-frame RNG).
      const rng = makeRng((p.seed >>> 0) || 1);
      return { phase: 0, jitter: Array.from({ length: FANOUT_CAP }, () => (rng() - 0.5) * 2) };
    },
    step(h, targets, dt, elapsed, p, st) {
      st.phase += (p.speed || 0) * dt;                     // advance in place
      const ax = p.axis || 'x';
      const span = p.span || 0;
      for (let i = 0; i < targets.length; i++) {
        const ps = posOf(targets[i]);
        if (!ps) continue;
        let off = st.phase + (p.stagger ? st.jitter[i] * p.stagger : 0);
        if (span > 0) off = ((off % span) + span) % span - span * 0.5;  // wrap into [-span/2, span/2]
        if (typeof ps[ax] === 'number') ps[ax] = (p.base || 0) + off;   // in place (no alloc)
      }
    },
  });
}

/* =============================================================================
 *  DESCRIPTOR DEFAULT PARAMS — controls are INFERRED from these. `fanoutCap`/
 *  `sampleCap` document the bounds (INV-4); `seed` makes jitter deterministic.
 * ========================================================================== */
const DEFAULTS = {
  spin:       { axis: 'y', speed: 1.0, fanoutCap: FANOUT_CAP },
  orbit:      { radius: 5, speed: 0.5, startAngle: 0, center: [0, 0, 0], fanoutCap: FANOUT_CAP },
  keyframe:   { space: 'position', channel: 'y', keys: [{ t: 0, value: 0 }, { t: 1, value: 1 }], loop: true, fanoutCap: FANOUT_CAP },
  trajectory: { matrix: [], stride: 3, duration: 4, loop: true, sampleCap: SAMPLE_CAP, fanoutCap: FANOUT_CAP },
  flow:       { axis: 'x', speed: 1.0, base: 0, span: 0, stagger: 0, seed: 1, fanoutCap: FANOUT_CAP },
};

function categoryFor(desc) {
  if (desc.id === 'keyframe' || desc.id === 'trajectory') return 'Timeline';
  if (desc.id === 'flow') return 'Flow';
  return 'Motion';
}

/* =============================================================================
 *  THE DYNAMICS REGISTRY — register(desc)/list() matching VFX.list().
 * ========================================================================== */
export const DynamicsRegistry = createRegistry({
  name: 'DynamicsRegistry',
  categoryFor,
  enumOptions: { axis: ['x', 'y', 'z'], space: ['position', 'rotation', 'scale'] },
});

DynamicsRegistry.register({ id: 'spin', kind: 'Constant angular velocity', params: DEFAULTS.spin, factory: createSpin });
DynamicsRegistry.register({ id: 'orbit', kind: 'Circular orbit path', params: DEFAULTS.orbit, factory: createOrbit });
DynamicsRegistry.register({ id: 'keyframe', kind: 'Keyframe timeline (piecewise-linear)', params: DEFAULTS.keyframe, factory: createKeyframe });
DynamicsRegistry.register({ id: 'trajectory', kind: 'Matrix path over time', params: DEFAULTS.trajectory, factory: createTrajectory });
DynamicsRegistry.register({ id: 'flow', kind: 'Flow phase advance', params: DEFAULTS.flow, factory: createFlow });

export const dynamics = Object.freeze({
  name: NAME,
  version: VERSION,
  registry: DynamicsRegistry,
  FANOUT_CAP,
  SAMPLE_CAP,
});

export default DynamicsRegistry;
