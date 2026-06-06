/* =============================================================================
 *  engine/runtime/index.mjs  —  the RUNTIME HOST BOOTSTRAP  (Story P2.4)
 *
 *  WHAT THIS IS: the engine's IMPERATIVE SHELL — the single place that owns the
 *  frame loop and the shared-resource lifecycle. It generalizes the proven
 *  `prototype/vfx.js` `H` host-state + `init/update/dispose/reset` + ref-counted
 *  `POOL` discipline (and the live-effect dispatch list) into an app-agnostic
 *  `Engine` any app boots through ONE host contract:
 *
 *    Engine.init({ THREE, renderer, scene, camera, composer, clock, reduceMotion })
 *    Engine.update(dt, elapsed)   // THE single per-frame dispatcher
 *    Engine.dispose()             // free all pools + live handles
 *    Engine.reset()               // clear live handles + pool, ready to re-init
 *    Engine.add(handle) / Engine.remove(handle)   // register/unregister live handles
 *    Engine.spawn(registry, id, params)           // create-via-registry + auto-register
 *    Engine.pool                  // the engine/core ref-counted POOL (acquire/release/refs)
 *    Engine.host                  // the injected host record (read-only view of vendor)
 *
 *  HOST CONTRACT (INV-6 / INV-7, generalizing VFX.init):
 *    - THREE (r128) and ALL vendor objects are INJECTED through init(); the engine
 *      NEVER hard-imports THREE / Tweakpane (the firewall keystone, INV-6);
 *    - the SAME engine functions are callable by BOTH the live renderer AND the
 *      headless conformance harness (the parity backbone).
 *
 *  HEADLESS + DETERMINISTIC (INV-1):
 *    - update(dt,elapsed) is a NO-OP that NEVER throws when headless, before init(),
 *      or with reduceMotion set (a static resting frame — never an animation advance);
 *    - NO per-frame allocation in the dispatch loop: the live-handle array is reused,
 *      iterated by index — there is NO per-frame `new`, `.map`, `.filter`, closure, or
 *      array literal in update();
 *    - any randomness an app needs is the seeded engine/core makeRng (no wall-clock,
 *      no global Math.random) — the runtime itself reads only the dt/elapsed the host
 *      passes (never a wall-clock).
 *
 *  POOL (INV-4): Engine.pool is an engine/core createPool() — acquire(key,build)
 *    builds once + refs++ ; release(key) refs-- and dispose()s at zero refs.
 *
 *  NEVER THROW ACROSS THE HOST BOUNDARY: every per-handle update() and dispose() is
 *    try/caught (disposeResource discipline) so ONE bad capability cannot crash the
 *    frame or the teardown (architecture §Error Handling).
 *
 *  Native ESM (D1); builds on engine/core (P2.2) — imports ONLY from ../core
 *  (createPool / dispose / guards / clock). NO import of THREE/Tweakpane, nothing
 *  from apps/**, editor/**, conformance/** (INV-6). Loads + runs in plain Node >=20
 *  with NO THREE and NO DOM, never throwing.
 * ========================================================================== */

import {
  makeHost, haveTHREE, reduceMotion as coreReduceMotion,
  createPool, createClock, dispose as coreDispose,
} from '../core/index.mjs';

/** Module version (semver). A bump is an explicit, versioned change (the
 *  conformance suite + firewall key off engine identity). */
export const VERSION = '0.1.0-p2.4-runtime';
/** Human-readable module identity (engine tree dir name). */
export const NAME = 'engine/runtime';

/* =============================================================================
 *  createEngine() — a fresh, INSTANCE-LOCAL Engine (host + live handles + pool).
 *
 *  The default export `Engine` is one shared instance (mirrors `window.VFX` —
 *  one frame loop per app); `createEngine()` lets the tests + multi-context hosts
 *  build isolated engines without cross-talk. All state is closed over per call.
 * ========================================================================== */
export function createEngine() {
  /* ---------------------------------------------------------------------------
   *  HOST STATE — the `H` of vfx.js. Built by init(), cleared by dispose().
   *  Before init everything is null/false so every entry point early-outs
   *  (the headless contract). `ready` is true only after init() with a usable THREE.
   * ------------------------------------------------------------------------- */
  let H = makeHost();          // inert host (THREE=null, ready=false) before init()
  let initialized = false;     // init() has been called (even headless)

  /* LIVE HANDLES driven by update() — a flat list of factory handles
   *  `{ update(dt,elapsed)?, dispose()?, group? }`. The array is reused across
   *  frames (mutated in place on add/remove/teardown) — NEVER reallocated in
   *  update() — so the dispatch path is alloc-free (INV-1 / NFR8). */
  const live = [];

  /* The ref-counted shared-resource POOL (INV-4). One pool per engine; handles
   *  that acquire keys record them in `_poolKeys` so coreDispose releases them. */
  const pool = createPool();

  /* -------------------------------------------------------------------------
   *  add(handle) — register a live handle into the per-frame dispatcher.
   *  Idempotent (a handle is registered at most once). Returns the handle so
   *  callers can chain `const h = Engine.add(reg.factory(host, p))`.
   * ----------------------------------------------------------------------- */
  function add(handle) {
    if (!handle) return handle;
    if (live.indexOf(handle) === -1) live.push(handle);
    return handle;
  }

  /* -------------------------------------------------------------------------
   *  remove(handle) — unregister a live handle (does NOT dispose it; the caller
   *  owns that choice). Swallowed-safe; a no-op for an unregistered handle.
   * ----------------------------------------------------------------------- */
  function remove(handle) {
    const i = live.indexOf(handle);
    if (i >= 0) live.splice(i, 1);
    return handle;
  }

  /* -------------------------------------------------------------------------
   *  spawn(registry, id, params) — the create-via-registry helper. Looks up the
   *  descriptor on a pillar registry (ObjectRegistry/SceneRegistry/Dynamics-
   *  Registry/VFX — anything exposing get(id).factory), calls its
   *  `factory(host, params) -> handle`, auto-registers the handle into the
   *  dispatcher, and returns it. NEVER throws across the boundary: a missing
   *  registry/id/factory or a throwing factory yields null (swallowed).
   * ----------------------------------------------------------------------- */
  function spawn(registry, id, params) {
    if (!registry || typeof registry.get !== 'function') return null;
    let desc;
    try { desc = registry.get(id); } catch { desc = null; }
    if (!desc || typeof desc.factory !== 'function') return null;
    let handle = null;
    try { handle = desc.factory(H, params || {}); } catch { handle = null; }
    if (!handle) return null;
    return add(handle);
  }

  /* -------------------------------------------------------------------------
   *  init(opts) — wire the host (INV-6/INV-7 host contract). Idempotent-safe:
   *  re-init disposes the prior session's live handles + drains the pool first,
   *  then re-wires (so a second init() never leaks the first session's resources).
   *  Headless-safe: with no usable THREE it records the opts but ready stays false
   *  so every entry point remains inert. NEVER throws.
   * ----------------------------------------------------------------------- */
  function init(opts) {
    const o = opts || {};
    // tear down any prior session (idempotent re-init); keep no stale handles/pool.
    teardownLive();
    try { pool.clear(); } catch { /* swallowed */ }

    // build a fresh instance-local host record from the injected vendor. makeHost
    // sets ready = !!THREE (a usable THREE was injected) — the GPU guard (INV-1).
    H = makeHost(o);

    // a deterministic clock is provided if the host did not inject one (no wall-clock).
    if (!H.clock) { try { H.clock = createClock({ reduceMotion: H.reduceMotion }); } catch { /* keep null */ } }

    initialized = true;
    return engine;
  }

  /* -------------------------------------------------------------------------
   *  update(dt, elapsed) — THE single per-frame dispatcher. Iterates the live
   *  handles and calls each handle.update(dt, elapsed).
   *
   *  NO-OP (never throws) when:
   *    - not initialized / headless (THREE absent -> H.ready false), OR
   *    - reduceMotion is set (effects hold their static resting frame — INV-2).
   *
   *  ALLOC-FREE: the live array is reused + iterated by a numeric index; `dt`/
   *  `elapsed` are read straight off the args (sanitized to numbers WITHOUT
   *  boxing). There is NO per-frame `new`, array literal, closure, or method
   *  that allocates (no .map/.filter/.forEach) in this path (INV-1 / NFR8).
   *
   *  NEVER THROW ACROSS THE HOST BOUNDARY: each per-handle update() is try/caught
   *  so one bad capability cannot crash the frame (architecture §Error Handling).
   * ----------------------------------------------------------------------- */
  function update(dt, elapsed) {
    if (!H.ready) return;                  // headless / pre-init: silent no-op (INV-1)
    if (H.reduceMotion) return;            // reduced-motion: static resting frame (INV-2)
    // sanitize args to plain numbers in place (no allocation): a host glitch -> 0.
    const d = (typeof dt === 'number' && dt === dt) ? dt : 0;        // dt===dt rejects NaN
    let t = (typeof elapsed === 'number' && elapsed === elapsed) ? elapsed : 0;
    // advance the deterministic clock (in place); if the host omitted elapsed, read it.
    if (H.clock && typeof H.clock.tick === 'function') {
      try { H.clock.tick(d); } catch { /* swallowed */ }
      if (elapsed == null && typeof H.clock.elapsed === 'number') t = H.clock.elapsed;
    }
    for (let i = 0; i < live.length; i++) {
      const h = live[i];
      if (h && typeof h.update === 'function') {
        try { h.update(d, t); } catch { /* one bad handle must not break the frame */ }
      }
    }
  }

  /* -------------------------------------------------------------------------
   *  teardownLive() — dispose every live handle (complete + swallowed-safe) and
   *  empty the live list IN PLACE (no reallocation). Each handle's dispose() goes
   *  through the core dispose() (frees geometry/material/texture/uniform, releases
   *  POOL keys via _pool/_poolKeys, detaches from parents) and is try/caught so a
   *  bad handle cannot break the teardown (INV-4 / §Error Handling).
   * ----------------------------------------------------------------------- */
  function teardownLive() {
    for (let i = live.length - 1; i >= 0; i--) {
      const h = live[i];
      try { coreDispose(h); } catch { /* swallowed: never throw across host boundary */ }
    }
    live.length = 0;            // empty in place (reused next session) — no new array
  }

  /* -------------------------------------------------------------------------
   *  dispose() — free EVERYTHING: dispose all live handles, then drain the POOL
   *  (each pooled resource deep-disposed at refcount 0), then clear the host back
   *  to the inert pre-init state. A subsequent update() is a SAFE no-op (H.ready
   *  is false). NEVER throws (INV-4).
   * ----------------------------------------------------------------------- */
  function dispose() {
    teardownLive();
    try { pool.clear(); } catch { /* swallowed */ }
    H = makeHost();             // back to inert: THREE=null, ready=false
    initialized = false;
  }

  /* -------------------------------------------------------------------------
   *  reset() — clear the live handles + pool but DO NOT clear the host (re-arm
   *  the same wired session). Like vfx.js reset(): teardown live, keep H. After
   *  reset() the engine is ready to register fresh handles and re-init if needed.
   * ----------------------------------------------------------------------- */
  function reset() {
    teardownLive();
    try { pool.clear(); } catch { /* swallowed */ }
  }

  /* -------------------------------------------------------------------------
   *  The Engine surface. `host`/`pool` are exposed as the documented contract
   *  surface; `live` count is read-only via liveCount() (view-only, mutates nothing).
   * ----------------------------------------------------------------------- */
  const engine = {
    NAME, VERSION,
    init, update, dispose, reset,
    add, remove, spawn,
    pool,
    get host() { return H; },
    get ready() { return !!H.ready; },
    get initialized() { return initialized; },
    /** view-only count of registered live handles (for probes/tests). */
    liveCount() { return live.length; },
    /** view-only: is a live handle currently registered? (probe helper). */
    has(handle) { return live.indexOf(handle) >= 0; },
  };
  return engine;
}

/** The shared singleton Engine (one frame loop per app; mirrors `window.VFX`). */
export const Engine = createEngine();

/* =============================================================================
 *  HEADLESS SMOKE EXPORT — `__runtimeHeadless` — so the conformance harness can
 *  drive the SAME init/update/dispose/reset/pool functions the live renderer
 *  uses (the parity backbone). View-only readers + the exact lifecycle the
 *  Tier-B render-snapshot strategy asserts (pre-init no-op, dispose frees,
 *  reduceMotion freezes, alloc-free dispatch). Mutates nothing it reads.
 * ========================================================================== */
export const __runtimeHeadless = Object.freeze({
  NAME, VERSION,
  /** Build a fresh isolated engine the harness can drive in its own scope. */
  createEngine,
  /** The shared singleton (the same one the live app boots). */
  Engine,
  /** Re-export the kernel guards the harness asserts the runtime honors. */
  haveTHREE, reduceMotion: coreReduceMotion,
  /** A read-only lifecycle snapshot of an engine (view-only — mutates nothing). */
  snapshot(eng) {
    const e = eng || Engine;
    return {
      ready: !!(e && e.ready),
      initialized: !!(e && e.initialized),
      live: (e && typeof e.liveCount === 'function') ? e.liveCount() : 0,
      poolKeys: (e && e.pool && typeof e.pool.keys === 'function') ? e.pool.keys().slice() : [],
    };
  },
});

/** The module surface descriptor (a plain, frozen object the in-page boundary
 *  proof + editor reflection can read without touching GPU). */
export const runtime = Object.freeze({
  name: NAME,
  version: VERSION,
  createEngine,
  Engine,
});

export default Engine;
