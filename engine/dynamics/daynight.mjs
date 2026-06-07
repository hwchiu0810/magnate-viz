/* =============================================================================
 *  engine/dynamics/daynight.mjs  —  the DAY/NIGHT cycle dynamic  (Story P5.3)
 *
 *  WHAT THIS IS: a time-driven global cycle that drives a COLOUR + INTENSITY
 *  channel over the timeline — the generic, app-agnostic engine primitive behind
 *  "the world has a sky that warms at dawn and cools at dusk". It is a PURE
 *  function of (declarative gradient stops, elapsed): NO wall-clock, NO global
 *  RNG, NO allocation per frame.
 *
 *  THE CYCLE (declarative, serialization-first — INV-5):
 *    A day/night cycle is a LIST of gradient stops `[{ t, color:[r,g,b], intensity }]`
 *    over a normalised cycle phase `t ∈ [0,1)` (0 = cycle start, wraps). The cycle
 *    `period` (seconds) maps the host-injected `elapsed` onto the phase. At a given
 *    `elapsed` the stop list is sampled piecewise-linearly (eased optionally) into a
 *    single `{ color:[r,g,b], intensity }` reading. NO functions are serialized; the
 *    factory re-creates the cycle from the plain stop list + period on load.
 *
 *  SUB-WHITE (INV-3 / NFR3): EVERY colour/intensity component the cycle emits is
 *  CLAMPED to `EMISSIVE_MAX` (0.85). The day/night output rides the sub-white
 *  emissive clamp so it feeds UnrealBloom WITHOUT blowing out to white — the bound
 *  is asserted by the conformance harness. The clamp is applied to the FINAL
 *  reading (after interpolation), so no interpolated mid-stop can exceed it either.
 *
 *  REDUCED-MOTION (INV-2 / NFR2): under `reduceMotion` the cycle FREEZES to a
 *  static resting frame (a declared `resting` phase, else phase 0) and does NOT
 *  advance on subsequent update() — the deterministic single frame the snapshot
 *  harness reads.
 *
 *  ALLOC-FREE (INV-4): the sorted stop track + the reusable `{color,intensity}`
 *  output reading are built ONCE (initState/onParams); update() mutates that
 *  pre-built reading in place and writes scalars into the target IN PLACE. The
 *  read() probe returns that same reading (VIEW-ONLY) — no per-frame new.
 *
 *  HEADLESS-SAFE (INV-1): pure math; a missing target / malformed stops -> inert.
 *  Native ESM (D1); imports nothing app/vendor (INV-6).
 * ========================================================================== */

import { easingFn } from './easing.mjs';

/** Sub-white emissive clamp (INV-3). Day/night colour + intensity ride <= 0.85. */
export const EMISSIVE_MAX = 0.85;

/** A reasonable default dawn->day->dusk->night gradient, ALL sub-white (<=0.85).
 *  Phase 0 = pre-dawn night; 0.25 = warm dawn; 0.5 = cool day; 0.75 = dusk. */
export const DEFAULT_STOPS = Object.freeze([
  { t: 0.0,  color: [0.05, 0.07, 0.16], intensity: 0.12 },   // deep night
  { t: 0.25, color: [0.80, 0.55, 0.32], intensity: 0.62 },   // warm dawn
  { t: 0.5,  color: [0.62, 0.74, 0.85], intensity: 0.85 },   // cool day (rides the clamp)
  { t: 0.75, color: [0.70, 0.40, 0.30], intensity: 0.55 },   // dusk
]);

/** Clamp a single channel into [0, EMISSIVE_MAX] (sub-white, never < 0). */
function clampSubWhite(x) {
  const v = +x;
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : (v > EMISSIVE_MAX ? EMISSIVE_MAX : v);
}

/** Map host `elapsed` onto the cycle phase t ∈ [0,1). period<=0 -> frozen at 0. */
export function cyclePhase(elapsed, period) {
  const p = +period;
  if (!(p > 0)) return 0;
  let ph = (+elapsed || 0) / p;
  ph = ph - Math.floor(ph);                 // wrap into [0,1)
  return ph;
}

/** Build (ONCE) the sorted stop track + the reusable {color,intensity} reading. */
export function buildDayNightState(p) {
  const stops = [];
  const list = Array.isArray(p.stops) ? p.stops : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || typeof s.t !== 'number' || !Number.isFinite(s.t)) continue;
    const c = Array.isArray(s.color) ? s.color : [0, 0, 0];
    stops.push({
      t: ((s.t % 1) + 1) % 1,                                // normalise into [0,1)
      r: +c[0] || 0, g: +c[1] || 0, b: +c[2] || 0,
      intensity: (typeof s.intensity === 'number' && Number.isFinite(s.intensity)) ? s.intensity : 1,
      easing: (typeof s.easing === 'string') ? s.easing : ((typeof p.easing === 'string') ? p.easing : 'linear'),
    });
  }
  stops.sort((a, b) => a.t - b.t);                           // deterministic cyclic order
  // the reusable reading (rebuilt ONCE; mutated in place every frame).
  const reading = { color: [0, 0, 0], intensity: 0 };
  return { stops, reading };
}

/** Sample the cyclic stop track at phase t -> writes the pre-built reading IN PLACE.
 *  Cyclic: the segment AFTER the last stop wraps back to the first stop (t+1).
 *  Every emitted component is sub-white-clamped (INV-3). */
export function sampleDayNight(stops, t, reading) {
  const out = reading || { color: [0, 0, 0], intensity: 0 };
  const n = stops.length;
  if (n === 0) { out.color[0] = out.color[1] = out.color[2] = 0; out.intensity = 0; return out; }
  if (n === 1) {
    out.color[0] = clampSubWhite(stops[0].r);
    out.color[1] = clampSubWhite(stops[0].g);
    out.color[2] = clampSubWhite(stops[0].b);
    out.intensity = clampSubWhite(stops[0].intensity);
    return out;
  }
  const ph = ((t % 1) + 1) % 1;
  // find the bracketing pair [a,b] on the cycle (wrapping past the last stop).
  let a = stops[n - 1], b = stops[0], span = (stops[0].t + 1) - stops[n - 1].t, local = (ph + (ph < stops[0].t ? 1 : 0)) - stops[n - 1].t;
  for (let i = 0; i < n - 1; i++) {
    if (ph >= stops[i].t && ph < stops[i + 1].t) { a = stops[i]; b = stops[i + 1]; span = stops[i + 1].t - stops[i].t; local = ph - stops[i].t; break; }
  }
  const f = span > 0 ? (local / span) : 0;
  const e = easingFn(b.easing)(f < 0 ? 0 : (f > 1 ? 1 : f));
  out.color[0] = clampSubWhite(a.r + (b.r - a.r) * e);
  out.color[1] = clampSubWhite(a.g + (b.g - a.g) * e);
  out.color[2] = clampSubWhite(a.b + (b.b - a.b) * e);
  out.intensity = clampSubWhite(a.intensity + (b.intensity - a.intensity) * e);
  return out;
}

/** The resting phase honored under reduceMotion: a declared `resting` (in [0,1)),
 *  else phase 0. */
function restingPhase(p) {
  if (typeof p.resting === 'number' && Number.isFinite(p.resting)) return ((p.resting % 1) + 1) % 1;
  return 0;
}

/** Write the reading into a bound target IN PLACE (no alloc). A target may carry a
 *  `color` ({r,g,b}/{setRGB}) and/or an `intensity` scalar field. */
function writeReading(target, reading) {
  if (!target) return;
  const col = target.color;
  if (col) {
    if (typeof col.setRGB === 'function') col.setRGB(reading.color[0], reading.color[1], reading.color[2]);
    else { if (typeof col.r === 'number') col.r = reading.color[0]; if (typeof col.g === 'number') col.g = reading.color[1]; if (typeof col.b === 'number') col.b = reading.color[2]; }
  }
  if (typeof target.intensity === 'number') target.intensity = reading.intensity;
}

/**
 * dayNightStep(host, targets, dt, elapsed, p, st) — the per-frame body. PURE fn of
 * (stops, elapsed): map elapsed -> phase, sample into the pre-built reading, write
 * every target. Used by the factory wrapper in index.mjs (passed as opts.step).
 */
export function dayNightStep(host, targets, dt, elapsed, p, st) {
  if (!st.stops.length) return;
  const ph = cyclePhase(elapsed, p.period);
  sampleDayNight(st.stops, ph, st.reading);
  for (let i = 0; i < targets.length; i++) writeReading(targets[i], st.reading);
}

/** dayNightRest(...) — the reduceMotion resting-frame body (declared resting / phase 0). */
export function dayNightRest(host, targets, p, st) {
  if (!st.stops.length) return;
  sampleDayNight(st.stops, restingPhase(p), st.reading);
  for (let i = 0; i < targets.length; i++) writeReading(targets[i], st.reading);
}

/** VIEW-ONLY probe reading: the pre-built {color,intensity} reading + the cap. */
export function dayNightRead(st) {
  if (!st || !st.reading) return null;
  return { color: st.reading.color.slice(), intensity: st.reading.intensity, emissiveMax: EMISSIVE_MAX };
}

/** The descriptor default params (controls are inferred from these). `period` is
 *  the cycle length in seconds; `stops` the declarative gradient; `resting` the
 *  reduceMotion frozen phase; `emissiveMax` documents the sub-white cap (INV-3). */
export const DAYNIGHT_DEFAULTS = Object.freeze({
  period: 60,
  stops: DEFAULT_STOPS.map((s) => ({ t: s.t, color: s.color.slice(), intensity: s.intensity })),
  easing: 'linear',
  resting: 0,
  emissiveMax: EMISSIVE_MAX,
});

/**
 * sampleDayNightCycle(stops, elapsed, opts) — PURE convenience sampler for the
 * conformance layer: returns a FRESH {color:[r,g,b], intensity, emissiveMax}
 * reading at `elapsed` (the live dynamic mutates a pre-built reading in place).
 * Every component is sub-white-clamped (<= 0.85). Reproducible from (stops,elapsed).
 */
export function sampleDayNightCycle(stops, elapsed, opts = {}) {
  const st = buildDayNightState({ stops, easing: opts.easing });
  const ph = cyclePhase(elapsed, opts.period === undefined ? 60 : opts.period);
  const reading = { color: [0, 0, 0], intensity: 0 };
  sampleDayNight(st.stops, ph, reading);
  return { color: reading.color.slice(), intensity: reading.intensity, emissiveMax: EMISSIVE_MAX };
}

export const daynight = Object.freeze({
  EMISSIVE_MAX,
  DEFAULT_STOPS,
  DAYNIGHT_DEFAULTS,
  cyclePhase,
  buildDayNightState,
  sampleDayNight,
  sampleDayNightCycle,
  dayNightStep,
  dayNightRest,
  dayNightRead,
});

export default daynight;
