# Smart Factory hall — glTF model drop-in (GLTFLoader)

The Smart Factory hall is wired (in `magnate-3d-three.html`) to upgrade its
elements to artist-made **glTF/GLB** models via Three.js `GLTFLoader`. Each model
is **optional + decorative**: if its file is missing, GLTFLoader is unavailable,
or the page runs headless, the hall keeps its **procedural** look (no breakage).

## How it works
`FACTORY_MODELS` maps a logical key → a **relative** path under this folder
(`assets/factory/<key>.glb`). Relative paths resolve both for the local dev
server (`prototype/` root) and on GitHub Pages (`magnate-site/` root).

| Key | What it upgrades | Wiring | Status |
|---|---|---|---|
| `robot.glb` | floor robots (4, placed in the hall) | additive `placeFactoryModel` | **bundled** (demo) |
| `agv.glb` | the 3 AGVs (guide-line tugs) | `swapFactoryVisual` (animation continues) | drop-in |
| `amr.glb` | the 4 AMRs (free-roamers) | `swapFactoryVisual` | drop-in |
| `machine.glb` | CNC/assembly machines | `FACTORY_MODELS.machine` (extend `buildSmartFactoryHall`) | drop-in |
| `forklift.glb` | forklifts | extend | drop-in |
| `rack.glb` | storage racking | extend | drop-in |

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
   table (e.g. a Kenney AGV → `agv.glb`, a CNC → `machine.glb`, a robot →
   `robot.glb` to replace the demo).
4. Reload the page → the hall swaps the procedural elements for your models.
5. To publish, copy `prototype/assets/` into the published site repo
   (`magnate-site/assets/`) and push (the site is now a multi-file bundle).

## Bundled demo model
`robot.glb` is **RobotExpressive** from the three.js examples (by Tomás Laulhé,
CC0; modified by Don McCurdy) — included only as a live proof the loader works.
Replace it with a Kenney robot for the factory aesthetic.
