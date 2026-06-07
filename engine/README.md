# `engine/` — the ENGINE CORE

The reusable, app-agnostic visualization engine. It imports **nothing** app-specific
(the engine/app import-firewall, **INV-6**), takes plain data (`NDArray` + declarative
encoding specs) and returns plain outputs (channel buffers, serializable descriptors).
**Magnate is App #1** — a *consumer*, never a dependency of the engine.

This README documents the **module-system model** ratified in **ADR-D1** and the
**extraction order** the platform follows. It is the reference for Story **P2.1**
(establish the native-ESM module boundaries) onward.

---

## The two-world module model (ADR-D1)

The platform runs **two coexisting module worlds**, on purpose, with **no bundler in v1**:

| World | What | How it loads | Why |
|---|---|---|---|
| **App shell** (classic, GLOBAL) | the prototype HUD + render bootstrap + `econ-core.js` / `viz-panels.js` / `vfx.js` | classic `<script>` / `<script src=...>`; **three.js r128 as a GLOBAL `window.THREE`** classic build (CDN), zero-build | preserves the running CDN prototype + the headless `node:vm` testing exactly as-is; **WebGPU + r150+ ESM-only is post-v1** (INV-7) |
| **Engine** (native ESM) | `engine/**` modules (`core`, then `objects`/`scenes`/`dynamics`, …) | native **ES modules** resolved via an **import-map**, loaded by a `<script type="module">` | native ESM gives the **static module boundaries** the import-firewall (INV-6) needs — *without introducing a toolchain* |

The app shell stays **GLOBAL-THREE / zero-build**; the engine extracts to **native ESM**.
The two worlds meet only at the **runtime host contract** (below) — never via cross-imports.

### Import-map + `<script type="module">`

In the prototype (`prototype/magnate-3d-three.html`) the boundary is established
**additively** (P2.1):

```html
<!-- (a) import-map: bare/prefix specifiers -> engine ESM files (no bundler) -->
<script type="importmap">
{ "imports": { "engine/": "./engine/", "engine/core": "./engine/core/index.mjs" } }
</script>

<!-- (b) module bootstrap: PROVE the boundary loads in-page (window.__engine) -->
<script type="module">
  import core from 'engine/core';
  window.__engine = core;            // boundary proof; classic app code is untouched
</script>
```

This is **behavior-neutral**: it loads the engine boundary alongside the app, stashes a
handle for inspection, and changes **no** scene / economy / encoding / streaming / render
logic. The classic inline app scripts are the single source of runtime truth, unchanged.

> Evergreen browsers only — native import-map support is assumed (NFR9). The gating
> test suite is plain Node ≥20 ESM + `node:vm`, no GPU.

### The headless harness only evaluates the CLASSIC app scripts

The conformance loader (`conformance/lib/headless.mjs`) loads the prototype's **classic
inline `<script>` blocks** into a stubbed-THREE/DOM scope and reads the in-prototype probe
contracts (`__magnateHeadless` / `__worldHeadless` / `__smartFactoryHeadless`). It
**SKIPS** `<script type="module">` and `<script type="importmap">` blocks (and CDN
`<script src=...>`), so `verify_city` / `verify_world` / `run.mjs` evaluate **exactly the
same classic economy/encoding/streaming logic as before** — the engine ESM boundary is
additive and does not enter the headless economy harness. The engine modules are tested by
their **own** Node ESM tests (e.g. `engine/core/core.test.mjs`), GPU-free.

---

## Vendor is INJECTED, never imported (INV-6 / INV-7)

`engine/**` modules **never** hard-import THREE or Tweakpane. Vendor (and `renderer` /
`scene` / `camera` / `composer` / `clock` / `reduceMotion`) arrives **only** through the
runtime host contract — the same shape the live renderer and the headless harness both call:

```js
Engine.init({ THREE, renderer, scene, camera, composer, clock, reduceMotion });
Engine.update(dt, elapsed);   // single per-frame dispatcher; no-op headless / reduceMotion
Engine.dispose();             // frees all pools + live handles
Engine.reset();
```

This generalizes the proven `vfx.js` `VFX.init({ THREE, ... })` pattern. Because vendor is
injected, every engine module:
- loads & evaluates with **no THREE and no DOM** present, never throwing (INV-1 headless);
- is statically free of `three` / `tweakpane` imports, so the import-firewall passes (INV-6);
- runs on three.js **r128 GLOBAL `window.THREE`** when the live app injects it (INV-7).

The firewall is enforced in CI by `ops/platform/firewall_check.mjs`, which scans every
`engine/**` source file and fails on (A) any import reaching into `apps/**` / `editor/**` /
`conformance/**` / an app-specific module, or (B) any hard import of THREE / Tweakpane.

---

## The D1 extraction order

The engine is extracted from the single-file prototype in this committed order
(ADR-D1; `vfx.js` was already split first):

```
vfx.js (DONE: IIFE -> window.VFX, 41-effect registry)
   |
core  ──►  objects  ──►  scenes  ──►  dynamics
(P2.1/P2.2)  (P2.3)       (P2.3)       (P2.3)
```

1. **`engine/core`** — the firewall **keystone** (P2.1, this story) and then the **kernel**
   (P2.2): registry base, deterministic clock, seeded `mulberry32` RNG, `dispose()`
   lifecycle, headless guards (`haveTHREE` / `havePost`), `reduceMotion` gate. It imports
   nothing app-specific and names no app — so it is the right place to *establish* the
   boundary first.
2. **`engine/objects`** — unified Object model (2D/2.5D/3D + infographic) + instancing
   (P2.3).
3. **`engine/scenes`** — Scene Manager: scene graph + section registry, camera/light
   presets, transitions, day/night (P2.3).
4. **`engine/dynamics`** — timeline/keyframe + matrix→trajectory motion + orchestration
   (P2.3).

`engine/runtime` (host bootstrap + frame dispatcher + ref-counted POOL) is stood up in
**P2.4**; Magnate becomes a consumer bundle under `apps/magnate/bindings/` in **P2.5**.

### `engine/core` keystone status (P2.1)

`engine/core/index.mjs` is a **native-ESM keystone**, not yet the kernel. It exports a
`VERSION`, a doc header, and clearly-marked **placeholders** for the P2.2 kernel surface
(`createRegistry` / `createClock` / `makeRng` / `haveTHREE` / `havePost` / `reduceMotion`
/ `dispose`) — real ESM, headless-safe no-ops. It establishes the module boundary and lets
the INV-6 firewall mechanically cover a real ESM module **before** the kernel logic is
extracted in P2.2.

---

## Current contents

| Path | Status | Notes |
|---|---|---|
| `engine/core/index.mjs` | **P2.1 keystone** | native-ESM boundary keystone + P2.2 placeholders; no THREE/Tweakpane/app imports |
| `engine/core/core.test.mjs` | **P2.1 test** | Node ≥20 ESM; loads core with no THREE/DOM, asserts surface + no forbidden/hard-vendor import |
| `engine/serialize/` | P1.4 skeleton | project-document schema-v1 (`index.mjs` / `project.schema.json` / `example.project.json` / `serialize.test.mjs`) |

`data/`, `transform/`, `encode/`, `objects/`, `scenes/`, `dynamics/`, `vfx/`, `copilot/`,
`runtime/` land with their respective epics (P2–P6).
