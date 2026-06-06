/* =============================================================================
 *  engine/core/guards.mjs  —  headless host-state + guards  (Story P2.2)
 *
 *  WHAT THIS IS: the kernel generalization of `prototype/vfx.js`'s `H` host state
 *  and its inert-no-op guard discipline. Vendor (THREE / composer / DOM) arrives
 *  ONLY by injection (the runtime host contract `init({THREE,...})`, INV-6/INV-7);
 *  before init — or whenever THREE/composer/DOM are absent — EVERY entry point is
 *  an inert no-op that NEVER throws (INV-1 / NFR1). This is non-negotiable: the
 *  module loads + runs in Node >=20 with no GPU/DOM.
 *
 *  GUARDS (exact `vfx.js` semantics):
 *    - haveTHREE(H)  === H.ready && H.THREE          (THREE usable for real GPU objects)
 *    - havePost(H)   === haveTHREE + H.composer + H.THREE.ShaderPass   (POST wireable)
 *    - reduceMotion(H) — the single flag gating all time-driven update() math.
 *    - gate(H, fn, fallback) — run fn only when not reduced-motion; else fallback.
 *
 *  STRUCTURAL FALLBACKS (so factories build something headless):
 *    - vec(H, x,y,z)   -> THREE.Vector3 when present, else plain {x,y,z,set(...)}
 *    - vec2(H, x,y)    -> THREE.Vector2 when present, else plain {x,y,set(...)}
 *    - color(H, c)     -> THREE.Color   when present, else plain {r,g,b,setRGB(...)}
 *  These mirror `vfx.js`'s headless-safe `vec2`/`vec3`/`colorOf` fallbacks.
 *
 *  Native ESM (D1); NO hard import of THREE/Tweakpane — vendor via the H param
 *  only (INV-6). Pure, headless-safe; nothing here ever throws across the boundary.
 * ========================================================================== */

/**
 * makeHost(opts) — a fresh, INSTANCE-LOCAL host-state object (the `H` of vfx.js),
 * populated by the imperative shell's init() and cleared by dispose(). Before
 * init everything is null/false so every guard early-outs (headless contract).
 *
 * @param {object} [opts]  optional initial vendor injection (all optional).
 * @returns {object} H — a mutable host-state record.
 */
export function makeHost(opts = {}) {
  const o = opts || {};
  return {
    THREE: o.THREE || null,
    renderer: o.renderer || null,
    scene: o.scene || null,
    camera: o.camera || null,
    composer: o.composer || null,
    clock: o.clock || null,
    reduceMotion: !!o.reduceMotion,
    ready: !!(o.THREE) && o.ready !== false, // ready iff a usable THREE was injected
    width: o.width || 1280,
    height: o.height || 720,
    pixelRatio: o.pixelRatio || 1,
  };
}

/** Is THREE usable for building real GPU objects?  (`H.ready && H.THREE`) */
export function haveTHREE(H) {
  return !!(H && H.ready && H.THREE);
}

/** Is the POST family wireable? (THREE + composer + a ShaderPass constructor). */
export function havePost(H) {
  return !!(haveTHREE(H) && H.composer && H.THREE && typeof H.THREE.ShaderPass === 'function');
}

/** Is a DOM available for overlay capabilities (infographic DOM path, editor)? */
export function haveDOM(H) {
  if (H && H.document) return true;
  return typeof globalThis !== 'undefined' && !!globalThis.document;
}

/**
 * reduceMotion(H) — the single gate flag for all time-driven update() math.
 * Absent host -> true (a static resting frame is the safe headless default).
 */
export function reduceMotion(H) {
  return H ? !!H.reduceMotion : true;
}

/**
 * gate(H, fn, fallback) — run the time-driven `fn` ONLY when motion is allowed;
 * under reduceMotion (or with no host) return `fallback` (default undefined) and
 * never call `fn`. The functional form of `vfx.js`'s `if (H.reduceMotion) return;`.
 */
export function gate(H, fn, fallback) {
  if (reduceMotion(H)) return fallback;
  if (typeof fn === 'function') return fn();
  return fallback;
}

/* -----------------------------------------------------------------------------
 *  Structural vector / color fallbacks — used when THREE is absent so factories
 *  always have a {x,y,z,set} / {r,g,b,setRGB} they can read & mutate headless.
 * ------------------------------------------------------------------------- */

/** plain headless Vector3 fallback (the exact shape `vfx.js` falls back to). */
function plainVec3(x, y, z) {
  return { x: x || 0, y: y || 0, z: z || 0, set(px, py, pz) { this.x = px; this.y = py; this.z = pz; return this; } };
}
/** plain headless Vector2 fallback. */
function plainVec2(x, y) {
  return { x: x || 0, y: y || 0, set(px, py) { this.x = px; this.y = py; return this; } };
}
/** plain headless Color fallback ({r,g,b} in 0..1 + setRGB). */
function plainColor(r, g, b) {
  return { r: r || 0, g: g || 0, b: b || 0, setRGB(pr, pg, pb) { this.r = pr; this.g = pg; this.b = pb; return this; } };
}

/** vec(H, x,y,z) -> THREE.Vector3 when present, else plain {x,y,z,set}. */
export function vec(H, x, y, z) {
  if (haveTHREE(H) && H.THREE.Vector3) {
    try { return new H.THREE.Vector3(x || 0, y || 0, z || 0); } catch { /* fall through */ }
  }
  return plainVec3(x, y, z);
}

/** vec2(H, x,y) -> THREE.Vector2 when present, else plain {x,y,set}. */
export function vec2(H, x, y) {
  if (haveTHREE(H) && H.THREE.Vector2) {
    try { return new H.THREE.Vector2(x || 0, y || 0); } catch { /* fall through */ }
  }
  return plainVec2(x, y);
}

/**
 * color(H, c) -> THREE.Color when present, else plain {r,g,b,setRGB}.
 * Accepts a hex number, a [r,g,b] (0..1) array, or an {r,g,b} object.
 */
export function color(H, c) {
  if (haveTHREE(H) && H.THREE.Color) {
    try {
      if (typeof c === 'number') return new H.THREE.Color(c);
      if (Array.isArray(c)) return new H.THREE.Color(c[0] || 0, c[1] || 0, c[2] || 0);
      if (c && c.isColor) return c;
      if (c && typeof c.r === 'number') return new H.THREE.Color(c.r, c.g, c.b);
      return new H.THREE.Color(1, 1, 1);
    } catch { /* fall through */ }
  }
  if (typeof c === 'number') return plainColor(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
  if (Array.isArray(c)) return plainColor(c[0] || 0, c[1] || 0, c[2] || 0);
  if (c && typeof c.r === 'number') return plainColor(c.r, c.g, c.b);
  return plainColor(1, 1, 1);
}
