# Magnate — interactive 3D economy-sim + visualization-platform prototype

**▶ Live demo: https://hwchiu0810.github.io/magnate-viz/**

An interactive, browser-based **3D visualization** of *Magnate* (a Sim-Companies-style persistent
multiplayer business / economy simulation) **and** an evolving **matrix-data, math-driven
visualization platform** built on top of it. Companies source raw materials, run multi-tier
production, and trade on a uniform-price batch-auction market; the prototype renders that economy as
a living world — and the newer sections let you *build* visualizations from data, formulas, and VFX.

> **What this is — and isn't:** a *visualization of the game's design* + a platform demo, driven by a
> shared, deterministic, conservation-checked economy core. It is **not** the production multiplayer
> client — no servers, accounts, or real money. Everything runs client-side in your browser.

## Sections (12)
Switch with the buttons along the top:

- **🏭 Factory** — a boundaryless, infinitely-streamed supply-chain world (extraction → smelting →
  fabrication → assembly), with a central economy district of firm towers (height ∝ net worth).
- **🏛 Market** / **💰 Finance** — 3D **Sankeys** (supply-chain value / money flow; the finance one is
  ledger-tied).
- **🕸 Network** / **🏆 Leaderboard** — a trade-interconnection graph / companies ranked by net worth.
- **🏙 Smart City · 🛍 Shopping Mall** — focused **digital-twin** worlds: glowing wireframe structure,
  physics fields (thermal colormaps, a power grid, data-comms driven by the real trade graph), data
  packets, and a telemetry HUD.
- **🏭 Smart Factory** — a **networked OEE plant**: 26 machines / 41 conveyor belts across 8 stages
  (6 intake → machining → sub-assembly welds → distribution hubs → finishing → dual main-assembly hubs
  → QC / dispatch → pack → ship) with cross-connecting branches. **Function-specific machine models**
  (vertical mills, horizontal lathes, robotic weld cells, assembly hubs, inspection-scanner gates,
  boxing packers); each site runs at its own **throughput** that drives its belt speed; an **AGV fleet**
  plus a **QC pass/fail rework loop** whose carts physically ferry the rejected part back to a repair
  station; **multi-line Overhead Hoist Transfer** running across the ceiling; live **OEE = Availability
  × Performance × Quality** with interactive levers (per-site throughput, reliability, buffer size).
- **📦 ERP · Order-to-Cash** / **🤝 CRM · Sales Pipeline** — process-flow theaters where documents and
  deals move as 3D objects through stages. ERP models **Theory of Constraints** — the constraint
  workstation throttles throughput and starves the stations downstream; CRM is a sales-pipeline
  funnel-flow.
- **🛰 Digital Twin** — a multi-dynamic lab (power-grid / data-center-heat / data-comms / logistics).
- **🪐 VFX Lab — Scene Edit Mode** — a **41-effect real-time VFX library** (post · particles · energy ·
  material · infographic) with a category palette · management list · Tweakpane parameter panel · live
  preview; an **Object + VFX Builder** (place objects + apply effects by **formula or prompt**); and a
  **Data → Viz** panel — pick a matrix → project (PCA/MDS) → encode (position/scale/color) → watch it
  become a visualization, powered by the platform's `engine/` modules.

## Controls
- **Orbit** by dragging; **scroll** to zoom; toggle **roam** to fly the streamed world.
- **Click** a firm tower / exchange to **inspect** it (balances, recent trades, net-worth sparkline).
- **Scrub the timeline** to replay recent history. **B** toggles digital-twin render mode.
- **Select & move** objects in any section — arm pick-mode and click (Shift for multi-select), drag the
  3-axis transform gizmo, **pin** so moves stick on animated objects, and **save / export** the layout.
- Respects `prefers-reduced-motion` — animation freezes if your system requests it.

## Tech
- **Three.js r128** + selective **bloom + ACES** tone-mapping (sub-white emissive → no white-out);
  **Tweakpane** powers the editor panels — both from CDN.
- A **deterministic, conservation-checked economy core** (the four ledger accounts `WORLD_FAUCET`,
  `SINK_BURN`, `NPC_DESK`, `CONTRACT_ESCROW` always balance) shared with the design's headless model.
- The **visualization-platform engine** (`engine/`, native ES modules): a matrix/tensor data store, N-D
  projections, and a declarative `data → visual-channel` encoding grammar — the same pure functions a
  headless conformance harness freezes byte-identically.

## Layout / run locally
A **multi-file** static site (the engine loads as native ES modules, so it isn't a single file):
```
index.html              → redirects to prototype/magnate-3d-three.html
prototype/              the 3D view + 2D dashboard + classic scripts + dataviz.mjs + assets
engine/                 the platform engine (ES modules: data · transform · encode · …)
```
```bash
# any static server from the repo root works:
python3 -m http.server 8000        # then open http://localhost:8000/
```
The `engine/` modules resolve via relative paths, so it works at the site root and on GitHub project Pages.

## Credits
Built with [Three.js](https://threejs.org/) (MIT) + [Tweakpane](https://tweakpane.github.io/) (MIT),
from CDN. A prototype visualization of the Magnate design + platform — not the production game.
