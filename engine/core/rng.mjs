/* =============================================================================
 *  engine/core/rng.mjs  —  seeded, instance-local mulberry32 RNG  (Story P2.2)
 *
 *  WHAT THIS IS: the kernel's deterministic randomness source (INV-1). It
 *  GENERALIZES the proven `prototype/vfx.js` `makeRng(seed)` mulberry32 into a
 *  first-class engine primitive every pillar shares.
 *
 *  DETERMINISTIC BY CONSTRUCTION (INV-1 / NFR1):
 *    - the generator state is INSTANCE-LOCAL (closed over per `makeRng` call) —
 *      there is NO module-level mutable state, NO global RNG, NO `Math.random()`;
 *    - it NEVER reads a wall-clock (`Date.now` / `performance.now`) — the only
 *      input is the explicit integer `seed`;
 *    - the SAME seed yields the SAME sequence bit-identically, and RESEEDING
 *      (a fresh `makeRng(seed)` OR `rng.reseed(seed)`) reproduces it again.
 *
 *  mulberry32 is a tiny, fast, well-distributed 32-bit PRNG returning a float in
 *  [0,1). It is the SAME arithmetic as `vfx.js` so a per-effect random in the
 *  prototype and a kernel random stay byte-identical for a given seed.
 *
 *  Native ESM (D1); imports nothing app/vendor (INV-6). Pure, headless-safe.
 * ========================================================================== */

/** Default seed when none is supplied — a fixed nonzero constant (NOT a clock),
 *  so a seedless `makeRng()` is still fully deterministic. */
export const DEFAULT_SEED = 0x9e3779b9; // golden-ratio constant (same as vfx.js)

/** Coerce any value into a valid 32-bit unsigned seed (never 0 -> avoids a
 *  degenerate stream). Mirrors `vfx.js`: `(seed >>> 0) || 0x9e3779b9`. */
function toSeed(seed) {
  const s = (seed >>> 0);
  return s || DEFAULT_SEED;
}

/**
 * makeRng(seed) — build a deterministic, instance-local mulberry32 generator.
 *
 * @param {number} [seed=DEFAULT_SEED]  explicit integer seed (coerced to u32).
 * @returns {function(): number & { reseed(s:number):number, seed:number }}
 *          a callable `next()` returning a float in [0,1); also exposes
 *          `next.reseed(s)` (reset the stream to a new seed; returns the seed)
 *          and `next.seed` (the current seed, read-only).
 *
 * INV-1: same seed -> same sequence; reseed reproduces it. No wall-clock,
 * no global RNG, no Math.random.
 */
export function makeRng(seed = DEFAULT_SEED) {
  // a is the SOLE mutable state — closed over here, never escapes (instance-local).
  let a = toSeed(seed);
  let _seed = a;

  function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Reset this generator's stream to a (new) seed; returns the applied seed. */
  next.reseed = function reseed(s) {
    a = toSeed(s);
    _seed = a;
    return _seed;
  };

  // expose the (coerced) seed read-only for tooling / serialization.
  Object.defineProperty(next, 'seed', { get() { return _seed; }, enumerable: true });

  return next;
}

export default makeRng;
