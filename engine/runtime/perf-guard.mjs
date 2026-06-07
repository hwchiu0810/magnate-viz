/* =============================================================================
 *  engine/runtime/perf-guard.mjs  —  AUTO-DEGRADE PERF POLICY  (Story P7.1)
 *  (NFR8 perf budget; §Performance Considerations → frame budget / bloom auto-disable)
 *
 *  WHAT THIS IS: a PURE, HEADLESS quality-tier policy function. Given a frame-time
 *  SIGNAL (a smoothed ms/frame the host measures) it decides WHICH quality tier
 *  the engine should run at — the testable PATTERN behind "auto-LOD degrades
 *  gracefully to the 30 fps floor (bloom auto-disables first, mesh->sprite->cull
 *  LOD applies) rather than dropping frames hard."
 *
 *  THE TIER LADDER (best -> floor), each a declarative quality preset:
 *       'high'   <= 16.6 ms  (60 fps): full bloom, full-res, mesh LOD bias
 *       'medium' <= 22.0 ms  (~45 fps): half-res bloom, LOD bias toward sprite
 *       'low'    <= 33.3 ms  (30 fps floor): bloom OFF, aggressive LOD/cull, sprite-first
 *
 *  HYSTERESIS: the policy takes the CURRENT tier so it only DOWNGRADES when the
 *  frame-time crosses the next-worse budget and only UPGRADES when it falls a
 *  margin BELOW the current tier's budget (prevents tier flapping). It is a pure
 *  function of (frameTimeMs, currentTier) — NO wall-clock, NO state, NO RNG — so
 *  the host owns the smoothing + the apply; the DECISION is freezable headless.
 *
 *  BLOOM POLICY: bloomPolicy(tier) returns the declarative bloom preset for a tier
 *  — { enabled, resScale, threshold } — encoding "bloom at half-res" (resScale 0.5
 *  at medium) and "bloom auto-disables first" (enabled:false at low). The sub-white
 *  emissive clamp (<=0.85, INV-3) keeps the high-pass threshold cheap and prevents
 *  white-out — surfaced here as EMISSIVE_SUBWHITE so the policy + the harness agree.
 *
 *  HEADLESS-SAFE (INV-1 / INV-6): imports NOTHING; pure; same input -> bit-identical
 *  output. The host wires the chosen tier into its composer/LOD bias at the seam.
 *
 *  HONESTY / SEAM (deferred): MEASURING the real frame-time (a `performance.now()`
 *  / rAF delta) + the GPU cost of half-res bloom under load NEEDS a browser/GPU and
 *  is DEFERRED to a headed smoke off the CI gate. What is testable here is the pure
 *  POLICY mapping (frameTimeMs, tier) -> tier + the bloom preset per tier.
 * ========================================================================== */

export const VERSION = '0.1.0-p7.1-perf-guard';
export const NAME = 'engine/runtime/perf-guard';

/** Frame-time budgets (ms). 60 fps target, 30 fps floor (NFR8). */
export const BUDGET_60_MS = 1000 / 60;      // 16.666..
export const BUDGET_45_MS = 1000 / 45;      // 22.222..
export const BUDGET_30_MS = 1000 / 30;      // 33.333..

/** The closed quality-tier vocabulary (best -> floor). Frozen. */
export const QUALITY_TIERS = Object.freeze(['high', 'medium', 'low']);

/** The sub-white emissive clamp (INV-3 / NFR3) the bloom high-pass relies on. */
export const EMISSIVE_SUBWHITE = 0.85;

/** Upgrade margin (ms): frame-time must fall this far below a better tier's
 *  budget before we upgrade, so the tier does not flap frame-to-frame. */
const UPGRADE_MARGIN_MS = 2.0;

/* Per-tier budget ceiling (the worst frame-time still acceptable AT that tier). */
const TIER_CEIL = Object.freeze({ high: BUDGET_60_MS, medium: BUDGET_45_MS, low: BUDGET_30_MS });
/* Tier ordering index (0 = best). */
const TIER_IX = Object.freeze({ high: 0, medium: 1, low: 2 });

/* -----------------------------------------------------------------------------
 *  qualityTier(frameTimeMs, currentTier) — the PURE policy.
 *  Returns the tier the engine SHOULD run at next frame.
 *    - frameTimeMs <= 16.6  -> can sustain 'high'
 *    - <= 22.0              -> 'medium'  (half-res bloom)
 *    - else                 -> 'low'     (bloom off, aggressive LOD; the 30fps floor)
 *  With a currentTier supplied, hysteresis dampens flapping: downgrade as soon as
 *  the current tier's budget is exceeded; upgrade only when frame-time is a margin
 *  below the better tier's ceiling. A non-finite signal holds the current tier
 *  (or 'high' if none) — a glitchy probe never forces a degrade.
 * ------------------------------------------------------------------------- */
export function qualityTier(frameTimeMs, currentTier) {
  const cur = QUALITY_TIERS.includes(currentTier) ? currentTier : null;
  if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) return cur || 'high';

  // the raw tier the instantaneous frame-time alone would pick
  let raw;
  if (frameTimeMs <= BUDGET_60_MS) raw = 'high';
  else if (frameTimeMs <= BUDGET_45_MS) raw = 'medium';
  else raw = 'low';

  if (!cur) return raw;                                   // no hysteresis without a prior tier

  const curIx = TIER_IX[cur], rawIx = TIER_IX[raw];

  // DOWNGRADE immediately if we exceed the current tier's own budget.
  if (frameTimeMs > TIER_CEIL[cur]) {
    return rawIx > curIx ? raw : cur;                     // step toward the worse tier
  }
  // UPGRADE only if frame-time is a clear margin below a BETTER tier's ceiling.
  if (rawIx < curIx) {
    const betterTier = QUALITY_TIERS[curIx - 1];
    if (frameTimeMs <= TIER_CEIL[betterTier] - UPGRADE_MARGIN_MS) return betterTier;
    return cur;                                           // not enough headroom to upgrade yet
  }
  return cur;                                             // within budget, same tier (stable)
}

/* -----------------------------------------------------------------------------
 *  bloomPolicy(tier) — the declarative bloom preset for a quality tier.
 *    high   -> full bloom, full-res
 *    medium -> bloom at HALF-RES (the architecture's half-res bloom)
 *    low    -> bloom OFF (auto-disables first under the 30fps floor)
 *  `subWhite` is constant (INV-3): bloom always rides the <=0.85 emissive clamp.
 *  Pure + headless.
 * ------------------------------------------------------------------------- */
export function bloomPolicy(tier) {
  const t = QUALITY_TIERS.includes(tier) ? tier : 'high';
  if (t === 'low')    return Object.freeze({ enabled: false, resScale: 0.5, threshold: 0.85, subWhite: EMISSIVE_SUBWHITE });
  if (t === 'medium') return Object.freeze({ enabled: true,  resScale: 0.5, threshold: 0.80, subWhite: EMISSIVE_SUBWHITE });
  return                Object.freeze({ enabled: true,  resScale: 1.0, threshold: 0.75, subWhite: EMISSIVE_SUBWHITE });
}

/* -----------------------------------------------------------------------------
 *  lodBias(tier) — the LOD distance-threshold MULTIPLIER for a quality tier.
 *  Lower tiers shrink the mesh/sprite distances (mesh->sprite->cull sooner). A
 *  scene multiplies its lod.DEFAULT_LOD thresholds by this. Pure + headless.
 * ------------------------------------------------------------------------- */
export function lodBias(tier) {
  const t = QUALITY_TIERS.includes(tier) ? tier : 'high';
  if (t === 'low')    return 0.5;                          // cull/sprite aggressively
  if (t === 'medium') return 0.75;
  return 1.0;
}

/* -----------------------------------------------------------------------------
 *  createPerfGuard(opts) — a tiny STATEFUL wrapper (host-owned) around the pure
 *  policy: holds the current tier + an EWMA-smoothed frame-time, and on each
 *  sample() returns the (possibly changed) tier. The smoothing is deterministic
 *  (a fixed alpha) — NO wall-clock; the host passes the measured dtMs. Headless-
 *  safe; the real measurement is the deferred browser seam.
 * ------------------------------------------------------------------------- */
export function createPerfGuard(opts = {}) {
  const alpha = clamp01(typeof opts.alpha === 'number' ? opts.alpha : 0.1);
  let tier = QUALITY_TIERS.includes(opts.startTier) ? opts.startTier : 'high';
  let ewma = Number.isFinite(opts.startMs) ? opts.startMs : BUDGET_60_MS;
  return {
    get tier() { return tier; },
    get frameTimeMs() { return ewma; },
    /** feed a measured frame-time (ms); returns the resulting quality tier. */
    sample(dtMs) {
      if (Number.isFinite(dtMs) && dtMs >= 0) ewma = ewma + alpha * (dtMs - ewma);
      tier = qualityTier(ewma, tier);
      return tier;
    },
    bloom() { return bloomPolicy(tier); },
    lodBias() { return lodBias(tier); },
    reset(startTier, startMs) {
      tier = QUALITY_TIERS.includes(startTier) ? startTier : 'high';
      ewma = Number.isFinite(startMs) ? startMs : BUDGET_60_MS;
    },
  };
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/** Reflection-friendly frozen surface descriptor. */
export const perfGuard = Object.freeze({
  name: NAME, version: VERSION,
  QUALITY_TIERS, BUDGET_60_MS, BUDGET_45_MS, BUDGET_30_MS, EMISSIVE_SUBWHITE,
  qualityTier, bloomPolicy, lodBias, createPerfGuard,
});

export default perfGuard;
