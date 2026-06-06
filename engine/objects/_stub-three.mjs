/* =============================================================================
 *  engine/objects/_stub-three.mjs  —  minimal stub THREE for the P2.3 pillar tests
 *
 *  A tiny, no-op THREE surface (mirroring the `prototype/vfx.smoke.mjs` fake THREE)
 *  the objects/scenes/dynamics tests inject as `host.THREE` to exercise the GPU
 *  BUILD path headlessly — constructors return disposable objects that never throw.
 *  This is a TEST FIXTURE (not part of the engine surface); it imports nothing
 *  app/vendor and is GPU-free.
 * ========================================================================== */

function makeVec3(x = 0, y = 0, z = 0) {
  return { x, y, z, isVector3: true,
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    copy(o) { if (o) { this.x = o.x; this.y = o.y; this.z = o.z; } return this; },
    lerpVectors() { return this; } };
}
function makeColor(r = 1, g = 1, b = 1) {
  return { r, g, b, isColor: true,
    set() { return this; },
    setRGB(a, c, d) { this.r = a; this.g = c; this.b = d; return this; } };
}

class Object3D {
  constructor() {
    this.children = []; this.visible = true; this.userData = {};
    this.position = makeVec3(); this.scale = makeVec3(1, 1, 1); this.rotation = makeVec3();
    this.parent = null; this.frustumCulled = true;
  }
  add(c) { this.children.push(c); if (c) c.parent = this; return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); if (c) c.parent = null; } return this; }
  lookAt() { return this; }
}
class Group extends Object3D {}
class Mesh extends Object3D { constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; } }
class Sprite extends Object3D { constructor(mat) { super(); this.material = mat; } }
class AmbientLight extends Object3D { constructor() { super(); this.color = makeColor(); this.intensity = 1; } }
class DirectionalLight extends Object3D { constructor() { super(); this.color = makeColor(); this.intensity = 1; } }

class BufferGeometry { constructor() { this.attributes = {}; this._disposed = false; } dispose() { this._disposed = true; } }
class BoxGeometry extends BufferGeometry {}
class SphereGeometry extends BufferGeometry {}
class ConeGeometry extends BufferGeometry {}
class TorusGeometry extends BufferGeometry {}
class IcosahedronGeometry extends BufferGeometry {}
class PlaneGeometry extends BufferGeometry {}

function makeColoredMaterial(extra = {}) {
  return Object.assign({
    color: makeColor(1, 1, 1), emissive: makeColor(0, 0, 0),
    transparent: false, opacity: 1, side: 0, _disposed: false,
    dispose() { this._disposed = true; },
  }, extra);
}
class MeshStandardMaterial { constructor() { return makeColoredMaterial(); } }
class MeshBasicMaterial { constructor() { return makeColoredMaterial(); } }
class SpriteMaterial { constructor() { return makeColoredMaterial(); } }

export function makeStubTHREE() {
  return {
    Object3D, Group, Mesh, Sprite, AmbientLight, DirectionalLight,
    BufferGeometry, BoxGeometry, SphereGeometry, ConeGeometry, TorusGeometry, IcosahedronGeometry, PlaneGeometry,
    MeshStandardMaterial, MeshBasicMaterial, SpriteMaterial,
    Vector3: function (x, y, z) { return makeVec3(x, y, z); },
    Color: function (r, g, b) { return makeColor(r, g, b); },
    DoubleSide: 2, FrontSide: 0, BackSide: 1,
  };
}

/** a host record with an injected stub THREE + camera (ready). */
export function makeStubHost(opts = {}) {
  const THREE = makeStubTHREE();
  return {
    THREE,
    ready: true,
    reduceMotion: !!opts.reduceMotion,
    camera: opts.camera || (function () {
      const c = { position: makeVec3(0, 0, 0), fov: 50, lookAt() {}, updateProjectionMatrix() {} };
      return c;
    })(),
    gltfLoader: opts.gltfLoader || { load(url, onLoad) { try { onLoad && onLoad({ scene: new Group() }); } catch { /* */ } } },
  };
}

export default makeStubTHREE;
