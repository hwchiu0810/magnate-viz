/* =============================================================================
 *  engine/core/index.mjs  —  ENGINE-CORE KERNEL  (Story P2.2; was P2.1 keystone)
 *
 *  WHAT THIS IS: the functional-core KERNEL all four pillars share — generalizing
 *  the proven `prototype/vfx.js` patterns (`H` guards, `makeRng`/`mulberry32`, the
 *  `REGISTRY` backing `VFX.list()` + `inferControl`/`CONTROL_OVERRIDES`, and
 *  `disposeResource`) into reusable engine primitives:
 *
 *    - SEEDED RNG          makeRng(seed) -> instance-local mulberry32 (INV-1)
 *    - DETERMINISTIC CLOCK createClock({reduceMotion}) -> injected-dt time (INV-1)
 *    - HEADLESS GUARDS     makeHost / haveTHREE / havePost / reduceMotion / gate
 *                          + vec/vec2/color structural fallbacks (INV-1)
 *    - REGISTRY BASE       createRegistry() -> register(desc) + list() with controls
 *                          INFERRED from params shape + per-capability overrides
 *    - DISPOSE LIFECYCLE   dispose(handleOrResource) — complete + swallowed-safe (INV-4)
 *    - POOL                createPool() — ref-counted shared-resource pool (INV-4)
 *
 *  HISTORY: P2.1 stood this module up as the native-ESM firewall KEYSTONE with
 *  documented placeholders. P2.2 (this) FILLS those placeholders with the real
 *  kernel — the P2.1 export NAMES + VERSION semantics + frozen `core` descriptor
 *  surface are preserved (the stable contract the runtime + editor reflect against).
 *
 *  HEADLESS-SAFE / GPU-FREE / VENDOR-INJECTED by construction (INV-1, INV-6, INV-7):
 *    - imports NOTHING from apps/**, editor/**, conformance/** (INV-6 firewall);
 *    - NO hard import of THREE / Tweakpane — vendor arrives ONLY via a host object
 *      passed into the guards (the runtime `init({THREE,...})` contract), never a
 *      static import (INV-6 / INV-7);
 *    - NO app-specific (Magnate) names — engine-only vocabulary;
 *    - loads & runs in plain Node >=20 with NO THREE and NO DOM, never throwing.
 *
 *  Extraction order (ADR-D1): core (this) -> objects -> scenes -> dynamics.
 *  Native ESM (D1): resolved via the P2.1 import-map; no bundler. See engine/README.md.
 * ========================================================================== */

import { makeRng as _makeRng, DEFAULT_SEED } from './rng.mjs';
import { makeClock } from './clock.mjs';
import {
  makeHost,
  haveTHREE as _haveTHREE,
  havePost as _havePost,
  haveDOM,
  reduceMotion as _reduceMotion,
  gate,
  vec, vec2, color,
} from './guards.mjs';
import { createRegistry as _createRegistry, controlsFor, inferControl, CONTROL_TYPES } from './registry.mjs';
import { createPool } from './pool.mjs';
import { dispose as _dispose, disposeResource, disposeMaterial } from './dispose.mjs';

/** Engine-core module version (semver). A bump is an explicit, versioned change
 *  (the conformance suite + firewall key off engine identity). P2.2 fills the
 *  kernel behind the P2.1 keystone surface. */
export const VERSION = '0.2.0-p2.2-kernel';

/** Human-readable module identity (for the in-page boundary proof window.__engine). */
export const NAME = 'engine/core';

/* -----------------------------------------------------------------------------
 *  SEEDED RNG (INV-1) — instance-local mulberry32. Re-exported under the stable
 *  P2.1 name; same seed -> same sequence; reseed reproduces. No wall-clock / global.
 * ------------------------------------------------------------------------- */
export function makeRng(seed = DEFAULT_SEED) { return _makeRng(seed); }
export { DEFAULT_SEED };

/* -----------------------------------------------------------------------------
 *  DETERMINISTIC CLOCK (INV-1) — injected-dt time; no wall-clock. The P2.1
 *  keystone name `createClock()` is preserved; it now returns the real clock
 *  (`elapsed`/`frame`/`tick`/`advance`/`reset`), gated by reduceMotion.
 * ------------------------------------------------------------------------- */
export function createClock(opts = {}) { return makeClock(opts); }

/* -----------------------------------------------------------------------------
 *  HEADLESS GUARDS (INV-1). The P2.1 keystone exported guards that take a `host`
 *  positional argument; that signature is preserved. `makeHost` builds the
 *  instance-local `H` record; vec/vec2/color fall back to plain {x,y,z,set} /
 *  {r,g,b,setRGB} when THREE is absent.
 * ------------------------------------------------------------------------- */
export { makeHost, haveDOM, gate, vec, vec2, color };

/** haveTHREE(host) — true iff host.ready && host.THREE (real GPU usable). */
export function haveTHREE(host) { return _haveTHREE(host); }
/** havePost(host) — true iff haveTHREE + composer + a ShaderPass constructor. */
export function havePost(host) { return _havePost(host); }
/** reduceMotion(host) — the single gate flag; absent host -> true (static frame). */
export function reduceMotion(host) { return _reduceMotion(host); }

/* -----------------------------------------------------------------------------
 *  REGISTRY BASE — register(desc) is the ONLY way a capability becomes visible;
 *  list() -> [{id,kind,category,params,controls,factory}] with controls inferred
 *  from the params shape + a per-capability override table (within the frozen
 *  contracts/control-types.json vocabulary). P2.1 name `createRegistry()` preserved.
 * ------------------------------------------------------------------------- */
export function createRegistry(opts = {}) { return _createRegistry(opts); }
export { controlsFor, inferControl, CONTROL_TYPES };

/* -----------------------------------------------------------------------------
 *  POOL (INV-4) — ref-counted shared-resource pool.
 * ------------------------------------------------------------------------- */
export { createPool };

/* -----------------------------------------------------------------------------
 *  DISPOSE LIFECYCLE (INV-4) — complete + swallowed-safe. P2.1 name preserved.
 * ------------------------------------------------------------------------- */
export function dispose(handleOrResource) { return _dispose(handleOrResource); }
export { disposeResource, disposeMaterial };

/* -----------------------------------------------------------------------------
 *  The engine-core surface descriptor — a plain, frozen object the in-page
 *  boundary proof (and the editor reflection) can read without touching GPU.
 *  The `surface` array enumerates the STABLE P2.1 kernel-surface export names.
 * ------------------------------------------------------------------------- */
export const core = Object.freeze({
  name: NAME,
  version: VERSION,
  /** The stable kernel-surface export names (the P2.1 contract, now filled). */
  surface: Object.freeze([
    'createRegistry', 'createClock', 'makeRng',
    'haveTHREE', 'havePost', 'reduceMotion', 'dispose',
  ]),
  createRegistry, createClock, makeRng,
  haveTHREE, havePost, reduceMotion, dispose,
  // additive kernel surface (does not narrow the P2.1 contract):
  makeHost, haveDOM, gate, vec, vec2, color,
  createPool, controlsFor, inferControl, disposeResource, disposeMaterial,
  CONTROL_TYPES, DEFAULT_SEED,
});

export default core;
