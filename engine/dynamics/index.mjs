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
 *  Native ESM (D1); imports ONLY from ../core (the P2.2 kernel) + the local
 *  pure ./easing library + nothing app/vendor.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  P5 DEEPENING (Stories P5.1 + P5.2 — ADDITIVE, same 5 registry ids):
 *
 *    P5.1 TIMELINE/KEYFRAME — the `keyframe` dynamic is DEEPENED to a declarative
 *    timeline of `[{t, channel, value, easing}]` keyframes interpolated by a PURE
 *    easing library (./easing) as a pure function of (keyframes, elapsed) over the
 *    HOST-INJECTED clock (the `elapsed` the host passes to update()) — NOT an
 *    internally-accumulated dt. Same elapsed -> byte-identical channels (INV-1);
 *    reduceMotion snaps to the resting frame (t=0 / declared `resting`); any
 *    jitter uses an instance-local seeded mulberry32 (engine/core makeRng).
 *
 *    P5.2 MATRIX->TRAJECTORY — the `trajectory` dynamic is DEEPENED to sample a
 *    `timeseries` NDArray (shape [t,n,f], meta.t) at `elapsed` and drive the
 *    position/motion channel of N instances, writing ZERO-COPY into pre-sized
 *    typed-array buffers (no per-frame new). The path is reproducible from
 *    (data, seed); a seeded projection feeding positions stays deterministic;
 *    the channel is PROPORTIONAL (channel(value)/value is a single constant `k`
 *    across instances — encoding linearity). reduceMotion -> the t=0 sample.
 *
 *  BACKWARD-COMPATIBLE: the P2.3 flat shapes still work (keyframe `{t,value}` +
 *  `channel`/`space`; trajectory flat `matrix`+`stride`); the registry still has
 *  EXACTLY the five ids spin/orbit/keyframe/trajectory/flow.
 * ========================================================================== */

import { createRegistry, makeRng, reduceMotion } from '../core/index.mjs';
import { easingFn, EASING_NAMES } from './easing.mjs';

export const VERSION = '0.2.0-p5-dynamics';
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

    /**
     * read() — a VIEW-ONLY probe reading of the dynamic's current channel output
     * (the headless count/channel-reader contract). A dynamic that declares an
     * `opts.read(state, p)` hook returns its structured reading (e.g. the trajectory
     * pre-sized channel buffer + [n,f] dims); otherwise returns null. Mutates NOTHING.
     */
    read() {
      if (typeof o.read === 'function') { try { return o.read(state, current); } catch { return null; } }
      return null;
    },

    update(dt, elapsed) {
      if (disposed) return;
      if (reduceMotion(host)) {
        // INV-2: reduced-motion is a NO-OP advance. A dynamic that declares an
        // `onReduced(host, targets, p, state)` hook SNAPS its targets to a static
        // resting frame (e.g. t=0 / a declared resting keyframe) — exactly ONCE,
        // idempotently — so a captured channel array reflects the resting frame
        // and does not advance on subsequent update() calls (the Tier-B vectors
        // freeze this snapshot). Dynamics with no hook simply early-out (P2.3).
        if (typeof o.onReduced === 'function' && !state.__rest) {
          try { o.onReduced(host, targets, current, state); } catch { /* swallowed */ }
          state.__rest = true;
        }
        return;
      }
      state.__rest = false;                            // motion resumed -> allow a future re-snap
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

/* ---- keyframe: a DECLARATIVE TIMELINE of [{t, channel, value, easing}] stops -
 *
 *  P5.1 DEEPENED. The interpolated channel values are a PURE function of
 *  (keyframes, elapsed): the timeline is read off the HOST-INJECTED `elapsed`
 *  (the deterministic clock the host passes to update()) — NOT an internally
 *  accumulated dt — so the SAME elapsed reproduces byte-identical channels across
 *  runs and a single seeded frame is freezable as a render-snapshot vector (INV-1).
 *
 *  Each keyframe may carry its OWN `channel` (so one dynamic drives several channels
 *  from one declarative list) and its OWN `easing` (a frozen ./easing name applied
 *  over the [a,b] span). Backward compatible with the P2.3 simple `{t,value}` shape
 *  where the channel falls back to the dynamic-level `channel`/`space`.
 *
 *  ALLOC-FREE (INV-4): the per-channel sorted key tracks AND the channel-value
 *  output buffer are built ONCE (initState / onParams). update() mutates the
 *  pre-built `st.out` map in place and writes scalars into target fields in place —
 *  no per-frame new.  reduceMotion -> the resting frame (t=0 / declared `resting`).
 * ------------------------------------------------------------------------- */
function createKeyframe(host, arg) {
  return wrapDynamic(host, DEFAULTS.keyframe, arg, {
    initState(p) { return buildKeyframeState(p); },
    onParams(p, st) { const ns = buildKeyframeState(p); st.tracks = ns.tracks; st.dur = ns.dur; st.out = ns.out; st.channels = ns.channels; },

    step(h, targets, dt, elapsed, p, st) {
      if (!st.channels.length) return;
      const tt = timelineTime(elapsed, st.dur, p.loop);   // PURE: elapsed -> timeline time
      // sample every channel track into the PRE-BUILT st.out map (no alloc).
      for (let c = 0; c < st.channels.length; c++) {
        const ch = st.channels[c];
        st.out[ch] = sampleTrack(st.tracks[ch], tt);      // eased piecewise sample
      }
      writeChannels(targets, p.space, st.channels, st.out);
    },

    onReduced(h, targets, p, st) {
      if (!st.channels.length) return;
      const tt = restingTime(p, st.dur);                  // t=0 / declared resting
      for (let c = 0; c < st.channels.length; c++) {
        const ch = st.channels[c];
        st.out[ch] = sampleTrack(st.tracks[ch], tt);
      }
      writeChannels(targets, p.space, st.channels, st.out);
    },
  });
}

/** Build (ONCE) the per-channel sorted key tracks + the reusable output map. */
function buildKeyframeState(p) {
  const fallbackCh = p.channel || 'y';
  const fallbackEasing = (typeof p.easing === 'string') ? p.easing : 'linear';  // timeline-level default
  const tracks = Object.create(null);                     // channel -> sorted [{t,value,easing}]
  const list = Array.isArray(p.keys) ? p.keys : [];
  let count = 0;
  for (let i = 0; i < list.length && count < SAMPLE_CAP; i++) {
    const k = list[i];
    if (!k || typeof k.t !== 'number' || typeof k.value !== 'number') continue;
    const ch = (typeof k.channel === 'string' && k.channel) ? k.channel : fallbackCh;
    if (!tracks[ch]) tracks[ch] = [];
    tracks[ch].push({ t: k.t, value: k.value, easing: (typeof k.easing === 'string' ? k.easing : fallbackEasing) });
    count++;
  }
  const channels = [];
  let dur = 0;
  for (const ch in tracks) {
    tracks[ch].sort((a, b) => a.t - b.t);                 // stable timeline order
    const last = tracks[ch][tracks[ch].length - 1];
    if (last && last.t > dur) dur = last.t;
    channels.push(ch);
  }
  channels.sort();                                        // deterministic channel order
  const out = Object.create(null);
  for (let c = 0; c < channels.length; c++) out[channels[c]] = 0;  // pre-build the buffer (no per-frame alloc)
  return { tracks, channels, out, dur: dur || 1 };
}

/** PURE: map host `elapsed` onto the timeline time (loop wraps; else clamp). */
function timelineTime(elapsed, dur, loop) {
  let tt = +elapsed || 0;
  if (loop) tt = dur > 0 ? (((tt % dur) + dur) % dur) : 0;  // wrap into [0,dur)
  else tt = Math.max(0, Math.min(tt, dur));
  return tt;
}

/** The resting-frame time: a declared `resting` keyframe-time, else t=0. */
function restingTime(p, dur) {
  if (typeof p.resting === 'number' && Number.isFinite(p.resting)) {
    return Math.max(0, Math.min(p.resting, dur));
  }
  return 0;
}

/** Eased piecewise sample of a sorted single-channel track at timeline time tt. */
function sampleTrack(keys, tt) {
  if (!keys || !keys.length) return 0;
  if (tt <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (tt >= last.t) return last.value;
  for (let i = 1; i < keys.length; i++) {
    if (tt <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const span = (b.t - a.t) || 1;
      const f = (tt - a.t) / span;                        // 0..1 progress within the span
      const e = easingFn(b.easing)(f);                    // PURE easing (b's incoming easing)
      return a.value + (b.value - a.value) * e;
    }
  }
  return last.value;
}

/** Write the sampled channel scalars into the target nodes IN PLACE (no alloc). */
function writeChannels(targets, space, channels, out) {
  const sp = space || 'position';
  for (let i = 0; i < targets.length; i++) {
    const node = (sp === 'rotation') ? rotOf(targets[i]) : (sp === 'scale') ? scaleOf(targets[i]) : posOf(targets[i]);
    if (!node) continue;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      if (typeof node[ch] === 'number') node[ch] = out[ch];  // in place (no alloc)
    }
  }
}

/* ---- trajectory: a MATRIX → a path over time ------------------------------
 *
 *  P5.2 DEEPENED — two declarative modes, both PURE functions of (data, elapsed):
 *
 *  (A) TIMESERIES NDArray  `data`: a `timeseries` NDArray of shape [t, n, f]
 *      (axis `meta.t` = the time axis, default 0; n = INSTANCES; f = features /
 *      position components) drives N instances. At a given `elapsed` we map to a
 *      timeline time, find the bracketing time rows, and for every instance n we
 *      linearly interpolate its f features. The result is written ZERO-COPY into a
 *      PRE-SIZED Float32Array channel buffer (`st.buffer`, built ONCE) and, when a
 *      target exists for instance n, into that target's position fields IN PLACE.
 *      The channel is PROPORTIONAL: `channel = value · k` (a single constant `k`
 *      across ALL instances — encoding linearity; `k` defaults to 1, no floor/cap),
 *      so `channel(value)/value === k` is the platform's signature parity check.
 *      Reproducible from (data, seed): a seeded projection feeding `data` upstream
 *      stays deterministic (the seed is recorded in the descriptor).
 *
 *  (B) LEGACY FLAT matrix `matrix`+`stride` (P2.3): a single shared path of
 *      [x,y,z] rows that every target follows — preserved byte-for-byte.
 *
 *  BOTH alloc-free (INV-4): the parsed path / the [t,n,f] dims / the output buffer
 *  are built ONCE; update() mutates them in place. N is CAPPED at FANOUT_CAP and
 *  the time/sample count at SAMPLE_CAP. reduceMotion -> the t=0 resting sample.
 * ------------------------------------------------------------------------- */
function createTrajectory(host, arg) {
  return wrapDynamic(host, DEFAULTS.trajectory, arg, {
    initState(p) { return buildTrajectoryState(p); },
    onParams(p, st) { const ns = buildTrajectoryState(p); for (const k in ns) st[k] = ns[k]; },

    step(h, targets, dt, elapsed, p, st) {
      if (st.ts) sampleTimeseries(targets, p, st, +elapsed || 0);
      else sampleFlatPath(targets, p, st, +elapsed || 0);
    },

    onReduced(h, targets, p, st) {
      // INV-2: snap to the static t=0 resting sample (does not advance).
      if (st.ts) sampleTimeseries(targets, p, st, 0);
      else sampleFlatPath(targets, p, st, 0);
    },

    // VIEW-ONLY probe: the pre-sized channel buffer + [n,f] dims + proportionality k.
    read(st) {
      if (!st.ts) return null;
      return { buffer: st.buffer, n: st.ts.n, f: st.ts.f, k: st.k };
    },
  });
}

/** Build (ONCE) the trajectory state: either a timeseries plan or a flat path,
 *  plus the PRE-SIZED output channel buffer (no per-frame alloc). */
function buildTrajectoryState(p) {
  const ts = parseTimeseries(p.data);
  if (ts) {
    // proportionality constant k (channel = value·k). Default 1 (identity, no cap).
    const k = (typeof p.k === 'number' && Number.isFinite(p.k)) ? p.k : 1;
    // PRE-SIZE the channel output buffer: n instances × f features (zero-copy target).
    const buffer = new Float32Array(ts.n * ts.f);
    return { ts, k, buffer };
  }
  return { ts: null, path: normalizePath(p.matrix, p.stride) };
}

/** Map host `elapsed` -> a [0,1] progress `u` (loop wraps; else clamp). PURE. */
function progressU(elapsed, duration, loop) {
  const dur = Math.max(1e-6, +duration || 1e-6);
  let u = (+elapsed || 0) / dur;
  if (loop) u = u - Math.floor(u);                         // wrap into [0,1)
  else u = Math.min(1, Math.max(0, u));
  return u;
}

/* --- (A) timeseries [t,n,f] sampling --------------------------------------- */
/** Parse a `data` NDArray (kind timeseries, shape [t,n,f]) into a sampling plan,
 *  CAPPED at SAMPLE_CAP time rows and FANOUT_CAP instances. Returns null if the
 *  data is not a usable [t,n,f] timeseries (-> caller falls back to flat path). */
function parseTimeseries(nd) {
  if (!nd || !nd.data || typeof nd.data.length !== 'number') return null;
  const shape = nd.shape;
  if (!Array.isArray(shape) || shape.length !== 3) return null;
  const stride = Array.isArray(nd.stride) && nd.stride.length === 3 ? nd.stride : null;
  if (!stride) return null;
  const tAxis = (nd.meta && Number.isInteger(nd.meta.t)) ? nd.meta.t : 0;
  if (tAxis < 0 || tAxis > 2) return null;
  // resolve the n / f axes as the two non-t axes (kept in ascending axis order).
  const rest = [0, 1, 2].filter((a) => a !== tAxis);
  const nAxis = rest[0], fAxis = rest[1];
  const T = Math.min(SAMPLE_CAP, shape[tAxis] | 0);
  const n = Math.min(FANOUT_CAP, shape[nAxis] | 0);
  const f = shape[fAxis] | 0;
  if (T < 1 || n < 1 || f < 1) return null;
  return {
    data: nd.data, offset: (nd.offset | 0) || 0,
    T, n, f,
    tStride: stride[tAxis], nStride: stride[nAxis], fStride: stride[fAxis],
  };
}

/** Position-axis keys — module-scope constant (hoisted out of the per-frame path so
 *  sampleTimeseries() allocates nothing per frame; strict INV-4 alloc-free). */
const POS = ['x', 'y', 'z'];

/** Sample the [t,n,f] timeseries at `elapsed` into the PRE-SIZED st.buffer
 *  (zero-copy) and into target positions IN PLACE. Proportional: out = value·k. */
function sampleTimeseries(targets, p, st, elapsed) {
  const ts = st.ts, k = st.k, buf = st.buffer;
  const u = progressU(elapsed, p.duration, p.loop);
  const fi = u * (ts.T - 1);                               // fractional time index
  const i0 = Math.min(ts.T - 1, Math.floor(fi));
  const i1 = Math.min(ts.T - 1, i0 + 1);
  const frac = fi - i0;
  const base0 = ts.offset + i0 * ts.tStride;
  const base1 = ts.offset + i1 * ts.tStride;
  for (let inst = 0; inst < ts.n; inst++) {
    const n0 = base0 + inst * ts.nStride;
    const n1 = base1 + inst * ts.nStride;
    const outRow = inst * ts.f;
    const tgt = targets.length ? posOf(targets[inst < targets.length ? inst : targets.length - 1]) : null;
    for (let c = 0; c < ts.f; c++) {
      const a = +ts.data[n0 + c * ts.fStride] || 0;
      const b = +ts.data[n1 + c * ts.fStride] || 0;
      const value = a + (b - a) * frac;                    // time-interp feature value
      const out = value * k;                               // PROPORTIONAL channel (channel/value === k)
      buf[outRow + c] = out;                               // zero-copy into the pre-sized buffer
      if (tgt && c < 3 && typeof tgt[POS[c]] === 'number') tgt[POS[c]] = out;  // drive position in place
    }
  }
}

/* --- (B) legacy flat path -------------------------------------------------- */
/** Sample the flat shared path at `elapsed` (PURE) and drive every target. */
function sampleFlatPath(targets, p, st, elapsed) {
  const path = st.path;                                    // [{x,y,z},...] (pre-built once)
  const n = path.length;
  if (n === 0) return;
  const u = progressU(elapsed, p.duration, p.loop);
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
    else if (ps) { ps.x = x; ps.y = y; ps.z = z; }         // in place (no alloc)
  }
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
  // P5.1: `easing` is the timeline-level default easing (a per-key `easing` wins);
  // `resting` is the declared resting-frame time honored under reduceMotion (INV-2).
  keyframe:   { space: 'position', channel: 'y', keys: [{ t: 0, value: 0 }, { t: 1, value: 1 }], easing: 'linear', resting: 0, loop: true, fanoutCap: FANOUT_CAP },
  // P5.2: `data` is a timeseries [t,n,f] NDArray (null -> falls back to the flat
  // `matrix` path); `k` is the proportionality constant (channel = value·k).
  trajectory: { data: null, k: 1, matrix: [], stride: 3, duration: 4, loop: true, sampleCap: SAMPLE_CAP, fanoutCap: FANOUT_CAP },
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
  enumOptions: {
    axis: ['x', 'y', 'z'],
    space: ['position', 'rotation', 'scale'],
    easing: EASING_NAMES.slice(),                         // P5.1: declarable easing curves (select)
  },
});

DynamicsRegistry.register({ id: 'spin', kind: 'Constant angular velocity', params: DEFAULTS.spin, factory: createSpin });
DynamicsRegistry.register({ id: 'orbit', kind: 'Circular orbit path', params: DEFAULTS.orbit, factory: createOrbit });
DynamicsRegistry.register({ id: 'keyframe', kind: 'Eased keyframe timeline (pure fn of elapsed)', params: DEFAULTS.keyframe, factory: createKeyframe });
DynamicsRegistry.register({ id: 'trajectory', kind: 'Matrix→trajectory ([t,n,f] timeseries) over time', params: DEFAULTS.trajectory, factory: createTrajectory });
DynamicsRegistry.register({ id: 'flow', kind: 'Flow phase advance', params: DEFAULTS.flow, factory: createFlow });

/* =============================================================================
 *  PURE PRIMITIVES — exported so the conformance/test layer can freeze the motion
 *  math directly (no host, no GPU). All are pure, alloc-light, deterministic.
 * ========================================================================== */

/**
 * sampleKeyframes(keys, elapsed, opts) — the P5.1 PURE keyframe interpolator.
 * A pure function of (keys, elapsed): builds the per-channel tracks, maps `elapsed`
 * onto the timeline (loop/clamp), and returns a fresh `{channel: value}` map.
 * (Convenience for vectors — the live dynamic mutates a PRE-BUILT buffer in place.)
 *
 * @param {Array<{t,channel?,value,easing?}>} keys
 * @param {number} elapsed
 * @param {{channel?:string, easing?:string, loop?:boolean}} [opts]
 */
export function sampleKeyframes(keys, elapsed, opts = {}) {
  const st = buildKeyframeState({ keys, channel: opts.channel, easing: opts.easing });
  const tt = timelineTime(elapsed, st.dur, !!opts.loop);
  const out = {};
  for (let c = 0; c < st.channels.length; c++) {
    const ch = st.channels[c];
    out[ch] = sampleTrack(st.tracks[ch], tt);
  }
  return out;
}

/**
 * sampleTrajectory(nd, elapsed, opts) — the P5.2 PURE [t,n,f] sampler. Returns a
 * fresh Float32Array of n·f proportional channel values (channel = value·k) sampled
 * at `elapsed`. Reproducible from (data) for a fixed elapsed; `k` is constant across
 * all instances (encoding linearity). (The live dynamic writes a PRE-SIZED buffer.)
 *
 * @param {object} nd  a timeseries NDArray-like {data,shape,stride,offset?,meta?}
 * @param {number} elapsed
 * @param {{k?:number, duration?:number, loop?:boolean}} [opts]
 */
export function sampleTrajectory(nd, elapsed, opts = {}) {
  const ts = parseTimeseries(nd);
  if (!ts) return new Float32Array(0);
  const k = (typeof opts.k === 'number' && Number.isFinite(opts.k)) ? opts.k : 1;
  const st = { ts, k, buffer: new Float32Array(ts.n * ts.f) };
  const p = { duration: opts.duration === undefined ? 1 : opts.duration, loop: !!opts.loop };
  sampleTimeseries([], p, st, +elapsed || 0);
  return st.buffer;
}

export { EASING_NAMES };
export { easing } from './easing.mjs';

export const dynamics = Object.freeze({
  name: NAME,
  version: VERSION,
  registry: DynamicsRegistry,
  FANOUT_CAP,
  SAMPLE_CAP,
  sampleKeyframes,
  sampleTrajectory,
  easingNames: EASING_NAMES,
});

export default DynamicsRegistry;
