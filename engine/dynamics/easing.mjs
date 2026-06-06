/* =============================================================================
 *  engine/dynamics/easing.mjs  —  the PURE easing library  (Story P5.1)
 *
 *  WHAT THIS IS: the deterministic easing curves the deepened keyframe/timeline
 *  dynamic (P5.1) interpolates with. EVERY function here is a PURE map of a
 *  normalised progress `t ∈ [0,1]` -> an eased progress `e ∈ [0,1]` — NO state,
 *  NO wall-clock, NO RNG, NO allocation. Same `t` -> byte-identical `e` across
 *  runs (INV-1). These are the only nonlinearity in the keyframe interpolation,
 *  so freezing the easing curves freezes the motion.
 *
 *  CONTRACT (so a keyframe `easing` name is total + safe):
 *    - input `t` is CLAMPED to [0,1] before the curve is applied (a keyframe
 *      span's progress is always 0..1; out-of-range is a caller bug, not a throw);
 *    - every curve satisfies f(0)=0 and f(1)=1 (endpoints are exact — a keyframe
 *      seats EXACTLY on its declared value at the stop), so the t=0 / t=1 frames
 *      the conformance harness freezes are independent of the curve;
 *    - an UNKNOWN easing name resolves to `linear` (total: never undefined,
 *      never a throw) — a typo degrades gracefully to the identity-ish curve.
 *
 *  Native ESM (D1); imports nothing app/vendor (INV-6). Pure, headless-safe.
 * ========================================================================== */

/** Clamp progress into the unit interval (a keyframe span is always 0..1). */
function clamp01(t) {
  const x = +t;
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

/* -----------------------------------------------------------------------------
 *  THE CURVES — each is f:[0,1]->[0,1] with f(0)=0, f(1)=1, pure + alloc-free.
 *  Standard Penner-style set; the names are the frozen `easing` vocabulary a
 *  keyframe may declare. All operate on the pre-clamped progress.
 * ------------------------------------------------------------------------- */

/** linear — the identity curve (no easing). */
export function linear(t) { return clamp01(t); }

/** step — hard hold until t>=1 (a stepped/hold keyframe; f(1)=1, else 0). */
export function step(t) { return clamp01(t) >= 1 ? 1 : 0; }

/* --- quadratic (power 2) --------------------------------------------------- */
export function easeInQuad(t) { const x = clamp01(t); return x * x; }
export function easeOutQuad(t) { const x = clamp01(t); return 1 - (1 - x) * (1 - x); }
export function easeInOutQuad(t) {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/* --- cubic (power 3) ------------------------------------------------------- */
export function easeInCubic(t) { const x = clamp01(t); return x * x * x; }
export function easeOutCubic(t) { const x = clamp01(t); return 1 - Math.pow(1 - x, 3); }
export function easeInOutCubic(t) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/* --- sinusoidal ------------------------------------------------------------ */
export function easeInSine(t) { const x = clamp01(t); return 1 - Math.cos((x * Math.PI) / 2); }
export function easeOutSine(t) { const x = clamp01(t); return Math.sin((x * Math.PI) / 2); }
export function easeInOutSine(t) { const x = clamp01(t); return -(Math.cos(Math.PI * x) - 1) / 2; }

/* --- exponential (f(0)=0, f(1)=1 guaranteed at the endpoints) -------------- */
export function easeInExpo(t) { const x = clamp01(t); return x <= 0 ? 0 : Math.pow(2, 10 * x - 10); }
export function easeOutExpo(t) { const x = clamp01(t); return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); }
export function easeInOutExpo(t) {
  const x = clamp01(t);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2;
}

/* --- smoothstep (Hermite) -------------------------------------------------- */
export function smoothstep(t) { const x = clamp01(t); return x * x * (3 - 2 * x); }
export function smootherstep(t) { const x = clamp01(t); return x * x * x * (x * (x * 6 - 15) + 10); }

/* -----------------------------------------------------------------------------
 *  THE EASING TABLE — the frozen `easing` vocabulary -> pure curve. Friendly
 *  aliases map onto the canonical names so a spec can say `easeIn`/`easeOut`/
 *  `easeInOut` (default cubic family) or `cubic` etc. without a separate edit.
 * ------------------------------------------------------------------------- */
export const EASINGS = Object.freeze({
  linear,
  step, hold: step,

  // shorthand families default to the cubic curve (a sensible "ease")
  easeIn: easeInCubic,
  easeOut: easeOutCubic,
  easeInOut: easeInOutCubic,
  ease: easeInOutCubic,

  // explicit cubic
  cubic: easeInOutCubic,
  easeInCubic, easeOutCubic, easeInOutCubic,

  // explicit quad
  quad: easeInOutQuad,
  easeInQuad, easeOutQuad, easeInOutQuad,

  // sinusoidal
  sine: easeInOutSine,
  easeInSine, easeOutSine, easeInOutSine,

  // exponential
  expo: easeInOutExpo,
  easeInExpo, easeOutExpo, easeInOutExpo,

  // hermite smoothing
  smoothstep, smootherstep,
});

/** The frozen set of declarable easing names (for descriptor/select inference). */
export const EASING_NAMES = Object.freeze(Object.keys(EASINGS));

/**
 * easingFn(name) — resolve an easing name to its PURE curve. TOTAL + safe: an
 * unknown / missing name resolves to `linear` (never undefined, never a throw).
 * A function passed straight through is NOT honored (specs are declarative —
 * INV-5: no serialized functions); only the frozen string names resolve.
 */
export function easingFn(name) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(EASINGS, name)) {
    return EASINGS[name];
  }
  return linear;
}

/**
 * ease(name, t) — apply the named easing to progress t (clamped to [0,1]).
 * The one-call form used by the keyframe interpolator. Pure + alloc-free.
 */
export function ease(name, t) { return easingFn(name)(t); }

export const easing = Object.freeze({
  EASINGS, EASING_NAMES, easingFn, ease,
  linear, step,
  easeInQuad, easeOutQuad, easeInOutQuad,
  easeInCubic, easeOutCubic, easeInOutCubic,
  easeInSine, easeOutSine, easeInOutSine,
  easeInExpo, easeOutExpo, easeInOutExpo,
  smoothstep, smootherstep,
});

export default easing;
