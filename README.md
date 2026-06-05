# Magnate — interactive 3D economy-sim prototype

**▶ Live demo: https://hwchiu0810.github.io/magnate-viz/**

An interactive, browser-based **3D visualization** of *Magnate* — a Sim-Companies-style persistent
multiplayer business / economy simulation. Companies source raw materials, run multi-tier
production, and trade on a uniform-price batch-auction market; this prototype renders that economy
as a living world. It runs entirely client-side from a single self-contained `index.html` (the
deterministic economy core and all visualization code are inlined); only the Three.js library loads
from a CDN.

> **What this is — and isn't:** a *visualization of the game's design*, driven by a shared,
> deterministic, conservation-checked economy core. It is **not** the production multiplayer client —
> there are no servers, accounts, or real money. Everything runs locally in your browser.

## Scenes
Switch scenes with the section buttons along the top:

- **🏭 Factory** — a boundaryless, infinitely-streamed production-line world. Tiles stream in and out
  as you roam, and each biome ring is a stage of the supply chain — **extraction → smelting →
  fabrication → assembly/packaging** — with conveyor belts, processing machines, goods riding the
  belts, and logistics trucks on the road network. At the center is the live economy district: firm
  towers whose height tracks each company's net worth, the exchange, and animated supply-chain flows
  arcing between the rooftops.
- **🏛 Market** — a 3D Sankey of supply-chain value: ribbon thickness is proportional to traded
  volume, with flow particles streaming along the band edges from node to node.
- **💰 Finance** — a 3D Sankey of money flow, tied to the ledger (mint → firms → sinks · desk · escrow).
- **🕸 Network** — a floating trade-interconnection graph (nodes = firms, edges = co-traded volume).
- **🏆 Leaderboard** — companies ranked by net worth.

## Controls
- **Orbit** the camera by dragging; **scroll** to zoom.
- **Click** a firm tower or the exchange to **inspect** it (balances, recent trades, a net-worth sparkline).
- **Scrub the timeline** to replay the economy's recent history.
- Toggle **roam** mode to fly through the streamed world.
- Respects `prefers-reduced-motion` — animation freezes if your system requests reduced motion.

## Tech
- **Three.js** (r128) rendering — kept crisp, with **no post-processing / bloom**.
- A **deterministic economy core** (shared with the design's headless model) that is conservation-checked:
  the four ledger accounts (`WORLD_FAUCET`, `SINK_BURN`, `NPC_DESK`, `CONTRACT_ESCROW`) always balance.
- **Procedurally-modeled** vehicles, factories, and towers — no external 3D-asset downloads, so the world
  stays a single self-contained file and streams with bounded memory.

## Run locally
```bash
# any static server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000/
```
(Or just open `index.html` directly in a browser — it only needs internet for the Three.js CDN script.)

## Credits
Built with [Three.js](https://threejs.org/) (MIT), loaded from CDN. This is a prototype visualization of
the Magnate game design, not the production game.
