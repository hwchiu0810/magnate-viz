/* =============================================================================
 *  engine/core/clock.mjs  —  deterministic, injected-time Clock  (Story P2.2)
 *
 *  WHAT THIS IS: the kernel's single notion of TIME (INV-1). It is driven ONLY by
 *  the dt the host passes each frame — exactly the `vfx.js` host contract where
 *  the dispatcher uses "the dt/elapsed the host passes to update()" and NEVER a
 *  wall-clock. This is the deterministic playhead the conformance harness keys on.
 *
 *  DETERMINISTIC BY CONSTRUCTION (INV-1 / NFR1):
 *    - NO `Date.now` / `performance.now` / `THREE.Clock.getDelta()` — time only
 *      advances via the explicit `tick(dt)` the imperative shell calls;
 *    - state (`elapsed` / `frame`) is INSTANCE-LOCAL (closed over per `makeClock`);
 *    - the same dt sequence reproduces the same `elapsed` bit-identically;
 *    - `reduceMotion` freezes advance to a static resting frame: `tick()` returns
 *      0 and `elapsed` does not move (the deterministic single-frame the harness
 *      asserts on — mirrors `vfx.js`'s `if (H.reduceMotion) return;`).
 *
 *  Native ESM (D1); imports nothing app/vendor (INV-6). Pure, headless-safe.
 * ========================================================================== */

/** Sanitize a dt into a finite, non-negative number (a host glitch -> 0, never
 *  NaN/Inf creeping into the deterministic clock). */
function sanitizeDt(dt) {
  const d = +dt;
  if (!Number.isFinite(d) || d <= 0) return 0;
  return d;
}

/**
 * makeClock(opts) — a deterministic clock advanced only by injected dt.
 *
 * @param {{ reduceMotion?: boolean }} [opts]
 *        reduceMotion: when true, tick() is a no-op (static resting frame).
 * @returns {{
 *   elapsed: number,          // accumulated time (seconds), read-only getter
 *   frame: number,            // accumulated tick count, read-only getter
 *   dt: number,               // the last applied dt, read-only getter
 *   reduceMotion: boolean,    // gate flag (settable)
 *   tick(dt:number): number,  // advance by an explicit dt; returns applied dt (0 if gated)
 *   advance(dt:number): number, // alias of tick() (P2.1 keystone name)
 *   reset(): void             // back to elapsed=0, frame=0
 * }}
 *
 * INV-1: no wall-clock; same dt sequence -> same elapsed bit-identically.
 */
export function makeClock(opts = {}) {
  let _elapsed = 0;
  let _frame = 0;
  let _lastDt = 0;
  let _reduceMotion = !!(opts && opts.reduceMotion);

  /** Advance the clock by an explicit dt (seconds). Returns the dt actually
   *  applied (0 when reduceMotion gates motion or dt is non-positive/NaN). */
  function tick(dt) {
    if (_reduceMotion) return 0;       // static resting frame — time frozen
    const d = sanitizeDt(dt);
    if (d === 0) return 0;
    _elapsed += d;
    _frame += 1;
    _lastDt = d;
    return d;
  }

  const clock = {
    get elapsed() { return _elapsed; },
    get frame() { return _frame; },
    get dt() { return _lastDt; },
    get reduceMotion() { return _reduceMotion; },
    set reduceMotion(v) { _reduceMotion = !!v; },
    tick,
    /** Alias kept stable from the P2.1 keystone surface. */
    advance(dt) { return tick(dt); },
    reset() { _elapsed = 0; _frame = 0; _lastDt = 0; },
  };
  return clock;
}

export default makeClock;
