# Smart Factory hall — glTF model drop-in (GLTFLoader)

The Smart Factory hall is wired (in `magnate-3d-three.html`) to upgrade its
elements to artist-made **glTF/GLB** models via Three.js `GLTFLoader`. Each model
is **optional + decorative**: if its file is missing, GLTFLoader is unavailable,
or the page runs headless, the hall keeps its **procedural** look (no breakage).

## How it works
`FACTORY_MODELS` maps a logical key → a **relative** path under this folder
(`assets/factory/<key>.glb`). Relative paths resolve both for the local dev
server (`prototype/` root) and on GitHub Pages (`magnate-site/` root).

Every element TYPE in the hall is now swap-wired in place — drop the matching
`.glb` and that element upgrades the moment it loads, riding the same animated
group so motion continues. Until then the procedural look is used.

| Key | Element it upgrades | Count | Wiring | Status |
|---|---|---|---|---|
| `robot.glb` | floor robots placed in the hall | 4 | additive `placeFactoryModel` | **bundled** (demo) |
| `agv.glb` | AGVs (guide-line tugs, rigid loop) | 3 | `swapFactoryVisual` (animation continues) | drop-in |
| `amr.glb` | AMRs (free-roaming, waypoint-hopping) | 4 | `swapFactoryVisual` | drop-in |
| `machine.glb` | machine STATIONS (plinth/housing/panel/vent) | 10 | `swapFactoryVisual` (per-station group) | drop-in |
| `robotarm.glb` | articulated robot ARMS at each station | 10 | `swapFactoryVisual` (arm sweep continues) | drop-in |
| `rack.glb` | storage RACKING runs (north wall) | 5 | `swapFactoryVisual` (per-rack group) | drop-in |
| `crate.glb` | conveyor GOODS / totes on the loops | 14 | `swapFactoryVisual` (loop keeps sliding) | drop-in |
| `worker.glb` | walking WORKERS on the aisles | 8 | `swapFactoryVisual` (walk loop continues) | drop-in |
| `forklift.glb` | FORKLIFTS on the aisle circuit | 2 | `swapFactoryVisual` (loop keeps driving) | drop-in |
| `conveyor.glb` | conveyor belt segments (reserved) | — | `FACTORY_MODELS.conveyor` (manifest completeness) | drop-in |

Models are auto-scaled to a sensible height and seated on the floor, so you don't
need to pre-normalise them.

## Get the Kenney CC0 models
> The build sandbox can't reach `kenney.nl` (firewalled), so the Kenney kits
> aren't bundled — but **your machine can**. They are **CC0** (no attribution
> required, commercial OK).

1. Download a kit from <https://kenney.nl/assets> — good ones for a factory:
   - **Conveyor Kit**, **Mini Factory / Industrial**, **Vehicle / Forklift**,
     **Robot** packs.
2. Each kit ships `.glb` (or `.gltf`) per object. Pick one model per role above.
3. **Rename + drop** them into `prototype/assets/factory/` using the keys in the
   table (e.g. a Kenney AGV → `agv.glb`, a CNC → `machine.glb`, a robot arm →
   `robotarm.glb`, a forklift → `forklift.glb`, a crate → `crate.glb`, a figure →
   `worker.glb`, a shelving unit → `rack.glb`, a robot → `robot.glb` to replace
   the demo).
4. Reload the page → the hall swaps the procedural elements for your models.
5. To publish, copy `prototype/assets/` into the published site repo
   (`magnate-site/assets/`) and push (the site is now a multi-file bundle).

## Bundled demo model
`robot.glb` is **RobotExpressive** from the three.js examples (by Tomás Laulhé,
CC0; modified by Don McCurdy) — included only as a live proof the loader works.
Replace it with a Kenney robot for the factory aesthetic.
