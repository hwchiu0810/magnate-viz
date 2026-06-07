/* =============================================================================
 *  prototype/magnate-render.mjs  —  the RENDER-PATH SWAP bridge  (Story P2.5b)
 *
 *  WHAT THIS IS: the thin browser bridge that exposes the apps/magnate RENDER
 *  bindings (apps/magnate/render) to the prototype's CLASSIC inline app script.
 *  Loaded via a <script type="module"> tag that stashes the resolved module on
 *  window.__magnateRender. The inline Smart City / Smart Factory / Shopping Mall
 *  render path then WRITES its data-bound mesh attributes (tower height, twinHeat
 *  shell colour, comms-packet weight) FROM these engine-driven reads WHEN this
 *  handle is present.
 *
 *  GRACEFUL FALLBACK (the whole safety story): this file lives in prototype/ and
 *  imports the app render layer via relative '../apps/magnate/render/index.mjs',
 *  which in turn imports '../engine/...'. If those paths are unreachable (file://,
 *  the single-file dist, a non-root server) the <script type="module"> import
 *  fails in ISOLATION: window.__magnateRender stays undefined and the inline app
 *  renders EXACTLY as before from its own computation. The page NEVER throws.
 *
 *  The headless conformance harness evals only the CLASSIC inline scripts and never
 *  loads this module, so the __*Headless probes + the frozen vectors are untouched
 *  (BYTE-IDENTICAL). Native ESM (D1); pure + deterministic (INV-1).
 * ========================================================================== */

import render from '../apps/magnate/render/index.mjs';

export default render;
