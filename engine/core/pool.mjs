/* =============================================================================
 *  engine/core/pool.mjs  —  ref-counted shared-resource POOL  (Story P2.2, INV-4)
 *
 *  WHAT THIS IS: the kernel generalization of `prototype/vfx.js`'s `POOL` — a
 *  ref-counted registry of shared GPU resources so capabilities reuse a single
 *  geometry / texture / full-screen-shader skeleton rather than allocating one per
 *  instance (the pooled/bounded resource pattern, INV-4 / NFR4).
 *
 *    acquire(key, build)  builds the resource once (lazily), then refs++ ;
 *    release(key)         refs-- ; at zero it deep-disposes the resource and drops the key.
 *
 *  Every `build()` is try/caught (a headless build failure yields a null resource,
 *  never a throw). `dispose()` (engine/core/dispose.mjs) releases the POOL keys a
 *  handle holds via `handle._pool` + `handle._poolKeys` — closing the INV-4 loop.
 *
 *  Native ESM (D1); imports the swallowed-safe deep-free from dispose.mjs (engine-
 *  relative only, INV-6). Headless-safe.
 * ========================================================================== */

import { disposeResource } from './dispose.mjs';

/**
 * createPool() — a fresh, INSTANCE-LOCAL ref-counted resource pool.
 *
 * @returns {{
 *   acquire(key:string, build:()=>any): any,  // build-once + refs++ ; returns the resource
 *   release(key:string): void,                // refs-- ; dispose() at zero
 *   refs(key:string): number,                 // current refcount (0 if absent)
 *   has(key:string): boolean,
 *   keys(): string[],
 *   clear(): void                             // dispose() everything (INV-4)
 * }}
 */
export function createPool() {
  const map = Object.create(null);

  return {
    acquire(key, build) {
      let e = map[key];
      if (!e) {
        let res = null;
        try { res = (typeof build === 'function') ? build() : null; } catch { res = null; }
        e = map[key] = { res, refs: 0 };
      }
      e.refs++;
      return e.res;
    },
    release(key) {
      const e = map[key];
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) {
        disposeResource(e.res);
        delete map[key];
      }
    },
    refs(key) { return map[key] ? map[key].refs : 0; },
    has(key) { return !!map[key]; },
    keys() { return Object.keys(map); },
    clear() {
      for (const k in map) { try { disposeResource(map[k].res); } catch { /* swallowed */ } }
      for (const k in map) delete map[k];
    },
  };
}

export default createPool;
