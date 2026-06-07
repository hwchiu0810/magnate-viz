/* =============================================================================
 *  engine/scenes/lod.mjs  —  HEADLESS LOD / CULLING / STREAMING helpers
 *  (Story P7.1, ADR-D1 / NFR8 / FR1; §Performance Considerations → LOD/culling)
 *
 *  WHAT THIS IS: PURE, HEADLESS, SEEDLESS policy helpers for the perf-budget
 *  story — the testable PATTERN behind distance-LOD + frustum culling + bounded
 *  streaming. These are math-only selectors that decide WHICH level-of-detail a
 *  binding should render at and WHICH chunks stay live around a focus; the actual
 *  three.js mesh<->sprite swap + GPU `frustumCulled` flag are applied by the scene
 *  factory at the seam (see applyLOD()), but the DECISION is a pure function the
 *  conformance harness can freeze (no GPU, no DOM, no clock, no RNG).
 *
 *  THE LOD LADDER (architecture: "distance LOD swaps mesh -> sprite -> cull"):
 *       'mesh'   (near)   full-detail mesh
 *       'sprite' (mid)    cheap billboard sprite
 *       'cull'   (far)    not rendered (off-screen / past cull distance)
 *
 *  BOUNDED STREAMING (architecture: streamAround(focus); the prototype's
 *  __worldHeadless.liveChunks() invariant): from a focus point + a view radius +
 *  a chunk size, enumerate exactly the bounded RING of chunk coords that should be
 *  live — a structural cap (never grows with world size). This is the generalized
 *  `streamChunks(x,z)` of the prototype, with the live count proven bounded.
 *
 *  HEADLESS-SAFE (INV-1 / INV-6): imports NOTHING (no core, no THREE, no DOM);
 *  every fn is pure (same inputs -> bit-identical output). NO wall-clock, NO RNG.
 *
 *  HONESTY / SEAM (deferred): the *measured* GPU win of LOD/culling (frame-time
 *  under load, sprite-vs-mesh fill cost) needs a browser+GPU to MEASURE and is
 *  DEFERRED to a headed smoke off the CI critical path. What is testable here is
 *  the POLICY: the tier selection + the bounded live-set enumeration.
 * ========================================================================== */

export const VERSION = '0.1.0-p7.1-lod';
export const NAME = 'engine/scenes/lod';

/** The closed LOD-tier vocabulary (near -> far). Frozen. */
export const LOD_TIERS = Object.freeze(['mesh', 'sprite', 'cull']);

/** Default distance thresholds (world units). distance < meshMax -> 'mesh';
 *  < spriteMax -> 'sprite'; else 'cull'. Overridable per call. */
export const DEFAULT_LOD = Object.freeze({ meshMax: 40, spriteMax: 120 });

/** Hard CAP on the number of live chunks streamAround() may return (INV-4 /
 *  NFR4). A view radius is bounded, but this guards against a pathological
 *  (huge-radius / tiny-chunk) request blowing the budget. */
export const STREAM_RING_CAP = 4096;

/* -----------------------------------------------------------------------------
 *  lodTier(distance, opts) — pure distance->tier selector (mesh -> sprite -> cull).
 *  Returns one of LOD_TIERS. A non-finite/negative distance is treated as 0 (near)
 *  so a glitchy input never culls erroneously; thresholds clamp to a sane order.
 * ------------------------------------------------------------------------- */
export function lodTier(distance, opts = {}) {
  const meshMax = num(opts.meshMax, DEFAULT_LOD.meshMax);
  let spriteMax = num(opts.spriteMax, DEFAULT_LOD.spriteMax);
  if (spriteMax < meshMax) spriteMax = meshMax;           // keep ladder monotone
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0;
  if (d < meshMax) return 'mesh';
  if (d < spriteMax) return 'sprite';
  return 'cull';
}

/* -----------------------------------------------------------------------------
 *  distance(a, b) — pure Euclidean distance between two {x,y,z}-ish points (any
 *  missing axis is 0). Used by lodFor()/streamAround(); no allocation per call
 *  beyond the scalar result.
 * ------------------------------------------------------------------------- */
export function distance(a, b) {
  const ax = num(a && a.x, 0), ay = num(a && a.y, 0), az = num(a && a.z, 0);
  const bx = num(b && b.x, 0), by = num(b && b.y, 0), bz = num(b && b.z, 0);
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* -----------------------------------------------------------------------------
 *  lodFor(point, camera, opts) — convenience: tier for a world point given a
 *  camera position. camera may be a {position:{x,y,z}} (THREE shape) or a bare
 *  {x,y,z}. Pure + headless.
 * ------------------------------------------------------------------------- */
export function lodFor(point, camera, opts = {}) {
  const camPos = (camera && camera.position) ? camera.position : camera;
  return lodTier(distance(point, camPos || {}), opts);
}

/* -----------------------------------------------------------------------------
 *  inFrustumSphere(point, radius, plane) — a MINIMAL, conservative frustum test:
 *  given a point + bounding radius + an array of 6 plane records
 *  {nx,ny,nz,d} (normalized, pointing inward, signed-distance convention
 *  nx*x+ny*y+nz*z + d >= -radius), returns false iff the sphere is fully outside
 *  any plane. With NO planes supplied it returns true (frustumCulled default ON
 *  is a GPU concern; this is the headless decision seam). Pure + headless.
 *
 *  This is the testable analogue of three's Frustum.intersectsSphere — the engine
 *  sets mesh.frustumCulled = true and lets the GPU cull; the planes-from-camera
 *  extraction is the browser seam (deferred), but the POLICY is freezable.
 * ------------------------------------------------------------------------- */
export function inFrustumSphere(point, radius, planes) {
  if (!Array.isArray(planes) || planes.length === 0) return true;   // no frustum -> visible
  const r = num(radius, 0);
  const x = num(point && point.x, 0), y = num(point && point.y, 0), z = num(point && point.z, 0);
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i]; if (!p) continue;
    const sd = num(p.nx, 0) * x + num(p.ny, 0) * y + num(p.nz, 0) * z + num(p.d, 0);
    if (sd < -r) return false;                            // fully behind this plane -> cull
  }
  return true;
}

/* -----------------------------------------------------------------------------
 *  streamAround(focus, opts) — the bounded-ring chunk enumerator (FR1; the
 *  prototype's streamChunks generalization). Given a focus {x,z}, a view radius,
 *  and a chunk size, returns the SORTED, DEDUPED, BOUNDED list of chunk coords
 *  {cx, cz} whose chunk-center is within `radius` of the focus — exactly the live
 *  set. The count is structurally bounded (a disc of radius/chunk) and HARD-capped
 *  at STREAM_RING_CAP so the live set never exceeds the budget (INV-4).
 *
 *  Returns { chunks:[{cx,cz}], count, capped:boolean }. Deterministic ordering
 *  (by cz then cx) so the output is a freezable conformance vector. Pure + headless.
 * ------------------------------------------------------------------------- */
export function streamAround(focus, opts = {}) {
  const chunk = Math.max(1e-6, num(opts.chunk, 16));
  const radius = Math.max(0, num(opts.radius, 64));
  const fx = num(focus && focus.x, 0), fz = num(focus && focus.z, 0);
  const r2 = radius * radius;

  // center chunk index + how many chunks the radius spans on each side
  const c0x = Math.round(fx / chunk), c0z = Math.round(fz / chunk);
  const span = Math.ceil(radius / chunk);

  const chunks = [];
  let capped = false;
  for (let dz = -span; dz <= span && !capped; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const cx = c0x + dx, cz = c0z + dz;
      // chunk center in world space; include iff within the view disc
      const wx = cx * chunk, wz = cz * chunk;
      const ddx = wx - fx, ddz = wz - fz;
      if (ddx * ddx + ddz * ddz <= r2) {
        if (chunks.length >= STREAM_RING_CAP) { capped = true; break; }
        chunks.push({ cx, cz });
      }
    }
  }
  // deterministic order (cz major, cx minor) — a stable, freezable enumeration
  chunks.sort((a, b) => (a.cz - b.cz) || (a.cx - b.cx));
  return { chunks, count: chunks.length, capped };
}

/* -----------------------------------------------------------------------------
 *  applyLOD(handle, tier) — the SEAM that applies a tier decision to a live
 *  THREE-or-stub handle. HEADLESS-SAFE: with no THREE / a plain-group handle it
 *  only toggles `.visible` + records `.lodTier` (the headless-readable decision);
 *  with a real handle exposing meshNode/spriteNode it swaps which is visible.
 *  NEVER throws. This keeps the GPU swap behind a guarded, view-only-when-headless
 *  boundary; the *measured* swap cost is the deferred browser seam.
 * ------------------------------------------------------------------------- */
export function applyLOD(handle, tier) {
  if (!handle || !LOD_TIERS.includes(tier)) return handle;
  try {
    handle.lodTier = tier;                                 // headless-readable decision
    const mesh = handle.meshNode || null;
    const sprite = handle.spriteNode || null;
    if (mesh && 'visible' in mesh) mesh.visible = (tier === 'mesh');
    if (sprite && 'visible' in sprite) sprite.visible = (tier === 'sprite');
    if (handle.group && 'visible' in handle.group) handle.group.visible = (tier !== 'cull');
  } catch { /* swallowed: never throw across the host boundary */ }
  return handle;
}

/* ---- tiny pure helper ----------------------------------------------------- */
function num(v, dflt) { return (typeof v === 'number' && v === v) ? v : dflt; }

/** Reflection-friendly frozen surface descriptor. */
export const lod = Object.freeze({
  name: NAME, version: VERSION,
  LOD_TIERS, DEFAULT_LOD, STREAM_RING_CAP,
  lodTier, lodFor, distance, inFrustumSphere, streamAround, applyLOD,
});

export default lod;
