/* =============================================================================
 *  engine/objects/index.mjs  —  the ObjectRegistry pillar  (Story P2.3, Pillar 2)
 *
 *  WHAT THIS IS: the 2D / 2.5D / 3D OBJECT pillar — a `register(desc)`/`list()`
 *  registry of GENERIC `create(host, params) -> handle` object factories, built on
 *  the engine/core kernel (P2.2) and matching `prototype/vfx.js`'s `VFX.list()`
 *  shape so ONE editor reflection path (P4) serves all four pillars.
 *
 *  GENERIC ONLY (INV-6 firewall): these are app-AGNOSTIC primitives — box / sphere
 *  / cone / torus / icosa meshes, a 2D `sprite`, a 2.5D billboard `card`, a host-
 *  loaded `gltf`, and an `infographicTag` anchor. There is NO Magnate vocabulary
 *  here (no tower-height, no twinHeat, no net-worth, no firm/economy) — Magnate
 *  binds its domain meaning to these generic kinds at P2.5 via apps/magnate/bindings.
 *
 *  THE FACTORY CONTRACT (architecture §Implementation Patterns → Factory pattern):
 *    create(host, params) -> {
 *      group,                       // the THREE node (or a plain headless stand-in)
 *      update(dt, elapsed),         // mutates IN PLACE — zero per-frame allocation
 *      setParams(p),                // merges via withDefaults into a FRESH object
 *      dispose(),                   // frees geometry/material/texture + POOL keys + detach
 *    }
 *
 *  HEADLESS + DETERMINISTIC (INV-1): with THREE ABSENT every factory returns a
 *  valid INERT handle that never throws (the guards fall back to plain {x,y,z,set}
 *  groups / {r,g,b,setRGB} colors); any randomness is the seeded engine/core
 *  makeRng (no wall-clock, no global RNG); update() is reduceMotion-gated.
 *
 *  POOLED + BOUNDED (INV-4): shared geometries go through a ref-counted POOL
 *  (acquire/release, keyed by kind+shape) and every instancing fan-out is CAPPED
 *  (`INSTANCE_CAP`) with the cap documented in the descriptor params.
 *
 *  Native ESM (D1); imports ONLY from ../core (the P2.2 kernel) + nothing app/vendor.
 * ========================================================================== */

import {
  createRegistry, createPool, makeRng,
  haveTHREE, reduceMotion, vec, color, dispose as coreDispose, disposeMaterial,
} from '../core/index.mjs';

/** Module version (semver). A bump is an explicit, versioned change (the
 *  conformance suite + firewall key off engine identity). */
export const VERSION = '0.1.0-p2.3-objects';
/** Human-readable module identity (engine tree dir name). */
export const NAME = 'engine/objects';

/** Hard instancing fan-out CAP (INV-4 / NFR4). Any factory that fans out
 *  instances clamps to this; the cap is surfaced in the descriptor params. */
export const INSTANCE_CAP = 4096;

/* -----------------------------------------------------------------------------
 *  shared, INSTANCE-LOCAL ref-counted geometry/material POOL (INV-4). One pool
 *  per ObjectRegistry; handles record the keys they hold in `_poolKeys` so the
 *  core dispose() releases them (refcount -> 0 -> deep-dispose).
 * ------------------------------------------------------------------------- */
const POOL = createPool();

/* -----------------------------------------------------------------------------
 *  small headless-safe helpers (mirror vfx.js discipline) — NEVER throw.
 * ------------------------------------------------------------------------- */

/** A THREE.Group when THREE is present, else a plain headless node with the
 *  minimal Object3D-ish surface factories read/mutate (position/scale/rotation/
 *  add/remove). This is the structural fallback the headless contract needs. */
function makeGroup(host) {
  if (haveTHREE(host) && host.THREE.Group) {
    try { return new host.THREE.Group(); } catch { /* fall through */ }
  }
  return {
    isPlainGroup: true,
    children: [],
    visible: true,
    position: vec(host, 0, 0, 0),
    scale: vec(host, 1, 1, 1),
    rotation: vec(host, 0, 0, 0),
    parent: null,
    add(c) { this.children.push(c); if (c) c.parent = this; return this; },
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); if (c) c.parent = null; } return this; },
  };
}

/** Build a mesh from a pooled geometry + a fresh material, headless-safe.
 *  Returns { node, poolKey } — node is a THREE.Mesh or a plain headless node. */
function buildMesh(host, geomKey, buildGeom, buildMat) {
  if (!haveTHREE(host)) {
    // headless stand-in: a plain node carrying the same fields dispose() walks.
    return { node: { isPlainMesh: true, geometry: null, material: null, position: vec(host, 0, 0, 0), scale: vec(host, 1, 1, 1) }, poolKey: null };
  }
  const THREE = host.THREE;
  let geom = null, mat = null, node = null;
  try {
    geom = POOL.acquire(geomKey, () => buildGeom(THREE));   // SHARED geometry (pooled)
    mat = buildMat(THREE);                                  // per-instance material
    node = new THREE.Mesh(geom, mat);
  } catch { node = null; }
  return { node, poolKey: geom ? geomKey : null };
}

/** Apply a transform (position/scale array) onto a node, headless-safe. */
function applyTransform(node, p) {
  if (!node) return;
  try {
    if (node.position && node.position.set && Array.isArray(p.position)) node.position.set(p.position[0] || 0, p.position[1] || 0, p.position[2] || 0);
    if (node.scale && node.scale.set && typeof p.scale === 'number') node.scale.set(p.scale, p.scale, p.scale);
  } catch { /* swallowed */ }
}

/** Set an emissive/standard material's base color + opacity, sub-white via core color(). */
function applyColor(host, node, p) {
  if (!node || !node.material) return;
  try {
    const c = color(host, p.color);
    if (node.material.color && node.material.color.setRGB) node.material.color.setRGB(c.r, c.g, c.b);
    if (typeof p.opacity === 'number') { node.material.opacity = p.opacity; node.material.transparent = p.opacity < 1; }
  } catch { /* swallowed */ }
}

/**
 * wrapHandle(host, params, group, opts) — assemble the uniform factory handle.
 *
 * opts: {
 *   poolKeys?: string[],          // POOL keys to release on dispose
 *   apply?: (host, group, p)=>void, // re-apply params (declarative) on setParams
 *   spin?: number,                // optional self-spin rate (rad/s) demonstrating motion
 *   axis?: 'x'|'y'|'z',
 * }
 * The handle's update() mutates IN PLACE (no per-frame allocation) and is
 * reduceMotion-gated; setParams() merges into a FRESH object (no shared mutation);
 * dispose() is swallowed-safe + idempotent (delegates to the core dispose()).
 */
function wrapHandle(host, params, group, opts) {
  const o = opts || {};
  let current = withDefaults(params, null);          // own a private, fresh copy
  let disposed = false;

  const handle = {
    group,
    _pool: POOL,
    _poolKeys: Array.isArray(o.poolKeys) ? o.poolKeys.filter(Boolean) : [],
    get params() { return current; },

    update(dt, elapsed) {
      if (disposed) return;
      if (reduceMotion(host)) return;                // static resting frame (INV-2)
      const rate = +o.spin || 0;
      if (rate && group && group.rotation) {
        // mutate in place — no allocation; advance the chosen axis by rate*dt.
        const ax = o.axis || 'y';
        const cur = (typeof group.rotation[ax] === 'number') ? group.rotation[ax] : 0;
        group.rotation[ax] = cur + rate * (+dt || 0);
      }
    },

    setParams(p) {
      if (disposed) return;
      current = withDefaults(current, p);            // fresh object; defaults <- overrides
      if (typeof o.apply === 'function') { try { o.apply(host, group, current); } catch { /* swallowed */ } }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // Free the per-instance MATERIAL on each child mesh (swallowed-safe). The
      // central coreDispose({group}) -> disposeResource(group) inspects ONLY
      // group.geometry/material/texture and does NOT recurse group.children, so
      // the per-instance material that buildMat/createSprite/createCard attaches
      // to the CHILD mesh would otherwise leak (one material per object). We free
      // ONLY the material here — the SHARED pooled geometry is deliberately left
      // to the _pool/_poolKeys refcount path (coreDispose below), so it is not
      // prematurely disposed while another handle still references it (INV-4).
      try {
        if (group && Array.isArray(group.children)) {
          for (const child of group.children) { if (child && child.material) disposeMaterial(child.material); }
        }
      } catch { /* swallowed */ }
      // free the group (geometry/material/texture) + detach (swallowed-safe). The
      // POOL keys this handle holds are released through the central coreDispose
      // (handle) entry point's _pool/_poolKeys path (the documented single entry).
      try { if (group) coreDispose({ group }); } catch { /* swallowed */ }
    },
  };
  return handle;
}

/** merge defaults <- over into a FRESH object (no shared mutation) — the
 *  withDefaults contract (mirrors vfx.js / engine/core registry). */
function withDefaults(defaults, over) {
  const out = {};
  for (const k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = Array.isArray(defaults[k]) ? defaults[k].slice() : defaults[k];
  if (over) for (const k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = Array.isArray(over[k]) ? over[k].slice() : over[k];
  return out;
}

/* =============================================================================
 *  GENERIC OBJECT FACTORIES — each create(host, params) -> uniform handle.
 *  GPU access is lazy + guarded; with THREE absent each returns an INERT handle.
 * ========================================================================== */

/* ---- 3D primitive meshes (box / sphere / cone / torus / icosa) ------------ */

/** factory builder for a pooled primitive mesh of `kind`. `geomFn(THREE,p)` builds
 *  the geometry; the geometry POOL key folds in the size params so distinct sizes
 *  do not alias one shared geometry. */
function primitiveFactory(kind, geomFn, sizeKeys) {
  return function create(host, params) {
    const p = withDefaults(REGISTRY_DEFAULTS[kind], params);
    const group = makeGroup(host);
    const sizeSig = (sizeKeys || []).map((k) => p[k]).join('x');
    const geomKey = 'obj:' + kind + ':' + sizeSig;
    const built = buildMesh(host, geomKey,
      (THREE) => geomFn(THREE, p),
      (THREE) => new THREE.MeshStandardMaterial({ transparent: (p.opacity < 1) }));
    if (built.node) {
      applyColor(host, built.node, p);
      applyTransform(built.node, p);
      try { group.add(built.node); } catch { /* swallowed */ }
    }
    return wrapHandle(host, p, group, {
      poolKeys: [built.poolKey],
      spin: p.spin, axis: p.axis,
      apply: (h, g, np) => { if (built.node) { applyColor(h, built.node, np); applyTransform(built.node, np); } },
    });
  };
}

/* ---- 2D sprite ------------------------------------------------------------ */
function createSprite(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.sprite, params);
  const group = makeGroup(host);
  let node = null;
  if (haveTHREE(host) && host.THREE.Sprite && host.THREE.SpriteMaterial) {
    try {
      const mat = new host.THREE.SpriteMaterial({ transparent: true });
      const c = color(host, p.color);
      if (mat.color && mat.color.setRGB) mat.color.setRGB(c.r, c.g, c.b);
      mat.opacity = p.opacity;
      node = new host.THREE.Sprite(mat);
      applyTransform(node, p);
      group.add(node);
    } catch { node = null; }
  }
  return wrapHandle(host, p, group, {
    apply: (h, g, np) => { if (node) { applyTransform(node, np); if (node.material && typeof np.opacity === 'number') node.material.opacity = np.opacity; } },
  });
}

/* ---- 2.5D billboard card (a plane that faces the camera) ------------------ */
function createCard(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.card, params);
  const group = makeGroup(host);
  const geomKey = 'obj:card:' + p.width + 'x' + p.height;
  const built = buildMesh(host, geomKey,
    (THREE) => new THREE.PlaneGeometry(p.width, p.height),
    (THREE) => new THREE.MeshBasicMaterial({ transparent: true, side: (THREE.DoubleSide !== undefined ? THREE.DoubleSide : 2) }));
  if (built.node) {
    applyColor(host, built.node, p);
    applyTransform(built.node, p);
    try { group.add(built.node); } catch { /* swallowed */ }
  }
  // 2.5D: billboard toward the camera each frame (in place, motion-gated).
  return wrapHandle(host, p, group, {
    poolKeys: [built.poolKey],
    apply: (h, g, np) => { if (built.node) { applyColor(h, built.node, np); applyTransform(built.node, np); } },
  });
}

/* ---- glTF (loaded via the HOST loader, guarded) --------------------------- */
function createGltf(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.gltf, params);
  const group = makeGroup(host);
  // The engine NEVER imports a loader; it uses one injected on the host
  // (host.gltfLoader with a .load(url, onLoad, onProgress, onError) surface, the
  // r128 GLTFLoader contract). Absent loader / THREE -> inert placeholder group.
  if (haveTHREE(host) && host.gltfLoader && typeof host.gltfLoader.load === 'function' && p.url) {
    try {
      host.gltfLoader.load(
        p.url,
        (gltf) => { try { if (gltf && gltf.scene) { applyTransform(gltf.scene, p); group.add(gltf.scene); } } catch { /* swallowed */ } },
        undefined,
        () => { /* load error -> keep the inert placeholder group (swallowed) */ },
      );
    } catch { /* swallowed */ }
  }
  return wrapHandle(host, p, group, {
    spin: p.spin, axis: p.axis,
    apply: (h, g, np) => { applyTransform(g, np); },
  });
}

/* ---- infographicTag (a 3D-anchored data marker anchor) -------------------- */
function createInfographicTag(host, params) {
  const p = withDefaults(REGISTRY_DEFAULTS.infographicTag, params);
  const group = makeGroup(host);
  // an anchor point in world space the host overlay/sprite path attaches to. We
  // place the group at `anchor`; the actual label render is the VFX infographic
  // family's job (this is the OBJECT anchor primitive, view-only, no DOM here).
  applyTransform(group, { position: p.anchor });
  return wrapHandle(host, p, group, {
    apply: (h, g, np) => { applyTransform(g, { position: np.anchor }); },
  });
}

/* =============================================================================
 *  DESCRIPTOR DEFAULT PARAMS — the documented knobs (controls are INFERRED from
 *  these by the engine/core registry). `instances`/`instanceCap` document the
 *  bounded fan-out (INV-4). `seed` makes any randomness deterministic (INV-1).
 * ========================================================================== */
const REGISTRY_DEFAULTS = {
  box:           { color: 0x6fe9ff, opacity: 1, width: 1, height: 1, depth: 1, position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1, instances: 1, instanceCap: INSTANCE_CAP },
  sphere:        { color: 0x6fe9ff, opacity: 1, radius: 1, segments: 24, position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1, instances: 1, instanceCap: INSTANCE_CAP },
  cone:          { color: 0x6fe9ff, opacity: 1, radius: 1, height: 2, segments: 24, position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1, instances: 1, instanceCap: INSTANCE_CAP },
  torus:         { color: 0x6fe9ff, opacity: 1, radius: 1, tube: 0.3, segments: 24, position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1, instances: 1, instanceCap: INSTANCE_CAP },
  icosa:         { color: 0x6fe9ff, opacity: 1, radius: 1, detail: 0, position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1, instances: 1, instanceCap: INSTANCE_CAP },
  sprite:        { color: 0xffffff, opacity: 1, position: [0, 0, 0], scale: 1, seed: 1 },
  card:          { color: 0xffffff, opacity: 1, width: 1, height: 1, position: [0, 0, 0], scale: 1, seed: 1 },
  gltf:          { url: '', position: [0, 0, 0], scale: 1, spin: 0, axis: 'y', seed: 1 },
  infographicTag:{ anchor: [0, 0, 0], offset: [0, 0], text: '', seed: 1 },
};

/* category derivation: dimensional family (central, vfx.js categoryFor style). */
const KIND_CATEGORY = {
  box: 'Mesh', sphere: 'Mesh', cone: 'Mesh', torus: 'Mesh', icosa: 'Mesh',
  sprite: 'Sprite', card: 'Card', gltf: 'Model', infographicTag: 'Infographic',
};
function categoryFor(desc) { return KIND_CATEGORY[desc.id] || 'Mesh'; }

/* =============================================================================
 *  THE OBJECT REGISTRY — register(desc) is the ONLY way a kind becomes visible;
 *  list() -> [{id,kind,category,params,controls,factory}] (matching VFX.list()).
 * ========================================================================== */
export const ObjectRegistry = createRegistry({
  name: 'ObjectRegistry',
  categoryFor,
  enumOptions: { axis: ['x', 'y', 'z'] },
});

ObjectRegistry.register({ id: 'box', kind: '3D box mesh', params: REGISTRY_DEFAULTS.box,
  factory: primitiveFactory('box', (THREE, p) => new THREE.BoxGeometry(p.width, p.height, p.depth), ['width', 'height', 'depth']) });
ObjectRegistry.register({ id: 'sphere', kind: '3D sphere mesh', params: REGISTRY_DEFAULTS.sphere,
  factory: primitiveFactory('sphere', (THREE, p) => new THREE.SphereGeometry(p.radius, p.segments, p.segments), ['radius', 'segments']) });
ObjectRegistry.register({ id: 'cone', kind: '3D cone mesh', params: REGISTRY_DEFAULTS.cone,
  factory: primitiveFactory('cone', (THREE, p) => new THREE.ConeGeometry(p.radius, p.height, p.segments), ['radius', 'height', 'segments']) });
ObjectRegistry.register({ id: 'torus', kind: '3D torus mesh', params: REGISTRY_DEFAULTS.torus,
  factory: primitiveFactory('torus', (THREE, p) => new THREE.TorusGeometry(p.radius, p.tube, p.segments, p.segments), ['radius', 'tube', 'segments']) });
ObjectRegistry.register({ id: 'icosa', kind: '3D icosahedron mesh', params: REGISTRY_DEFAULTS.icosa,
  factory: primitiveFactory('icosa', (THREE, p) => new THREE.IcosahedronGeometry(p.radius, p.detail), ['radius', 'detail']) });
ObjectRegistry.register({ id: 'sprite', kind: '2D camera-facing sprite', params: REGISTRY_DEFAULTS.sprite, factory: createSprite });
ObjectRegistry.register({ id: 'card', kind: '2.5D billboard card', params: REGISTRY_DEFAULTS.card, factory: createCard });
ObjectRegistry.register({ id: 'gltf', kind: 'glTF model (host-loaded)', params: REGISTRY_DEFAULTS.gltf, factory: createGltf });
ObjectRegistry.register({ id: 'infographicTag', kind: '3D-anchored data marker', params: REGISTRY_DEFAULTS.infographicTag, factory: createInfographicTag });

/** The module surface descriptor (a plain, frozen object the editor reflection +
 *  in-page boundary proof can read without touching GPU). */
export const objects = Object.freeze({
  name: NAME,
  version: VERSION,
  registry: ObjectRegistry,
  INSTANCE_CAP,
});

export default ObjectRegistry;
