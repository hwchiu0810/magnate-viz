/* =============================================================================
 *  vfx.js  —  MAGNATE real-time VFX library  (Three.js r128 / classic GLOBAL THREE)
 * =============================================================================
 *
 *  WHAT THIS IS
 *  ------------
 *  A self-contained, dependency-injected real-time VFX toolkit for the Magnate
 *  "Economy City" prototype page. It is the runtime analogue of a motion-graphics
 *  pipeline (After Effects / Final Cut Pro): instead of baking compositing,
 *  color-grade, glow, glitch and camera FX into a video file, every effect is a
 *  live, parameterised, GPU-backed factory that the host render loop drives each
 *  frame. A UI can introspect the whole library via VFX.list() and build sliders
 *  for every documented knob.
 *
 *  PHASE 1 delivers:
 *    - the VFX CORE: the IIFE + window.VFX, init/dispose/reset, the single
 *      per-frame update(dt, elapsed) dispatcher, the effect REGISTRY backing
 *      VFX.list(), a shared resource POOL, headless / pre-init inert guards, and
 *      reduceMotion handling.
 *    - the POST / SCREEN family on VFX.post: a stack of guarded THREE.ShaderPass
 *      passes layered on the host EffectComposer (ordered, stackable, no-op if the
 *      composer is absent): color-grade / LUT, vignette, chromatic aberration,
 *      film grain, god rays (radial light scatter), depth-of-field (bokeh),
 *      glitch / RGB-shift, scanlines / CRT, lens flare, letterbox bars.
 *
 *  PHASE 2 adds (all via VFX.spawn(name, opts) -> handle):
 *    - GPU PARTICLES family (THREE.Points, pooled buffers, CAPPED counts):
 *        sparks, smoke, fire, embers, dust, magic, rain, confetti.
 *        Lifetime + emission-rate + gravity/drag + colour-over-life params; a
 *        shared point ShaderMaterial fades per-vertex colour*alpha over life;
 *        burst(n) for one-shots; per-particle sim writes pre-sized typed arrays in
 *        place (no per-frame allocation). Caps documented at the family header.
 *    - ENERGY / SCI-FI family (emissive line/mesh, sub-white clamped):
 *        beam (laser), lightning (jagged segment path, segment CAP 64),
 *        forceField (fresnel dome + impact ripple, burst() = ripple), portal
 *        (swirling disc), shockwave (expanding ring, burst() = replay),
 *        tractorBeam (cone + rising motes), materialize (assemble dissolve).
 *
 *  PHASE 3 adds:
 *    - MATERIAL family (VFX.material(mesh, name, opts) -> handle.restore()):
 *        dissolve / disintegrate (noise threshold + glowing burn edge), fresnel
 *        rim-glow, hologram (scanlines + flicker + fresnel, sub-white), iridescence
 *        (thin-film sheen), outline / toon (inverted-hull silhouette shell). The
 *        factory STORES mesh.material, swaps in a ShaderMaterial, and restore()
 *        (and dispose()) put the original back + free the swapped material.
 *    - INFOGRAPHIC family (VFX.infographic.<fn>(opts), the tech-ad / data-viz look):
 *        counter (animated number / odometer), callout (leader-line + dot + label
 *        on a 3D object), label (pill / lower-third), barChart, lineChart, ringChart,
 *        donutChart (draw-on charts), progressArc, gauge (KPI sweep), ticker (data
 *        marquee), tag (3D-anchored marker). TWO render paths: a projected DOM
 *        overlay (anchored to a world point via camera projection, guarded so it
 *        no-ops headless) AND in-scene canvas-texture sprites. View-only, motion-gated.
 *
 *  The mesh-attach family (VFX.attach) remains a stable, headless-safe stub so the
 *  API surface is complete from day one; it registers real factories in a later phase.
 *
 *  AE / FCP  ->  REAL-TIME MAPPING
 *  -------------------------------
 *    After Effects / FCP term          ->  VFX runtime equivalent
 *    ------------------------------------------------------------------
 *    Adjustment layer / effect stack   ->  VFX.post.enable(name, params)   (ordered ShaderPass stack)
 *    Lumetri / 3-way color / LUT       ->  VFX.post.enable('colorGrade')  + VFX.post.grade(THREE.Lut)
 *    Vignette                          ->  VFX.post.enable('vignette')
 *    CC RGB Split / chromatic aberr.   ->  VFX.post.enable('chromatic')
 *    Add Grain / Film                  ->  VFX.post.enable('filmGrain')
 *    Light rays / Volumetric / Trapcode->  VFX.post.enable('godRays')
 *    Camera Lens Blur / bokeh          ->  VFX.post.enable('dof')
 *    Glitch / Datamosh / Bad TV        ->  VFX.post.enable('glitch')
 *    Scan lines / Old TV / CRT         ->  VFX.post.enable('scanlines')
 *    Optical Flares / lens flare       ->  VFX.post.enable('lensFlare')
 *    Cinema bars / crop                ->  VFX.post.enable('letterbox')
 *    Particle emitter (CC Particle)    ->  VFX.spawn('sparks'|'smoke'|'fire'|...)   (GPU particles)
 *    Saber / energy beam / Optical FX  ->  VFX.spawn('beam'|'lightning'|'portal'|...) (energy / sci-fi)
 *    Layer style / dissolve / glow     ->  VFX.material(mesh, 'dissolve'|'fresnel'|'hologram'|...)
 *    Numeric counter / slider control  ->  VFX.infographic.counter(opts)   (DOM or sprite)
 *    Trim-path write-on / chart anim   ->  VFX.infographic.barChart|lineChart|ringChart|donutChart(opts)
 *    Lower-third title / callout       ->  VFX.infographic.label|callout|tag(opts)
 *    Radial progress / KPI gauge       ->  VFX.infographic.progressArc|gauge(opts)
 *    News / data ticker (marquee)      ->  VFX.infographic.ticker(opts)
 *    The comp playhead / timecode      ->  VFX.update(dt, elapsed)         (host render loop hook)
 *
 *  THE HOST CONTRACT  (dependency injection — nothing is assumed at load)
 *  ---------------------------------------------------------------------
 *    VFX.init({ THREE, renderer, scene, camera, composer, clock, reduceMotion })
 *      THREE       the global THREE r128 namespace (+ optional postprocessing globals:
 *                  THREE.ShaderPass / THREE.UnrealBloomPass / THREE.LuminosityHighPassShader /
 *                  THREE.FXAAShader / THREE.CopyShader / THREE.Lut). None are assumed to
 *                  exist; each is referenced lazily and guarded.
 *      renderer    the WebGLRenderer (already ACES tone-mapped by the host).
 *      scene       the active THREE.Scene.
 *      camera      the active camera.
 *      composer    the host EffectComposer the POST passes layer onto. If absent, the
 *                  whole POST family is a silent no-op.
 *      clock       optional THREE.Clock; if absent the dispatcher uses the dt/elapsed
 *                  the host passes to update().
 *      reduceMotion  honor prefers-reduced-motion: when true, update() is a no-op and
 *                  effects snap to a static resting frame (no animation advance).
 *
 *    BEFORE init (or if THREE / renderer / DOM are absent), EVERY entry point is an
 *    inert no-op that NEVER throws — the module is loaded in a Node smoke test with
 *    stubbed / absent globals. This is non-negotiable.
 *
 *  PUBLIC API  (stable)
 *  --------------------
 *    VFX.init(opts) / VFX.dispose() / VFX.reset()
 *    VFX.update(dt, elapsed)                  single per-frame hook; no-op when reduceMotion / headless
 *    VFX.post.enable(name, params)            add / re-show a screen pass (ordered, stackable)
 *    VFX.post.disable(name)                   hide / remove a screen pass
 *    VFX.post.set(name, params)               live-tune a pass's params
 *    VFX.post.grade(lut)                      load a THREE.Lut (or [r,g,b] ramp) into the colorGrade pass
 *    VFX.spawn(name, opts)   -> handle { update, setParams, burst?, dispose, group }
 *    VFX.attach(mesh, name, opts) -> handle    (attach dissolve/trail/etc to a mesh)
 *    VFX.material(mesh, name, opts) -> handle { ..., restore() }   (overlay shader material)
 *    VFX.infographic.<fn>(opts) -> handle      (motion-graphics)
 *    VFX.list() -> [{ name, family, category, kind, params, controls }]   complete, in-sync registry
 *                  (category + controls are ADDITIVE; params stays the flat default map)
 *    VFX.importQuarks(json, opts) -> particle handle   (map a three.quarks ParticleSystem JSON in)
 *    VFX.exportQuarks(handle)     -> three.quarks-shaped JSON   (best-effort, never throws)
 *
 *  COMPOSABLE + PARAMETERISED
 *  --------------------------
 *    Every effect is a factory returning { update(dt,t), setParams(p), dispose() }.
 *    Sensible defaults; every visual knob is a documented param (see each register()).
 *
 *  POOLED + BOUNDED (perf)
 *  -----------------------
 *    Shared geometries / materials live in the POOL and are ref-counted; full-screen
 *    passes reuse a single fragment-shader skeleton. Particle / segment counts are
 *    capped (documented per effect in later phases). dispose() frees GPU resources
 *    (geometry.dispose / material.dispose / texture.dispose) and detaches from parents.
 *    No per-frame allocation inside update() — uniforms are mutated in place.
 *
 *  DETERMINISTIC-SAFE
 *  ------------------
 *    Animation is driven from the injected clock / elapsed + dt, never wall-clock and
 *    never a global time-seeded RNG inside update math. Any randomness is seedable and
 *    instance-local (a small mulberry32 PRNG per effect) so a single frame is
 *    reproducible in a static headless render.
 *
 *  NO WHITE-OUT
 *  ------------
 *    Emissive / additive colours are clamped sub-white (max channel ~0.9) so they ride
 *    the host UnrealBloom + ACES tone-map without blowing out. The POST passes never
 *    push the composed image above the host's exposure; grade/grain/flare add at low
 *    gain and the final clamp keeps highlights under 1.0.
 *
 *  USAGE — per family
 *  ------------------
 *    // CORE: wire the host once, then drive it from the render loop.
 *    VFX.init({ THREE, renderer, scene, camera, composer, reduceMotion });
 *    function frame(dt, elapsed){ VFX.update(dt, elapsed); composer.render(); }
 *
 *    // POST / SCREEN: stack cinematic passes (ordered, live-tunable, headless-safe).
 *    VFX.post.enable('colorGrade', { exposure: 0.95, contrast: 1.05, saturation: 1.1 });
 *    VFX.post.grade(new THREE.Lut('cooltowarm', 64));
 *    VFX.post.enable('vignette',   { darkness: 0.9, offset: 1.1 });
 *    VFX.post.enable('chromatic',  { amount: 0.0016 });
 *    VFX.post.enable('filmGrain',  { intensity: 0.06 });
 *    VFX.post.enable('godRays',    { x: 0.5, y: 0.62, density: 0.92, weight: 0.35 });
 *    VFX.post.enable('dof',        { focus: 0.45, aperture: 0.018, maxBlur: 0.01 });
 *    VFX.post.enable('scanlines',  { count: 720, intensity: 0.18 });
 *    VFX.post.enable('letterbox',  { aspect: 2.39 });
 *    VFX.post.set('filmGrain', { intensity: 0.04 });   // live-tune
 *    VFX.post.disable('glitch');                        // remove a pass
 *
 *    // GPU PARTICLES (VFX.spawn): pooled THREE.Points, capped, colour-over-life.
 *    const sm = VFX.spawn('smoke', { origin: [0, 2, 0], rate: 30 });  // continuous plume
 *    const sp = VFX.spawn('sparks', { origin: [1, 0.5, 0] });  sp.burst(40);  // one-shot
 *    const cf = VFX.spawn('confetti', { origin: [0, 3, 0] });  cf.burst(150);
 *    sm.setParams({ rate: 10 });  sm.dispose();
 *
 *    // ENERGY / SCI-FI (VFX.spawn): emissive, sub-white, host-bloom-friendly.
 *    const beam = VFX.spawn('beam', { from: [0,0,0], to: [0,6,0], color: 0x6fe9ff });
 *    const ff   = VFX.spawn('forceField', { origin: [0,0,0], radius: 3 });  ff.burst(0,3,0); // ripple
 *    const sw   = VFX.spawn('shockwave', { origin: [0,0,0], maxRadius: 8 });  sw.burst();    // replay
 *    const pg   = VFX.spawn('portal', { origin: [0,2,-4], radius: 1.5 });
 *
 *    // MATERIAL (VFX.material): swap a shader material onto a mesh; restore() undoes it.
 *    const holo = VFX.material(mesh, 'hologram', { color: 0x6fe9ff, opacity: 0.7 });
 *    const dis  = VFX.material(mesh, 'dissolve', { duration: 1.2, color: 0xff7a1a }); dis.burst();
 *    const rim  = VFX.material(mesh, 'fresnel',  { color: 0x6fe9ff, power: 2.5 });
 *    holo.restore();   // put the original material back (dispose() also restores + frees)
 *
 *    // INFOGRAPHIC (VFX.infographic.<fn>): tech-ad / data-viz motion graphics (view-only).
 *    const c  = VFX.infographic.counter({ from: 0, to: 1000, duration: 2, world: [0,3,0] });
 *    const co = VFX.infographic.callout({ world: [2,1,0], text: 'ACME Corp', offset: [70,-50] });
 *    const lb = VFX.infographic.label({ text: 'Q3 Output', sub: '+12.4%', world: [0,4,0] });
 *    const bc = VFX.infographic.barChart({ data: [3,7,4,9,6,8], position: [0,2,0], layer: 'sprite' });
 *    const ga = VFX.infographic.gauge({ value: 0.82, label: 'OEE', position: [0,2,0] });
 *    const tk = VFX.infographic.ticker({ text: 'STEEL +1.2%   POWER -0.4%   ...', speed: 60 });
 *    c.setParams({ to: 2500 });   // retarget the counter; charts/gauges take { value } / { data }
 *
 *    // ATTACH (later phase — stable stub today):
 *    const a = VFX.attach(mesh, 'trail', { length: 24 });
 *
 *  HARD CONSTRAINT: no import/require, no ES-module syntax, no network. The file is a
 *  single IIFE that attaches window.VFX (falling back to globalThis).
 * ========================================================================== */
(function () {
  'use strict';

  /* ---- resolve a global "root" without assuming a browser ---- */
  var root =
    (typeof window !== 'undefined' && window) ||
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof self !== 'undefined' && self) ||
    {};

  /* =========================================================================
   *  HOST STATE  — populated by init(), cleared by dispose().
   *  Before init everything is null/false so every entry point can early-out.
   * ====================================================================== */
  var H = {
    THREE: null,
    renderer: null,
    scene: null,
    camera: null,
    composer: null,
    clock: null,
    reduceMotion: false,
    ready: false,            // true only after a successful init() with a usable THREE
    width: 1280,
    height: 720,
    pixelRatio: 1
  };

  /* live effect instances driven by update(). Keyed for the POST family by name;
     emitter/attach/material/infographic handles live in a flat list. */
  var liveEffects = [];      // [{ update(dt,t), dispose(), _tag }]
  var postStack = [];        // ordered POST passes [{ name, pass, fx, params }]

  /* =========================================================================
   *  THE REGISTRY  — the single source of truth backing VFX.list().
   *  Every implemented effect registers a descriptor here. Adding a family =
   *  registering more descriptors; VFX.list() stays complete + in sync.
   *  descriptor: { name, family, category, kind, params, factory }
   *    name    unique string id
   *    family  'post' | 'emitter' | 'attach' | 'material' | 'infographic'
   *    category  stable UI category string for grouping widgets, one of
   *              'Post' | 'Particles' | 'Energy' | 'Material' | 'Infographic'.
   *              Derived centrally (see categoryFor) — NOT hand-set per descriptor:
   *              family 'post'->Post, 'material'->Material, 'infographic'->Infographic,
   *              and family 'emitter' SPLIT by name into 'Particles' (sparks/smoke/fire/
   *              embers/dust/magic/rain/confetti) vs 'Energy' (beam/lightning/forceField/
   *              portal/shockwave/tractorBeam/materialize). An explicit desc.category
   *              overrides the derivation if ever supplied.
   *    kind    short human label of the visual
   *    params  default param object (the documented knobs)
   *    factory (host) -> creates the live effect; may be null for stub families
   * ====================================================================== */
  var REGISTRY = Object.create(null);

  /* the emitter names that are GPU particle systems (everything else in the
     'emitter' family is an Energy / sci-fi effect). Used to split the category. */
  var PARTICLE_EMITTERS = {
    sparks: 1, smoke: 1, fire: 1, embers: 1, dust: 1, magic: 1, rain: 1, confetti: 1
  };

  /* Derive the stable UI category from family + name. Central so adding effects
     needs no per-descriptor category edits. */
  function categoryFor(family, name) {
    switch (family) {
      case 'post': return 'Post';
      case 'material': return 'Material';
      case 'infographic': return 'Infographic';
      case 'emitter':
        return PARTICLE_EMITTERS[name] ? 'Particles' : 'Energy';
      default:
        return 'Post';
    }
  }

  function register(desc) {
    if (!desc || !desc.name) return;
    var family = desc.family || 'post';
    REGISTRY[desc.name] = {
      name: desc.name,
      family: family,
      category: desc.category || categoryFor(family, desc.name),
      kind: desc.kind || '',
      params: desc.params || {},
      factory: desc.factory || null
    };
  }

  /* =========================================================================
   *  SHARED RESOURCE POOL  — ref-counted GPU resources so effects share a single
   *  full-screen geometry / texture rather than allocating per instance.
   *  acquire(key, build) -> resource (built once, refcount++)
   *  release(key)        -> refcount--; dispose()'d at zero.
   * ====================================================================== */
  var POOL = {
    _map: Object.create(null),
    acquire: function (key, build) {
      var e = this._map[key];
      if (!e) {
        var res = null;
        try { res = build(); } catch (_) { res = null; }
        e = this._map[key] = { res: res, refs: 0 };
      }
      e.refs++;
      return e.res;
    },
    release: function (key) {
      var e = this._map[key];
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) {
        disposeResource(e.res);
        delete this._map[key];
      }
    },
    clear: function () {
      for (var k in this._map) {
        if (Object.prototype.hasOwnProperty.call(this._map, k)) {
          disposeResource(this._map[k].res);
        }
      }
      this._map = Object.create(null);
    }
  };

  /* deep-dispose anything THREE-ish without assuming methods exist. */
  function disposeResource(r) {
    if (!r) return;
    try {
      if (typeof r.dispose === 'function') r.dispose();
      if (r.geometry && typeof r.geometry.dispose === 'function') r.geometry.dispose();
      if (r.material) disposeMaterial(r.material);
      if (r.texture && typeof r.texture.dispose === 'function') r.texture.dispose();
    } catch (_) { /* headless-safe */ }
  }
  function disposeMaterial(m) {
    if (!m) return;
    try {
      if (Array.isArray(m)) { for (var i = 0; i < m.length; i++) disposeMaterial(m[i]); return; }
      // free common map slots
      var slots = ['map', 'tDiffuse', 'tColor', 'lutTexture', 'emissiveMap', 'alphaMap'];
      for (var s = 0; s < slots.length; s++) {
        var tx = m[slots[s]];
        if (tx && typeof tx.dispose === 'function') tx.dispose();
      }
      if (m.uniforms) {
        for (var u in m.uniforms) {
          var v = m.uniforms[u] && m.uniforms[u].value;
          if (v && typeof v.dispose === 'function') { try { v.dispose(); } catch (_) {} }
        }
      }
      if (typeof m.dispose === 'function') m.dispose();
    } catch (_) { /* headless-safe */ }
  }

  /* =========================================================================
   *  SMALL UTILITIES — all headless-safe (never throw on missing THREE).
   * ====================================================================== */

  /* mulberry32: tiny seedable PRNG so any per-instance randomness is reproducible. */
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* merge defaults <- overrides into a fresh object (no shared mutation). */
  function withDefaults(defaults, over) {
    var out = {};
    var k;
    for (k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = defaults[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    return out;
  }

  /* NO WHITE-OUT clamp: keep an emissive/additive colour's max channel <= cap (~0.9)
     so it rides the host bloom + ACES tone-map without blowing out. Operates on a
     plain {r,g,b} or a THREE.Color (in place if .setRGB exists). */
  var WHITE_CAP = 0.9;
  function clampSubWhite(col, cap) {
    cap = (typeof cap === 'number') ? cap : WHITE_CAP;
    var r = col.r, g = col.g, b = col.b;
    var mx = Math.max(r, g, b);
    if (mx > cap && mx > 0) {
      var s = cap / mx;
      r *= s; g *= s; b *= s;
    }
    if (typeof col.setRGB === 'function') col.setRGB(r, g, b);
    else { col.r = r; col.g = g; col.b = b; }
    return col;
  }

  /* is THREE usable for building real GPU objects? */
  function haveTHREE() { return !!(H.ready && H.THREE); }
  /* is the POST family wireable (THREE + composer + ShaderPass present)? */
  function havePost() {
    return !!(haveTHREE() && H.composer && typeof H.THREE.ShaderPass === 'function');
  }

  /* current viewport size (kept fresh on init / via set). */
  function viewW() { return H.width || 1280; }
  function viewH() { return H.height || 720; }

  /* =========================================================================
   *  POST / SCREEN family — full-screen ShaderPass effects.
   *
   *  Each is a factory that builds ONE THREE.ShaderPass with a tiny GLSL fragment
   *  shader operating on tDiffuse (the previous composed frame). The factory
   *  returns { pass, update(dt,t), setParams(p), dispose() }. Uniforms are mutated
   *  in place in update()/setParams() — zero per-frame allocation.
   *
   *  All passes:
   *    - read `tDiffuse` (the composer's working buffer),
   *    - keep additions sub-white (final clamp on the colour they output),
   *    - degrade to a transparent no-op pass under reduceMotion for time-based FX
   *      (they snap to a static resting frame: time freezes, the look stays).
   * ====================================================================== */

  /* Build a ShaderPass from a fragment body. Returns the pass or null (guarded). */
  function makeScreenPass(fragShader, uniforms) {
    if (!havePost()) return null;
    var THREE = H.THREE;
    var shaderDef = {
      uniforms: withDefaults({ tDiffuse: { value: null } }, null),
      vertexShader:
        'varying vec2 vUv;\n' +
        'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: fragShader
    };
    // copy provided uniforms onto the shader def (objects with {value})
    for (var u in uniforms) {
      if (Object.prototype.hasOwnProperty.call(uniforms, u)) shaderDef.uniforms[u] = uniforms[u];
    }
    var pass = null;
    try {
      pass = new THREE.ShaderPass(shaderDef);
      // ShaderPass usually names the input "tDiffuse"; r128 honors this.
      if (pass) pass.needsSwap = true;
    } catch (_) { pass = null; }
    return pass;
  }

  /* helper to read a uniform value safely. */
  function uval(pass, name) {
    return pass && pass.material && pass.material.uniforms && pass.material.uniforms[name];
  }
  function setU(pass, name, v) {
    var u = uval(pass, name);
    if (u) u.value = v;
  }

  /* ----- shared GLSL snippets (string constants — not per-frame) ----- */
  var GLSL_HEAD = 'varying vec2 vUv;\nuniform sampler2D tDiffuse;\n';

  /* -------------------------------------------------------------------------
   *  colorGrade / LUT  —  exposure / contrast / saturation / lift-gamma-gain,
   *  plus an optional LUT (loaded via VFX.post.grade). Mirrors the host THREE.Lut
   *  style: a 1D ramp texture sampled by luminance.
   *
   *  PARAMS: exposure(0.95) contrast(1.0) saturation(1.0) tint([1,1,1])
   *          lutMix(0) lutSize(1)
   * --------------------------------------------------------------------- */
  function buildColorGrade(params) {
    var p = withDefaults(REGISTRY.colorGrade.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float exposure;\nuniform float contrast;\nuniform float saturation;\n' +
      'uniform vec3 tint;\nuniform float lutMix;\nuniform sampler2D lut;\nuniform float lutSize;\n' +
      'void main(){\n' +
      '  vec4 c = texture2D(tDiffuse, vUv);\n' +
      '  vec3 col = c.rgb * exposure * tint;\n' +
      '  col = (col - 0.5) * contrast + 0.5;\n' +
      '  float l = dot(col, vec3(0.2126,0.7152,0.0722));\n' +
      '  col = mix(vec3(l), col, saturation);\n' +
      '  if (lutMix > 0.001 && lutSize > 1.5){\n' +
      '    float gl = clamp(dot(clamp(col,0.0,1.0), vec3(0.2126,0.7152,0.0722)), 0.0, 1.0);\n' +
      '    vec3 g = texture2D(lut, vec2(gl, 0.5)).rgb;\n' +
      '    col = mix(col, g, lutMix);\n' +
      '  }\n' +
      '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);\n' +
      '}',
      {
        exposure: { value: p.exposure },
        contrast: { value: p.contrast },
        saturation: { value: p.saturation },
        tint: { value: vec3(p.tint) },
        lutMix: { value: p.lutMix },
        lut: { value: null },
        lutSize: { value: p.lutSize }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      setU(pass, 'exposure', np.exposure);
      setU(pass, 'contrast', np.contrast);
      setU(pass, 'saturation', np.saturation);
      if (np.tint) { var t = uval(pass, 'tint'); if (t && t.value && t.value.set) t.value.set(np.tint[0], np.tint[1], np.tint[2]); }
      if (typeof np.lutMix === 'number') setU(pass, 'lutMix', np.lutMix);
    });
  }

  /* -------------------------------------------------------------------------
   *  vignette  —  radial darkening to focus the centre (AE Vignette).
   *  PARAMS: darkness(0.9) offset(1.1) roundness(1.0)
   * --------------------------------------------------------------------- */
  function buildVignette(params) {
    var p = withDefaults(REGISTRY.vignette.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float darkness;\nuniform float offset;\nuniform float roundness;\n' +
      'void main(){\n' +
      '  vec4 c = texture2D(tDiffuse, vUv);\n' +
      '  vec2 uv = (vUv - 0.5) * vec2(offset);\n' +
      '  uv.x *= roundness;\n' +
      '  float d = dot(uv, uv);\n' +
      '  float v = smoothstep(0.8, 0.0, d);\n' +
      '  v = mix(1.0, v, clamp(darkness, 0.0, 1.0));\n' +
      '  gl_FragColor = vec4(c.rgb * v, c.a);\n' +
      '}',
      {
        darkness: { value: p.darkness },
        offset: { value: p.offset },
        roundness: { value: p.roundness }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      setU(pass, 'darkness', np.darkness);
      setU(pass, 'offset', np.offset);
      setU(pass, 'roundness', np.roundness);
    });
  }

  /* -------------------------------------------------------------------------
   *  chromatic  —  RGB-split chromatic aberration radiating from centre.
   *  PARAMS: amount(0.0016) radial(1.0)
   * --------------------------------------------------------------------- */
  function buildChromatic(params) {
    var p = withDefaults(REGISTRY.chromatic.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float amount;\nuniform float radial;\n' +
      'void main(){\n' +
      '  vec2 dir = (vUv - 0.5);\n' +
      '  float r2 = dot(dir, dir);\n' +
      '  vec2 off = dir * amount * (1.0 + radial * r2 * 4.0);\n' +
      '  float cr = texture2D(tDiffuse, vUv + off).r;\n' +
      '  vec4 cg = texture2D(tDiffuse, vUv);\n' +
      '  float cb = texture2D(tDiffuse, vUv - off).b;\n' +
      '  gl_FragColor = vec4(cr, cg.g, cb, cg.a);\n' +
      '}',
      {
        amount: { value: p.amount },
        radial: { value: p.radial }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      setU(pass, 'amount', np.amount);
      setU(pass, 'radial', np.radial);
    });
  }

  /* -------------------------------------------------------------------------
   *  filmGrain  —  animated luminance noise (AE Add Grain). Time-driven; under
   *  reduceMotion the time uniform freezes (static grain frame).
   *  PARAMS: intensity(0.06) speed(1.0) size(1.0)
   * --------------------------------------------------------------------- */
  function buildFilmGrain(params) {
    var p = withDefaults(REGISTRY.filmGrain.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float intensity;\nuniform float time;\nuniform float size;\n' +
      'float hash(vec2 q){ return fract(sin(dot(q, vec2(12.9898,78.233))) * 43758.5453); }\n' +
      'void main(){\n' +
      '  vec4 c = texture2D(tDiffuse, vUv);\n' +
      '  float n = hash(vUv * (size * 512.0) + time) - 0.5;\n' +
      '  gl_FragColor = vec4(clamp(c.rgb + n * intensity, 0.0, 1.0), c.a);\n' +
      '}',
      {
        intensity: { value: p.intensity },
        time: { value: 0 },
        size: { value: p.size }
      }
    );
    var w = wrapPass(pass, p, function (pass, np) {
      setU(pass, 'intensity', np.intensity);
      setU(pass, 'size', np.size);
    });
    w.timeDriven = true; w.speed = p.speed;
    w.update = function (dt, t) {
      if (!pass || H.reduceMotion) return;            // snap: freeze grain phase
      var u = uval(pass, 'time'); if (u) u.value = (t || 0) * (w.speed || 1.0);
    };
    return w;
  }

  /* -------------------------------------------------------------------------
   *  godRays  —  radial light-scatter / volumetric rays from a screen-space sun.
   *  A cheap single-pass radial blur toward (x,y), masked to bright pixels so it
   *  rides the host bloom. PARAMS: x(0.5) y(0.65) density(0.92) weight(0.35)
   *  decay(0.95) exposure(0.5) samples(48 capped at 64) threshold(0.55)
   * --------------------------------------------------------------------- */
  function buildGodRays(params) {
    var p = withDefaults(REGISTRY.godRays.params, params);
    var SAMP = Math.max(8, Math.min(64, Math.floor(p.samples)));   // CAP: 64 samples
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform vec2 sun;\nuniform float density;\nuniform float weight;\n' +
      'uniform float decay;\nuniform float exposure;\nuniform float threshold;\n' +
      'const int SAMPLES = ' + SAMP + ';\n' +
      'void main(){\n' +
      '  vec2 uv = vUv;\n' +
      '  vec2 delta = (uv - sun) * (density / float(SAMPLES));\n' +
      '  float illum = 1.0;\n' +
      '  vec3 acc = vec3(0.0);\n' +
      '  for (int i = 0; i < SAMPLES; i++){\n' +
      '    uv -= delta;\n' +
      '    vec3 s = texture2D(tDiffuse, uv).rgb;\n' +
      '    float lum = dot(s, vec3(0.2126,0.7152,0.0722));\n' +
      '    s *= step(threshold, lum);\n' +
      '    acc += s * illum * weight;\n' +
      '    illum *= decay;\n' +
      '  }\n' +
      '  vec4 base = texture2D(tDiffuse, vUv);\n' +
      '  vec3 rays = acc * exposure;\n' +
      '  gl_FragColor = vec4(clamp(base.rgb + rays, 0.0, 0.95), base.a);\n' +   // sub-white clamp
      '}',
      {
        sun: { value: vec2(p.x, p.y) },
        density: { value: p.density },
        weight: { value: p.weight },
        decay: { value: p.decay },
        exposure: { value: p.exposure },
        threshold: { value: p.threshold }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      var s = uval(pass, 'sun'); if (s && s.value && s.value.set) s.value.set(np.x, np.y);
      setU(pass, 'density', np.density);
      setU(pass, 'weight', np.weight);
      setU(pass, 'decay', np.decay);
      setU(pass, 'exposure', np.exposure);
      setU(pass, 'threshold', np.threshold);
    });
  }

  /* -------------------------------------------------------------------------
   *  dof  —  cheap depth-of-field / bokeh approximation (a centred-focus radial
   *  blur; without a depth buffer it blurs by distance from a focus band).
   *  PARAMS: focus(0.5) aperture(0.015) maxBlur(0.01)
   * --------------------------------------------------------------------- */
  function buildDof(params) {
    var p = withDefaults(REGISTRY.dof.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform vec2 texel;\nuniform float focus;\nuniform float aperture;\nuniform float maxBlur;\n' +
      'void main(){\n' +
      '  float d = abs(vUv.y - focus);\n' +
      '  float blur = clamp(d * aperture * 60.0, 0.0, maxBlur);\n' +
      '  vec4 sum = vec4(0.0);\n' +
      '  sum += texture2D(tDiffuse, vUv);\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2( blur,  0.0));\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2(-blur,  0.0));\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2( 0.0,  blur));\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2( 0.0, -blur));\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2( blur,  blur)) * 0.7071;\n' +
      '  sum += texture2D(tDiffuse, vUv + vec2(-blur, -blur)) * 0.7071;\n' +
      '  gl_FragColor = sum / (5.0 + 1.4142);\n' +
      '}',
      {
        texel: { value: vec2(1 / viewW(), 1 / viewH()) },
        focus: { value: p.focus },
        aperture: { value: p.aperture },
        maxBlur: { value: p.maxBlur }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      setU(pass, 'focus', np.focus);
      setU(pass, 'aperture', np.aperture);
      setU(pass, 'maxBlur', np.maxBlur);
    });
  }

  /* -------------------------------------------------------------------------
   *  glitch  —  RGB-shift + block displacement + scanline jump (AE Bad TV).
   *  Time-driven; under reduceMotion it freezes to a single static glitch frame.
   *  PARAMS: amount(0.4) speed(1.0) blockiness(0.5) colorShift(0.004)
   * --------------------------------------------------------------------- */
  function buildGlitch(params) {
    var p = withDefaults(REGISTRY.glitch.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float amount;\nuniform float time;\nuniform float blockiness;\nuniform float colorShift;\n' +
      'float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }\n' +
      'void main(){\n' +
      '  float t = time;\n' +
      '  float band = floor(vUv.y * mix(8.0, 48.0, blockiness));\n' +
      '  float jump = (rand(vec2(band, floor(t*10.0))) - 0.5) * amount * 0.06;\n' +
      '  vec2 uv = vUv; uv.x += jump;\n' +
      '  float cs = colorShift * (0.5 + amount);\n' +
      '  float r = texture2D(tDiffuse, uv + vec2(cs, 0.0)).r;\n' +
      '  vec4 g = texture2D(tDiffuse, uv);\n' +
      '  float b = texture2D(tDiffuse, uv - vec2(cs, 0.0)).b;\n' +
      '  gl_FragColor = vec4(r, g.g, b, g.a);\n' +
      '}',
      {
        amount: { value: p.amount },
        time: { value: 0 },
        blockiness: { value: p.blockiness },
        colorShift: { value: p.colorShift }
      }
    );
    var w = wrapPass(pass, p, function (pass, np) {
      setU(pass, 'amount', np.amount);
      setU(pass, 'blockiness', np.blockiness);
      setU(pass, 'colorShift', np.colorShift);
    });
    w.timeDriven = true; w.speed = p.speed;
    w.update = function (dt, t) {
      if (!pass || H.reduceMotion) return;            // snap: freeze glitch frame
      var u = uval(pass, 'time'); if (u) u.value = (t || 0) * (w.speed || 1.0);
    };
    return w;
  }

  /* -------------------------------------------------------------------------
   *  scanlines  —  CRT scanlines + subtle barrel + rolling brightness (Old TV).
   *  Roll is time-driven; under reduceMotion the roll freezes (static scanlines).
   *  PARAMS: count(720) intensity(0.18) curvature(0.06) speed(1.0)
   * --------------------------------------------------------------------- */
  function buildScanlines(params) {
    var p = withDefaults(REGISTRY.scanlines.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float count;\nuniform float intensity;\nuniform float curvature;\nuniform float time;\n' +
      'void main(){\n' +
      '  vec2 uv = vUv;\n' +
      '  vec2 cc = uv - 0.5;\n' +
      '  float dist = dot(cc, cc) * curvature;\n' +
      '  uv = uv + cc * dist;\n' +
      '  vec4 c = texture2D(tDiffuse, uv);\n' +
      '  float s = sin((uv.y + time * 0.05) * count * 3.14159);\n' +
      '  float scan = 1.0 - intensity * (0.5 + 0.5 * s) * 0.5;\n' +
      '  float edge = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? 0.0 : 1.0;\n' +
      '  gl_FragColor = vec4(c.rgb * scan * edge, c.a);\n' +
      '}',
      {
        count: { value: p.count },
        intensity: { value: p.intensity },
        curvature: { value: p.curvature },
        time: { value: 0 }
      }
    );
    var w = wrapPass(pass, p, function (pass, np) {
      setU(pass, 'count', np.count);
      setU(pass, 'intensity', np.intensity);
      setU(pass, 'curvature', np.curvature);
    });
    w.timeDriven = true; w.speed = p.speed;
    w.update = function (dt, t) {
      if (!pass || H.reduceMotion) return;            // snap: freeze roll
      var u = uval(pass, 'time'); if (u) u.value = (t || 0) * (w.speed || 1.0);
    };
    return w;
  }

  /* -------------------------------------------------------------------------
   *  lensFlare  —  screen-space anamorphic flare/ghosts from a light position
   *  (Optical Flares). Additive, sub-white capped so it rides bloom.
   *  PARAMS: x(0.5) y(0.5) intensity(0.5) ghosts(4 capped at 8) halo(0.4)
   *          tint([0.55,0.78,0.9])
   * --------------------------------------------------------------------- */
  function buildLensFlare(params) {
    var p = withDefaults(REGISTRY.lensFlare.params, params);
    var GH = Math.max(0, Math.min(8, Math.floor(p.ghosts)));     // CAP: 8 ghosts
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform vec2 light;\nuniform float intensity;\nuniform float halo;\nuniform vec3 tint;\n' +
      'const int GHOSTS = ' + GH + ';\n' +
      'void main(){\n' +
      '  vec4 base = texture2D(tDiffuse, vUv);\n' +
      '  vec2 uv = vUv - light;\n' +
      '  float dist = length(uv);\n' +
      '  vec3 flare = vec3(0.0);\n' +
      '  vec2 ghostVec = -uv * 0.35;\n' +
      '  for (int i = 0; i < GHOSTS; i++){\n' +
      '    vec2 gp = uv + ghostVec * float(i);\n' +
      '    float g = max(0.0, 1.0 - length(gp) * 3.0);\n' +
      '    flare += vec3(g * g) * tint * (0.4 / (float(i) + 1.0));\n' +
      '  }\n' +
      '  float h = max(0.0, 1.0 - abs(dist - halo) * 6.0);\n' +
      '  flare += vec3(h * h) * tint * 0.5;\n' +
      '  flare += vec3(max(0.0, 1.0 - dist * 5.0)) * tint;\n' +
      '  gl_FragColor = vec4(clamp(base.rgb + flare * intensity, 0.0, 0.9), base.a);\n' +  // sub-white clamp
      '}',
      {
        light: { value: vec2(p.x, p.y) },
        intensity: { value: p.intensity },
        halo: { value: p.halo },
        tint: { value: vec3(p.tint) }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      var l = uval(pass, 'light'); if (l && l.value && l.value.set) l.value.set(np.x, np.y);
      setU(pass, 'intensity', np.intensity);
      setU(pass, 'halo', np.halo);
      if (np.tint) { var t = uval(pass, 'tint'); if (t && t.value && t.value.set) t.value.set(np.tint[0], np.tint[1], np.tint[2]); }
    });
  }

  /* -------------------------------------------------------------------------
   *  letterbox  —  cinematic crop bars to a target aspect (AE crop / cinema bars).
   *  PARAMS: aspect(2.39) softness(0.002) color([0,0,0])
   * --------------------------------------------------------------------- */
  function buildLetterbox(params) {
    var p = withDefaults(REGISTRY.letterbox.params, params);
    var pass = makeScreenPass(
      GLSL_HEAD +
      'uniform float barH;\nuniform float softness;\nuniform vec3 barColor;\n' +
      'void main(){\n' +
      '  vec4 c = texture2D(tDiffuse, vUv);\n' +
      '  float top = smoothstep(barH - softness, barH + softness, vUv.y);\n' +
      '  float bot = smoothstep(barH - softness, barH + softness, 1.0 - vUv.y);\n' +
      '  float mask = top * bot;\n' +
      '  gl_FragColor = vec4(mix(barColor, c.rgb, mask), c.a);\n' +
      '}',
      {
        barH: { value: barHeightFor(p.aspect) },
        softness: { value: p.softness },
        barColor: { value: vec3(p.color) }
      }
    );
    return wrapPass(pass, p, function (pass, np) {
      if (typeof np.aspect === 'number') setU(pass, 'barH', barHeightFor(np.aspect));
      setU(pass, 'softness', np.softness);
      if (np.color) { var c = uval(pass, 'barColor'); if (c && c.value && c.value.set) c.value.set(np.color[0], np.color[1], np.color[2]); }
    });
  }
  /* fraction of frame height each bar occupies to reach target aspect. */
  function barHeightFor(targetAspect) {
    var srcAspect = viewW() / viewH();
    if (!isFinite(targetAspect) || targetAspect <= srcAspect) return 0.0;
    return clamp((1 - srcAspect / targetAspect) * 0.5, 0, 0.45);
  }

  /* small THREE.Vector2/3 builders, headless-safe (fall back to plain {x,y[,z],set}). */
  function vec2(a, b) {
    var x = (a != null) ? a : 0, y = (b != null) ? b : 0;
    if (haveTHREE() && H.THREE.Vector2) { try { return new H.THREE.Vector2(x, y); } catch (_) {} }
    return { x: x, y: y, set: function (px, py) { this.x = px; this.y = py; return this; } };
  }
  function vec3(arr) {
    var x = 0, y = 0, z = 0;
    if (Array.isArray(arr)) { x = arr[0] || 0; y = arr[1] || 0; z = arr[2] || 0; }
    if (haveTHREE() && H.THREE.Vector3) { try { return new H.THREE.Vector3(x, y, z); } catch (_) {} }
    return { x: x, y: y, z: z, set: function (px, py, pz) { this.x = px; this.y = py; this.z = pz; return this; } };
  }
  /* Vector3 from explicit components (headless-safe). */
  function vec3xyz(x, y, z) { return vec3([x || 0, y || 0, z || 0]); }

  /* THREE.Color builder, headless-safe. Accepts a hex number, [r,g,b] (0..1) or {r,g,b}.
     Always returns sub-white-clamped so emissive/additive colours ride bloom+ACES. */
  function colorOf(c, cap) {
    var THREE = haveTHREE() ? H.THREE : null;
    var col;
    if (THREE && THREE.Color) {
      try {
        if (typeof c === 'number') col = new THREE.Color(c);
        else if (Array.isArray(c)) col = new THREE.Color(c[0] || 0, c[1] || 0, c[2] || 0);
        else if (c && c.isColor) col = c;
        else if (c && typeof c.r === 'number') col = new THREE.Color(c.r, c.g, c.b);
        else col = new THREE.Color(1, 1, 1);
      } catch (_) { col = null; }
    }
    if (!col) {
      // plain fallback object
      if (typeof c === 'number') { col = { r: ((c >> 16) & 255) / 255, g: ((c >> 8) & 255) / 255, b: (c & 255) / 255 }; }
      else if (Array.isArray(c)) { col = { r: c[0] || 0, g: c[1] || 0, b: c[2] || 0 }; }
      else if (c && typeof c.r === 'number') { col = { r: c.r, g: c.g, b: c.b }; }
      else col = { r: 1, g: 1, b: 1 };
      col.setRGB = function (r, g, b) { this.r = r; this.g = g; this.b = b; return this; };
    }
    return clampSubWhite(col, cap);
  }

  /* additive-blending enum with the host's guarded fallback (matches the HTML). */
  function additiveBlend() {
    var THREE = haveTHREE() ? H.THREE : null;
    return (THREE && THREE.AdditiveBlending !== undefined) ? THREE.AdditiveBlending : 2;
  }
  function doubleSide() {
    var THREE = haveTHREE() ? H.THREE : null;
    return (THREE && THREE.DoubleSide !== undefined) ? THREE.DoubleSide : 2;
  }
  function backSide() {
    var THREE = haveTHREE() ? H.THREE : null;
    return (THREE && THREE.BackSide !== undefined) ? THREE.BackSide : 1;
  }

  /* Wrap a built ShaderPass into the standard effect interface. */
  function wrapPass(pass, params, applyFn) {
    var current = params;
    var disposed = false;
    var fx = {
      pass: pass,
      params: current,
      timeDriven: false,
      speed: 1.0,
      /* default update: static passes do nothing per-frame. time-driven passes
         override .update (see filmGrain/glitch/scanlines). */
      update: function (/*dt, t*/) {},
      setParams: function (np) {
        if (disposed || !pass) return;
        current = withDefaults(current, np);
        fx.params = current;
        try { applyFn(pass, current); } catch (_) {}
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (pass) {
          try { if (pass.material) disposeMaterial(pass.material); } catch (_) {}
          try { if (pass.fsQuad && pass.fsQuad.dispose) pass.fsQuad.dispose(); } catch (_) {}
          try { if (typeof pass.dispose === 'function') pass.dispose(); } catch (_) {}
        }
      }
    };
    return fx;
  }

  /* =========================================================================
   *  REGISTER the POST family. params = the documented default knobs.
   * ====================================================================== */
  register({ name: 'colorGrade', family: 'post', kind: 'Color grade / LUT (Lumetri)',
    params: { exposure: 0.95, contrast: 1.0, saturation: 1.0, tint: [1, 1, 1], lutMix: 0, lutSize: 1 },
    factory: buildColorGrade });
  register({ name: 'vignette', family: 'post', kind: 'Radial vignette',
    params: { darkness: 0.9, offset: 1.1, roundness: 1.0 },
    factory: buildVignette });
  register({ name: 'chromatic', family: 'post', kind: 'Chromatic aberration / RGB split',
    params: { amount: 0.0016, radial: 1.0 },
    factory: buildChromatic });
  register({ name: 'filmGrain', family: 'post', kind: 'Animated film grain',
    params: { intensity: 0.06, speed: 1.0, size: 1.0 },
    factory: buildFilmGrain });
  register({ name: 'godRays', family: 'post', kind: 'God rays / radial light scatter',
    params: { x: 0.5, y: 0.65, density: 0.92, weight: 0.35, decay: 0.95, exposure: 0.5, threshold: 0.55, samples: 48 },
    factory: buildGodRays });
  register({ name: 'dof', family: 'post', kind: 'Depth-of-field / bokeh',
    params: { focus: 0.5, aperture: 0.015, maxBlur: 0.01 },
    factory: buildDof });
  register({ name: 'glitch', family: 'post', kind: 'Glitch / RGB-shift (Bad TV)',
    params: { amount: 0.4, speed: 1.0, blockiness: 0.5, colorShift: 0.004 },
    factory: buildGlitch });
  register({ name: 'scanlines', family: 'post', kind: 'Scanlines / CRT',
    params: { count: 720, intensity: 0.18, curvature: 0.06, speed: 1.0 },
    factory: buildScanlines });
  register({ name: 'lensFlare', family: 'post', kind: 'Lens flare / optical flares',
    params: { x: 0.5, y: 0.5, intensity: 0.5, ghosts: 4, halo: 0.4, tint: [0.55, 0.78, 0.9] },
    factory: buildLensFlare });
  register({ name: 'letterbox', family: 'post', kind: 'Cinematic letterbox bars',
    params: { aspect: 2.39, softness: 0.002, color: [0, 0, 0] },
    factory: buildLetterbox });

  /* =========================================================================
   *  THE POST API  — ordered, stackable, headless-safe. No-op if composer absent.
   *
   *  Ordering: passes render in the order they were enabled, AFTER any pre-existing
   *  host passes (RenderPass + UnrealBloom + FXAA). enable() inserts before a final
   *  renderToScreen pass when one is detected, so the host's last pass stays last;
   *  otherwise it appends. disable() removes the pass from both the composer and the
   *  internal stack and disposes it.
   * ====================================================================== */

  function findPostEntry(name) {
    for (var i = 0; i < postStack.length; i++) if (postStack[i].name === name) return postStack[i];
    return null;
  }

  /* Insert a pass into the host composer, keeping a trailing renderToScreen pass last. */
  function composerInsert(pass) {
    var comp = H.composer;
    if (!comp || !pass) return;
    if (typeof comp.insertPass === 'function' && Array.isArray(comp.passes)) {
      // keep the last renderToScreen pass (FXAA / bloom) at the end
      var idx = comp.passes.length;
      for (var i = comp.passes.length - 1; i >= 0; i--) {
        if (comp.passes[i] && comp.passes[i].renderToScreen) { idx = i; }
        else break;
      }
      try { comp.insertPass(pass, idx); return; } catch (_) {}
    }
    if (typeof comp.addPass === 'function') { try { comp.addPass(pass); } catch (_) {} }
  }
  function composerRemove(pass) {
    var comp = H.composer;
    if (!comp || !pass) return;
    if (typeof comp.removePass === 'function') { try { comp.removePass(pass); return; } catch (_) {} }
    if (Array.isArray(comp.passes)) {
      var i = comp.passes.indexOf(pass);
      if (i >= 0) comp.passes.splice(i, 1);
    }
  }

  var postAPI = {
    /**
     * Enable (or re-show) a POST pass on the host composer.
     * @param {string} name  one of the registered post effects (see VFX.list()).
     * @param {object} [params] knob overrides; merged over the effect's defaults.
     * @returns {object|null} the effect handle, or null when headless / no composer.
     */
    enable: function (name, params) {
      if (!havePost()) return null;
      var desc = REGISTRY[name];
      if (!desc || desc.family !== 'post' || typeof desc.factory !== 'function') return null;
      var existing = findPostEntry(name);
      if (existing) {                 // already enabled -> just tune + ensure visible
        if (params) existing.fx.setParams(params);
        if (existing.fx.pass) existing.fx.pass.enabled = true;
        return existing.fx;
      }
      var fx = null;
      try { fx = desc.factory(params); } catch (_) { fx = null; }
      if (!fx || !fx.pass) return null;
      composerInsert(fx.pass);
      var entry = { name: name, pass: fx.pass, fx: fx, params: fx.params };
      postStack.push(entry);
      if (fx.timeDriven) liveEffects.push(fx);     // only time-driven passes need per-frame ticks
      return fx;
    },

    /**
     * Disable (remove + dispose) a POST pass.
     * @param {string} name
     */
    disable: function (name) {
      var entry = findPostEntry(name);
      if (!entry) return;
      composerRemove(entry.pass);
      var li = liveEffects.indexOf(entry.fx);
      if (li >= 0) liveEffects.splice(li, 1);
      try { entry.fx.dispose(); } catch (_) {}
      var si = postStack.indexOf(entry);
      if (si >= 0) postStack.splice(si, 1);
    },

    /**
     * Live-tune an enabled POST pass.
     * @param {string} name
     * @param {object} params
     */
    set: function (name, params) {
      var entry = findPostEntry(name);
      if (!entry) return;
      try { entry.fx.setParams(params); } catch (_) {}
    },

    /**
     * Load a colour LUT into the colorGrade pass (auto-enables colorGrade if needed).
     * Accepts a THREE.Lut, a THREE.Texture/DataTexture, or an array of [r,g,b] stops
     * (0..1) that is rasterised into a 1xN DataTexture. Mirrors the host THREE.Lut style.
     * @param {THREE.Lut|THREE.Texture|Array} lut
     * @param {number} [mix=1] blend amount 0..1.
     */
    grade: function (lut, mix) {
      if (!havePost()) return;
      var entry = findPostEntry('colorGrade');
      if (!entry) { postAPI.enable('colorGrade'); entry = findPostEntry('colorGrade'); }
      if (!entry || !entry.fx || !entry.fx.pass) return;
      var tex = lutToTexture(lut);
      var pass = entry.fx.pass;
      var size = lutSizeOf(lut, tex);
      setU(pass, 'lut', tex);
      setU(pass, 'lutSize', size);
      setU(pass, 'lutMix', (typeof mix === 'number') ? clamp(mix, 0, 1) : 1.0);
    }
  };

  /* turn a THREE.Lut / Texture / [r,g,b] ramp into a sampleable 1D texture. */
  function lutToTexture(lut) {
    if (!haveTHREE() || !lut) return null;
    var THREE = H.THREE;
    // THREE.Lut exposes createTexture() in r128
    if (typeof lut.createTexture === 'function') {
      try { return lut.createTexture(); } catch (_) {}
    }
    // already a texture-like
    if (lut.isTexture || lut.isDataTexture || (lut.image && lut.needsUpdate !== undefined)) return lut;
    // array of [r,g,b] stops -> DataTexture
    if (Array.isArray(lut) && lut.length > 1 && THREE.DataTexture) {
      try {
        var n = lut.length;
        var data = new Uint8Array(n * 4);
        for (var i = 0; i < n; i++) {
          var c = lut[i] || [0, 0, 0];
          data[i * 4 + 0] = clamp(Math.round((c[0] || 0) * 255), 0, 255);
          data[i * 4 + 1] = clamp(Math.round((c[1] || 0) * 255), 0, 255);
          data[i * 4 + 2] = clamp(Math.round((c[2] || 0) * 255), 0, 255);
          data[i * 4 + 3] = 255;
        }
        var fmt = (THREE.RGBAFormat !== undefined) ? THREE.RGBAFormat : 1023;
        var t = new THREE.DataTexture(data, n, 1, fmt);
        t.needsUpdate = true;
        return t;
      } catch (_) { return null; }
    }
    return null;
  }
  function lutSizeOf(lut, tex) {
    if (Array.isArray(lut)) return lut.length;
    if (lut && lut.lut && lut.lut.length) return lut.lut.length;
    if (tex && tex.image && tex.image.width) return tex.image.width;
    return 64;
  }

  /* =========================================================================
   *  GPU PARTICLES family  (VFX.spawn) — THREE.Points clouds with CPU-side
   *  per-particle simulation written into shared, pre-sized typed-array buffers.
   *
   *  AE / FCP mapping: CC Particle World / Trapcode Particular emitters.
   *
   *  DESIGN
   *  ------
   *    - One THREE.Points per emitter, backed by a BufferGeometry whose
   *      position(3) + color(3) + psize(1) + alpha(1) attributes are sized ONCE to
   *      the particle CAP. update() rewrites those arrays in place (no per-frame
   *      allocation) and flips needsUpdate. A tiny ShaderMaterial multiplies each
   *      point's per-vertex colour by its per-vertex alpha so particles fade over
   *      life; gl_PointSize uses the per-vertex psize / view distance.
   *    - Continuous emission at `rate` particles/sec (fractional carry), plus
   *      burst(n) for one-shots. Dead particles are recycled (a freelist over the
   *      same buffer), so the cap is a hard ceiling — never exceeded.
   *    - Simulation: per-particle position/velocity, gravity, linear drag, size
   *      and colour interpolated start->end over normalised life. Spawn jitter and
   *      initial velocity come from an instance-local seedable PRNG so a static
   *      headless frame is reproducible. update() advances ALL particles from the
   *      injected dt — never wall-clock.
   *    - reduceMotion: the dispatcher already freezes update(); additionally each
   *      emitter primes a static "resting" frame at spawn (a single deterministic
   *      fill at t=0) so the look is present without motion.
   *
   *  PERF CAPS (documented):
   *    sparks 400 · smoke 300 · fire 450 · embers 350 · dust 600 · magic 500 ·
   *    rain 1200 · confetti 500. `max` param overrides but is itself clamped to
   *    PARTICLE_HARD_CAP (2000) so a single emitter can't blow the budget.
   *
   *  COMMON PARAMS (every emitter):
   *    max(cap)            hard particle ceiling for this emitter
   *    rate(n/sec)         continuous emission rate (0 = burst-only)
   *    life([min,max] s)   per-particle lifetime range
   *    size([start,end])   point size in world units (interpolated over life)
   *    gravity([x,y,z])    constant acceleration (world units/s^2)
   *    drag(0..~2 /s)      linear velocity damping
   *    speed(scalar)       initial speed multiplier
   *    spread(0..1)        emission cone / scatter
   *    color / color2      start / end colour (hex | [r,g,b]); sub-white clamped
   *    origin([x,y,z])     emitter position (the returned group is also movable)
   *    seed(int)           PRNG seed for reproducible spawns
   *  Per-emitter extras are documented at each register() call.
   * ====================================================================== */

  var PARTICLE_HARD_CAP = 2000;

  /* shared point shader: size attenuation + per-vertex colour * alpha. Sub-white
     is enforced on the CPU side (colours are clamped before upload). */
  var POINT_VERT =
    'attribute float psize;\nattribute float alpha;\n' +
    'varying vec3 vColor;\nvarying float vAlpha;\n' +
    'uniform float uScale;\n' +
    'void main(){\n' +
    '  vColor = color; vAlpha = alpha;\n' +
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
    '  gl_PointSize = psize * uScale * (300.0 / max(-mv.z, 0.001));\n' +
    '  gl_Position = projectionMatrix * mv;\n' +
    '}';
  var POINT_FRAG =
    'varying vec3 vColor;\nvarying float vAlpha;\n' +
    'uniform float uSoft;\n' +
    'void main(){\n' +
    '  vec2 d = gl_PointCoord - vec2(0.5);\n' +
    '  float r = length(d);\n' +
    '  if (r > 0.5) discard;\n' +
    '  float a = vAlpha * smoothstep(0.5, 0.5 - uSoft, r);\n' +
    '  gl_FragColor = vec4(min(vColor, vec3(0.9)), a);\n' +   // sub-white clamp
    '}';

  /**
   * Core particle-system factory. All eight emitters configure THIS via a `spec`
   * (caps, blending, soft-edge, and an init(pp,rng) hook that seeds a fresh
   * particle's velocity/colour/life). Returns the standard handle plus burst().
   */
  function makeParticles(spec, opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    if (typeof THREE.Points !== 'function' || typeof THREE.BufferGeometry !== 'function' ||
        typeof THREE.BufferAttribute !== 'function') return null;

    var d = spec.defaults;
    var p = withDefaults(d, opts);
    var cap = Math.max(1, Math.min(PARTICLE_HARD_CAP, Math.floor(p.max || d.max)));
    var rng = makeRng((p.seed != null ? p.seed : (spec.seed || 1)) | 0);

    // pre-sized buffers (allocated ONCE).
    var N = cap;
    var posArr = new Float32Array(N * 3);
    var colArr = new Float32Array(N * 3);
    var sizArr = new Float32Array(N);
    var alpArr = new Float32Array(N);

    // per-particle sim state (typed arrays, allocated once — no per-frame alloc).
    var velX = new Float32Array(N), velY = new Float32Array(N), velZ = new Float32Array(N);
    var ageArr = new Float32Array(N);     // seconds lived
    var lifeArr = new Float32Array(N);    // total lifetime (0 = dead)
    var sSize = new Float32Array(N), eSize = new Float32Array(N);
    var sCol = new Float32Array(N * 3), eCol = new Float32Array(N * 3);

    var geo = new THREE.BufferGeometry();
    var posAttr = new THREE.BufferAttribute(posArr, 3);
    var colAttr = new THREE.BufferAttribute(colArr, 3);
    var sizAttr = new THREE.BufferAttribute(sizArr, 1);
    var alpAttr = new THREE.BufferAttribute(alpArr, 1);
    try { posAttr.setUsage && posAttr.setUsage(THREE.DynamicDrawUsage || 35048); } catch (_) {}
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setAttribute('psize', sizAttr);
    geo.setAttribute('alpha', alpAttr);
    try { geo.setDrawRange && geo.setDrawRange(0, N); } catch (_) {}

    var mat = null;
    try {
      mat = new THREE.ShaderMaterial({
        uniforms: { uScale: { value: p.sizeScale || 1.0 }, uSoft: { value: spec.soft != null ? spec.soft : 0.35 } },
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: spec.additive ? additiveBlend() : (THREE.NormalBlending !== undefined ? THREE.NormalBlending : 1),
        vertexColors: true
      });
    } catch (_) { mat = null; }
    if (!mat) { try { geo.dispose(); } catch (_) {} return null; }

    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;

    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    group.add(points);
    if (H.scene && typeof H.scene.add === 'function') { try { H.scene.add(group); } catch (_) {} }

    var startCol = colorOf(p.color, 0.9);
    var endCol = colorOf(p.color2 != null ? p.color2 : p.color, 0.9);
    var gx = (p.gravity && p.gravity[0]) || 0, gy = (p.gravity && p.gravity[1]) || 0, gz = (p.gravity && p.gravity[2]) || 0;

    var emitCarry = 0;     // fractional emission accumulator
    var disposed = false;

    function spawnOne() {
      // find a dead slot (linear scan over cap; cap is small + bounded).
      var idx = -1;
      for (var i = 0; i < N; i++) { if (lifeArr[i] <= 0) { idx = i; break; } }
      if (idx < 0) return;   // at cap: drop (hard ceiling, never exceeded)
      var pp = SCRATCH;
      pp.idx = idx;
      pp.px = 0; pp.py = 0; pp.pz = 0;
      pp.vx = 0; pp.vy = 0; pp.vz = 0;
      var lmin = (p.life && p.life[0]) || 1, lmax = (p.life && p.life[1]) || lmin;
      pp.life = lmin + rng() * Math.max(0, lmax - lmin);
      pp.s0 = (p.size && p.size[0]) || 1; pp.s1 = (p.size && p.size[1] != null) ? p.size[1] : pp.s0;
      pp.sr = startCol.r; pp.sg = startCol.g; pp.sb = startCol.b;
      pp.er = endCol.r; pp.eg = endCol.g; pp.eb = endCol.b;
      // emitter-specific seeding
      try { spec.init(pp, rng, p); } catch (_) {}
      // commit
      posArr[idx * 3] = pp.px; posArr[idx * 3 + 1] = pp.py; posArr[idx * 3 + 2] = pp.pz;
      velX[idx] = pp.vx * (p.speed || 1); velY[idx] = pp.vy * (p.speed || 1); velZ[idx] = pp.vz * (p.speed || 1);
      lifeArr[idx] = pp.life; ageArr[idx] = 0;
      sSize[idx] = pp.s0; eSize[idx] = pp.s1;
      sCol[idx * 3] = pp.sr; sCol[idx * 3 + 1] = pp.sg; sCol[idx * 3 + 2] = pp.sb;
      eCol[idx * 3] = pp.er; eCol[idx * 3 + 1] = pp.eg; eCol[idx * 3 + 2] = pp.eb;
      // prime its rendered attributes for t=0 (so a static frame already shows it)
      writeParticle(idx, 0);
    }

    function writeParticle(idx, ageNorm) {
      var sz = sSize[idx] + (eSize[idx] - sSize[idx]) * ageNorm;
      sizArr[idx] = sz;
      var i3 = idx * 3;
      colArr[i3] = sCol[i3] + (eCol[i3] - sCol[i3]) * ageNorm;
      colArr[i3 + 1] = sCol[i3 + 1] + (eCol[i3 + 1] - sCol[i3 + 1]) * ageNorm;
      colArr[i3 + 2] = sCol[i3 + 2] + (eCol[i3 + 2] - sCol[i3 + 2]) * ageNorm;
      // alpha curve: quick fade-in, long fade-out (bell weighted to the start).
      var fade = spec.fade ? spec.fade(ageNorm) : (ageNorm < 0.12 ? ageNorm / 0.12 : 1.0 - (ageNorm - 0.12) / 0.88);
      alpArr[idx] = clamp(fade, 0, 1) * (p.opacity != null ? p.opacity : 1);
    }

    function killParticle(idx) {
      lifeArr[idx] = 0;
      alpArr[idx] = 0;
      // park offscreen-ish (size 0 + alpha 0 already hides it)
      sizArr[idx] = 0;
    }

    function burst(n) {
      n = Math.max(0, Math.floor(n != null ? n : (p.burst || 20)));
      for (var i = 0; i < n; i++) spawnOne();
      flagDirty();
    }

    function flagDirty() {
      posAttr.needsUpdate = true; colAttr.needsUpdate = true;
      sizAttr.needsUpdate = true; alpAttr.needsUpdate = true;
    }

    // prime a static resting frame: a deterministic burst so reduceMotion/headless
    // shows particles without any motion advance.
    var primeN = Math.min(N, Math.floor((p.rate || 0) * ((p.life && p.life[1]) || 1) * 0.5) || (p.burst || 0));
    if (p.prime !== false && primeN > 0) burst(primeN);

    var handle = {
      group: group,
      points: points,
      burst: burst,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        var d2 = (typeof dt === 'number' && dt > 0) ? Math.min(dt, 0.05) : 0;  // clamp huge frames
        // continuous emission
        if (p.rate > 0 && d2 > 0) {
          emitCarry += p.rate * d2;
          var toEmit = Math.floor(emitCarry);
          emitCarry -= toEmit;
          for (var e = 0; e < toEmit; e++) spawnOne();
        }
        var drag = (p.drag || 0);
        var dampF = drag > 0 ? Math.max(0, 1 - drag * d2) : 1;
        for (var i = 0; i < N; i++) {
          if (lifeArr[i] <= 0) continue;
          ageArr[i] += d2;
          if (ageArr[i] >= lifeArr[i]) { killParticle(i); continue; }
          // integrate
          velX[i] = velX[i] * dampF + gx * d2;
          velY[i] = velY[i] * dampF + gy * d2;
          velZ[i] = velZ[i] * dampF + gz * d2;
          var i3 = i * 3;
          posArr[i3] += velX[i] * d2;
          posArr[i3 + 1] += velY[i] * d2;
          posArr[i3 + 2] += velZ[i] * d2;
          writeParticle(i, ageArr[i] / lifeArr[i]);
        }
        flagDirty();
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.rate != null) p.rate = np.rate;
        if (np.drag != null) p.drag = np.drag;
        if (np.opacity != null) p.opacity = np.opacity;
        if (np.gravity) { gx = np.gravity[0] || 0; gy = np.gravity[1] || 0; gz = np.gravity[2] || 0; }
        if (np.sizeScale != null && mat.uniforms.uScale) mat.uniforms.uScale.value = np.sizeScale;
        if (np.color != null) startCol = colorOf(np.color, 0.9);
        if (np.color2 != null) endCol = colorOf(np.color2, 0.9);
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        try { group.remove(points); } catch (_) {}
        try { geo.dispose(); } catch (_) {}
        try { disposeMaterial(mat); } catch (_) {}
      }
    };
    return handle;
  }

  /* a single reusable scratch object for spawnOne (avoids per-spawn allocation). */
  var SCRATCH = { idx: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 1, s1: 1, sr: 1, sg: 1, sb: 1, er: 1, eg: 1, eb: 1 };

  /* helpers to seed a unit-ish random direction from the instance PRNG. */
  function randCone(pp, rng, spread, up) {
    // direction biased toward +up axis, widening with spread (0..1).
    var theta = rng() * Math.PI * 2;
    var phi = (rng() * spread) * (Math.PI * 0.5);
    var s = Math.sin(phi);
    var dirx = Math.cos(theta) * s;
    var dirz = Math.sin(theta) * s;
    var diry = Math.cos(phi);
    if (up === 'y') { pp.vx = dirx; pp.vy = diry; pp.vz = dirz; }
    else if (up === '-y') { pp.vx = dirx; pp.vy = -diry; pp.vz = dirz; }
    else { pp.vx = dirx; pp.vy = diry; pp.vz = dirz; }
  }
  function randSphere(pp, rng) {
    var u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pp.vx = r * Math.cos(th); pp.vy = u; pp.vz = r * Math.sin(th);
  }

  /* ---- the eight emitter specs ---- */

  function buildSparks(opts) {
    return makeParticles({
      additive: true, soft: 0.25, seed: 7,
      defaults: { max: 400, rate: 0, burst: 30, life: [0.3, 0.8], size: [0.18, 0.02],
        gravity: [0, -9.8, 0], drag: 0.6, speed: 6, spread: 1.0,
        color: [0.9, 0.7, 0.25], color2: [0.7, 0.15, 0.02], origin: [0, 0, 0], sizeScale: 1 },
      init: function (pp, rng, p) {
        randSphere(pp, rng);
        pp.vy = Math.abs(pp.vy) * 0.6 + 0.4;     // bias up
        var j = 0.03;
        pp.px = (rng() - 0.5) * j; pp.py = (rng() - 0.5) * j; pp.pz = (rng() - 0.5) * j;
      }
    }, opts);
  }

  function buildSmoke(opts) {
    return makeParticles({
      additive: false, soft: 0.6, seed: 11,
      defaults: { max: 300, rate: 24, burst: 0, life: [1.6, 3.2], size: [0.4, 2.4],
        gravity: [0, 0.4, 0], drag: 0.5, speed: 0.6, spread: 0.5,
        color: [0.32, 0.33, 0.35], color2: [0.12, 0.12, 0.13], origin: [0, 0, 0], opacity: 0.55, sizeScale: 1 },
      fade: function (a) { return a < 0.2 ? a / 0.2 * 0.8 : 0.8 * (1 - (a - 0.2) / 0.8); },
      init: function (pp, rng) {
        randCone(pp, rng, 0.5, 'y');
        var j = 0.25;
        pp.px = (rng() - 0.5) * j; pp.pz = (rng() - 0.5) * j; pp.py = 0;
        pp.vx *= 0.4; pp.vz *= 0.4;
      }
    }, opts);
  }

  function buildFire(opts) {
    return makeParticles({
      additive: true, soft: 0.45, seed: 13,
      defaults: { max: 450, rate: 90, burst: 0, life: [0.5, 1.1], size: [0.5, 0.05],
        gravity: [0, 2.6, 0], drag: 0.8, speed: 0.8, spread: 0.35,
        color: [0.9, 0.55, 0.12], color2: [0.55, 0.05, 0.02], origin: [0, 0, 0], opacity: 0.85, sizeScale: 1 },
      fade: function (a) { return a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / 0.9; },
      init: function (pp, rng) {
        randCone(pp, rng, 0.35, 'y');
        var j = 0.18;
        pp.px = (rng() - 0.5) * j; pp.pz = (rng() - 0.5) * j; pp.py = 0;
        pp.vx *= 0.5; pp.vz *= 0.5;
      }
    }, opts);
  }

  function buildEmbers(opts) {
    return makeParticles({
      additive: true, soft: 0.3, seed: 17,
      defaults: { max: 350, rate: 30, burst: 0, life: [1.4, 3.0], size: [0.12, 0.03],
        gravity: [0, 1.4, 0], drag: 0.3, speed: 0.7, spread: 0.6,
        color: [0.9, 0.5, 0.15], color2: [0.6, 0.12, 0.03], origin: [0, 0, 0], opacity: 0.9, sizeScale: 1 },
      init: function (pp, rng) {
        randCone(pp, rng, 0.6, 'y');
        var j = 0.4;
        pp.px = (rng() - 0.5) * j; pp.pz = (rng() - 0.5) * j; pp.py = 0;
      }
    }, opts);
  }

  function buildDust(opts) {
    return makeParticles({
      additive: false, soft: 0.5, seed: 19,
      defaults: { max: 600, rate: 40, burst: 0, life: [3.0, 7.0], size: [0.05, 0.05],
        gravity: [0, -0.04, 0], drag: 0.1, speed: 0.25, spread: 1.0,
        color: [0.6, 0.6, 0.62], color2: [0.55, 0.55, 0.58], origin: [0, 0, 0], opacity: 0.28, sizeScale: 1, area: 6 },
      fade: function (a) { return Math.sin(a * Math.PI) * 0.9; },
      init: function (pp, rng, p) {
        randSphere(pp, rng);
        var A = p.area || 6;
        pp.px = (rng() - 0.5) * A; pp.py = rng() * A * 0.5; pp.pz = (rng() - 0.5) * A;
      }
    }, opts);
  }

  function buildMagic(opts) {
    return makeParticles({
      additive: true, soft: 0.2, seed: 23,
      defaults: { max: 500, rate: 60, burst: 0, life: [1.0, 2.2], size: [0.16, 0.02],
        gravity: [0, 0.6, 0], drag: 0.4, speed: 0.6, spread: 1.0,
        color: [0.5, 0.85, 0.9], color2: [0.55, 0.4, 0.85], origin: [0, 0, 0], opacity: 0.9, sizeScale: 1, radius: 0.8, swirl: 2.0 },
      fade: function (a) { return Math.sin(a * Math.PI); },
      init: function (pp, rng, p) {
        // spawn on a swirling ring around origin
        var ang = rng() * Math.PI * 2, rr = (p.radius || 0.8) * (0.6 + rng() * 0.4);
        pp.px = Math.cos(ang) * rr; pp.pz = Math.sin(ang) * rr; pp.py = (rng() - 0.5) * 0.2;
        var sw = (p.swirl || 2.0);
        pp.vx = -Math.sin(ang) * sw * rr; pp.vz = Math.cos(ang) * sw * rr; pp.vy = 0.3 + rng() * 0.6;
      }
    }, opts);
  }

  function buildRain(opts) {
    return makeParticles({
      additive: false, soft: 0.1, seed: 29,
      defaults: { max: 1200, rate: 600, burst: 0, life: [0.6, 1.0], size: [0.04, 0.04],
        gravity: [0, -30, 0], drag: 0, speed: 1, spread: 0,
        color: [0.55, 0.62, 0.72], color2: [0.5, 0.58, 0.7], origin: [0, 0, 0], opacity: 0.5, sizeScale: 1, area: 14, height: 12 },
      fade: function (a) { return a < 0.9 ? 1 : (1 - a) / 0.1; },
      init: function (pp, rng, p) {
        var A = p.area || 14;
        pp.px = (rng() - 0.5) * A; pp.pz = (rng() - 0.5) * A; pp.py = (p.height || 12) * (0.5 + rng() * 0.5);
        pp.vx = 0; pp.vy = -10 - rng() * 6; pp.vz = 0;
      }
    }, opts);
  }

  function buildConfetti(opts) {
    return makeParticles({
      additive: false, soft: 0.05, seed: 31,
      defaults: { max: 500, rate: 0, burst: 120, life: [1.6, 3.0], size: [0.16, 0.16],
        gravity: [0, -3.2, 0], drag: 0.8, speed: 6, spread: 1.0,
        color: [0.85, 0.3, 0.4], color2: [0.3, 0.55, 0.85], origin: [0, 0, 0], opacity: 0.95, sizeScale: 1, palette: true },
      fade: function (a) { return a < 0.05 ? a / 0.05 : (a > 0.85 ? (1 - a) / 0.15 : 1); },
      init: function (pp, rng) {
        randCone(pp, rng, 1.0, 'y');
        pp.vy = Math.abs(pp.vy) * 0.7 + 0.6;
        // random festive palette per piece (sub-white)
        var palette = [[0.85, 0.3, 0.4], [0.3, 0.55, 0.85], [0.85, 0.75, 0.25], [0.4, 0.8, 0.45], [0.7, 0.4, 0.8]];
        var c = palette[(rng() * palette.length) | 0];
        pp.sr = c[0]; pp.sg = c[1]; pp.sb = c[2]; pp.er = c[0]; pp.eg = c[1]; pp.eb = c[2];
        var j = 0.06; pp.px = (rng() - 0.5) * j; pp.py = (rng() - 0.5) * j; pp.pz = (rng() - 0.5) * j;
      }
    }, opts);
  }

  /* register the GPU PARTICLES family (family 'emitter' so VFX.spawn finds them). */
  register({ name: 'sparks', family: 'emitter', kind: 'Sparks (additive, gravity)',
    params: { max: 400, rate: 0, burst: 30, life: [0.3, 0.8], size: [0.18, 0.02], gravity: [0, -9.8, 0], drag: 0.6, speed: 6, spread: 1.0, color: [0.9, 0.7, 0.25], color2: [0.7, 0.15, 0.02], origin: [0, 0, 0] },
    factory: buildSparks });
  register({ name: 'smoke', family: 'emitter', kind: 'Smoke plume (soft, rising)',
    params: { max: 300, rate: 24, life: [1.6, 3.2], size: [0.4, 2.4], gravity: [0, 0.4, 0], drag: 0.5, speed: 0.6, spread: 0.5, color: [0.32, 0.33, 0.35], color2: [0.12, 0.12, 0.13], opacity: 0.55, origin: [0, 0, 0] },
    factory: buildSmoke });
  register({ name: 'fire', family: 'emitter', kind: 'Fire (additive flame column)',
    params: { max: 450, rate: 90, life: [0.5, 1.1], size: [0.5, 0.05], gravity: [0, 2.6, 0], drag: 0.8, speed: 0.8, spread: 0.35, color: [0.9, 0.55, 0.12], color2: [0.55, 0.05, 0.02], opacity: 0.85, origin: [0, 0, 0] },
    factory: buildFire });
  register({ name: 'embers', family: 'emitter', kind: 'Embers (drifting hot motes)',
    params: { max: 350, rate: 30, life: [1.4, 3.0], size: [0.12, 0.03], gravity: [0, 1.4, 0], drag: 0.3, speed: 0.7, spread: 0.6, color: [0.9, 0.5, 0.15], color2: [0.6, 0.12, 0.03], opacity: 0.9, origin: [0, 0, 0] },
    factory: buildEmbers });
  register({ name: 'dust', family: 'emitter', kind: 'Dust motes (ambient float)',
    params: { max: 600, rate: 40, life: [3.0, 7.0], size: [0.05, 0.05], gravity: [0, -0.04, 0], drag: 0.1, speed: 0.25, spread: 1.0, color: [0.6, 0.6, 0.62], color2: [0.55, 0.55, 0.58], opacity: 0.28, area: 6, origin: [0, 0, 0] },
    factory: buildDust });
  register({ name: 'magic', family: 'emitter', kind: 'Magic sparkles (swirling ring)',
    params: { max: 500, rate: 60, life: [1.0, 2.2], size: [0.16, 0.02], gravity: [0, 0.6, 0], drag: 0.4, speed: 0.6, spread: 1.0, color: [0.5, 0.85, 0.9], color2: [0.55, 0.4, 0.85], opacity: 0.9, radius: 0.8, swirl: 2.0, origin: [0, 0, 0] },
    factory: buildMagic });
  register({ name: 'rain', family: 'emitter', kind: 'Rain (falling streaks)',
    params: { max: 1200, rate: 600, life: [0.6, 1.0], size: [0.04, 0.04], gravity: [0, -30, 0], drag: 0, speed: 1, spread: 0, color: [0.55, 0.62, 0.72], color2: [0.5, 0.58, 0.7], opacity: 0.5, area: 14, height: 12, origin: [0, 0, 0] },
    factory: buildRain });
  register({ name: 'confetti', family: 'emitter', kind: 'Confetti burst (festive palette)',
    params: { max: 500, rate: 0, burst: 120, life: [1.6, 3.0], size: [0.16, 0.16], gravity: [0, -3.2, 0], drag: 0.8, speed: 6, spread: 1.0, color: [0.85, 0.3, 0.4], color2: [0.3, 0.55, 0.85], opacity: 0.95, origin: [0, 0, 0] },
    factory: buildConfetti });

  /* =========================================================================
   *  ENERGY / SCI-FI family  (VFX.spawn) — emissive line/mesh effects. All
   *  emissive colours are sub-white clamped (max channel ~0.9) so they ride the
   *  host UnrealBloom + ACES tone-map without blowing out.
   *
   *  AE / FCP mapping: Saber / Optical Flares / energy-beam plugins.
   *
   *  Effects: beam, lightning, forceField, portal, shockwave, tractorBeam,
   *  materialize. Each returns the standard handle { update, setParams, dispose,
   *  group } (+ burst() where a one-shot makes sense). World-space — the returned
   *  group is positioned at `origin`/`from` and is freely re-parentable.
   *
   *  PERF CAPS: lightning segment count capped at 64; tractor-beam motes capped at
   *  PARTICLE_HARD_CAP via the particle core. Geometries/materials are per-instance
   *  (these are singletons, not pooled) and freed in dispose().
   * ====================================================================== */

  /* small additive emissive material (no lighting; rides bloom). */
  function emissiveMat(colorHex, opacity, blend) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var col = colorOf(colorHex, 0.9);
    var Ctor = THREE.MeshBasicMaterial || THREE.MeshStandardMaterial;
    try {
      var m = new Ctor({});
      if (m.color && m.color.copy) m.color.copy(col); else if (m.color && m.color.set) m.color.set(col.r, col.g, col.b);
      if (m.emissive && m.emissive.copy) { m.emissive.copy(col); m.emissiveIntensity = 1; }
      m.transparent = true;
      m.opacity = (opacity != null) ? opacity : 1;
      m.depthWrite = false;
      m.blending = (blend === false) ? (THREE.NormalBlending || 1) : additiveBlend();
      if ('side' in m) m.side = doubleSide();
      return m;
    } catch (_) { return null; }
  }

  /* -------------------------------------------------------------------------
   *  beam / laser  —  an emissive cylinder from `from` to `to` with a soft glow
   *  sheath + animated energy pulse along its length.
   *  PARAMS: from([x,y,z]) to([x,y,z]) radius(0.06) color(0x6fe9ff)
   *          intensity(0.9) pulseSpeed(2.0) glow(2.2)
   * --------------------------------------------------------------------- */
  function buildBeam(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.beam.params, opts);
    var group = new THREE.Group();
    var core = null, glow = null, disposed = false, phase = 0;

    function makeCyl(radius, op, blend) {
      try {
        var geo = new THREE.CylinderGeometry(radius, radius, 1, 8, 1, true);
        var mat = emissiveMat(p.color, op, blend);
        var mesh = new THREE.Mesh(geo, mat);
        return mesh;
      } catch (_) { return null; }
    }
    core = makeCyl(p.radius, p.intensity);
    glow = makeCyl(p.radius * (p.glow || 2.2), (p.intensity || 0.9) * 0.25);
    if (core) group.add(core);
    if (glow) group.add(glow);
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }

    function orient() {
      // place group at midpoint, scale cylinders to length, aim +Y axis at (to-from)
      var fx = p.from[0], fy = p.from[1], fz = p.from[2];
      var tx = p.to[0], ty = p.to[1], tz = p.to[2];
      var dx = tx - fx, dy = ty - fy, dz = tz - fz;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
      try { group.position.set((fx + tx) / 2, (fy + ty) / 2, (fz + tz) / 2); } catch (_) {}
      // aim: default cylinder axis is +Y; use lookAt on a child-friendly quaternion.
      if (group.quaternion && THREE.Quaternion && THREE.Vector3) {
        try {
          var up = new THREE.Vector3(0, 1, 0);
          var dir = new THREE.Vector3(dx, dy, dz).normalize();
          var q = new THREE.Quaternion().setFromUnitVectors(up, dir);
          group.quaternion.copy(q);
        } catch (_) {}
      }
      if (core) { try { core.scale.set(1, len, 1); } catch (_) {} }
      if (glow) { try { glow.scale.set(1, len, 1); } catch (_) {} }
    }
    orient();

    return {
      group: group,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        phase = t || 0;
        var pulse = 0.75 + 0.25 * Math.sin(phase * (p.pulseSpeed || 2.0) * Math.PI);
        if (core && core.material) core.material.opacity = (p.intensity || 0.9) * pulse;
        if (glow && glow.material) glow.material.opacity = (p.intensity || 0.9) * 0.25 * pulse;
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.from) p.from = np.from;
        if (np.to) p.to = np.to;
        if (np.color != null) {
          var c = colorOf(np.color, 0.9);
          if (core && core.material && core.material.color && core.material.color.setRGB) core.material.color.setRGB(c.r, c.g, c.b);
          if (glow && glow.material && glow.material.color && glow.material.color.setRGB) glow.material.color.setRGB(c.r, c.g, c.b);
        }
        if (np.intensity != null) p.intensity = np.intensity;
        if (np.from || np.to) orient();
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        [core, glow].forEach(function (m) { if (m) { try { m.geometry && m.geometry.dispose(); } catch (_) {} try { disposeMaterial(m.material); } catch (_) {} } });
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  lightning arc  —  a jagged emissive poly-line from `from` to `to`,
   *  re-randomised on a cadence (instance PRNG). Segment count CAPPED at 64.
   *  PARAMS: from to color(0xbfd8ff) segments(16) jitter(0.4) intensity(0.85)
   *          flicker(18) thickness(0.04) seed(1)
   * --------------------------------------------------------------------- */
  function buildLightning(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    if (typeof THREE.BufferGeometry !== 'function' || typeof THREE.BufferAttribute !== 'function') return null;
    var p = withDefaults(REGISTRY.lightning.params, opts);
    var SEG = Math.max(2, Math.min(64, Math.floor(p.segments)));   // CAP: 64 segments
    var rng = makeRng((p.seed != null ? p.seed : 1) | 0);
    var group = new THREE.Group();
    var posArr = new Float32Array((SEG + 1) * 3);
    var geo = new THREE.BufferGeometry();
    var posAttr = new THREE.BufferAttribute(posArr, 3);
    try { posAttr.setUsage && posAttr.setUsage(THREE.DynamicDrawUsage || 35048); } catch (_) {}
    geo.setAttribute('position', posAttr);
    var lineMat = null, line = null, disposed = false, accum = 0;
    try {
      var col = colorOf(p.color, 0.9);
      lineMat = new (THREE.LineBasicMaterial || THREE.MeshBasicMaterial)({});
      if (lineMat.color && lineMat.color.setRGB) lineMat.color.setRGB(col.r, col.g, col.b);
      lineMat.transparent = true; lineMat.opacity = p.intensity; lineMat.depthWrite = false;
      lineMat.blending = additiveBlend();
      lineMat.linewidth = (p.thickness || 0.04) * 50;   // note: WebGL ignores >1 but set anyway
      var LineCtor = THREE.Line || THREE.LineSegments;
      line = new LineCtor(geo, lineMat);
      line.frustumCulled = false;
      group.add(line);
    } catch (_) { line = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }

    function rebuild() {
      var fx = p.from, tx = p.to;
      var dx = tx[0] - fx[0], dy = tx[1] - fx[1], dz = tx[2] - fx[2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
      // perpendicular basis for jitter
      var ux = dy, uy = -dx, uz = 0;       // a perpendicular-ish vector
      var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      var jit = (p.jitter || 0.4) * len * 0.12;
      for (var i = 0; i <= SEG; i++) {
        var f = i / SEG;
        var bx = fx[0] + dx * f, by = fx[1] + dy * f, bz = fx[2] + dz * f;
        var taper = Math.sin(f * Math.PI);   // 0 at ends, 1 in middle
        var off = (rng() - 0.5) * 2 * jit * taper;
        var off2 = (rng() - 0.5) * 2 * jit * taper;
        posArr[i * 3] = bx + ux * off + dz * 0 + off2 * 0.3;
        posArr[i * 3 + 1] = by + uy * off;
        posArr[i * 3 + 2] = bz + uz * off + off2;
      }
      posAttr.needsUpdate = true;
    }
    rebuild();

    return {
      group: group,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        accum += (typeof dt === 'number' ? dt : 0);
        var period = 1 / Math.max(1, (p.flicker || 18));
        if (accum >= period) { accum = 0; rebuild(); }
        if (lineMat) lineMat.opacity = (p.intensity || 0.85) * (0.6 + 0.4 * rng());
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.from) p.from = np.from;
        if (np.to) p.to = np.to;
        if (np.intensity != null) p.intensity = np.intensity;
        if (np.jitter != null) p.jitter = np.jitter;
        if (np.color != null && lineMat && lineMat.color && lineMat.color.setRGB) { var c = colorOf(np.color, 0.9); lineMat.color.setRGB(c.r, c.g, c.b); }
        rebuild();
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        try { geo.dispose(); } catch (_) {}
        try { disposeMaterial(lineMat); } catch (_) {}
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  force-field dome  —  a fresnel-rim sphere/hemisphere with an impact ripple.
   *  burst(x,y,z) triggers a ripple from a world-space hit point.
   *  PARAMS: radius(2) color(0x55c8ff) opacity(0.35) rimPower(2.5)
   *          hemisphere(true) origin([0,0,0]) rippleSpeed(3)
   * --------------------------------------------------------------------- */
  function buildForceField(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.forceField.params, opts);
    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    var mesh = null, disposed = false, rippleT = -1, rippleX = 0, rippleY = 0, rippleZ = 0;
    var col = colorOf(p.color, 0.9);
    try {
      var phiLen = p.hemisphere ? Math.PI * 0.5 : Math.PI;
      var geo = new THREE.SphereGeometry(p.radius, 32, 24, 0, Math.PI * 2, 0, phiLen);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: vec3([col.r, col.g, col.b]) },
          uOpacity: { value: p.opacity },
          uRimPower: { value: p.rimPower },
          uTime: { value: 0 },
          uRipple: { value: -1 },           // <0 = inactive
          uRipplePos: { value: vec3(p.origin || [0, 0, 0]) },
          uRippleSpeed: { value: p.rippleSpeed }
        },
        vertexShader:
          'varying vec3 vN;\nvarying vec3 vWorld;\nvarying vec3 vView;\n' +
          'void main(){\n' +
          '  vN = normalize(normalMatrix * normal);\n' +
          '  vec4 wp = modelMatrix * vec4(position,1.0);\n' +
          '  vWorld = wp.xyz;\n' +
          '  vec4 mv = modelViewMatrix * vec4(position,1.0);\n' +
          '  vView = normalize(-mv.xyz);\n' +
          '  gl_Position = projectionMatrix * mv;\n' +
          '}',
        fragmentShader:
          'varying vec3 vN;\nvarying vec3 vWorld;\nvarying vec3 vView;\n' +
          'uniform vec3 uColor;\nuniform float uOpacity;\nuniform float uRimPower;\n' +
          'uniform float uTime;\nuniform float uRipple;\nuniform vec3 uRipplePos;\nuniform float uRippleSpeed;\n' +
          'void main(){\n' +
          '  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), uRimPower);\n' +
          '  float hex = 0.04 * sin(vWorld.x*8.0)*sin(vWorld.y*8.0)*sin(vWorld.z*8.0);\n' +
          '  float a = fres + hex;\n' +
          '  if (uRipple >= 0.0){\n' +
          '    float d = distance(vWorld, uRipplePos);\n' +
          '    float wave = sin((d - uRipple*uRippleSpeed)*6.0) * exp(-uRipple*2.0) * exp(-d*0.4);\n' +
          '    a += max(0.0, wave)*0.8;\n' +
          '  }\n' +
          '  vec3 c = min(uColor, vec3(0.9));\n' +    // sub-white clamp
          '  gl_FragColor = vec4(c, clamp(a,0.0,1.0) * uOpacity);\n' +
          '}',
        transparent: true, depthWrite: false, side: doubleSide(), blending: additiveBlend()
      });
      mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
    } catch (_) { mesh = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }

    function uni(n) { return mesh && mesh.material && mesh.material.uniforms && mesh.material.uniforms[n]; }

    return {
      group: group,
      burst: function (x, y, z) {
        // trigger a ripple from a world hit-point (defaults to top of dome).
        rippleT = 0;
        rippleX = (x != null) ? x : (p.origin ? p.origin[0] : 0);
        rippleY = (y != null) ? y : ((p.origin ? p.origin[1] : 0) + p.radius);
        rippleZ = (z != null) ? z : (p.origin ? p.origin[2] : 0);
        var rp = uni('uRipplePos'); if (rp && rp.value && rp.value.set) rp.value.set(rippleX, rippleY, rippleZ);
        var r = uni('uRipple'); if (r) r.value = 0;
      },
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        var ut = uni('uTime'); if (ut) ut.value = t || 0;
        if (rippleT >= 0) {
          rippleT += (typeof dt === 'number' ? dt : 0);
          var r = uni('uRipple'); if (r) r.value = rippleT;
          if (rippleT > 1.5) { rippleT = -1; if (r) r.value = -1; }   // ripple done
        }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.opacity != null) { var o = uni('uOpacity'); if (o) o.value = np.opacity; p.opacity = np.opacity; }
        if (np.rimPower != null) { var rp = uni('uRimPower'); if (rp) rp.value = np.rimPower; }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var uc = uni('uColor'); if (uc && uc.value && uc.value.set) uc.value.set(c.r, c.g, c.b); }
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        if (mesh) { try { mesh.geometry && mesh.geometry.dispose(); } catch (_) {} try { disposeMaterial(mesh.material); } catch (_) {} }
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  portal  —  a swirling emissive disc/ring with a turbulent interior.
   *  PARAMS: radius(1.5) color(0x8a6fff) color2(0x55c8ff) opacity(0.85)
   *          spin(1.2) origin([0,0,0])
   * --------------------------------------------------------------------- */
  function buildPortal(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.portal.params, opts);
    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    var mesh = null, disposed = false;
    var c1 = colorOf(p.color, 0.9), c2 = colorOf(p.color2, 0.9);
    try {
      var geo = new THREE.CircleGeometry ? new THREE.CircleGeometry(p.radius, 48) : new THREE.RingGeometry(0, p.radius, 48);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: vec3([c1.r, c1.g, c1.b]) },
          uColor2: { value: vec3([c2.r, c2.g, c2.b]) },
          uOpacity: { value: p.opacity },
          uTime: { value: 0 },
          uSpin: { value: p.spin }
        },
        vertexShader:
          'varying vec2 vUv;\nvoid main(){ vUv = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'varying vec2 vUv;\nuniform vec3 uColor;\nuniform vec3 uColor2;\nuniform float uOpacity;\nuniform float uTime;\nuniform float uSpin;\n' +
          'void main(){\n' +
          '  float r = length(vUv) * 2.0;\n' +
          '  float ang = atan(vUv.y, vUv.x);\n' +
          '  float swirl = sin(ang*5.0 + uTime*uSpin*3.0 - r*8.0);\n' +
          '  float ring = smoothstep(1.0, 0.85, r);\n' +
          '  float core = smoothstep(0.0, 0.7, 1.0 - r);\n' +
          '  vec3 c = mix(uColor, uColor2, 0.5 + 0.5*swirl);\n' +
          '  float a = (core*0.7 + ring*0.3 + 0.2*swirl*core) * uOpacity;\n' +
          '  gl_FragColor = vec4(min(c, vec3(0.9)), clamp(a,0.0,1.0));\n' +   // sub-white clamp
          '}',
        transparent: true, depthWrite: false, side: doubleSide(), blending: additiveBlend()
      });
      mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
    } catch (_) { mesh = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }
    function uni(n) { return mesh && mesh.material && mesh.material.uniforms && mesh.material.uniforms[n]; }

    return {
      group: group,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        var ut = uni('uTime'); if (ut) ut.value = t || 0;
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.opacity != null) { var o = uni('uOpacity'); if (o) o.value = np.opacity; }
        if (np.spin != null) { var s = uni('uSpin'); if (s) s.value = np.spin; }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var uc = uni('uColor'); if (uc && uc.value && uc.value.set) uc.value.set(c.r, c.g, c.b); }
        if (np.color2 != null) { var c2b = colorOf(np.color2, 0.9); var uc2 = uni('uColor2'); if (uc2 && uc2.value && uc2.value.set) uc2.value.set(c2b.r, c2b.g, c2b.b); }
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        if (mesh) { try { mesh.geometry && mesh.geometry.dispose(); } catch (_) {} try { disposeMaterial(mesh.material); } catch (_) {} }
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  shockwave ring  —  an expanding, fading emissive ring on the ground plane.
   *  Auto-plays once on spawn; burst() re-triggers. Driven by elapsed-relative age.
   *  PARAMS: maxRadius(6) duration(0.8) color(0xffd9a0) thickness(0.2)
   *          intensity(0.85) origin([0,0,0]) loop(false)
   * --------------------------------------------------------------------- */
  function buildShockwave(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.shockwave.params, opts);
    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    var mesh = null, disposed = false, age = 0, playing = true;
    var col = colorOf(p.color, 0.9);
    try {
      var geo = new THREE.RingGeometry(0.9, 1.0, 64);   // unit ring; scaled by age
      var mat = emissiveMat(p.color, p.intensity);
      mesh = new THREE.Mesh(geo, mat);
      try { mesh.rotation.x = -Math.PI / 2; } catch (_) {}  // lay flat on ground
      group.add(mesh);
    } catch (_) { mesh = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }

    function applyAge() {
      var dur = Math.max(0.001, p.duration);
      var f = clamp(age / dur, 0, 1);
      var r = f * p.maxRadius;
      if (mesh) {
        try { mesh.scale.set(r, r, r); } catch (_) {}
        if (mesh.material) mesh.material.opacity = (p.intensity || 0.85) * (1 - f);
        if (mesh.visible !== undefined) mesh.visible = f < 1 || !!p.loop;
      }
    }
    applyAge();   // resting frame at age 0

    return {
      group: group,
      burst: function () { age = 0; playing = true; if (mesh && mesh.visible !== undefined) mesh.visible = true; applyAge(); },
      update: function (dt, t) {
        if (disposed || H.reduceMotion || !playing) return;
        age += (typeof dt === 'number' ? dt : 0);
        if (age >= p.duration) {
          if (p.loop) age = 0; else { playing = false; }
        }
        applyAge();
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.maxRadius != null) p.maxRadius = np.maxRadius;
        if (np.duration != null) p.duration = np.duration;
        if (np.intensity != null) p.intensity = np.intensity;
        if (np.color != null && mesh && mesh.material && mesh.material.color && mesh.material.color.setRGB) { var c = colorOf(np.color, 0.9); mesh.material.color.setRGB(c.r, c.g, c.b); }
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        if (mesh) { try { mesh.geometry && mesh.geometry.dispose(); } catch (_) {} try { disposeMaterial(mesh.material); } catch (_) {} }
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  tractor beam  —  a translucent emissive cone + rising motes pulled toward
   *  the emitter. Built on the particle core for the motes (capped) + a cone mesh.
   *  PARAMS: from([x,y,h,0]) radius(1.2) height(5) color(0x7fe0ff)
   *          opacity(0.3) rate(50) origin([0,0,0])
   * --------------------------------------------------------------------- */
  function buildTractorBeam(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.tractorBeam.params, opts);
    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    var cone = null, disposed = false;
    var col = colorOf(p.color, 0.9);
    try {
      var geo = new THREE.CylinderGeometry(p.radius * 0.15, p.radius, p.height, 24, 1, true);
      var mat = emissiveMat(p.color, p.opacity);
      cone = new THREE.Mesh(geo, mat);
      try { cone.position.y = p.height * 0.5; } catch (_) {}
      group.add(cone);
    } catch (_) { cone = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }

    // rising motes via the particle core (negative-gravity upward pull, capped).
    var motes = makeParticles({
      additive: true, soft: 0.3, seed: 41,
      defaults: { max: 220, rate: p.rate, burst: 0, life: [0.8, 1.6], size: [0.1, 0.02],
        gravity: [0, p.height * 1.2, 0], drag: 0.2, speed: 0.4, spread: 1.0,
        color: [col.r, col.g, col.b], color2: [col.r * 0.7, col.g * 0.7, col.b * 0.7], opacity: 0.9, sizeScale: 1, radius: p.radius },
      fade: function (a) { return Math.sin(a * Math.PI); },
      init: function (pp, rng, sp) {
        var ang = rng() * Math.PI * 2, rr = (sp.radius || p.radius) * Math.sqrt(rng());
        pp.px = Math.cos(ang) * rr; pp.pz = Math.sin(ang) * rr; pp.py = 0.05;
        pp.vx = -pp.px * 0.4; pp.vz = -pp.pz * 0.4; pp.vy = 0.5;
      }
    }, { prime: false });
    if (motes && motes.group) group.add(motes.group);

    var pulse = 0;
    return {
      group: group,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (motes) motes.update(dt, t);
        pulse = 0.7 + 0.3 * Math.sin((t || 0) * 4);
        if (cone && cone.material) cone.material.opacity = (p.opacity || 0.3) * pulse;
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.opacity != null) p.opacity = np.opacity;
        if (np.rate != null && motes) motes.setParams({ rate: np.rate });
        if (np.color != null && cone && cone.material && cone.material.color && cone.material.color.setRGB) { var c = colorOf(np.color, 0.9); cone.material.color.setRGB(c.r, c.g, c.b); }
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (motes) motes.dispose(); } catch (_) {}
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        if (cone) { try { cone.geometry && cone.geometry.dispose(); } catch (_) {} try { disposeMaterial(cone.material); } catch (_) {} }
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  materialize-in (assemble)  —  fades/assembles a clone proxy of an existing
   *  mesh, or a default box, by animating a clip-plane-like dissolve threshold in
   *  a shader from bottom to top. Drives a 0->1 progress over `duration`.
   *  When a target mesh is supplied via opts.mesh, a sibling shell is added that
   *  reveals upward; otherwise a default unit box is assembled.
   *  PARAMS: mesh(null) duration(1.2) color(0x7fe0ff) edge(0.08) size(1)
   *          origin([0,0,0]) loop(false)
   * --------------------------------------------------------------------- */
  function buildMaterialize(opts) {
    if (!haveTHREE()) return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.materialize.params, opts);
    var group = new THREE.Group();
    if (p.origin) { try { group.position.set(p.origin[0] || 0, p.origin[1] || 0, p.origin[2] || 0); } catch (_) {} }
    var shell = null, disposed = false, age = 0, playing = true;
    var col = colorOf(p.color, 0.9);
    try {
      var geo = (p.mesh && p.mesh.geometry) ? p.mesh.geometry
        : (THREE.BoxGeometry ? new THREE.BoxGeometry(p.size, p.size, p.size) : new THREE.SphereGeometry(p.size, 16, 12));
      var ownGeo = !(p.mesh && p.mesh.geometry);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: vec3([col.r, col.g, col.b]) },
          uProgress: { value: 0 },
          uEdge: { value: p.edge },
          uMinY: { value: -p.size * 0.5 },
          uMaxY: { value: p.size * 0.5 }
        },
        vertexShader:
          'varying float vY;\nvoid main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'varying float vY;\nuniform vec3 uColor;\nuniform float uProgress;\nuniform float uEdge;\nuniform float uMinY;\nuniform float uMaxY;\n' +
          'void main(){\n' +
          '  float h = (vY - uMinY) / max(0.0001, (uMaxY - uMinY));\n' +
          '  float thresh = uProgress;\n' +
          '  if (h > thresh) discard;\n' +
          '  float edge = smoothstep(thresh - uEdge, thresh, h);\n' +
          '  vec3 c = mix(min(uColor, vec3(0.9)), vec3(0.9), edge);\n' +   // sub-white clamp
          '  gl_FragColor = vec4(c, 0.55 + 0.35*edge);\n' +
          '}',
        transparent: true, depthWrite: false, side: doubleSide(), blending: additiveBlend()
      });
      shell = new THREE.Mesh(geo, mat);
      shell._ownGeo = ownGeo;
      group.add(shell);
    } catch (_) { shell = null; }
    if (H.scene && H.scene.add) { try { H.scene.add(group); } catch (_) {} }
    function uni(n) { return shell && shell.material && shell.material.uniforms && shell.material.uniforms[n]; }
    function applyAge() {
      var dur = Math.max(0.001, p.duration);
      var f = clamp(age / dur, 0, 1);
      var u = uni('uProgress'); if (u) u.value = f;
    }
    applyAge();

    return {
      group: group,
      burst: function () { age = 0; playing = true; applyAge(); },
      update: function (dt, t) {
        if (disposed || H.reduceMotion || !playing) return;
        age += (typeof dt === 'number' ? dt : 0);
        if (age >= p.duration) { if (p.loop) age = 0; else playing = false; }
        applyAge();
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.duration != null) p.duration = np.duration;
        if (np.color != null) { var c = colorOf(np.color, 0.9); var uc = uni('uColor'); if (uc && uc.value && uc.value.set) uc.value.set(c.r, c.g, c.b); }
        if (np.origin) { try { group.position.set(np.origin[0] || 0, np.origin[1] || 0, np.origin[2] || 0); } catch (_) {} }
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { if (group.parent && group.parent.remove) group.parent.remove(group); } catch (_) {}
        if (shell) {
          if (shell._ownGeo) { try { shell.geometry && shell.geometry.dispose(); } catch (_) {} }
          try { disposeMaterial(shell.material); } catch (_) {}
        }
      }
    };
  }

  /* register the ENERGY / SCI-FI family (family 'emitter' so VFX.spawn finds them). */
  register({ name: 'beam', family: 'emitter', kind: 'Energy beam / laser (cylinder + glow)',
    params: { from: [0, 0, 0], to: [0, 4, 0], radius: 0.06, color: 0x6fe9ff, intensity: 0.9, pulseSpeed: 2.0, glow: 2.2 },
    factory: buildBeam });
  register({ name: 'lightning', family: 'emitter', kind: 'Lightning arc (jagged poly-line)',
    params: { from: [0, 0, 0], to: [0, 5, 0], color: 0xbfd8ff, segments: 16, jitter: 0.4, intensity: 0.85, flicker: 18, thickness: 0.04, seed: 1 },
    factory: buildLightning });
  register({ name: 'forceField', family: 'emitter', kind: 'Force-field dome (fresnel + ripple)',
    params: { radius: 2, color: 0x55c8ff, opacity: 0.35, rimPower: 2.5, hemisphere: true, rippleSpeed: 3, origin: [0, 0, 0] },
    factory: buildForceField });
  register({ name: 'portal', family: 'emitter', kind: 'Portal (swirling emissive disc)',
    params: { radius: 1.5, color: 0x8a6fff, color2: 0x55c8ff, opacity: 0.85, spin: 1.2, origin: [0, 0, 0] },
    factory: buildPortal });
  register({ name: 'shockwave', family: 'emitter', kind: 'Shockwave ring (expanding)',
    params: { maxRadius: 6, duration: 0.8, color: 0xffd9a0, thickness: 0.2, intensity: 0.85, loop: false, origin: [0, 0, 0] },
    factory: buildShockwave });
  register({ name: 'tractorBeam', family: 'emitter', kind: 'Tractor beam (cone + rising motes)',
    params: { radius: 1.2, height: 5, color: 0x7fe0ff, opacity: 0.3, rate: 50, origin: [0, 0, 0] },
    factory: buildTractorBeam });
  register({ name: 'materialize', family: 'emitter', kind: 'Materialize-in (assemble dissolve)',
    params: { mesh: null, duration: 1.2, color: 0x7fe0ff, edge: 0.08, size: 1, loop: false, origin: [0, 0, 0] },
    factory: buildMaterialize });

  /* =========================================================================
   *  MATERIAL family  (VFX.material) — swap/overlay a shader material onto an
   *  EXISTING mesh, returning a handle whose restore() puts the original material
   *  back. These are the runtime analogue of an AE "layer style" applied to a comp
   *  layer (glow / dissolve / fresnel rim / iridescence / outline-toon).
   *
   *  CONTRACT
   *  --------
   *    VFX.material(mesh, name, opts) -> { update(dt,t), setParams(p), restore(), dispose(), group:null, material }
   *    - The factory STORES mesh.material, builds a new ShaderMaterial, and assigns
   *      it to mesh.material. restore() (and dispose()) reassign the stored original
   *      and free the swapped-in material. dispose() == restore() + free.
   *    - Effects are GPU shaders that ride the host bloom + ACES: every emissive /
   *      glow output is sub-white clamped in-GLSL (min(col, vec3(0.9))).
   *    - Animated effects (dissolve sweep, hologram scanline/flicker) advance from
   *      the injected elapsed; under reduceMotion update() is a no-op so the look
   *      snaps to a static resting frame (dissolve holds its threshold, hologram
   *      holds its scanline phase). The global dispatcher already gates this.
   *    - Headless-safe: if THREE / mesh / ShaderMaterial is absent the factory
   *      returns null and VFX.material() hands back an inert handle (never throws).
   *
   *  EFFECTS (name -> look):
   *    dissolve     noise-threshold burn-away with a glowing burn edge (a.k.a.
   *                 disintegrate). progress 0->1 dissolves the surface; the edge
   *                 band glows. burst() replays the sweep.
   *    fresnel      view-dependent rim glow added over the base albedo.
   *    hologram     scanlines + flicker + fresnel edge, tinted, semi-transparent.
   *    iridescence  thin-film style hue shift by view angle (oil-slick sheen).
   *    outline      flat toon shade + a fattened back-face outline shell (two
   *                 materials: the mesh gets a toon material, a back-face shell is
   *                 ADDED as a child for the silhouette).
   * ====================================================================== */

  /* Shared world-position + normal varyings vertex shader for the material family. */
  var MAT_VERT =
    'varying vec3 vWorld;\nvarying vec3 vN;\nvarying vec3 vView;\nvarying vec2 vUvM;\nvarying vec3 vLocal;\n' +
    'void main(){\n' +
    '  vUvM = uv;\n' +
    '  vLocal = position;\n' +
    '  vN = normalize(normalMatrix * normal);\n' +
    '  vec4 wp = modelMatrix * vec4(position, 1.0);\n' +
    '  vWorld = wp.xyz;\n' +
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
    '  vView = normalize(-mv.xyz);\n' +
    '  gl_Position = projectionMatrix * mv;\n' +
    '}';

  /* Build a material-family handle around a mesh: store original, swap in newMat,
     and provide restore()/dispose(). `uni(n)` reads the swapped material uniforms.
     `tick` is an optional per-frame fn (dt, t, uni). Headless-safe. */
  function swapMaterial(mesh, newMat, tick, onSetParams) {
    if (!mesh || !newMat) return null;
    var original = mesh.material;       // may be a single material or an array
    var disposed = false;
    function uni(n) { return newMat.uniforms && newMat.uniforms[n]; }
    try { mesh.material = newMat; } catch (_) {}
    var handle = {
      group: null,
      material: newMat,
      mesh: mesh,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (typeof tick === 'function') { try { tick(dt, t, uni); } catch (_) {} }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (typeof onSetParams === 'function') { try { onSetParams(np, uni, newMat); } catch (_) {} }
      },
      restore: function () {
        if (disposed) return;
        try { mesh.material = original; } catch (_) {}
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        try { mesh.material = original; } catch (_) {}
        try { disposeMaterial(newMat); } catch (_) {}
      }
    };
    return handle;
  }

  /* -------------------------------------------------------------------------
   *  dissolve / disintegrate  —  a value-noise threshold eats the surface from
   *  0->1 with a glowing burn edge. progress can be driven (auto over duration)
   *  or set manually; burst() replays the sweep.
   *  PARAMS: progress(0) duration(1.2) auto(true) loop(false) color(0xff7a1a)
   *          edge(0.08) scale(2.5) reverse(false)
   * --------------------------------------------------------------------- */
  function buildDissolve(mesh, opts) {
    if (!haveTHREE() || !mesh || typeof H.THREE.ShaderMaterial !== 'function') return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.dissolve.params, opts);
    var edgeCol = colorOf(p.color, 0.9);
    var base = colorOf(p.base != null ? p.base : 0x6a7480, 0.9);
    var mat = null;
    try {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uProgress: { value: clamp(p.progress, 0, 1) },
          uEdge: { value: p.edge },
          uScale: { value: p.scale },
          uEdgeColor: { value: vec3([edgeCol.r, edgeCol.g, edgeCol.b]) },
          uBase: { value: vec3([base.r, base.g, base.b]) },
          uReverse: { value: p.reverse ? 1.0 : 0.0 }
        },
        vertexShader: MAT_VERT,
        fragmentShader:
          'varying vec3 vWorld;\nvarying vec3 vN;\nvarying vec3 vView;\n' +
          'uniform float uProgress;\nuniform float uEdge;\nuniform float uScale;\n' +
          'uniform vec3 uEdgeColor;\nuniform vec3 uBase;\nuniform float uReverse;\n' +
          'float hash(vec3 q){ return fract(sin(dot(q, vec3(12.9898,78.233,37.719))) * 43758.5453); }\n' +
          'float vnoise(vec3 x){\n' +
          '  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);\n' +
          '  float n000=hash(i+vec3(0.,0.,0.)), n100=hash(i+vec3(1.,0.,0.));\n' +
          '  float n010=hash(i+vec3(0.,1.,0.)), n110=hash(i+vec3(1.,1.,0.));\n' +
          '  float n001=hash(i+vec3(0.,0.,1.)), n101=hash(i+vec3(1.,0.,1.));\n' +
          '  float n011=hash(i+vec3(0.,1.,1.)), n111=hash(i+vec3(1.,1.,1.));\n' +
          '  return mix(mix(mix(n000,n100,f.x),mix(n010,n110,f.x),f.y),mix(mix(n001,n101,f.x),mix(n011,n111,f.x),f.y),f.z);\n' +
          '}\n' +
          'void main(){\n' +
          '  float n = vnoise(vWorld * uScale);\n' +
          '  float thr = uReverse > 0.5 ? (1.0 - uProgress) : uProgress;\n' +
          '  if (n < thr) discard;\n' +
          '  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), 2.0);\n' +
          '  float edge = 1.0 - smoothstep(thr, thr + uEdge, n);\n' +
          '  vec3 col = mix(uBase + fres * 0.15, uEdgeColor, edge);\n' +
          '  gl_FragColor = vec4(min(col, vec3(0.9)), 1.0);\n' +   // sub-white clamp
          '}',
        transparent: false, side: doubleSide()
      });
    } catch (_) { mat = null; }
    if (!mat) return null;

    var age = (p.progress > 0 ? p.progress * p.duration : 0);
    var playing = !!p.auto;
    var h = swapMaterial(mesh, mat,
      function (dt, t, uni) {
        if (!playing) return;
        age += (typeof dt === 'number' ? dt : 0);
        var f = clamp(age / Math.max(0.001, p.duration), 0, 1);
        var u = uni('uProgress'); if (u) u.value = f;
        if (f >= 1) { if (p.loop) age = 0; else playing = false; }
      },
      function (np, uni) {
        if (np.progress != null) { var u = uni('uProgress'); if (u) u.value = clamp(np.progress, 0, 1); age = clamp(np.progress, 0, 1) * p.duration; }
        if (np.duration != null) p.duration = np.duration;
        if (np.edge != null) { var e = uni('uEdge'); if (e) e.value = np.edge; }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var ec = uni('uEdgeColor'); if (ec && ec.value && ec.value.set) ec.value.set(c.r, c.g, c.b); }
      });
    if (h) h.burst = function () { age = 0; playing = true; };
    return h;
  }

  /* -------------------------------------------------------------------------
   *  fresnel rim-glow  —  adds a view-dependent rim of light over the base albedo.
   *  PARAMS: color(0x6fe9ff) base(0x10161f) power(2.5) intensity(0.9) opacity(1)
   * --------------------------------------------------------------------- */
  function buildFresnel(mesh, opts) {
    if (!haveTHREE() || !mesh || typeof H.THREE.ShaderMaterial !== 'function') return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.fresnel.params, opts);
    var rim = colorOf(p.color, 0.9);
    var base = colorOf(p.base, 0.9);
    var mat = null;
    try {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uRim: { value: vec3([rim.r, rim.g, rim.b]) },
          uBase: { value: vec3([base.r, base.g, base.b]) },
          uPower: { value: p.power },
          uIntensity: { value: p.intensity },
          uOpacity: { value: p.opacity }
        },
        vertexShader: MAT_VERT,
        fragmentShader:
          'varying vec3 vN;\nvarying vec3 vView;\n' +
          'uniform vec3 uRim;\nuniform vec3 uBase;\nuniform float uPower;\nuniform float uIntensity;\nuniform float uOpacity;\n' +
          'void main(){\n' +
          '  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), uPower);\n' +
          '  vec3 col = uBase + uRim * fres * uIntensity;\n' +
          '  gl_FragColor = vec4(min(col, vec3(0.9)), uOpacity);\n' +   // sub-white clamp
          '}',
        transparent: p.opacity < 1, side: doubleSide()
      });
    } catch (_) { mat = null; }
    if (!mat) return null;
    return swapMaterial(mesh, mat, null,
      function (np, uni) {
        if (np.power != null) { var u = uni('uPower'); if (u) u.value = np.power; }
        if (np.intensity != null) { var i = uni('uIntensity'); if (i) i.value = np.intensity; }
        if (np.opacity != null) { var o = uni('uOpacity'); if (o) o.value = np.opacity; }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var r = uni('uRim'); if (r && r.value && r.value.set) r.value.set(c.r, c.g, c.b); }
      });
  }

  /* -------------------------------------------------------------------------
   *  hologram  —  scanlines + flicker + fresnel edge, tinted + semi-transparent.
   *  Time-driven (scanline scroll + flicker); under reduceMotion the phase freezes.
   *  PARAMS: color(0x6fe9ff) scanCount(160) scanSpeed(1.0) flicker(0.08)
   *          rimPower(2.0) opacity(0.7)
   * --------------------------------------------------------------------- */
  function buildHologram(mesh, opts) {
    if (!haveTHREE() || !mesh || typeof H.THREE.ShaderMaterial !== 'function') return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.hologram.params, opts);
    var col = colorOf(p.color, 0.9);
    var mat = null;
    try {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: vec3([col.r, col.g, col.b]) },
          uTime: { value: 0 },
          uScanCount: { value: p.scanCount },
          uScanSpeed: { value: p.scanSpeed },
          uFlicker: { value: p.flicker },
          uRimPower: { value: p.rimPower },
          uOpacity: { value: p.opacity }
        },
        vertexShader: MAT_VERT,
        fragmentShader:
          'varying vec3 vWorld;\nvarying vec3 vN;\nvarying vec3 vView;\n' +
          'uniform vec3 uColor;\nuniform float uTime;\nuniform float uScanCount;\nuniform float uScanSpeed;\n' +
          'uniform float uFlicker;\nuniform float uRimPower;\nuniform float uOpacity;\n' +
          'void main(){\n' +
          '  float fres = pow(1.0 - max(dot(normalize(vN), normalize(vView)), 0.0), uRimPower);\n' +
          '  float scan = 0.5 + 0.5 * sin((vWorld.y - uTime * uScanSpeed) * uScanCount);\n' +
          '  float flick = 1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * 30.0));\n' +
          '  float glow = (0.35 + 0.5 * scan + fres) * flick;\n' +
          '  vec3 col = uColor * glow;\n' +
          '  float a = clamp(uOpacity * (0.4 + 0.6 * scan + fres), 0.0, 1.0);\n' +
          '  gl_FragColor = vec4(min(col, vec3(0.9)), a);\n' +   // sub-white clamp
          '}',
        transparent: true, depthWrite: false, side: doubleSide(), blending: additiveBlend()
      });
    } catch (_) { mat = null; }
    if (!mat) return null;
    return swapMaterial(mesh, mat,
      function (dt, t, uni) { var u = uni('uTime'); if (u) u.value = t || 0; },
      function (np, uni) {
        if (np.opacity != null) { var o = uni('uOpacity'); if (o) o.value = np.opacity; }
        if (np.scanCount != null) { var s = uni('uScanCount'); if (s) s.value = np.scanCount; }
        if (np.flicker != null) { var f = uni('uFlicker'); if (f) f.value = np.flicker; }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var uc = uni('uColor'); if (uc && uc.value && uc.value.set) uc.value.set(c.r, c.g, c.b); }
      });
  }

  /* -------------------------------------------------------------------------
   *  iridescence  —  oil-slick / thin-film sheen: hue shifts by view angle.
   *  PARAMS: base(0x0a0e14) intensity(0.6) bands(3.0) opacity(1)
   * --------------------------------------------------------------------- */
  function buildIridescence(mesh, opts) {
    if (!haveTHREE() || !mesh || typeof H.THREE.ShaderMaterial !== 'function') return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.iridescence.params, opts);
    var base = colorOf(p.base, 0.9);
    var mat = null;
    try {
      mat = new THREE.ShaderMaterial({
        uniforms: {
          uBase: { value: vec3([base.r, base.g, base.b]) },
          uIntensity: { value: p.intensity },
          uBands: { value: p.bands },
          uOpacity: { value: p.opacity }
        },
        vertexShader: MAT_VERT,
        fragmentShader:
          'varying vec3 vN;\nvarying vec3 vView;\n' +
          'uniform vec3 uBase;\nuniform float uIntensity;\nuniform float uBands;\nuniform float uOpacity;\n' +
          'vec3 spectral(float t){\n' +
          '  return 0.5 + 0.5 * cos(6.28318 * (uBands * t + vec3(0.0, 0.33, 0.66)));\n' +
          '}\n' +
          'void main(){\n' +
          '  float ct = max(dot(normalize(vN), normalize(vView)), 0.0);\n' +
          '  float fres = pow(1.0 - ct, 1.5);\n' +
          '  vec3 sheen = spectral(ct);\n' +
          '  vec3 col = uBase + sheen * fres * uIntensity;\n' +
          '  gl_FragColor = vec4(min(col, vec3(0.9)), uOpacity);\n' +   // sub-white clamp
          '}',
        transparent: p.opacity < 1, side: doubleSide()
      });
    } catch (_) { mat = null; }
    if (!mat) return null;
    return swapMaterial(mesh, mat, null,
      function (np, uni) {
        if (np.intensity != null) { var i = uni('uIntensity'); if (i) i.value = np.intensity; }
        if (np.bands != null) { var b = uni('uBands'); if (b) b.value = np.bands; }
        if (np.opacity != null) { var o = uni('uOpacity'); if (o) o.value = np.opacity; }
      });
  }

  /* -------------------------------------------------------------------------
   *  outline / toon  —  a flat toon-shaded surface + a fattened back-face outline
   *  shell ADDED as a child of the mesh (the classic inverted-hull silhouette).
   *  The mesh material is swapped to a toon shader; the shell is a separate child
   *  back-face mesh scaled along normals. restore()/dispose() remove the shell too.
   *  PARAMS: color(0x9fb4c8) outlineColor(0x05080d) thickness(0.04) steps(3)
   * --------------------------------------------------------------------- */
  function buildOutline(mesh, opts) {
    if (!haveTHREE() || !mesh || typeof H.THREE.ShaderMaterial !== 'function') return null;
    var THREE = H.THREE;
    var p = withDefaults(REGISTRY.outline.params, opts);
    var fill = colorOf(p.color, 0.9);
    var line = colorOf(p.outlineColor, 0.9);
    var toonMat = null, shellMat = null, shell = null;
    try {
      toonMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: vec3([fill.r, fill.g, fill.b]) },
          uSteps: { value: Math.max(1, p.steps) },
          uLight: { value: vec3([0.4, 0.8, 0.5]) }
        },
        vertexShader: MAT_VERT,
        fragmentShader:
          'varying vec3 vN;\n' +
          'uniform vec3 uColor;\nuniform float uSteps;\nuniform vec3 uLight;\n' +
          'void main(){\n' +
          '  float ndl = max(dot(normalize(vN), normalize(uLight)), 0.0);\n' +
          '  float q = floor(ndl * uSteps) / uSteps;\n' +
          '  vec3 col = uColor * (0.35 + 0.65 * q);\n' +
          '  gl_FragColor = vec4(min(col, vec3(0.9)), 1.0);\n' +   // sub-white clamp
          '}',
        side: (THREE.FrontSide !== undefined ? THREE.FrontSide : 0)
      });
    } catch (_) { toonMat = null; }
    if (!toonMat) return null;

    var h = swapMaterial(mesh, toonMat, null,
      function (np, uni) {
        if (np.steps != null) { var s = uni('uSteps'); if (s) s.value = Math.max(1, np.steps); }
        if (np.color != null) { var c = colorOf(np.color, 0.9); var uc = uni('uColor'); if (uc && uc.value && uc.value.set) uc.value.set(c.r, c.g, c.b); }
        if (np.thickness != null && shellMat && shellMat.uniforms && shellMat.uniforms.uThickness) shellMat.uniforms.uThickness.value = np.thickness;
      });
    if (!h) return null;

    // inverted-hull outline shell: a back-face child that extrudes along normals.
    try {
      if (mesh.geometry && typeof THREE.Mesh === 'function') {
        shellMat = new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: vec3([line.r, line.g, line.b]) },
            uThickness: { value: p.thickness }
          },
          vertexShader:
            'uniform float uThickness;\n' +
            'void main(){\n' +
            '  vec3 p = position + normal * uThickness;\n' +
            '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);\n' +
            '}',
          fragmentShader:
            'uniform vec3 uColor;\nvoid main(){ gl_FragColor = vec4(min(uColor, vec3(0.9)), 1.0); }',
          side: backSide()
        });
        shell = new THREE.Mesh(mesh.geometry, shellMat);
        shell.frustumCulled = false;
        if (typeof mesh.add === 'function') mesh.add(shell);
      }
    } catch (_) { shell = null; }

    // wrap restore/dispose to also detach + free the shell.
    var baseRestore = h.restore, baseDispose = h.dispose;
    h.restore = function () { try { baseRestore(); } catch (_) {} try { if (shell && mesh.remove) mesh.remove(shell); } catch (_) {} };
    h.dispose = function () {
      try { if (shell && mesh.remove) mesh.remove(shell); } catch (_) {}
      try { if (shellMat) disposeMaterial(shellMat); } catch (_) {}
      try { baseDispose(); } catch (_) {}
    };
    return h;
  }

  /* register the MATERIAL family. The factory signature is (mesh, opts). */
  register({ name: 'dissolve', family: 'material', kind: 'Dissolve / disintegrate (noise + burn edge)',
    params: { progress: 0, duration: 1.2, auto: true, loop: false, color: 0xff7a1a, base: 0x6a7480, edge: 0.08, scale: 2.5, reverse: false },
    factory: buildDissolve });
  register({ name: 'fresnel', family: 'material', kind: 'Fresnel rim-glow',
    params: { color: 0x6fe9ff, base: 0x10161f, power: 2.5, intensity: 0.9, opacity: 1 },
    factory: buildFresnel });
  register({ name: 'hologram', family: 'material', kind: 'Hologram (scanlines + flicker + fresnel)',
    params: { color: 0x6fe9ff, scanCount: 160, scanSpeed: 1.0, flicker: 0.08, rimPower: 2.0, opacity: 0.7 },
    factory: buildHologram });
  register({ name: 'iridescence', family: 'material', kind: 'Iridescence (thin-film sheen)',
    params: { base: 0x0a0e14, intensity: 0.6, bands: 3.0, opacity: 1 },
    factory: buildIridescence });
  register({ name: 'outline', family: 'material', kind: 'Outline / toon (inverted-hull shell)',
    params: { color: 0x9fb4c8, outlineColor: 0x05080d, thickness: 0.04, steps: 3 },
    factory: buildOutline });

  /* =========================================================================
   *  INFOGRAPHIC family  (VFX.infographic.<fn>) — the tech-ad / data-viz "motion
   *  graphics" look. Two render paths, picked per effect or per opts.layer:
   *
   *    (A) DOM OVERLAY  — an absolutely-positioned HTML element anchored to a 3D
   *        world point by projecting it through the camera each frame. Crisp text /
   *        SVG-like lines OUTSIDE the bloom + ACES pipeline (so labels stay legible).
   *        GUARDED: if document / a DOM container is absent (headless), the overlay
   *        path no-ops — the handle is still returned and update()/dispose() are safe.
   *    (B) IN-SCENE SPRITE  — a THREE.Sprite (or Mesh) carrying a CanvasTexture that
   *        the effect redraws when its value changes. Lives in the 3D scene, sorts
   *        with depth, and is reduce-motion / headless safe (the 2D canvas stub in
   *        the smoke test simply ignores draw calls).
   *
   *  These are VIEW-ONLY: each is fed values via opts / setParams({ value }) — they
   *  never read or mutate the economy. Animation (counter tween, chart draw-on,
   *  ticker scroll, gauge needle, progress arc) advances from the injected elapsed;
   *  under reduceMotion update() is a no-op and each effect snaps to its target
   *  resting frame (counter shows `to`, charts fully drawn, arc at value).
   *
   *  AE / FCP mapping: numeric counter / slider control, trim-path "write-on",
   *  lower-third title, animated bar/line/ring/donut chart, radial progress, a data
   *  ticker / marquee, a KPI gauge, and a 3D-anchored callout / tag marker.
   *
   *  CAPS: chart series capped at INFO_MAX_POINTS (256) values; the ticker draws a
   *  single scrolling canvas (no per-char DOM). Canvas sizes are fixed per effect.
   *
   *  FUNCTIONS:
   *    counter(opts)     animated number / odometer (DOM or sprite)
   *    callout(opts)     leader-line + dot + label pointing at a 3D object (DOM)
   *    label(opts)       label pill / lower-third (DOM or sprite)
   *    barChart(opts)    draw-on vertical bars (sprite canvas)
   *    lineChart(opts)   draw-on line/area series (sprite canvas)
   *    ringChart(opts)   draw-on ring / radial-bar (sprite canvas)
   *    donutChart(opts)  draw-on donut with segments (sprite canvas)
   *    progressArc(opts) radial progress arc 0..1 (sprite canvas)
   *    ticker(opts)      scrolling data marquee (DOM or sprite)
   *    gauge(opts)       KPI gauge with a sweeping needle (sprite canvas)
   *    tag(opts)         3D-anchored tag marker / pin (DOM or sprite)
   * ====================================================================== */

  var INFO_MAX_POINTS = 256;

  /* easing for tweens / draw-on (smoothstep-ish ease-out). */
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); }

  /* Is a usable DOM available for overlay effects? (document + createElement). */
  function haveDOM() {
    return !!(root && root.document && typeof root.document.createElement === 'function');
  }
  /* Pick the overlay container: opts.container -> renderer.domElement.parentNode ->
     document.body. Returns null when headless. */
  function overlayContainer(opts) {
    if (!haveDOM()) return null;
    if (opts && opts.container && typeof opts.container.appendChild === 'function') return opts.container;
    try {
      if (H.renderer && H.renderer.domElement && H.renderer.domElement.parentNode &&
          typeof H.renderer.domElement.parentNode.appendChild === 'function') {
        return H.renderer.domElement.parentNode;
      }
    } catch (_) {}
    try { if (root.document.body && typeof root.document.body.appendChild === 'function') return root.document.body; } catch (_) {}
    return null;
  }

  /* Project a world [x,y,z] to viewport pixels {x,y,visible}. Headless-safe
     (returns visible:false if no camera / projection method). No per-frame alloc:
     reuses a module-scope scratch vector. */
  var _projScratch = null;
  function projectToScreen(world) {
    var out = { x: 0, y: 0, visible: false };
    if (!haveTHREE() || !H.camera) return out;
    var THREE = H.THREE;
    try {
      if (!_projScratch && THREE.Vector3) _projScratch = new THREE.Vector3();
      var v = _projScratch;
      if (!v || typeof v.set !== 'function' || typeof v.project !== 'function') {
        // headless / minimal stub camera: no projection — keep visible:false.
        return out;
      }
      v.set(world[0] || 0, world[1] || 0, world[2] || 0);
      v.project(H.camera);
      out.x = (v.x * 0.5 + 0.5) * viewW();
      out.y = (-v.y * 0.5 + 0.5) * viewH();
      out.visible = (v.z < 1) && isFinite(out.x) && isFinite(out.y);
    } catch (_) { out.visible = false; }
    return out;
  }

  /* Create an absolutely-positioned overlay element (or null when headless). */
  function makeOverlayEl(opts, className, html) {
    var container = overlayContainer(opts);
    if (!container) return null;
    var el = null;
    try {
      el = root.document.createElement('div');
      el.className = 'vfx-info ' + (className || '');
      if (el.style) {
        el.style.position = 'absolute';
        el.style.left = '0px'; el.style.top = '0px';
        el.style.pointerEvents = 'none';
        el.style.zIndex = String((opts && opts.zIndex) || 7);
        el.style.transform = 'translate(-50%, -50%)';
        el.style.willChange = 'transform, left, top';
      }
      if (html != null) el.innerHTML = html;
      container.appendChild(el);
    } catch (_) { el = null; }
    return el;
  }
  function setText(el, txt) { if (el) { try { el.textContent = txt; } catch (_) {} } }
  function positionEl(el, sx, sy, visible) {
    if (!el || !el.style) return;
    try {
      el.style.left = sx + 'px';
      el.style.top = sy + 'px';
      el.style.display = visible ? '' : 'none';
    } catch (_) {}
  }
  function removeEl(el) {
    if (!el) return;
    try { if (el.parentNode && el.parentNode.removeChild) el.parentNode.removeChild(el); } catch (_) {}
  }

  /* Build a 2D canvas of (w,h) and its 2D context, or {canvas:null,ctx:null} headless. */
  function makeCanvas(w, h) {
    if (!haveDOM()) return { canvas: null, ctx: null };
    var c = null, g = null;
    try {
      c = root.document.createElement('canvas');
      c.width = w || 256; c.height = h || 256;
      g = (typeof c.getContext === 'function') ? c.getContext('2d') : null;
    } catch (_) { c = null; g = null; }
    return { canvas: c, ctx: g };
  }

  /* Wrap a CanvasTexture onto a THREE.Sprite that the effect redraws. Headless-safe:
     returns { sprite, texture, canvas, ctx, redraw, dispose }. If THREE.Sprite or the
     DOM canvas is missing, sprite/texture are null and draws are skipped. */
  function makeCanvasSprite(opts, w, h, worldScaleX, worldScaleY) {
    var cc = makeCanvas(w, h);
    var THREE = haveTHREE() ? H.THREE : null;
    var sprite = null, texture = null, mat = null;
    if (THREE && cc.canvas && typeof THREE.CanvasTexture === 'function' && typeof THREE.Sprite === 'function') {
      try {
        texture = new THREE.CanvasTexture(cc.canvas);
        mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: (opts && opts.depthTest === true) });
        sprite = new THREE.Sprite(mat);
        var sx = (worldScaleX != null) ? worldScaleX : 2;
        var sy = (worldScaleY != null) ? worldScaleY : (sx * (h / Math.max(1, w)));
        if (sprite.scale && sprite.scale.set) sprite.scale.set(sx, sy, 1);
        if (opts && opts.position && sprite.position && sprite.position.set) sprite.position.set(opts.position[0] || 0, opts.position[1] || 0, opts.position[2] || 0);
        if (H.scene && typeof H.scene.add === 'function') H.scene.add(sprite);
      } catch (_) { sprite = null; }
    }
    return {
      sprite: sprite, texture: texture, canvas: cc.canvas, ctx: cc.ctx,
      redraw: function () { if (texture) texture.needsUpdate = true; },
      dispose: function () {
        try { if (sprite && sprite.parent && sprite.parent.remove) sprite.parent.remove(sprite); } catch (_) {}
        try { if (mat) disposeMaterial(mat); } catch (_) {}
        try { if (texture && texture.dispose) texture.dispose(); } catch (_) {}
      }
    };
  }

  /* format a number for the counter/odometer (thousands sep + fixed decimals). */
  function fmtNum(v, decimals, prefix, suffix, sep) {
    var d = (decimals != null) ? decimals : 0;
    var n = (typeof v === 'number' && isFinite(v)) ? v : 0;
    var s = Math.abs(n).toFixed(d);
    if (sep !== false) {
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      s = parts.join('.');
    }
    return (n < 0 ? '-' : '') + (prefix || '') + s + (suffix || '');
  }

  /* a sub-white CSS rgb() string from a hex / [r,g,b] (so DOM text matches the look). */
  function cssColor(c) {
    var col = colorOf(c, 0.95);
    return 'rgb(' + Math.round(col.r * 255) + ',' + Math.round(col.g * 255) + ',' + Math.round(col.b * 255) + ')';
  }

  /* -------------------------------------------------------------------------
   *  counter / odometer  —  tweens a number from `from` to `to` over `duration`.
   *  DOM overlay by default (crisp text); set layer:'sprite' for an in-scene sprite.
   *  setParams({ to }) retargets and re-tweens from the current value.
   *  PARAMS: from(0) to(100) duration(1.5) decimals(0) prefix('') suffix('')
   *          world(null) position(null) color(0x6fe9ff) font('700 28px ...')
   *          layer('dom'|'sprite')
   * --------------------------------------------------------------------- */
  function buildCounter(opts) {
    var p = withDefaults(REGISTRY.counter.params, opts);
    var disposed = false;
    var from = p.from, to = p.to, cur = p.from, age = 0, dur = Math.max(0.001, p.duration);
    var useSprite = (p.layer === 'sprite');
    var el = null, cs = null;

    function fmt(v) { return fmtNum(v, p.decimals, p.prefix, p.suffix); }
    function drawSprite() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      g.clearRect(0, 0, w, h);
      g.font = p.font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeText(fmt(cur), w / 2, h / 2);
      g.fillStyle = cssColor(p.color); g.fillText(fmt(cur), w / 2, h / 2);
      cs.redraw();
    }
    if (useSprite) { cs = makeCanvasSprite(p, 256, 64, p.spriteScale || 2); }
    else {
      el = makeOverlayEl(p, 'vfx-counter', null);
      if (el && el.style) { el.style.font = p.font; el.style.color = cssColor(p.color); el.style.textShadow = '0 1px 3px rgba(0,0,0,0.7)'; el.style.whiteSpace = 'nowrap'; }
    }
    // resting frame: at t=0 show `from` (reduce-motion will hold this until retargeted).
    if (el) setText(el, fmt(cur)); else drawSprite();

    function render(visible, sx, sy) {
      if (el) { positionEl(el, sx, sy, visible); setText(el, fmt(cur)); }
      else drawSprite();
    }

    var handle = {
      group: (cs && cs.sprite) ? cs.sprite : null,
      el: el,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (age < dur) { age += (typeof dt === 'number' ? dt : 0); cur = from + (to - from) * easeOut(age / dur); if (age >= dur) cur = to; }
        if (el && p.world) { var s = projectToScreen(p.world); render(s.visible, s.x, s.y); }
        else render(true, 0, 0);
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.to != null) { from = cur; to = np.to; age = 0; }
        if (np.from != null) { from = np.from; cur = np.from; }
        if (np.duration != null) { dur = Math.max(0.001, np.duration); }
        if (np.world) p.world = np.world;
        if (np.value != null) { from = np.value; to = np.value; cur = np.value; age = dur; }
        if (el) setText(el, fmt(cur)); else drawSprite();
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        removeEl(el);
        if (cs) cs.dispose();
      }
    };
    return handle;
  }

  /* -------------------------------------------------------------------------
   *  callout  —  a leader line + dot + label pointing at a 3D world object.
   *  DOM overlay: the dot sits on the projected anchor, the label is offset, and an
   *  SVG-free CSS line connects them. Headless-safe (no-op overlay).
   *  PARAMS: world([0,0,0]) text('') offset([60,-40]) color(0x6fe9ff)
   *          dotSize(8) font('600 14px ...')
   * --------------------------------------------------------------------- */
  function buildCallout(opts) {
    var p = withDefaults(REGISTRY.callout.params, opts);
    var disposed = false;
    var col = cssColor(p.color);
    var dot = makeOverlayEl(p, 'vfx-callout-dot', null);
    var lineEl = makeOverlayEl(p, 'vfx-callout-line', null);
    var label = makeOverlayEl(p, 'vfx-callout-label', null);
    if (dot && dot.style) { dot.style.width = p.dotSize + 'px'; dot.style.height = p.dotSize + 'px'; dot.style.borderRadius = '50%'; dot.style.background = col; dot.style.boxShadow = '0 0 8px ' + col; }
    if (lineEl && lineEl.style) { lineEl.style.height = '0px'; lineEl.style.borderTop = '1px solid ' + col; lineEl.style.transformOrigin = '0 0'; lineEl.style.transform = 'none'; }
    if (label) { setText(label, p.text); if (label.style) { label.style.font = p.font; label.style.color = col; label.style.transform = 'transl(-0%, -50%)'; label.style.padding = '2px 6px'; label.style.background = 'rgba(8,12,18,0.7)'; label.style.borderRadius = '4px'; label.style.whiteSpace = 'nowrap'; } }

    function place(sx, sy, visible) {
      var lx = sx + p.offset[0], ly = sy + p.offset[1];
      positionEl(dot, sx, sy, visible);
      // label anchored at its left edge near (lx,ly)
      if (label && label.style) { label.style.transform = 'translate(0, -50%)'; }
      positionEl(label, lx, ly, visible);
      if (lineEl && lineEl.style) {
        var dx = lx - sx, dy = ly - sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 0;
        var ang = Math.atan2(dy, dx) * 180 / Math.PI;
        lineEl.style.left = sx + 'px'; lineEl.style.top = sy + 'px';
        lineEl.style.width = len + 'px';
        lineEl.style.transform = 'rotate(' + ang + 'deg)';
        lineEl.style.display = visible ? '' : 'none';
      }
    }
    // resting frame
    var s0 = projectToScreen(p.world); place(s0.x, s0.y, s0.visible);

    return {
      group: null, dot: dot, label: label,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        var s = projectToScreen(p.world);
        place(s.x, s.y, s.visible);
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.world) p.world = np.world;
        if (np.text != null) setText(label, np.text);
        if (np.offset) p.offset = np.offset;
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        removeEl(dot); removeEl(lineEl); removeEl(label);
      }
    };
  }

  /* -------------------------------------------------------------------------
   *  label  —  a label pill / lower-third. DOM by default; layer:'sprite' for an
   *  in-scene canvas sprite. Anchored to a world point (DOM) or positioned (sprite).
   *  PARAMS: text('') sub('') world(null) position(null) color(0x6fe9ff)
   *          bg('rgba(8,12,18,0.78)') font('700 16px ...') layer('dom'|'sprite')
   * --------------------------------------------------------------------- */
  function buildLabel(opts) {
    var p = withDefaults(REGISTRY.label.params, opts);
    var disposed = false;
    var useSprite = (p.layer === 'sprite');
    var el = null, cs = null;

    function drawSprite() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      g.clearRect(0, 0, w, h);
      g.fillStyle = p.bg; if (g.fillRect) g.fillRect(0, 0, w, h);
      g.font = p.font; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = cssColor(p.color); g.fillText(p.text || '', 16, p.sub ? h * 0.38 : h * 0.5);
      if (p.sub) { g.font = '400 13px Segoe UI, sans-serif'; g.fillStyle = 'rgba(200,212,226,0.85)'; g.fillText(p.sub, 16, h * 0.68); }
      cs.redraw();
    }
    if (useSprite) { cs = makeCanvasSprite(p, 256, 80, p.spriteScale || 3); drawSprite(); }
    else {
      el = makeOverlayEl(p, 'vfx-label', '<div class="vfx-label-main"></div><div class="vfx-label-sub"></div>');
      if (el && el.style) { el.style.font = p.font; el.style.color = cssColor(p.color); el.style.background = p.bg; el.style.padding = '6px 12px'; el.style.borderRadius = '6px'; el.style.whiteSpace = 'nowrap'; el.style.borderLeft = '3px solid ' + cssColor(p.color); }
      try { if (el && el.firstChild) el.firstChild.textContent = p.text; if (el && el.lastChild && p.sub) el.lastChild.textContent = p.sub; } catch (_) {}
    }
    var s0 = p.world ? projectToScreen(p.world) : { x: 0, y: 0, visible: true };
    if (el) positionEl(el, s0.x, s0.y, s0.visible);

    return {
      group: (cs && cs.sprite) ? cs.sprite : null, el: el,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (el && p.world) { var s = projectToScreen(p.world); positionEl(el, s.x, s.y, s.visible); }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.text != null) { p.text = np.text; if (el) { try { el.firstChild.textContent = np.text; } catch (_) {} } else drawSprite(); }
        if (np.sub != null) { p.sub = np.sub; if (el) { try { el.lastChild.textContent = np.sub; } catch (_) {} } else drawSprite(); }
        if (np.world) p.world = np.world;
      },
      dispose: function () {
        if (disposed) return; disposed = true;
        removeEl(el); if (cs) cs.dispose();
      }
    };
  }

  /* shared chart draw-on driver: tweens a 0..1 reveal factor over duration. The
     per-chart drawer is called with (ctx, w, h, reveal). reduceMotion snaps reveal=1. */
  function chartHandle(p, cs, drawFn) {
    var disposed = false, age = 0, dur = Math.max(0.001, p.duration), reveal = (H.reduceMotion ? 1 : 0);
    var data = (p.data || []).slice(0, INFO_MAX_POINTS);
    function paint() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      g.clearRect(0, 0, w, h);
      try { drawFn(g, w, h, reveal, data, p); } catch (_) {}
      cs.redraw();
    }
    if (H.reduceMotion) { reveal = 1; }
    paint();   // resting frame (reveal=0 live, reveal=1 under reduceMotion)
    return {
      group: (cs && cs.sprite) ? cs.sprite : null,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (reveal < 1) { age += (typeof dt === 'number' ? dt : 0); reveal = easeOut(age / dur); if (age >= dur) reveal = 1; paint(); }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.data) { data = np.data.slice(0, INFO_MAX_POINTS); p.data = data; age = 0; reveal = (H.reduceMotion ? 1 : 0); paint(); }
        if (np.value != null) { data = [np.value]; age = 0; reveal = (H.reduceMotion ? 1 : 0); paint(); }
        if (np.color != null) { p.color = np.color; paint(); }
      },
      dispose: function () { if (disposed) return; disposed = true; if (cs) cs.dispose(); }
    };
  }

  /* -------------------------------------------------------------------------
   *  barChart  —  draw-on vertical bars (sprite canvas).
   *  PARAMS: data([..]) duration(1.0) color(0x6fe9ff) bg('rgba(8,12,18,0.55)')
   *          position(null) max(auto)
   * --------------------------------------------------------------------- */
  function buildBarChart(opts) {
    var p = withDefaults(REGISTRY.barChart.params, opts);
    var cs = makeCanvasSprite(p, 256, 160, p.spriteScale || 3);
    return chartHandle(p, cs, function (g, w, h, reveal, data, pp) {
      if (pp.bg && g.fillRect) { g.fillStyle = pp.bg; g.fillRect(0, 0, w, h); }
      var n = data.length || 1;
      var mx = pp.max || Math.max.apply(null, data.concat([1]));
      var pad = 12, bw = (w - pad * 2) / n * 0.7, gap = (w - pad * 2) / n;
      g.fillStyle = cssColor(pp.color);
      for (var i = 0; i < data.length; i++) {
        var bh = (h - pad * 2) * (data[i] / mx) * reveal;
        if (g.fillRect) g.fillRect(pad + i * gap + (gap - bw) / 2, h - pad - bh, bw, bh);
      }
    });
  }

  /* -------------------------------------------------------------------------
   *  lineChart  —  draw-on line/area series (sprite canvas).
   *  PARAMS: data([..]) duration(1.0) color(0x6fe9ff) fill(true) bg(...) position(null)
   * --------------------------------------------------------------------- */
  function buildLineChart(opts) {
    var p = withDefaults(REGISTRY.lineChart.params, opts);
    var cs = makeCanvasSprite(p, 256, 160, p.spriteScale || 3);
    return chartHandle(p, cs, function (g, w, h, reveal, data, pp) {
      if (pp.bg && g.fillRect) { g.fillStyle = pp.bg; g.fillRect(0, 0, w, h); }
      var n = data.length; if (n < 2) return;
      var mx = pp.max || Math.max.apply(null, data.concat([1]));
      var pad = 12, span = (w - pad * 2), drawN = Math.max(2, Math.floor(2 + (n - 2) * reveal));
      function px(i) { return pad + span * (i / (n - 1)); }
      function py(v) { return h - pad - (h - pad * 2) * (v / mx); }
      if (g.beginPath) {
        g.beginPath(); g.moveTo(px(0), py(data[0]));
        for (var i = 1; i < drawN; i++) g.lineTo(px(i), py(data[i]));
        g.lineWidth = 2; g.strokeStyle = cssColor(pp.color); if (g.stroke) g.stroke();
        if (pp.fill && g.fill) { g.lineTo(px(drawN - 1), h - pad); g.lineTo(px(0), h - pad); g.closePath(); g.globalAlpha = 0.18; g.fillStyle = cssColor(pp.color); g.fill(); g.globalAlpha = 1; }
      }
    });
  }

  /* -------------------------------------------------------------------------
   *  ringChart  —  draw-on radial-bar ring (sprite canvas). Single value 0..1.
   *  PARAMS: value(0.66) duration(1.0) color(0x6fe9ff) track('rgba(120,140,170,0.25)')
   *          thickness(0.22) position(null)
   * --------------------------------------------------------------------- */
  function buildRingChart(opts) {
    var p = withDefaults(REGISTRY.ringChart.params, opts);
    var cs = makeCanvasSprite(p, 192, 192, p.spriteScale || 2);
    p.data = [p.value];
    return chartHandle(p, cs, function (g, w, h, reveal, data, pp) {
      var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42, lw = R * pp.thickness;
      var val = clamp(data.length ? data[0] : pp.value, 0, 1);
      if (g.beginPath) {
        g.lineWidth = lw; g.strokeStyle = pp.track;
        g.beginPath(); if (g.arc) g.arc(cx, cy, R, 0, Math.PI * 2); if (g.stroke) g.stroke();
        g.strokeStyle = cssColor(pp.color);
        g.beginPath(); if (g.arc) g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * val * reveal); if (g.stroke) g.stroke();
      }
    });
  }

  /* -------------------------------------------------------------------------
   *  donutChart  —  draw-on donut with multiple segments (sprite canvas).
   *  PARAMS: data([..]) duration(1.0) palette([hex..]) hole(0.55) bg(...) position(null)
   * --------------------------------------------------------------------- */
  function buildDonutChart(opts) {
    var p = withDefaults(REGISTRY.donutChart.params, opts);
    var cs = makeCanvasSprite(p, 192, 192, p.spriteScale || 2);
    return chartHandle(p, cs, function (g, w, h, reveal, data, pp) {
      var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.45;
      var total = 0; for (var i = 0; i < data.length; i++) total += data[i]; if (total <= 0) total = 1;
      var pal = pp.palette, start = -Math.PI / 2;
      for (var j = 0; j < data.length; j++) {
        var frac = data[j] / total, ang = Math.PI * 2 * frac * reveal;
        if (g.beginPath && g.arc) {
          g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, start, start + ang); g.closePath();
          g.fillStyle = cssColor(pal[j % pal.length]); if (g.fill) g.fill();
        }
        start += Math.PI * 2 * frac;
      }
      // punch the hole
      if (g.beginPath && g.arc) { g.beginPath(); g.fillStyle = pp.bg; g.arc(cx, cy, R * pp.hole, 0, Math.PI * 2); if (g.fill) g.fill(); }
    });
  }

  /* -------------------------------------------------------------------------
   *  progressArc  —  a radial progress arc 0..1 with a soft glow tip (sprite).
   *  PARAMS: value(0.5) duration(1.0) color(0x6fe9ff) track('rgba(120,140,170,0.22)')
   *          thickness(0.16) startAngle(-90) position(null)
   * --------------------------------------------------------------------- */
  function buildProgressArc(opts) {
    var p = withDefaults(REGISTRY.progressArc.params, opts);
    var cs = makeCanvasSprite(p, 192, 192, p.spriteScale || 2);
    p.data = [p.value];
    return chartHandle(p, cs, function (g, w, h, reveal, data, pp) {
      var cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4, lw = R * pp.thickness;
      var val = clamp(data.length ? data[0] : pp.value, 0, 1) * reveal;
      var a0 = (pp.startAngle || -90) * Math.PI / 180;
      if (g.beginPath) {
        g.lineWidth = lw; if ('lineCap' in g) g.lineCap = 'round';
        g.strokeStyle = pp.track; g.beginPath(); if (g.arc) g.arc(cx, cy, R, 0, Math.PI * 2); if (g.stroke) g.stroke();
        g.strokeStyle = cssColor(pp.color); g.beginPath(); if (g.arc) g.arc(cx, cy, R, a0, a0 + Math.PI * 2 * val); if (g.stroke) g.stroke();
        g.font = '700 30px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = cssColor(pp.color); if (g.fillText) g.fillText(Math.round(val * 100) + '%', cx, cy);
      }
    });
  }

  /* -------------------------------------------------------------------------
   *  gauge  —  a KPI gauge (270deg arc) with a sweeping needle (sprite canvas).
   *  Needle tweens to the target value; reduceMotion snaps it to the target.
   *  PARAMS: value(0.5) min(0) max(1) duration(0.8) color(0x6fe9ff)
   *          track('rgba(120,140,170,0.25)') label('') position(null)
   * --------------------------------------------------------------------- */
  function buildGauge(opts) {
    var p = withDefaults(REGISTRY.gauge.params, opts);
    var cs = makeCanvasSprite(p, 224, 160, p.spriteScale || 2.6);
    var disposed = false, cur = (H.reduceMotion ? p.value : p.min), target = p.value;
    var span = Math.PI * 1.5, base = Math.PI * 0.75;   // 270deg sweep from 135deg

    function norm(v) { return clamp((v - p.min) / Math.max(0.0001, (p.max - p.min)), 0, 1); }
    function draw() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      var cx = w / 2, cy = h * 0.62, R = Math.min(w, h) * 0.42;
      g.clearRect(0, 0, w, h);
      if (g.beginPath) {
        g.lineWidth = R * 0.16; if ('lineCap' in g) g.lineCap = 'round';
        g.strokeStyle = p.track; g.beginPath(); if (g.arc) g.arc(cx, cy, R, base, base + span); if (g.stroke) g.stroke();
        g.strokeStyle = cssColor(p.color); g.beginPath(); if (g.arc) g.arc(cx, cy, R, base, base + span * norm(cur)); if (g.stroke) g.stroke();
        // needle
        var ang = base + span * norm(cur);
        if (g.moveTo) { g.beginPath(); g.lineWidth = 3; g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * R * 0.92, cy + Math.sin(ang) * R * 0.92); if (g.stroke) g.stroke(); }
        g.font = '700 24px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = cssColor(p.color); if (g.fillText) g.fillText(fmtNum(cur, p.decimals || 0), cx, cy - R * 0.18);
        if (p.label) { g.font = '400 13px Segoe UI, sans-serif'; g.fillStyle = 'rgba(200,212,226,0.85)'; if (g.fillText) g.fillText(p.label, cx, cy + R * 0.36); }
      }
      cs.redraw();
    }
    draw();
    return {
      group: (cs && cs.sprite) ? cs.sprite : null,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (Math.abs(cur - target) > 0.0001) { cur += (target - cur) * Math.min(1, (typeof dt === 'number' ? dt : 0) / Math.max(0.001, p.duration) * 4); draw(); }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.value != null) { target = np.value; if (H.reduceMotion) { cur = np.value; draw(); } }
        if (np.label != null) { p.label = np.label; draw(); }
        if (np.max != null) p.max = np.max;
        if (np.min != null) p.min = np.min;
      },
      dispose: function () { if (disposed) return; disposed = true; if (cs) cs.dispose(); }
    };
  }

  /* -------------------------------------------------------------------------
   *  ticker  —  a scrolling data marquee. DOM by default; layer:'sprite' draws a
   *  single scrolling canvas (no per-char DOM). Time-driven; reduceMotion freezes.
   *  PARAMS: text('') speed(60) color(0x6fe9ff) bg('rgba(8,12,18,0.8)')
   *          font('600 16px ...') width(360) world(null) position(null) layer('dom'|'sprite')
   * --------------------------------------------------------------------- */
  function buildTicker(opts) {
    var p = withDefaults(REGISTRY.ticker.params, opts);
    var disposed = false, offset = 0;
    var useSprite = (p.layer === 'sprite');
    var el = null, inner = null, cs = null, textW = 0;

    function drawSprite() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      g.clearRect(0, 0, w, h);
      if (p.bg && g.fillRect) { g.fillStyle = p.bg; g.fillRect(0, 0, w, h); }
      g.font = p.font; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillStyle = cssColor(p.color);
      if (g.measureText) { try { textW = g.measureText(p.text).width || (p.text.length * 9); } catch (_) { textW = p.text.length * 9; } }
      else textW = p.text.length * 9;
      var span = textW + 60;
      var x = w - (offset % span);
      if (g.fillText) { g.fillText(p.text, x, h / 2); g.fillText(p.text, x - span, h / 2); }
      cs.redraw();
    }
    if (useSprite) { cs = makeCanvasSprite(p, p.width, 36, p.spriteScale || 4); drawSprite(); }
    else {
      el = makeOverlayEl(p, 'vfx-ticker', '<div class="vfx-ticker-inner"></div>');
      if (el && el.style) { el.style.width = p.width + 'px'; el.style.overflow = 'hidden'; el.style.background = p.bg; el.style.font = p.font; el.style.color = cssColor(p.color); el.style.padding = '4px 0'; el.style.borderRadius = '4px'; el.style.transform = 'none'; }
      try { inner = el && el.firstChild; if (inner) { inner.textContent = p.text; if (inner.style) { inner.style.whiteSpace = 'nowrap'; inner.style.display = 'inline-block'; inner.style.paddingLeft = '100%'; } } } catch (_) {}
      if (el && p.world) { var s0 = projectToScreen(p.world); positionEl(el, s0.x, s0.y, s0.visible); }
    }

    return {
      group: (cs && cs.sprite) ? cs.sprite : null, el: el,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        offset += (p.speed || 60) * (typeof dt === 'number' ? dt : 0);
        if (cs) drawSprite();
        else if (inner && inner.style) { inner.style.transform = 'translateX(' + (-(offset % (p.width + 200))) + 'px)'; }
        if (el && p.world) { var s = projectToScreen(p.world); positionEl(el, s.x, s.y, s.visible); }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.text != null) { p.text = np.text; if (inner) { try { inner.textContent = np.text; } catch (_) {} } else drawSprite(); }
        if (np.speed != null) p.speed = np.speed;
        if (np.world) p.world = np.world;
      },
      dispose: function () { if (disposed) return; disposed = true; removeEl(el); if (cs) cs.dispose(); }
    };
  }

  /* -------------------------------------------------------------------------
   *  tag  —  a 3D-anchored tag marker / pin. DOM by default (a small pill that
   *  tracks a world point); layer:'sprite' for an in-scene sprite that always
   *  faces the camera. Headless-safe overlay.
   *  PARAMS: world([0,0,0]) text('') color(0x6fe9ff) bg('rgba(8,12,18,0.82)')
   *          font('600 13px ...') position(null) layer('dom'|'sprite')
   * --------------------------------------------------------------------- */
  function buildTag(opts) {
    var p = withDefaults(REGISTRY.tag.params, opts);
    var disposed = false;
    var useSprite = (p.layer === 'sprite');
    var el = null, cs = null;

    function drawSprite() {
      if (!cs || !cs.ctx) return;
      var g = cs.ctx, w = cs.canvas.width, h = cs.canvas.height;
      g.clearRect(0, 0, w, h);
      if (p.bg && g.fillRect) { g.fillStyle = p.bg; g.fillRect(0, 0, w, h); }
      g.font = p.font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = cssColor(p.color); if (g.fillText) g.fillText(p.text || '', w / 2, h / 2);
      cs.redraw();
    }
    if (useSprite) { cs = makeCanvasSprite(p, 192, 48, p.spriteScale || 1.6); drawSprite(); }
    else {
      el = makeOverlayEl(p, 'vfx-tag', null);
      setText(el, p.text);
      if (el && el.style) { el.style.font = p.font; el.style.color = cssColor(p.color); el.style.background = p.bg; el.style.padding = '3px 8px'; el.style.borderRadius = '10px'; el.style.border = '1px solid ' + cssColor(p.color); el.style.whiteSpace = 'nowrap'; }
    }
    var s0 = projectToScreen(p.world); if (el) positionEl(el, s0.x, s0.y, s0.visible);

    return {
      group: (cs && cs.sprite) ? cs.sprite : null, el: el,
      update: function (dt, t) {
        if (disposed || H.reduceMotion) return;
        if (el) { var s = projectToScreen(p.world); positionEl(el, s.x, s.y, s.visible); }
      },
      setParams: function (np) {
        if (disposed || !np) return;
        if (np.world) p.world = np.world;
        if (np.text != null) { p.text = np.text; if (el) setText(el, np.text); else drawSprite(); }
      },
      dispose: function () { if (disposed) return; disposed = true; removeEl(el); if (cs) cs.dispose(); }
    };
  }

  /* register the INFOGRAPHIC family. The factory signature is (opts). */
  register({ name: 'counter', family: 'infographic', kind: 'Animated number / odometer',
    params: { from: 0, to: 100, duration: 1.5, decimals: 0, prefix: '', suffix: '', world: null, position: null, color: 0x6fe9ff, font: '700 28px Segoe UI, sans-serif', layer: 'dom' },
    factory: buildCounter });
  register({ name: 'callout', family: 'infographic', kind: 'Callout leader-line + dot + label',
    params: { world: [0, 0, 0], text: '', offset: [60, -40], color: 0x6fe9ff, dotSize: 8, font: '600 14px Segoe UI, sans-serif' },
    factory: buildCallout });
  register({ name: 'label', family: 'infographic', kind: 'Label pill / lower-third',
    params: { text: '', sub: '', world: null, position: null, color: 0x6fe9ff, bg: 'rgba(8,12,18,0.78)', font: '700 16px Segoe UI, sans-serif', layer: 'dom' },
    factory: buildLabel });
  register({ name: 'barChart', family: 'infographic', kind: 'Draw-on bar chart',
    params: { data: [3, 7, 4, 9, 6, 8], duration: 1.0, color: 0x6fe9ff, bg: 'rgba(8,12,18,0.55)', position: null, max: 0 },
    factory: buildBarChart });
  register({ name: 'lineChart', family: 'infographic', kind: 'Draw-on line / area chart',
    params: { data: [2, 4, 3, 6, 5, 8, 7, 9], duration: 1.0, color: 0x6fe9ff, fill: true, bg: 'rgba(8,12,18,0.55)', position: null, max: 0 },
    factory: buildLineChart });
  register({ name: 'ringChart', family: 'infographic', kind: 'Draw-on ring / radial bar',
    params: { value: 0.66, duration: 1.0, color: 0x6fe9ff, track: 'rgba(120,140,170,0.25)', thickness: 0.22, position: null },
    factory: buildRingChart });
  register({ name: 'donutChart', family: 'infographic', kind: 'Draw-on donut chart',
    params: { data: [5, 3, 2, 4], duration: 1.0, palette: [0x6fe9ff, 0x8a6fff, 0xffd9a0, 0x4fd08a], hole: 0.55, bg: 'rgba(8,12,18,0.85)', position: null },
    factory: buildDonutChart });
  register({ name: 'progressArc', family: 'infographic', kind: 'Radial progress arc 0..1',
    params: { value: 0.5, duration: 1.0, color: 0x6fe9ff, track: 'rgba(120,140,170,0.22)', thickness: 0.16, startAngle: -90, position: null },
    factory: buildProgressArc });
  register({ name: 'gauge', family: 'infographic', kind: 'KPI gauge (sweeping needle)',
    params: { value: 0.5, min: 0, max: 1, duration: 0.8, decimals: 0, color: 0x6fe9ff, track: 'rgba(120,140,170,0.25)', label: '', position: null },
    factory: buildGauge });
  register({ name: 'ticker', family: 'infographic', kind: 'Data ticker / marquee',
    params: { text: '', speed: 60, color: 0x6fe9ff, bg: 'rgba(8,12,18,0.8)', font: '600 16px Segoe UI, sans-serif', width: 360, world: null, position: null, layer: 'dom' },
    factory: buildTicker });
  register({ name: 'tag', family: 'infographic', kind: '3D-anchored tag marker / pin',
    params: { world: [0, 0, 0], text: '', color: 0x6fe9ff, bg: 'rgba(8,12,18,0.82)', font: '600 13px Segoe UI, sans-serif', position: null, layer: 'dom' },
    factory: buildTag });

  /* =========================================================================
   *  LATER-PHASE FAMILY STUBS  — stable, headless-safe entry points so the public
   *  API surface is complete from Phase 1. They never throw; they return inert
   *  handles when called before the corresponding family is implemented. Each
   *  family will register real descriptors + factories in its phase, and VFX.list()
   *  will grow automatically.
   * ====================================================================== */

  function inertHandle(extra) {
    var h = {
      update: function (/*dt, t*/) {},
      setParams: function (/*p*/) {},
      dispose: function () {},
      group: null
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  /* If a future emitter/attach/material factory is registered for `name`, build it;
     otherwise return an inert handle. Always headless-safe. */
  function buildFromRegistry(name, family, args) {
    if (!haveTHREE()) return inertHandle();
    var desc = REGISTRY[name];
    if (!desc || desc.family !== family || typeof desc.factory !== 'function') return inertHandle();
    var fx = null;
    try { fx = desc.factory.apply(null, args); } catch (_) { fx = null; }
    if (!fx) return inertHandle();
    // track for per-frame updates + cleanup
    if (typeof fx.update === 'function') liveEffects.push(fx);
    return fx;
  }

  /**
   * VFX.spawn — object/world particle emitter (sparks, smoke, embers, etc).
   * Phase 1: stable inert stub. @returns handle { update, setParams, burst?, dispose, group }.
   */
  function spawn(name, opts) {
    var h = buildFromRegistry(name, 'emitter', [opts]);
    if (!h.burst) h.burst = function (/*n*/) {};
    // tag emitter handles with their effective params so VFX.exportQuarks can read
    // them back (the resolved param object = registry defaults merged with opts).
    try {
      if (h && typeof h === 'object' && REGISTRY[name]) {
        h._quarksName = name;
        if (!h._quarksParams) h._quarksParams = withDefaults(REGISTRY[name].params, opts);
      }
    } catch (_) {}
    return h;
  }

  /**
   * VFX.attach — attach an effect (dissolve, trail, ...) to an existing mesh.
   * Phase 1: stable inert stub. @returns handle.
   */
  function attach(mesh, name, opts) {
    return buildFromRegistry(name, 'attach', [mesh, opts]);
  }

  /**
   * VFX.material — swap/overlay a shader material (dissolve, fresnel, hologram,
   * iridescence, outline) onto an EXISTING mesh; the original material is restored
   * by handle.restore() / handle.dispose(). @returns handle with restore().
   */
  function material(mesh, name, opts) {
    var h = buildFromRegistry(name, 'material', [mesh, opts]);
    if (!h.restore) h.restore = function () {};
    return h;
  }

  /**
   * VFX.infographic — motion-graphics / data-viz effects. Each fn returns a handle
   * { update, setParams, dispose, group? } built from the registry (real factory if
   * registered, else an inert headless-safe handle). DOM-overlay effects no-op when
   * document / a container is absent; canvas-sprite effects skip draws under the
   * headless 2D-context stub. All are view-only (driven by injected values).
   */
  var infographic = {
    counter: function (opts) { return buildFromRegistry('counter', 'infographic', [opts]); },
    callout: function (opts) { return buildFromRegistry('callout', 'infographic', [opts]); },
    label: function (opts) { return buildFromRegistry('label', 'infographic', [opts]); },
    barChart: function (opts) { return buildFromRegistry('barChart', 'infographic', [opts]); },
    lineChart: function (opts) { return buildFromRegistry('lineChart', 'infographic', [opts]); },
    ringChart: function (opts) { return buildFromRegistry('ringChart', 'infographic', [opts]); },
    donutChart: function (opts) { return buildFromRegistry('donutChart', 'infographic', [opts]); },
    progressArc: function (opts) { return buildFromRegistry('progressArc', 'infographic', [opts]); },
    gauge: function (opts) { return buildFromRegistry('gauge', 'infographic', [opts]); },
    ticker: function (opts) { return buildFromRegistry('ticker', 'infographic', [opts]); },
    tag: function (opts) { return buildFromRegistry('tag', 'infographic', [opts]); }
  };

  /* =========================================================================
   *  CONTROL METADATA  — turn a flat default-param map into a `controls` map the
   *  editor builds widgets from, WITHOUT hand-authoring 41 descriptors.
   *
   *  THE controls DESCRIPTOR SHAPE (exact — the editor depends on it):
   *    controls is a plain object: paramKey -> ONE of these descriptor shapes:
   *      number  -> { type:'number', min:<num>, max:<num>, step:<num>, default:<num> }
   *      color   -> { type:'color',  default:[r,g,b] }            // r,g,b in 0..1
   *      vector  -> { type:'vector', length:2|3, min:<num>, max:<num>, step:<num>,
   *                   default:[ ... length numbers ... ] }
   *      enum    -> { type:'select', options:[<string>...], default:<string> }
   *      bool    -> { type:'bool',   default:<boolean> }
   *      text    -> { type:'text',   default:<string> }           // free-form strings
   *  Every param key of every effect yields exactly one descriptor.
   *
   *  HOW IT IS DERIVED:
   *    1. inferControl(key, value, effectName) classifies the param by its VALUE
   *       TYPE + its ROLE (inferred from the key name) and picks sensible ranges.
   *    2. CONTROL_OVERRIDES[effectName][key] (or CONTROL_OVERRIDES['*'][key]) replaces
   *       or patches the inferred descriptor where inference is too coarse.
   *  The result is cached per effect name (params are immutable defaults).
   * ====================================================================== */

  /* keys whose [r,g,b] / hex value is a COLOUR (not a generic vector). */
  var COLOR_KEY_RE = /(^|[^a-z])(color|colour|tint|rim|fill|edge ?color|outline ?color|base|palette)/i;
  /* keys that read as a 0..1 normalised amount/mix/fraction. */
  var UNIT_KEY_RE = /(opacity|mix|amount|intensity|weight|density|decay|saturation|threshold|spread|drag|flicker|hole|thickness|reveal|value|progress)/i;
  /* keys that read as a small screen-space fraction (sub-pixel offsets, aperture). */
  var FRACTION_KEY_RE = /(aperture|aberration|colorshift|maxblur|softness|softness)/i;
  /* keys that look like a CSS string (font / bg / track / css colour string). */
  var CSS_KEY_RE = /(^font$|^bg$|^track$|^suffix$|^prefix$|^text$|^sub$|^label$)/i;

  /* string enum options for the few enum-ish params we expose. */
  var ENUM_OPTIONS = {
    layer: ['dom', 'sprite']
  };

  /* per-effect (or '*') overrides for ranges inference gets wrong. Each override is
     a partial descriptor merged over the inferred one (or a full descriptor). */
  var CONTROL_OVERRIDES = {
    '*': {
      // global colour-ish string-name params already handled; numeric exposure span.
      exposure: { type: 'number', min: 0, max: 3, step: 0.01 },
      contrast: { type: 'number', min: 0, max: 3, step: 0.01 },
      saturation: { type: 'number', min: 0, max: 3, step: 0.01 },
      opacity: { type: 'number', min: 0, max: 1, step: 0.01 },
      seed: { type: 'number', min: 0, max: 9999, step: 1 }
    },
    colorGrade: { lutMix: { type: 'number', min: 0, max: 1, step: 0.01 }, lutSize: { type: 'number', min: 1, max: 256, step: 1 } },
    chromatic: { amount: { type: 'number', min: 0, max: 0.02, step: 0.0001 }, radial: { type: 'number', min: 0, max: 4, step: 0.01 } },
    filmGrain: { intensity: { type: 'number', min: 0, max: 0.5, step: 0.005 }, size: { type: 'number', min: 0.1, max: 4, step: 0.05 } },
    godRays: { samples: { type: 'number', min: 8, max: 64, step: 1 }, density: { type: 'number', min: 0, max: 1, step: 0.01 }, weight: { type: 'number', min: 0, max: 1, step: 0.01 }, decay: { type: 'number', min: 0.8, max: 1, step: 0.001 }, exposure: { type: 'number', min: 0, max: 2, step: 0.01 } },
    dof: { focus: { type: 'number', min: 0, max: 1, step: 0.01 }, aperture: { type: 'number', min: 0, max: 0.2, step: 0.001 }, maxBlur: { type: 'number', min: 0, max: 0.05, step: 0.001 } },
    glitch: { amount: { type: 'number', min: 0, max: 2, step: 0.01 }, colorShift: { type: 'number', min: 0, max: 0.05, step: 0.0005 } },
    scanlines: { count: { type: 'number', min: 60, max: 2000, step: 10 } },
    lensFlare: { ghosts: { type: 'number', min: 0, max: 8, step: 1 }, halo: { type: 'number', min: 0, max: 1, step: 0.01 } },
    letterbox: { aspect: { type: 'number', min: 1, max: 3.5, step: 0.01 }, softness: { type: 'number', min: 0, max: 0.05, step: 0.001 } },
    lightning: { segments: { type: 'number', min: 2, max: 64, step: 1 }, flicker: { type: 'number', min: 1, max: 60, step: 1 } },
    beam: { radius: { type: 'number', min: 0.005, max: 2, step: 0.005 }, glow: { type: 'number', min: 1, max: 6, step: 0.1 } },
    forceField: { radius: { type: 'number', min: 0.1, max: 20, step: 0.1 }, rimPower: { type: 'number', min: 0.5, max: 8, step: 0.1 } },
    portal: { radius: { type: 'number', min: 0.1, max: 20, step: 0.1 }, spin: { type: 'number', min: 0, max: 8, step: 0.1 } },
    shockwave: { maxRadius: { type: 'number', min: 0.1, max: 40, step: 0.1 } },
    dissolve: { scale: { type: 'number', min: 0.1, max: 20, step: 0.1 } },
    hologram: { scanCount: { type: 'number', min: 1, max: 1000, step: 1 } },
    iridescence: { bands: { type: 'number', min: 0.5, max: 12, step: 0.1 } },
    outline: { steps: { type: 'number', min: 1, max: 16, step: 1 } },
    gauge: { decimals: { type: 'number', min: 0, max: 6, step: 1 } },
    counter: { decimals: { type: 'number', min: 0, max: 6, step: 1 } },
    progressArc: { startAngle: { type: 'number', min: -360, max: 360, step: 1 } },
    ticker: { width: { type: 'number', min: 60, max: 1920, step: 10 }, speed: { type: 'number', min: 0, max: 400, step: 1 } }
  };

  /* clone a default param value so the descriptor never aliases the registry. */
  function cloneDefault(v) {
    if (Array.isArray(v)) return v.slice();
    return v;
  }

  /* normalise a colour-ish default (hex number | [r,g,b]) into a sub-white [r,g,b]. */
  function colorDefault(v) {
    var c = colorOf(v, 0.9);
    return [c.r, c.g, c.b];
  }

  /* pick a numeric [min,max,step] from the key role + default magnitude. */
  function numberRange(key, value) {
    var def = (typeof value === 'number' && isFinite(value)) ? value : 0;
    if (UNIT_KEY_RE.test(key)) return { min: 0, max: 1, step: 0.01 };
    if (FRACTION_KEY_RE.test(key)) return { min: 0, max: 0.05, step: 0.001 };
    if (/^(x|y)$/.test(key)) return { min: 0, max: 1, step: 0.01 };        // screen-space pos
    if (/(speed|rate|pulsespeed|scanspeed|rippleSpeed)/i.test(key)) {
      var sMax = Math.max(10, Math.abs(def) * 4 || 10);
      return { min: 0, max: sMax, step: sMax > 100 ? 1 : 0.1 };
    }
    if (/(power|rimpower)/i.test(key)) return { min: 0.5, max: 8, step: 0.1 };
    if (/(count|max|samples|segments|steps|ghosts|width)/i.test(key)) {
      var cMax = Math.max(16, Math.ceil(Math.abs(def) * 4) || 16);
      return { min: 0, max: cMax, step: 1 };
    }
    if (/(duration|life|height|area)/i.test(key)) {
      var dMax = Math.max(10, Math.abs(def) * 4 || 10);
      return { min: 0, max: dMax, step: 0.05 };
    }
    // generic: span a reasonable window around the default.
    var mag = Math.abs(def);
    var max = (mag <= 1) ? 2 : Math.ceil(mag * 4);
    var min = def < 0 ? -max : 0;
    var step = (max - min) <= 4 ? 0.01 : (max - min <= 100 ? 0.1 : 1);
    return { min: min, max: max, step: step };
  }

  /* pick min/max/step for each component of a numeric vector. */
  function vectorRange(key, arr) {
    if (/gravity/i.test(key)) return { min: -40, max: 40, step: 0.1 };
    if (/(life|size)/i.test(key)) return { min: 0, max: 10, step: 0.01 };
    if (/(from|to|origin|world|position|center)/i.test(key)) return { min: -50, max: 50, step: 0.1 };
    if (/offset/i.test(key)) return { min: -500, max: 500, step: 1 };
    // generic vector span around the largest component
    var mag = 1;
    for (var i = 0; i < arr.length; i++) { var a = Math.abs(arr[i] || 0); if (a > mag) mag = a; }
    var max = Math.ceil(mag * 4);
    return { min: -max, max: max, step: (max <= 4 ? 0.01 : 0.1) };
  }

  /* Classify a single param into a control descriptor. */
  function inferControl(key, value, effectName) {
    // explicit enum params first
    if (ENUM_OPTIONS[key]) {
      return { type: 'select', options: ENUM_OPTIONS[key].slice(), default: (typeof value === 'string' ? value : ENUM_OPTIONS[key][0]) };
    }
    // booleans
    if (typeof value === 'boolean') return { type: 'bool', default: value };
    // numbers (incl. hex colour numbers, disambiguated by key name)
    if (typeof value === 'number') {
      if (COLOR_KEY_RE.test(key) && value > 255) {
        // a hex colour packed as a number (e.g. 0x6fe9ff)
        return { type: 'color', default: colorDefault(value) };
      }
      var r = numberRange(key, value);
      return { type: 'number', min: r.min, max: r.max, step: r.step, default: value };
    }
    // strings
    if (typeof value === 'string') {
      // CSS / font / free text -> text widget
      return { type: 'text', default: value };
    }
    // arrays: colour [r,g,b], colour PALETTE [hex...], or numeric vector
    if (Array.isArray(value)) {
      // palette: array of hex colour numbers (or array of [r,g,b] arrays)
      if (/palette/i.test(key)) {
        var stops = value.map(function (c) { return colorDefault(c); });
        return { type: 'colorList', default: stops };
      }
      // a [r,g,b] colour: length 3 + a colour-ish key, values in 0..1
      if (value.length === 3 && COLOR_KEY_RE.test(key) && allInUnit(value)) {
        return { type: 'color', default: cloneDefault(value) };
      }
      // a plain colour key with 3 unit floats even if name not matched strongly
      if (value.length === 3 && /tint|color/i.test(key) && allInUnit(value)) {
        return { type: 'color', default: cloneDefault(value) };
      }
      // numeric vector (2 or 3)
      if ((value.length === 2 || value.length === 3) && value.every(isNum)) {
        var vr = vectorRange(key, value);
        return { type: 'vector', length: value.length, min: vr.min, max: vr.max, step: vr.step, default: cloneDefault(value) };
      }
      // generic numeric array (e.g. chart data) -> a numberList widget
      if (value.every(isNum)) return { type: 'numberList', default: cloneDefault(value) };
      // fallback: opaque list
      return { type: 'list', default: cloneDefault(value) };
    }
    // null / object (e.g. world:null, mesh:null) -> a nullable reference slot
    if (value === null || typeof value === 'object') {
      return { type: 'ref', default: null };
    }
    // last-resort
    return { type: 'text', default: String(value) };
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function allInUnit(arr) { for (var i = 0; i < arr.length; i++) { if (arr[i] < 0 || arr[i] > 1) return false; } return true; }

  /* merge an override descriptor over an inferred one (override wins per-key,
     keeps the inferred default if the override omits one). */
  function applyOverride(inferred, over) {
    if (!over) return inferred;
    var out = {};
    var k;
    for (k in inferred) if (Object.prototype.hasOwnProperty.call(inferred, k)) out[k] = inferred[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    if (out.default === undefined && inferred.default !== undefined) out.default = inferred.default;
    return out;
  }

  var _controlsCache = Object.create(null);

  /* Build (and cache) the controls map for an effect's flat default params. */
  function controlsFor(effectName, params) {
    if (_controlsCache[effectName]) return _controlsCache[effectName];
    var out = {};
    var starOver = CONTROL_OVERRIDES['*'] || {};
    var effOver = CONTROL_OVERRIDES[effectName] || {};
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var desc = inferControl(key, params[key], effectName);
      // per-effect override beats global '*' override
      if (effOver[key]) desc = applyOverride(desc, effOver[key]);
      else if (starOver[key]) desc = applyOverride(desc, starOver[key]);
      // re-attach the actual default value if an override changed the type but not default
      if (desc.default === undefined) desc.default = cloneDefault(params[key]);
      out[key] = desc;
    }
    _controlsCache[effectName] = out;
    return out;
  }

  /* =========================================================================
   *  three.quarks IMPORT / EXPORT  (VFX.importQuarks / VFX.exportQuarks)
   *
   *  three.quarks (https://quarks.art, npm three.quarks @0.17.x) serialises a
   *  ParticleSystem to a flat JSON (ParticleSystemJSONParameters). This module maps
   *  the COMMON subset of that JSON onto one of our GPU-particle emitters and back.
   *  It NEVER throws and ignores unknown fields — headless / guarded.
   *
   *  SCHEMA SOURCE: fetched from cdn.jsdelivr.net (three.quarks 0.17.1 dist types +
   *  quarks.core esm) at authoring time. The exact shapes used:
   *
   *  ParticleSystemJSONParameters (subset we read/write):
   *    { version, looping, duration, worldSpace,
   *      shape:      ShapeJSON,
   *      startLife:  FunctionJSON,   startSpeed: FunctionJSON,
   *      startSize:  FunctionJSON,   startColor: ColorJSON,
   *      emissionOverTime: FunctionJSON,
   *      emissionBursts:   [ BurstJSON ],
   *      behaviors:  [ BehaviorJSON ] }
   *
   *  ShapeJSON   : { type:'sphere'|'cone'|'point'|'donut'|'circle'|'hemisphere'|'grid'
   *                       |'rectangle'|'mesh_surface', radius, arc, thickness, angle,
   *                  mode, spread, speed:FunctionJSON }
   *  FunctionJSON (ValueGenerator): one of
   *                  { type:'ConstantValue', value }
   *                  { type:'IntervalValue', a, b }
   *                  { type:'PiecewiseBezier', functions:[{function,start}] }   (we read end y)
   *  ColorJSON   : { type:'ConstantColor', color:{r,g,b,a} }
   *                { type:'ColorRange',    a:{r,g,b,a}, b:{r,g,b,a} }
   *                { type:'Gradient'|'RandomColor'|... }  (we sample first/last stop)
   *  BurstJSON   : { time, count:(number|FunctionJSON), cycle, interval, probability }
   *  BehaviorJSON: { type:'ApplyForce', direction:[x,y,z], magnitude:FunctionJSON }
   *                { type:'GravityForce', center:[x,y,z], magnitude:number }
   *                { type:'ColorOverLife', color:ColorJSON }      -> end colour
   *                { type:'SizeOverLife',  size:FunctionJSON }     -> end size factor
   *                (other behaviors are ignored gracefully)
   *
   *  MAPPING onto our emitter params (see GPU PARTICLES family):
   *    shape.type + radius/angle  -> origin (0) + spread (0..1) + size of emission cone
   *    shape.speed / startSpeed   -> speed (mid of interval)
   *    emissionOverTime           -> rate (particles/sec)
   *    emissionBursts[].count     -> burst (sum of one-shot counts at time 0)
   *    startLife                  -> life [min,max]
   *    startSize                  -> size [start,end] (end via SizeOverLife if present)
   *    startColor                 -> color  ([r,g,b], sub-white)
   *    ColorOverLife end / range b-> color2 ([r,g,b])
   *    ApplyForce / GravityForce  -> gravity [x,y,z]  (force direction*magnitude, or
   *                                  pull toward center)
   *  We always import as our generic 'sparks'-style emitter UNLESS opts.effect names
   *  a specific emitter (e.g. 'smoke'); the mapped params are merged over that
   *  emitter's defaults so anything we couldn't read keeps a sensible value.
   * ====================================================================== */

  var QUARKS_VERSION = '3.0';   // schema version we stamp on export (three.quarks fmt)

  /* read a three.quarks FunctionJSON (ValueGenerator) into {min,max,mid,end}. Robust
     to a bare number too. Returns null when unreadable. */
  function readQuarksValue(fn) {
    if (fn == null) return null;
    if (typeof fn === 'number' && isFinite(fn)) return { min: fn, max: fn, mid: fn, end: fn };
    if (typeof fn !== 'object') return null;
    var t = fn.type;
    if (t === 'ConstantValue' && isNum(fn.value)) {
      return { min: fn.value, max: fn.value, mid: fn.value, end: fn.value };
    }
    if (t === 'IntervalValue' && (isNum(fn.a) || isNum(fn.b))) {
      var a = isNum(fn.a) ? fn.a : 0, b = isNum(fn.b) ? fn.b : a;
      return { min: Math.min(a, b), max: Math.max(a, b), mid: (a + b) / 2, end: b };
    }
    if (t === 'PiecewiseBezier' && Array.isArray(fn.functions) && fn.functions.length) {
      // a list of [{ function: {p:[p0,p1,p2,p3]}, start }]; read first p0 + last p3.
      var first = fn.functions[0], last = fn.functions[fn.functions.length - 1];
      var p0 = first && first.function && first.function.p && first.function.p[0];
      var pN = last && last.function && last.function.p && last.function.p[3];
      var s = isNum(p0) ? p0 : 0, e = isNum(pN) ? pN : s;
      return { min: Math.min(s, e), max: Math.max(s, e), mid: (s + e) / 2, end: e };
    }
    // unknown generator: try a flat .value / .a fallback
    if (isNum(fn.value)) return { min: fn.value, max: fn.value, mid: fn.value, end: fn.value };
    if (isNum(fn.a)) { var av = fn.a, bv = isNum(fn.b) ? fn.b : av; return { min: Math.min(av, bv), max: Math.max(av, bv), mid: (av + bv) / 2, end: bv }; }
    return null;
  }

  /* read a three.quarks ColorJSON into { start:[r,g,b], end:[r,g,b] } (sub-white). */
  function readQuarksColor(cj) {
    if (!cj || typeof cj !== 'object') return null;
    function rgb(o) {
      if (!o) return null;
      // {r,g,b,a} floats 0..1
      if (isNum(o.r) || isNum(o.g) || isNum(o.b)) return [o.r || 0, o.g || 0, o.b || 0];
      return null;
    }
    var t = cj.type;
    if (t === 'ConstantColor') { var c = rgb(cj.color); if (c) return { start: c, end: c }; }
    if (t === 'ColorRange' || t === 'RandomColor') {
      var a = rgb(cj.a), b = rgb(cj.b);
      if (a || b) return { start: a || b, end: b || a };
    }
    if (t === 'Gradient' || t === 'RandomColorBetweenGradient') {
      // sample first + last keys of the continuous-linear colour function.
      var fnc = cj.color || (cj.gradient1 && cj.gradient1.color);
      if (fnc && Array.isArray(fnc.keys) && fnc.keys.length) {
        var k0 = fnc.keys[0], kN = fnc.keys[fnc.keys.length - 1];
        var s = k0 && k0.value, e = kN && kN.value;
        var sc = s ? [s.r || 0, s.g || 0, s.b || 0] : null;
        var ec = e ? [e.r || 0, e.g || 0, e.b || 0] : null;
        if (sc || ec) return { start: sc || ec, end: ec || sc };
      }
    }
    // bare {r,g,b}
    var bare = rgb(cj);
    if (bare) return { start: bare, end: bare };
    return null;
  }

  /* Map a parsed three.quarks JSON onto our emitter param overrides. Pure + guarded. */
  function quarksToParams(json) {
    var over = {};
    if (!json || typeof json !== 'object') return over;

    // --- emission rate (emissionOverTime) ---
    var rate = readQuarksValue(json.emissionOverTime);
    if (rate) over.rate = Math.max(0, rate.mid);

    // --- bursts (one-shots at/near time 0) ---
    if (Array.isArray(json.emissionBursts) && json.emissionBursts.length) {
      var burstSum = 0;
      for (var bi = 0; bi < json.emissionBursts.length; bi++) {
        var bj = json.emissionBursts[bi] || {};
        var cnt = (typeof bj.count === 'number') ? bj.count : (readQuarksValue(bj.count) ? readQuarksValue(bj.count).mid : 0);
        if (isNum(cnt)) burstSum += cnt;
      }
      if (burstSum > 0) over.burst = Math.round(burstSum);
    }

    // --- lifetime ---
    var life = readQuarksValue(json.startLife);
    if (life) over.life = [Math.max(0.001, life.min), Math.max(life.min, life.max)];

    // --- size (start) + end via SizeOverLife behaviour ---
    var size = readQuarksValue(json.startSize);
    var startSize = size ? size.mid : null;

    // --- speed: prefer shape.speed, fall back to startSpeed ---
    var shape = json.shape || {};
    var speed = readQuarksValue(shape.speed) || readQuarksValue(json.startSpeed);
    if (speed) over.speed = Math.max(0, speed.mid);

    // --- emitter shape -> spread + origin ---
    over.origin = [0, 0, 0];
    var st = shape.type;
    if (st === 'cone') {
      // cone angle (radians) -> spread 0..1 over a quarter-turn
      var ang = isNum(shape.angle) ? shape.angle : 0.3;
      over.spread = clamp(ang / (Math.PI * 0.5), 0, 1);
    } else if (st === 'sphere' || st === 'hemisphere') {
      over.spread = 1.0;
    } else if (st === 'point') {
      over.spread = 0.0;
    } else if (st === 'donut' || st === 'circle' || st === 'rectangle' || st === 'grid') {
      over.spread = 0.6;
    }
    // shape.radius -> an emission area hint where the emitter supports it
    if (isNum(shape.radius)) over.area = shape.radius;

    // --- start colour ---
    var sc = readQuarksColor(json.startColor);
    if (sc) { over.color = sc.start; if (sc.end) over.color2 = sc.end; }

    // --- behaviours: ColorOverLife (end colour), SizeOverLife (end size), forces ---
    var gx = 0, gy = 0, gz = 0, haveForce = false;
    if (Array.isArray(json.behaviors)) {
      for (var i = 0; i < json.behaviors.length; i++) {
        var bh = json.behaviors[i] || {};
        switch (bh.type) {
          case 'ColorOverLife': {
            var col = readQuarksColor(bh.color);
            if (col && col.end) over.color2 = col.end;
            break;
          }
          case 'SizeOverLife': {
            var so = readQuarksValue(bh.size);
            if (so && startSize != null) {
              // size factor over life: end = start * factor.end
              over.size = [startSize, Math.max(0, startSize * so.end)];
            }
            break;
          }
          case 'ApplyForce': {
            var dir = bh.direction;
            var mag = readQuarksValue(bh.magnitude);
            var m = mag ? mag.mid : 1;
            if (Array.isArray(dir)) { gx += (dir[0] || 0) * m; gy += (dir[1] || 0) * m; gz += (dir[2] || 0) * m; haveForce = true; }
            break;
          }
          case 'GravityForce': {
            // pull toward a center: approximate as a downward-ish constant via -magnitude on Y
            var gm = isNum(bh.magnitude) ? bh.magnitude : 0;
            gy -= gm * 0.01; haveForce = true;
            break;
          }
          default: break;   // ignore unknown behaviours gracefully
        }
      }
    }
    if (haveForce) over.gravity = [gx, gy, gz];
    // if SizeOverLife absent but we read a start size, set a flat size pair.
    if (over.size == null && startSize != null) over.size = [startSize, startSize];

    return over;
  }

  /* choose which of our emitters to instantiate for an imported system. */
  function chooseQuarksEmitter(json, opts) {
    if (opts && opts.effect && REGISTRY[opts.effect] && REGISTRY[opts.effect].family === 'emitter' && PARTICLE_EMITTERS[opts.effect]) {
      return opts.effect;
    }
    // light heuristic from the shape / blending; default to 'sparks' (generic).
    return 'sparks';
  }

  /**
   * VFX.importQuarks — map a three.quarks ParticleSystem JSON onto one of our GPU
   * particle emitters and spawn it. Returns the particle handle (with burst()), or
   * an inert handle headless. NEVER throws; unknown fields are ignored.
   *
   * @param {object|string} json  a three.quarks ParticleSystemJSONParameters object
   *                               (or a JSON string of one). Garbage / empty is safe.
   * @param {object} [opts]  { effect:'<emitterName>' to force a target emitter,
   *                           origin:[x,y,z], seed:int, ...any emitter param override }
   * @returns {object} the emitter handle { update, setParams, burst, dispose, group }.
   */
  function importQuarks(json, opts) {
    opts = opts || {};
    // accept a JSON string too
    if (typeof json === 'string') {
      try { json = JSON.parse(json); } catch (_) { json = null; }
    }
    var mapped = {};
    try { mapped = quarksToParams(json); } catch (_) { mapped = {}; }
    // caller overrides (origin / seed / explicit params) win over the mapping.
    var merged = withDefaults(mapped, opts);
    delete merged.effect;   // not an emitter param
    var name = chooseQuarksEmitter(json, opts);
    var h = spawn(name, merged);
    // tag the handle so exportQuarks can round-trip the mapped params.
    try { if (h && typeof h === 'object') { h._quarksName = name; h._quarksParams = merged; } } catch (_) {}
    return h;
  }

  /* build a three.quarks ConstantValue / IntervalValue FunctionJSON. */
  function quarksConst(v) { return { type: 'ConstantValue', value: +v || 0 }; }
  function quarksInterval(a, b) {
    a = +a || 0; b = (b == null) ? a : (+b || 0);
    if (a === b) return quarksConst(a);
    return { type: 'IntervalValue', a: a, b: b };
  }
  /* build a three.quarks ColorJSON {r,g,b,a} (sub-white clamped). */
  function quarksColor(c) {
    var col = colorOf(c, 0.9);
    return { r: col.r, g: col.g, b: col.b, a: 1 };
  }

  /**
   * VFX.exportQuarks — produce a best-effort three.quarks-shaped ParticleSystem JSON
   * from one of OUR emitter handles (or a {name, params} descriptor). Maps the common
   * fields back; fields three.quarks needs but we don't model get sensible defaults.
   * NEVER throws (returns a minimal valid JSON on any failure).
   *
   * @param {object} handle  a handle returned by VFX.spawn()/importQuarks() (we read
   *                         handle._params/_name if present), OR a plain
   *                         { name:'<emitter>', params:{...} } descriptor.
   * @returns {object} a three.quarks ParticleSystemJSONParameters-shaped object.
   */
  function exportQuarks(handle) {
    // resolve the source params + emitter name from whatever we were handed.
    var name = 'sparks', p = null;
    try {
      if (handle && typeof handle === 'object') {
        if (handle._quarksName) name = handle._quarksName;
        else if (handle.name && REGISTRY[handle.name]) name = handle.name;
        if (handle._quarksParams) p = handle._quarksParams;
        else if (handle.params) p = handle.params;
      }
    } catch (_) {}
    if (!p) {
      var desc = REGISTRY[name] || REGISTRY.sparks;
      p = desc ? desc.params : {};
    }
    p = p || {};

    // helpers reading our params with defaults from the registry where missing.
    var defaults = (REGISTRY[name] && REGISTRY[name].params) || {};
    function val(k, d) { return (p[k] != null) ? p[k] : (defaults[k] != null ? defaults[k] : d); }

    var life = val('life', [1, 1]);
    var size = val('size', [1, 1]);
    var grav = val('gravity', [0, 0, 0]);
    var spread = val('spread', 1);
    var speed = val('speed', 1);
    var rate = val('rate', 0);
    var burst = val('burst', 0);

    var json = {
      version: QUARKS_VERSION,
      autoDestroy: false,
      looping: true,
      prewarm: false,
      duration: 1,
      worldSpace: true,
      shape: {
        type: (spread >= 0.95) ? 'sphere' : (spread <= 0.05 ? 'point' : 'cone'),
        radius: isNum(val('area', null)) ? val('area', 1) : 1,
        arc: Math.PI * 2,
        thickness: 1,
        angle: clamp(spread, 0, 1) * (Math.PI * 0.5),
        mode: 0,
        spread: 0,
        speed: quarksConst(speed)
      },
      startLife: quarksInterval(life[0], life[1]),
      startSpeed: quarksConst(speed),
      startRotation: quarksConst(0),
      startSize: quarksInterval(size[0], size[1] != null ? size[1] : size[0]),
      startColor: { type: 'ConstantColor', color: quarksColor(val('color', [1, 1, 1])) },
      emissionOverTime: quarksConst(rate),
      emissionOverDistance: quarksConst(0),
      emissionBursts: (burst > 0) ? [{ time: 0, count: burst, cycle: 1, interval: 0.01, probability: 1 }] : [],
      onlyUsedByOther: false,
      rendererEmitterSettings: {},
      renderMode: 0,
      startTileIndex: 0,
      uTileCount: 1,
      vTileCount: 1,
      blending: additiveBlend(),
      transparent: true,
      material: '',
      behaviors: []
    };

    // SizeOverLife: if start != end size, emit a SizeOverLife behaviour (end factor).
    try {
      if (Array.isArray(size) && size.length >= 2 && size[0] && size[1] != null && size[1] !== size[0]) {
        var factor = size[0] ? (size[1] / size[0]) : 1;
        json.behaviors.push({ type: 'SizeOverLife', size: { type: 'PiecewiseBezier', functions: [{ function: { type: 'Bezier', p: [1, (1 + factor) / 2, (1 + factor) / 2, factor] }, start: 0 }] } });
      }
    } catch (_) {}

    // ColorOverLife: if color2 differs from color, emit a ColorOverLife (range -> end).
    try {
      var c2 = val('color2', null);
      if (c2 != null) {
        json.behaviors.push({ type: 'ColorOverLife', color: { type: 'ColorRange', a: quarksColor(val('color', [1, 1, 1])), b: quarksColor(c2) } });
      }
    } catch (_) {}

    // gravity / force -> ApplyForce behaviour (direction*magnitude).
    try {
      if (Array.isArray(grav) && (grav[0] || grav[1] || grav[2])) {
        var gm = Math.sqrt(grav[0] * grav[0] + grav[1] * grav[1] + grav[2] * grav[2]) || 1;
        var dir = [grav[0] / gm, grav[1] / gm, grav[2] / gm];
        json.behaviors.push({ type: 'ApplyForce', direction: dir, magnitude: quarksConst(gm) });
      }
    } catch (_) {}

    return json;
  }

  /* =========================================================================
   *  CORE LIFECYCLE  — init / dispose / reset / update / list.
   * ====================================================================== */

  /**
   * Wire the host. Idempotent: calling again re-wires (disposes prior live effects).
   * Headless-safe: with no usable THREE/renderer/DOM it records the opts but every
   * entry point stays inert (ready=false).
   */
  function init(opts) {
    opts = opts || {};
    // tear down any prior session's live effects (but keep registry/pool definitions).
    teardownLive();

    H.THREE = opts.THREE || (typeof root.THREE !== 'undefined' ? root.THREE : null);
    H.renderer = opts.renderer || null;
    H.scene = opts.scene || null;
    H.camera = opts.camera || null;
    H.composer = opts.composer || null;
    H.clock = opts.clock || null;
    H.reduceMotion = !!opts.reduceMotion;

    // viewport size (best-effort; never throws).
    try {
      if (opts.width && opts.height) { H.width = opts.width; H.height = opts.height; }
      else if (H.renderer && typeof H.renderer.getSize === 'function') {
        var sz = H.renderer.getSize(vec2());
        if (sz && sz.x) { H.width = sz.x; H.height = sz.y; }
      } else if (typeof root.innerWidth === 'number') {
        H.width = root.innerWidth || H.width; H.height = root.innerHeight || H.height;
      }
      if (H.renderer && typeof H.renderer.getPixelRatio === 'function') H.pixelRatio = H.renderer.getPixelRatio() || 1;
    } catch (_) { /* keep defaults */ }

    // READY only when THREE is a usable object. (POST additionally needs composer+ShaderPass,
    // checked lazily by havePost(); emitter/material families need scene, checked at build.)
    H.ready = !!(H.THREE && typeof H.THREE === 'object');
    return root.VFX;
  }

  /** Dispose every live effect + POST pass + pooled resource; return to pre-init state. */
  function dispose() {
    teardownLive();
    POOL.clear();
    H.THREE = null; H.renderer = null; H.scene = null; H.camera = null;
    H.composer = null; H.clock = null; H.reduceMotion = false; H.ready = false;
  }

  /** Tear down all live effects + POST passes without clearing the pool or host refs. */
  function teardownLive() {
    // remove POST passes from the composer first
    for (var i = postStack.length - 1; i >= 0; i--) {
      try { composerRemove(postStack[i].pass); } catch (_) {}
      try { postStack[i].fx.dispose(); } catch (_) {}
    }
    postStack.length = 0;
    // dispose remaining live effects (emitter/attach/material/infographic)
    for (var j = liveEffects.length - 1; j >= 0; j--) {
      try { if (typeof liveEffects[j].dispose === 'function') liveEffects[j].dispose(); } catch (_) {}
    }
    liveEffects.length = 0;
  }

  /** Reset = tear down live effects but keep the host wired (re-arm). */
  function reset() {
    teardownLive();
  }

  /**
   * THE per-frame hook. Advances every live effect. No-op when:
   *   - not ready (headless / pre-init), OR
   *   - reduceMotion is true (effects snap to their static resting frame: time-driven
   *     passes freeze their phase uniform, so no animation advances).
   * Zero per-frame allocation: uniforms are mutated in place.
   * @param {number} dt       delta seconds since last frame.
   * @param {number} elapsed  total elapsed seconds (from the host clock).
   */
  function update(dt, elapsed) {
    if (!H.ready) return;            // headless / pre-init: silent no-op
    if (H.reduceMotion) return;      // reduced-motion: freeze (static resting frame)
    var t = elapsed;
    if (t == null && H.clock && typeof H.clock.getElapsedTime === 'function') {
      try { t = H.clock.getElapsedTime(); } catch (_) { t = 0; }
    }
    if (t == null) t = 0;
    var d = (typeof dt === 'number') ? dt : 0;
    for (var i = 0; i < liveEffects.length; i++) {
      var fx = liveEffects[i];
      if (fx && typeof fx.update === 'function') {
        try { fx.update(d, t); } catch (_) { /* one bad effect must not break the loop */ }
      }
    }
  }

  /**
   * The complete, in-sync effect registry for a UI to build controls from.
   *
   * Each entry is { name, family, category, kind, params, controls }:
   *   - params   the FLAT default-param map (numbers / [r,g,b] / vectors / strings) —
   *              UNCHANGED shape, so existing callers keep working.
   *   - category one of 'Post' | 'Particles' | 'Energy' | 'Material' | 'Infographic'.
   *   - controls paramKey -> a UI descriptor (see controlsFor / the doc block above):
   *                number -> { type:'number', min, max, step, default }
   *                color  -> { type:'color',  default:[r,g,b] }
   *                vector -> { type:'vector', length, min, max, step, default:[...] }
   *                select -> { type:'select', options:[...], default }
   *                bool   -> { type:'bool',   default }
   *                text   -> { type:'text',   default }    (free-form strings / fonts)
   *                colorList/numberList/list/ref -> list + nullable-reference slots
   * @returns {Array<{name,family,category,kind,params,controls}>}
   */
  function list() {
    var out = [];
    for (var name in REGISTRY) {
      if (Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
        var d = REGISTRY[name];
        // copy params so callers can't mutate the registry defaults
        var params = withDefaults(d.params, null);
        out.push({
          name: d.name,
          family: d.family,
          category: d.category || categoryFor(d.family, d.name),
          kind: d.kind,
          params: params,
          // ADDITIVE control metadata (cached per effect); covers EVERY param key.
          controls: controlsFor(d.name, d.params)
        });
      }
    }
    // stable ordering: family then name
    out.sort(function (a, b) {
      if (a.family !== b.family) return a.family < b.family ? -1 : 1;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return out;
  }

  /* =========================================================================
   *  PUBLIC SURFACE — attach window.VFX (fall back to globalThis).
   * ====================================================================== */
  var VFX = {
    init: init,
    dispose: dispose,
    reset: reset,
    update: update,
    list: list,
    post: postAPI,
    spawn: spawn,
    attach: attach,
    material: material,
    infographic: infographic,
    importQuarks: importQuarks,
    exportQuarks: exportQuarks,
    // internals exposed read-only for tooling/tests (not part of the stable contract)
    _registry: REGISTRY,
    _state: H
  };

  root.VFX = VFX;
  if (typeof module !== 'undefined' && module.exports) { try { module.exports = VFX; } catch (_) {} }

})();
