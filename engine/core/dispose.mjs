/* =============================================================================
 *  engine/core/dispose.mjs  —  the dispose() lifecycle  (Story P2.2, INV-4)
 *
 *  WHAT THIS IS: the kernel generalization of `prototype/vfx.js`'s
 *  `disposeResource` / `disposeMaterial` discipline into a single, mandatory,
 *  COMPLETE, swallowed-safe `dispose(handleOrResource)`:
 *    - frees geometry / material / texture / uniform-texture (`.dispose()`),
 *    - releases ref-counted POOL keys the handle holds,
 *    - detaches the object from its parent,
 *    - and NEVER throws across the host boundary (every GPU/DOM op is try/caught),
 *      so one bad capability can't crash a frame (INV-4 / NFR4; Error Handling rule
 *      "never throw across the host boundary").
 *
 *  It accepts EITHER a raw THREE resource (geometry/material/texture/mesh) OR a
 *  factory HANDLE `{ dispose(), group?, _pool?, _poolKeys? }`. Idempotent: a
 *  second dispose() is a harmless no-op (handles guard their own `dispose()`).
 *
 *  Native ESM (D1); NO hard import of THREE — operates duck-typed on whatever is
 *  passed (INV-6). Pure-ish (mutates the passed object's lifecycle), headless-safe.
 * ========================================================================== */

/** common texture slots a material may hold (freed individually). */
const TEXTURE_SLOTS = ['map', 'tDiffuse', 'tColor', 'lutTexture', 'emissiveMap', 'alphaMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap', 'envMap'];

/** free a single texture-like object (swallowed). */
function disposeTexture(t) {
  try { if (t && typeof t.dispose === 'function') t.dispose(); } catch { /* swallowed */ }
}

/** free a material (or array of materials), including its map slots + uniform textures. */
export function disposeMaterial(m) {
  if (!m) return;
  try {
    if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) disposeMaterial(m[i]); return; }
    for (let s = 0; s < TEXTURE_SLOTS.length; s++) disposeTexture(m[TEXTURE_SLOTS[s]]);
    if (m.uniforms) {
      for (const u in m.uniforms) {
        if (!Object.prototype.hasOwnProperty.call(m.uniforms, u)) continue;
        const v = m.uniforms[u] && m.uniforms[u].value;
        if (v && typeof v.dispose === 'function') { try { v.dispose(); } catch { /* swallowed */ } }
      }
    }
    if (typeof m.dispose === 'function') m.dispose();
  } catch { /* headless-safe */ }
}

/** Deep-free any THREE-ish raw resource (geometry/material/texture/mesh) — the
 *  generalization of `vfx.js`'s `disposeResource`. Swallows every error. */
export function disposeResource(r) {
  if (!r) return;
  try {
    if (r.geometry && typeof r.geometry.dispose === 'function') { try { r.geometry.dispose(); } catch { /* swallowed */ } }
    if (r.material) disposeMaterial(r.material);
    if (r.texture && typeof r.texture.dispose === 'function') { try { r.texture.dispose(); } catch { /* swallowed */ } }
    // a bare material passed directly (has uniforms / map but no geometry)
    if (!r.geometry && (r.uniforms || r.isMaterial)) disposeMaterial(r);
    // a bare texture passed directly
    if (r.isTexture && typeof r.dispose === 'function') { try { r.dispose(); } catch { /* swallowed */ } }
    else if (typeof r.dispose === 'function' && !r.isMaterial && !r.isTexture
             && typeof r.update !== 'function' && typeof r.setParams !== 'function') {
      // a BARE geometry (BufferGeometry), a composer pass, or another generic disposable
      // (no geometry/material/texture/uniforms of its own) — actually free it. We EXCLUDE
      // effect/object HANDLEs ({update,setParams,dispose}), whose dispose() is invoked via
      // their own path, so we never double-call. (Fix: this branch previously no-op'd, so a
      // pooled bare geometry released to refcount 0 never disposed — an INV-4 leak.)
      try { r.dispose(); } catch { /* swallowed */ }
    }
  } catch { /* headless-safe */ }
}

/** Detach an Object3D-like node from its parent (`parent.remove(child)` or
 *  `child.removeFromParent()`), swallowed. */
function detachFromParent(obj) {
  if (!obj) return;
  try {
    if (typeof obj.removeFromParent === 'function') { obj.removeFromParent(); return; }
    if (obj.parent && typeof obj.parent.remove === 'function') obj.parent.remove(obj);
  } catch { /* swallowed */ }
}

/** Release any POOL keys a handle declares (`_poolKeys` + `_pool.release`). */
function releasePoolKeys(handle) {
  if (!handle || !handle._pool || typeof handle._pool.release !== 'function') return;
  const keys = handle._poolKeys;
  if (!Array.isArray(keys)) return;
  for (let i = 0; i < keys.length; i++) {
    try { handle._pool.release(keys[i]); } catch { /* swallowed */ }
  }
}

/**
 * dispose(handleOrResource) — mandatory + complete + swallowed-safe (INV-4).
 *
 * Frees GPU resources, releases POOL keys, detaches from parent, and invokes a
 * handle's own `dispose()`. NEVER throws across the host boundary. Idempotent.
 *
 * @param {object} h  a factory handle `{ dispose?, group?, _pool?, _poolKeys? }`
 *                    OR a raw THREE resource (geometry/material/texture/mesh).
 * @returns {undefined}
 */
export function dispose(h) {
  if (!h) return undefined;
  try {
    // 1. release ref-counted POOL keys this handle holds.
    releasePoolKeys(h);

    // 2. let the handle free its own owned resources first (factory contract).
    if (typeof h.dispose === 'function' && h.dispose !== dispose) {
      try { h.dispose(); } catch { /* swallowed: never throw across host boundary */ }
    }

    // 3. detach + deep-free any group / scene node the handle exposes.
    if (h.group) { detachFromParent(h.group); disposeResource(h.group); }

    // 4. deep-free the resource itself (raw resource OR handle with geometry/material).
    disposeResource(h);

    // 5. detach the handle itself if it is an Object3D-like node.
    detachFromParent(h);
  } catch { /* headless-safe — swallow any GPU/DOM error */ }
  return undefined;
}

export default dispose;
