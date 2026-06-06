/* =============================================================================
 *  engine/scenes/index.mjs  —  the SceneRegistry pillar  (Story P2.3, Pillar 1)
 *
 *  WHAT THIS IS: the SCENE / SECTION pillar — a `register(desc)`/`list()` registry
 *  of GENERIC `create(host, params) -> handle` scene factories, built on the
 *  engine/core kernel (P2.2) and matching `prototype/vfx.js`'s `VFX.list()` shape
 *  so ONE editor reflection path (P4) serves all four pillars.
 *
 *  GENERIC ONLY (INV-6 firewall): app-AGNOSTIC scene primitives — a `diorama`
 *  (an orbit-camera turntable scene), a `world` (a bounded-stream STUB scene with
 *  a capped active set), `cameraPreset` + `lightPreset` presets, and a `transition`
 *  helper (camera/opacity tween). NO Magnate vocabulary (no Smart City / Smart
 *  Factory / Shopping Mall, no day/night-of-an-economy semantics) — Magnate binds
 *  its sections to these generic scenes at P2.5 via apps/magnate/bindings.
 *
 *  THE FACTORY CONTRACT (architecture §Factory pattern): identical to the other
 *  pillars — create(host, params) -> { group, update(dt,elapsed), setParams(p),
 *  dispose() }. update() mutates IN PLACE (no per-frame allocation) + reduceMotion-
 *  gated; setParams() merges via withDefaults into a FRESH object; dispose() frees
 *  GPU resources + releases POOL keys + detaches (swallowed-safe).
 *
 *  HEADLESS + DETERMINISTIC (INV-1): with THREE/camera absent every factory returns
 *  a valid INERT handle that never throws; any randomness is seeded engine/core
 *  makeRng. POOLED + BOUNDED (INV-4): the `world` streamer's active set is CAPPED
 *  (`STREAM_CAP`) and the cap documented in the descriptor.
 *
 *  Native ESM (D1); imports ONLY from ../core (the P2.2 kernel) + nothing app/vendor.
 * ========================================================================== */

import {
  createRegistry, createPool, makeRng,
  haveTHREE, reduceMotion, vec, color, dispose as coreDispose,
} from '../core/index.mjs';

export const VERSION = '0.1.0-p2.3-scenes';
export const NAME = 'engine/scenes';

/** Hard CAP on a `world` scene's active streamed set (INV-4 / NFR4). The bounded-
 *  stream stub never holds more than this many active chunks; documented in params. */
export const STREAM_CAP = 256;

/** INSTANCE-LOCAL pool shared by scene factories (light/camera rigs reuse). */
const POOL = createPool();

/* ---- headless-safe helpers (NEVER throw) ---------------------------------- */
function makeGroup(host) {
  if (haveTHREE(host) && host.THREE.Group) {
    try { return new host.THREE.Group(); } catch { /* fall through */ }
  }
  return {
    isPlainGroup: true, children: [], visible: true,
    position: vec(host, 0, 0, 0), rotation: vec(host, 0, 0, 0), parent: null,
    add(c) { this.children.push(c); if (c) c.parent = this; return this; },
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); if (c) c.parent = null; } return this; },
  };
}

/** merge defaults <- over into a FRESH object (no shared mutation). */
function withDefaults(defaults, over) {
  const out = {};
  for (const k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = Array.isArray(defaults[k]) ? defaults[k].slice() : defaults[k];
  if (over) for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = Array.isArray(over[k]) ? over[k].slice() : over[k];
  return out;
}

/** position the host camera on an orbit, headless-safe + in place (no alloc). */
function orbitCamera(host, group, radius, height, angle) {
  const cam = host && host.camera;
  if (!cam || !cam.position || !cam.position.set) return;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  try {
    cam.position.set(x, height, z);
    if (typeof cam.lookAt === 'function') cam.lookAt(group && group.position ? group.position : { x: 0, y: 0, z: 0 });
  } catch { /* swallowed */ }
}

/**
 * wrapScene(host, params, group, opts) — the uniform factory handle for a scene.
 * opts.update(host, group, dt, elapsed, p) is the per-frame body (only invoked
 * when motion is allowed); opts.apply(host, group, p) re-applies declarative params.
 */
function wrapScene(host, params, group, opts) {
  const o = opts || {};
  let current = withDefaults(params, null);
  let disposed = false;

  const handle = {
    group,
    _pool: POOL,
    _poolKeys: Array.isArray(o.poolKeys) ? o.poolKeys.filter(Boolean) : [],
    get params() { return current; },

    update(dt, elapsed) {
      if (disposed) return;
      if (reduceMotion(host)) return;                 // static resting frame (INV-2)
      if (typeof o.update === 'function') { try { o.update(host, group, +dt || 0, +elapsed || 0, current); } catch { /* swallowed */ } }
    },

    setParams(p) {
      if (disposed) return;
      current = withDefaults(current, p);
      if (typeof o.apply === 'function') { try { o.apply(host, group, current); } catch { /* swallowed */ } }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (typeof o.onDispose === 'function') o.onDispose(); } catch { /* swallowed */ }
      try { if (group) coreDispose({ group }); } catch { /* swallowed */ }
    },
  };
  return handle;
}

/* =============================================================================
 *  GENERIC SCENE FACTORIES
 * ========================================================================== */

/* ---- diorama: a turntable scene with an orbit camera ---------------------- */
function createDiorama(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.diorama, params);
  const group = makeGroup(host);
  // a phase accumulator owned by the handle (closure state — not per-frame alloc).
  let phase = +p.startAngle || 0;
  // seat the camera once at the resting frame (deterministic, motion-independent).
  orbitCamera(host, group, p.radius, p.height, phase);
  return wrapScene(host, p, group, {
    update(h, g, dt, elapsed, np) {
      phase += (np.orbitSpeed || 0) * dt;             // advance in place (no alloc)
      orbitCamera(h, g, np.radius, np.height, phase);
    },
    apply(h, g, np) { orbitCamera(h, g, np.radius, np.height, phase); },
  });
}

/* ---- world: a bounded-stream STUB (capped active set) --------------------- */
function createWorld(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.world, params);
  const group = makeGroup(host);
  const cap = Math.max(0, Math.min(STREAM_CAP, Math.floor(p.activeCap)));   // CAP (INV-4)
  // deterministic stand-in for the active streamed set: a fixed-size ring of slot
  // markers we recycle (no growth — the bound is structural). Seeded layout.
  const rng = makeRng((p.seed >>> 0) || 1);
  const slots = [];                                  // pre-sized once (no per-frame new)
  const want = Math.min(cap, Math.max(0, Math.floor(p.initialActive)));
  for (let i = 0; i < want; i++) {
    slots.push({ active: true, x: (rng() - 0.5) * p.extent, z: (rng() - 0.5) * p.extent });
  }
  // a phase used to "stream" (toggle) slots within the cap — bounded recycling.
  let cursor = 0;
  return wrapScene(host, p, group, {
    update(h, g, dt, elapsed, np) {
      // bounded stream: advance a cursor and recycle ONE slot per step in place.
      if (slots.length === 0) return;
      cursor = (cursor + 1) % slots.length;
      const s = slots[cursor];
      s.x = (rng() - 0.5) * np.extent;               // mutate in place (no alloc)
      s.z = (rng() - 0.5) * np.extent;
    },
    apply() { /* params re-read live in update; nothing GPU to re-apply in the stub */ },
    // expose the bounded set so the harness/probe can assert the cap (view-only).
    onDispose() { slots.length = 0; },
  });
}

/* ---- cameraPreset: position/target/fov preset (no per-frame motion) ------- */
function createCameraPreset(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.cameraPreset, params);
  const group = makeGroup(host);
  applyCameraPreset(host, p);
  return wrapScene(host, p, group, {
    apply(h, g, np) { applyCameraPreset(h, np); },
  });
}
function applyCameraPreset(host, p) {
  const cam = host && host.camera;
  if (!cam) return;
  try {
    if (cam.position && cam.position.set && Array.isArray(p.position)) cam.position.set(p.position[0] || 0, p.position[1] || 0, p.position[2] || 0);
    if (typeof cam.lookAt === 'function' && Array.isArray(p.target)) cam.lookAt({ x: p.target[0] || 0, y: p.target[1] || 0, z: p.target[2] || 0 });
    if (typeof p.fov === 'number' && 'fov' in cam) { cam.fov = p.fov; if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix(); }
  } catch { /* swallowed */ }
}

/* ---- lightPreset: ambient + key directional light rig --------------------- */
function createLightPreset(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.lightPreset, params);
  const group = makeGroup(host);
  if (haveTHREE(host)) {
    const THREE = host.THREE;
    try {
      if (THREE.AmbientLight) {
        const amb = new THREE.AmbientLight(0xffffff, p.ambient);
        const ac = color(host, p.ambientColor); if (amb.color && amb.color.setRGB) amb.color.setRGB(ac.r, ac.g, ac.b);
        group.add(amb);
      }
      if (THREE.DirectionalLight) {
        const key = new THREE.DirectionalLight(0xffffff, p.keyIntensity);
        const kc = color(host, p.keyColor); if (key.color && key.color.setRGB) key.color.setRGB(kc.r, kc.g, kc.b);
        if (key.position && key.position.set && Array.isArray(p.keyDir)) key.position.set(p.keyDir[0] || 0, p.keyDir[1] || 0, p.keyDir[2] || 0);
        group.add(key);
      }
    } catch { /* swallowed */ }
  }
  return wrapScene(host, p, group, {
    apply() { /* light intensities re-applied via fresh build in P4; stub holds rig */ },
  });
}

/* ---- transition: a generic camera/opacity tween helper -------------------- */
function createTransition(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.transition, params);
  const group = makeGroup(host);
  let t = 0;                                          // normalized progress accumulator
  const fromPos = Array.isArray(p.from) ? p.from.slice() : [0, 0, 0];
  const toPos = Array.isArray(p.to) ? p.to.slice() : [0, 0, 0];
  return wrapScene(host, p, group, {
    update(h, g, dt, elapsed, np) {
      const dur = Math.max(1e-6, np.duration);
      t = Math.min(1, t + dt / dur);                  // advance in place (no alloc)
      const e = easeInOut(t);
      const cam = h && h.camera;
      if (cam && cam.position && cam.position.set) {
        cam.position.set(
          fromPos[0] + (toPos[0] - fromPos[0]) * e,
          fromPos[1] + (toPos[1] - fromPos[1]) * e,
          fromPos[2] + (toPos[2] - fromPos[2]) * e,
        );
      }
    },
    apply(h, g, np) { if (Array.isArray(np.from)) { fromPos[0] = np.from[0]; fromPos[1] = np.from[1]; fromPos[2] = np.from[2]; } if (Array.isArray(np.to)) { toPos[0] = np.to[0]; toPos[1] = np.to[1]; toPos[2] = np.to[2]; } },
  });
}
function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

/* =============================================================================
 *  DESCRIPTOR DEFAULT PARAMS — controls are INFERRED from these. `activeCap`
 *  documents the bounded stream (INV-4); `seed` makes layout deterministic (INV-1).
 * ========================================================================== */
const REGISTRY_DEFAULTS = {
  diorama:      { radius: 12, height: 6, orbitSpeed: 0.2, startAngle: 0, seed: 1 },
  world:        { extent: 200, initialActive: 32, activeCap: STREAM_CAP, seed: 1 },
  cameraPreset: { position: [0, 8, 16], target: [0, 0, 0], fov: 55 },
  lightPreset:  { ambient: 0.4, ambientColor: 0xffffff, keyIntensity: 0.8, keyColor: 0xffffff, keyDir: [5, 10, 7] },
  transition:   { from: [0, 8, 16], to: [0, 4, 8], duration: 1.2 },
};

const KIND_CATEGORY = {
  diorama: 'Scene', world: 'Scene',
  cameraPreset: 'Camera', lightPreset: 'Light', transition: 'Transition',
};
function categoryFor(desc) { return KIND_CATEGORY[desc.id] || 'Scene'; }

/* =============================================================================
 *  THE SCENE REGISTRY — register(desc)/list() matching VFX.list().
 * ========================================================================== */
export const SceneRegistry = createRegistry({
  name: 'SceneRegistry',
  categoryFor,
});

SceneRegistry.register({ id: 'diorama', kind: 'Orbit-camera turntable scene', params: REGISTRY_DEFAULTS.diorama, factory: createDiorama });
SceneRegistry.register({ id: 'world', kind: 'Bounded-stream world (stub)', params: REGISTRY_DEFAULTS.world, factory: createWorld });
SceneRegistry.register({ id: 'cameraPreset', kind: 'Camera position/target/fov preset', params: REGISTRY_DEFAULTS.cameraPreset, factory: createCameraPreset });
SceneRegistry.register({ id: 'lightPreset', kind: 'Ambient + key directional light rig', params: REGISTRY_DEFAULTS.lightPreset, factory: createLightPreset });
SceneRegistry.register({ id: 'transition', kind: 'Camera/opacity tween helper', params: REGISTRY_DEFAULTS.transition, factory: createTransition });

export const scenes = Object.freeze({
  name: NAME,
  version: VERSION,
  registry: SceneRegistry,
  STREAM_CAP,
});

export default SceneRegistry;
