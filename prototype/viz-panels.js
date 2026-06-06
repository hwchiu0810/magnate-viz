"use strict";
/*
 * viz-panels.js — dependency-free, ENGINE-AGNOSTIC visualization library for Magnate.
 *
 * Renders a finviz-style squarified treemap + an interconnection network on a 2D <canvas>
 * from a MagnateCore world. The ALGORITHMS are ported verbatim (in spirit) from the PROVEN
 * 2D dashboard (magnate.html): squarify (Bruls/Huizing/van Wijk), heatColor (green/red
 * diverging on change), the firms+desk network, the deterministic tier-ring seed layout,
 * and the spring+repulsion+center force relaxation. The ONLY change is that everything is
 * WORLD-DRIVEN (reads a MagnateCore world + optional replay snapshot) and reusable across
 * front-ends (the 2D dashboard already has its own copies; the 3D city views include THIS).
 *
 * No external dependencies. Assigns window.MagnateViz in the browser and module.exports in
 * Node so the headless harness can eval it. Rendering uses ONLY 2D canvas + a supplied theme
 * (no getComputedStyle dependency — the host passes colours), so it is deterministic and works
 * headless. Decorative node spread varies by node INDEX, never by a randomized data magnitude.
 */
(function (root) {

  // ============================================================================
  //  DATA — world-driven, exact ground truth when `frame` (a snapshot) is omitted.
  // ============================================================================

  // Read the per-firm inventory of good g from a snapshot, else live.
  function firmInv(world, frame, id, g) {
    if (frame) { const iv = frame.inv[id] || {}; return iv[g] || 0; }
    const f = world.firms.find(x => x.id === id);
    return f ? (f.inv[g] || 0) : 0;
  }
  function deskInvAt(world, frame, g) { return frame ? (frame.deskInv[g] || 0) : (world.deskInv[g] || 0); }
  function prefAt(world, frame, g)    { return frame ? frame.pref[g] : world.pref[g]; }
  function netWorthAt(world, frame, f) { return frame ? world.nwFromSnap(frame, f.id) : world.netWorth(f); }

  // Σ-over-firms inventory of g + the desk's inventory of g, all in units (matches econ-core).
  function goodStock(world, frame, g) {
    let stock = deskInvAt(world, frame, g);
    for (const f of world.firms) stock += firmInv(world, frame, f.id, g);
    return stock;
  }

  // The snapshot immediately PRIOR to the displayed frame, for the signed-change baseline.
  // When live (frame omitted), the displayed tick is world.tick, so the baseline is tick-1.
  function priorSnapshot(world, frame) {
    const t = frame ? frame.tick : world.tick;
    return world.snapshotAt ? world.snapshotAt(t - 1) : null;
  }

  /*
   * treemapData(world, mode, frame) -> [{ id, tier, value, change, ... }]
   *   mode 'market'  : per good g — value = (Σ firms.inv[g] + deskInv[g]) × pref[g];
   *                    tier = GOODS[g].tier; change = signed fraction of pref vs the prior tick.
   *   mode 'finance' : per firm — value = net worth; change = signed fraction vs the prior tick.
   * `frame` omitted -> read LIVE world (exact ground truth the harness asserts). When a snapshot
   * is supplied (replay), values come from that snapshot and the baseline is the prior snapshot.
   */
  function treemapData(world, mode, frame) {
    const prev = priorSnapshot(world, frame);
    if (mode === 'finance') {
      return world.firms.map(f => {
        const nw = netWorthAt(world, frame, f);
        const pv = prev ? world.nwFromSnap(prev, f.id) : null;
        const change = (pv != null && pv !== 0) ? (nw - pv) / Math.abs(pv) : 0;
        return { id: f.id, tier: world.GOODS[f.specialty].tier, value: nw, change,
                 isPlayer: f.id === world.PLAYER, specialty: f.specialty };
      });
    }
    // 'market' (default)
    return world.GKEYS.map(g => {
      const value = goodStock(world, frame, g) * prefAt(world, frame, g);
      const p = prefAt(world, frame, g);
      const pp = prev ? prev.pref[g] : null;
      const change = (pp != null && pp !== 0) ? (p - pp) / pp : 0;
      return { id: g, tier: world.GOODS[g].tier, value, change };
    });
  }

  /*
   * networkData(world, frame, windowTicks=30) -> { nodes, edges }
   *   nodes = every firm (value = net worth, tier = specialty tier) + one 'NPC_DESK' hub
   *           (value = Σ deskInv[g] × pref[g], tier = -1).
   *   edges = aggregate over the last `windowTicks` recorded snapshots, up to frame.tick (or the
   *           latest recorded tick): for each snapshot.ev.trades entry, every buyer × every seller
   *           is an unordered co-trade pair; weight += that trade's `vol`. Desk-as-counterparty
   *           naturally makes it the hub. Edges with a===b or weight<=0 are dropped.
   */
  function networkData(world, frame, windowTicks) {
    const W = windowTicks || 30;
    const nodes = world.firms.map(f => ({
      id: f.id, value: netWorthAt(world, frame, f),
      tier: world.GOODS[f.specialty].tier, isPlayer: f.id === world.PLAYER,
    }));
    let deskVal = 0;
    for (const g of world.GKEYS) deskVal += deskInvAt(world, frame, g) * prefAt(world, frame, g);
    nodes.push({ id: 'NPC_DESK', value: deskVal, tier: -1, isDesk: true });

    const snaps = (world.snapshots && world.snapshots()) || [];
    const vt = frame ? frame.tick : (snaps.length ? snaps[snaps.length - 1].tick : world.tick);
    const wmap = {};
    const addEdge = (a, b, w) => {
      if (a === b || !(w > 0)) return;
      const k = a < b ? a + '|' + b : b + '|' + a;
      wmap[k] = (wmap[k] || 0) + w;
    };
    for (const sn of snaps) {
      if (sn.tick > vt || sn.tick <= vt - W) continue;
      const ev = sn.ev || {};
      for (const t of (ev.trades || [])) {
        const vol = t.vol || 0; if (vol <= 0) continue;
        const buyers = t.buyers || [], sellers = t.sellers || [];
        for (const b of buyers) for (const s of sellers) addEdge(b, s, vol);
      }
    }
    const edges = Object.keys(wmap).map(k => { const ab = k.split('|'); return { a: ab[0], b: ab[1], weight: wmap[k] }; });
    return { nodes, edges };
  }

  // ============================================================================
  //  MONEY-FLOW DATA — signed per-tick delta of each of the 4 SYSTEM accounts over the
  //  LAST completed tick. The SINGLE SOURCE OF TRUTH for both the HUD hook AND the
  //  particle sizes. Ported (in spirit) from the PROVEN magnate.html financeFlows().
  //
  //  LIVE (frame omitted): snapshotAt(world.tick).bal[acct] - snapshotAt(world.tick-1).bal[acct].
  //  REPLAY (frame given, a snapshot): snapshotAt(frame.tick) - snapshotAt(frame.tick-1).
  //  Zeros if <2 snapshots are recorded. (The harness asserts the LIVE result equals the
  //  4-account snapshot deltas EXACTLY.)
  // ============================================================================
  const FLOW_ACCTS = ['WORLD_FAUCET', 'SINK_BURN', 'NPC_DESK', 'CONTRACT_ESCROW'];
  function financeFlows(world, frame) {
    const t = frame ? frame.tick : world.tick;
    const sa = world.snapshotAt ? world.snapshotAt(t) : null;
    const sb = world.snapshotAt ? world.snapshotAt(t - 1) : null;
    const out = {};
    for (const a of FLOW_ACCTS) out[a] = (sa && sb) ? (sa.bal[a] - sb.bal[a]) : 0;
    return out;
  }

  // ============================================================================
  //  MONEY-FLOW RENDERER — animated source/sink diagram. Nodes:
  //    WORLD_FAUCET (mint) -> FIRMS pool -> SINK_BURN / NPC_DESK / CONTRACT_ESCROW.
  //  Particle rate + edge thickness ∝ |flows[acct]| (the REAL signed ledger delta).
  //  Particle STATE is managed internally, keyed by the canvas (WeakMap), so the host
  //  just calls drawMoneyFlow(cv, flows, opts) every rAF. Under reducedMotion/paused we
  //  draw a STATIC snapshot (no moving particles). Decorative spread varies by particle
  //  INDEX, never by a randomized DATA magnitude (deterministic, headless-safe).
  // ============================================================================
  const FLOW_NODES = [
    { id: 'WORLD_FAUCET', label: 'FAUCET', col: 'good' },
    { id: 'FIRMS', label: 'FIRMS', col: 'accent' },
    { id: 'NPC_DESK', label: 'DESK', col: 'desk' },
    { id: 'CONTRACT_ESCROW', label: 'ESCROW', col: 't3' },
    { id: 'SINK_BURN', label: 'SINK', col: 'bad' },
  ];
  // edges carry money between FIRMS and each system account; magnitude = |per-tick delta| of that account
  const FLOW_EDGES = [
    { a: 'WORLD_FAUCET', b: 'FIRMS', acct: 'WORLD_FAUCET' },     // mint flows out of faucet into firms
    { a: 'FIRMS', b: 'SINK_BURN', acct: 'SINK_BURN' },           // fees/upkeep flow into the sink
    { a: 'FIRMS', b: 'NPC_DESK', acct: 'NPC_DESK' },             // desk market-making P&L
    { a: 'FIRMS', b: 'CONTRACT_ESCROW', acct: 'CONTRACT_ESCROW' },
  ];
  function flowLayout(w, h) {
    return {
      WORLD_FAUCET: { x: w * 0.12, y: h * 0.30 },
      FIRMS: { x: w * 0.50, y: h * 0.50 },
      NPC_DESK: { x: w * 0.88, y: h * 0.24 },
      CONTRACT_ESCROW: { x: w * 0.88, y: h * 0.74 },
      SINK_BURN: { x: w * 0.50, y: h * 0.90 },
    };
  }
  // money-flow palette — host theme overrides; sensible headless-safe fallbacks.
  function flowTheme(theme) {
    theme = theme || {};
    const T = mkTheme(theme);
    return {
      good: theme.good || '#4fd896',
      bad: theme.bad || '#ff6f6f',
      accent: T.accent,
      desk: T.desk,
      t3: (theme.tiers && theme.tiers[3]) || '#ffd35a',
      line: T.line,
      muted: theme.muted || theme.text || T.text,
    };
  }
  // particle state keyed by canvas: {particles:[...], last: ms timestamp}
  const _flowState = new WeakMap();
  function drawMoneyFlow(canvas, flows, opts) {
    if (!canvas) return;
    opts = opts || {};
    flows = flows || {};
    const FT = flowTheme(opts.theme);
    const colOf = key => FT[key] || FT.muted;
    const r = setup(canvas); const x = r.ctx, w = r.w, h = r.h;
    if (!x) return;
    const reduced = !!opts.reducedMotion, paused = !!opts.paused, frozen = reduced || paused;
    const pos = flowLayout(w, h);
    const edges = FLOW_EDGES.map(e => ({ ...e, p1: pos[e.a], p2: pos[e.b], mag: Math.abs(flows[e.acct] || 0) }));

    // particle state for THIS canvas
    let fs = _flowState.get(canvas);
    if (!fs) { fs = { particles: [], last: 0, seq: 0 }; _flowState.set(canvas, fs); }
    const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    const dt = fs.last ? Math.min(0.05, (now - fs.last) / 1000) : 0.016;
    fs.last = now;
    // Advance + spawn particles ONLY when not frozen. Frozen -> static snapshot (no moving particles).
    if (frozen) {
      fs.particles.length = 0;
    } else {
      for (const pt of fs.particles) pt.t += pt.spd * dt;
      fs.particles = fs.particles.filter(pt => pt.t < 1);
      edges.forEach((e, i) => {
        if (e.mag <= 0) return;
        const want = Math.min(0.5, e.mag / 120000);   // probability this frame ∝ REAL delta
        if (Math.random() < want * dt * 60) {
          const colKey = (e.acct === 'WORLD_FAUCET') ? 'good' : FLOW_NODES.find(n => n.id === e.b).col;
          fs.particles.push({ edge: i, t: 0, spd: 0.6 + Math.random() * 0.5, col: colKey, idx: fs.seq++ });
        }
      });
      if (fs.particles.length > 180) fs.particles.splice(0, fs.particles.length - 180);
    }

    if (x.clearRect) x.clearRect(0, 0, w, h);
    // edges — thickness ∝ |REAL per-tick delta|
    for (const e of edges) {
      const lw = Math.max(1, Math.min(8, e.mag / 40000 + 1));
      x.strokeStyle = FT.line; x.globalAlpha = 0.5; x.lineWidth = lw;
      x.beginPath(); x.moveTo(e.p1.x, e.p1.y); x.lineTo(e.p2.x, e.p2.y); x.stroke();
    }
    x.globalAlpha = 1;
    // particles in flight (decorative spread by particle INDEX, never by a randomized data magnitude)
    for (const pt of fs.particles) {
      const e = edges[pt.edge]; if (!e) continue;
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ox = -dy / len, oy = dx / len;                       // unit normal for the spread
      const spread = ((pt.idx % 5) - 2) * 1.4;                   // by INDEX -> deterministic
      const px = e.p1.x + dx * pt.t + ox * spread, py = e.p1.y + dy * pt.t + oy * spread;
      x.beginPath(); x.arc(px, py, 2.2, 0, Math.PI * 2); x.fillStyle = colOf(pt.col); x.fill();
    }
    // nodes
    x.font = '9px monospace'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    for (const n of FLOW_NODES) {
      const p = pos[n.id];
      x.beginPath(); x.arc(p.x, p.y, 7, 0, Math.PI * 2); x.fillStyle = colOf(n.col); x.fill();
      x.fillStyle = FT.muted; x.fillText(n.label, p.x, p.y - 11);
    }
    x.textAlign = 'left';
  }

  // ============================================================================
  //  SQUARIFIED TREEMAP LAYOUT (Bruls/Huizing/van Wijk) — pure geometry, no libs.
  //  items:[{...,value}] -> [{...,x,y,w,h}] filling the rect, minimising aspect ratios.
  // ============================================================================
  function squarify(items, x, y, w, h) {
    const out = [];
    const nodes = items.filter(d => d.value > 0).slice().sort((a, b) => b.value - a.value);
    const total = nodes.reduce((a, d) => a + d.value, 0);
    if (total <= 0 || w <= 0 || h <= 0) { return items.map(d => ({ ...d, x, y, w: 0, h: 0 })); }
    const area = w * h, scale = area / total;
    let rx = x, ry = y, rw = w, rh = h;
    const worst = (row, len, sum) => {
      const s2 = sum * sum, mx = Math.max(...row), mn = Math.min(...row);
      return Math.max((len * len * mx) / s2, (s2) / (len * len * mn));
    };
    const layoutRow = (row) => {
      const sum = row.reduce((a, v) => a + v, 0);
      if (rw >= rh) { const rowW = sum / rh; let cy = ry;
        for (const v of row) { const cellH = v / rowW; out.push({ x: rx, y: cy, w: rowW, h: cellH, _v: v }); cy += cellH; }
        rx += rowW; rw -= rowW;
      } else { const rowH = sum / rw; let cx = rx;
        for (const v of row) { const cellW = v / rowH; out.push({ x: cx, y: ry, w: cellW, h: rowH, _v: v }); cx += cellW; }
        ry += rowH; rh -= rowH;
      }
    };
    const scaled = nodes.map(d => d.value * scale);
    let i = 0, row = [];
    while (i < scaled.length) {
      const len = Math.min(rw, rh) || 1;
      const v = scaled[i];
      if (!row.length) { row.push(v); i++; continue; }
      const cur = worst(row, len, row.reduce((a, x) => a + x, 0));
      const nxt = worst(row.concat(v), len, row.reduce((a, x) => a + x, 0) + v);
      if (nxt <= cur) { row.push(v); i++; }
      else { layoutRow(row); row = []; }
    }
    if (row.length) layoutRow(row);
    return nodes.map((d, k) => { const cell = out[k] || { x, y, w: 0, h: 0 }; return { ...d, x: cell.x, y: cell.y, w: cell.w, h: cell.h }; });
  }

  // finviz green/red diverging heat on per-tick change. ~±3% saturates; ~0 -> muted grey.
  function heatColor(change) {
    const t = Math.max(-1, Math.min(1, (change || 0) / 0.03));
    const neutral = [60, 66, 78], up = [34, 170, 90], down = [214, 58, 64];
    const tgt = t >= 0 ? up : down, k = Math.abs(t);
    const r = Math.round(neutral[0] + (tgt[0] - neutral[0]) * k);
    const g = Math.round(neutral[1] + (tgt[1] - neutral[1]) * k);
    const b = Math.round(neutral[2] + (tgt[2] - neutral[2]) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ============================================================================
  //  THEME — the host passes colours so the lib is style-agnostic. Sensible
  //  fallbacks keep it self-contained (and headless-safe). tier(t) -> hex/css.
  // ============================================================================
  const TIER_NAMES = ['T0 Extraction', 'T1 Foundry', 'T2 Fabrication', 'T3 Assembly'];
  function mkTheme(theme) {
    theme = theme || {};
    const tiers = theme.tiers || ['#e0a64a', '#9fb0c8', '#3fb6b2', '#ffd35a'];
    return {
      accent:  theme.accent  || '#9be7ff',
      text:    theme.text    || '#eaf0fb',
      line:    theme.line    || '#26365c',
      surface: theme.surface || '#0f1830',
      desk:    theme.desk    || theme.accent || '#9be7ff',
      label:   theme.label   || '#ffffff',
      tier: t => (t < 0 ? (theme.desk || theme.accent || '#9be7ff') : (tiers[t] || '#888')),
    };
  }

  // Per-canvas state the renderers stash (DPR-scaled context + hit registries) keyed by canvas.
  const _canvasState = new WeakMap();
  function setup(canvas) {
    const dpr = (root.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: canvas.width || 300, height: canvas.height || 200 };
    const w = rect.width || canvas.width || 300, h = rect.height || canvas.height || 200;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext('2d');
    if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let st = _canvasState.get(canvas);
    if (!st) { st = { treemapHits: [], netHits: [] }; _canvasState.set(canvas, st); }
    st.w = w; st.h = h;
    return { ctx, w, h, st };
  }

  // ============================================================================
  //  TREEMAP RENDERER — Market grouped into 4 tier sectors with header strips;
  //  Finance flat. Diverging heat on change; id + signed % / value labels.
  //  Records hit-rects (CSS px) on the canvas for hitTreemap().
  // ============================================================================
  function drawTreemap(canvas, tiles, opts) {
    if (!canvas) return;
    opts = opts || {};
    const mode = opts.mode || 'market', selectedId = opts.selectedId || null;
    const T = mkTheme(opts.theme);
    const r = setup(canvas); const x = r.ctx, w = r.w, h = r.h, st = r.st;
    if (!x) return;
    st.treemapHits = [];
    if (x.clearRect) x.clearRect(0, 0, w, h);

    if (mode === 'market') {
      // group goods into 4 tier SECTORS, lay sectors out by total value, tile goods within each.
      const sectors = [0, 1, 2, 3].map(t => ({ tier: t, items: tiles.filter(d => d.tier === t) }))
        .map(s => ({ ...s, value: s.items.reduce((a, d) => a + d.value, 0) })).filter(s => s.value > 0);
      const placed = squarify(sectors, 2, 2, w - 4, h - 4);
      for (const sec of placed) {
        if (x.fillStyle !== undefined) { x.fillStyle = T.tier(sec.tier); x.globalAlpha = 0.16; x.fillRect(sec.x, sec.y, sec.w, sec.h); x.globalAlpha = 1; }
        x.fillStyle = T.tier(sec.tier); x.font = 'bold 9px monospace'; x.textBaseline = 'top';
        if (sec.w > 56 && sec.h > 16) x.fillText(TIER_NAMES[sec.tier], sec.x + 4, sec.y + 3);
        const pad = 2, gy = sec.h > 20 ? 13 : 0;
        const cells = squarify(sec.items, sec.x + pad, sec.y + pad + gy, Math.max(0, sec.w - 2 * pad), Math.max(0, sec.h - 2 * pad - gy));
        for (const c of cells) {
          if (c.w < 1 || c.h < 1) continue;
          x.fillStyle = heatColor(c.change); x.fillRect(c.x, c.y, c.w - 1, c.h - 1);
          st.treemapHits.push({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h });
          if (c.id === selectedId) { x.strokeStyle = T.accent; x.lineWidth = 2; x.strokeRect(c.x + 1, c.y + 1, c.w - 3, c.h - 3); }
          if (c.w > 40 && c.h > 22) {
            x.fillStyle = T.label; x.font = 'bold 10px monospace'; x.textBaseline = 'top';
            x.fillText(c.id, c.x + 4, c.y + 4);
            x.font = '9px monospace'; x.fillStyle = 'rgba(255,255,255,.85)';
            x.fillText((c.change >= 0 ? '+' : '') + (c.change * 100).toFixed(1) + '%', c.x + 4, c.y + 16);
          }
        }
      }
    } else {
      const cells = squarify(tiles, 2, 2, w - 4, h - 4);
      for (const c of cells) {
        if (c.w < 1 || c.h < 1) continue;
        x.fillStyle = heatColor(c.change); x.fillRect(c.x, c.y, c.w - 1, c.h - 1);
        st.treemapHits.push({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h });
        const sel = c.id === selectedId || c.isPlayer;
        if (sel) { x.strokeStyle = T.accent; x.lineWidth = c.isPlayer ? 2.5 : 2; x.strokeRect(c.x + 1.5, c.y + 1.5, c.w - 3, c.h - 3); }
        if (c.w > 46 && c.h > 24) {
          x.fillStyle = T.label; x.font = 'bold 10px monospace'; x.textBaseline = 'top';
          x.fillText(c.id + (c.isPlayer ? ' ★' : ''), c.x + 4, c.y + 4);
          x.font = '9px monospace'; x.fillStyle = 'rgba(255,255,255,.85)';
          const dollars = '$' + Math.round(c.value / 100).toLocaleString();
          x.fillText(dollars, c.x + 4, c.y + 16);
        }
      }
    }
    x.textBaseline = 'alphabetic';
  }

  // ============================================================================
  //  NETWORK — deterministic tier-ring seed layout + spring/repulsion/center
  //  relaxation, frozen by the host under reduced-motion / replay. Node sizes ∝
  //  net worth, colour by tier (desk distinct), edge thickness ∝ co-traded weight.
  // ============================================================================

  // initNetwork(canvas, data) -> state. Seeds a deterministic layout: the desk hub in the centre,
  // firms on tier rings around it. Spread is by node INDEX within its ring (never by magnitude).
  function initNetwork(canvas, data) {
    const state = { layout: {}, seed: data.nodes.map(n => n.id).join(','), netHits: [] };
    const byTier = {};
    for (const n of data.nodes) { if (n.isDesk) continue; (byTier[n.tier] || (byTier[n.tier] = [])).push(n); }
    for (const n of data.nodes) {
      if (n.isDesk) { state.layout[n.id] = { x: 0.5, y: 0.5, vx: 0, vy: 0 }; continue; }
      const ring = byTier[n.tier], idx = ring.indexOf(n), cnt = ring.length;
      const radius = 0.18 + 0.20 * n.tier;
      const ang = (idx / Math.max(1, cnt)) * Math.PI * 2 + n.tier * 0.6;
      state.layout[n.id] = { x: 0.5 + radius * Math.cos(ang), y: 0.5 + radius * Math.sin(ang), vx: 0, vy: 0 };
    }
    return state;
  }

  // relaxNetwork(data, state) — ONE iteration of spring(edges)+repulsion(all pairs)+center pull on
  // the normalised 0..1 layout. Deterministic: degenerate coincident pairs are nudged by index, not
  // by Math.random, so a fixed iteration count yields a fixed layout.
  function relaxNetwork(data, state) {
    if (!state || !state.layout) return state;
    const L = state.layout;
    const ids = data.nodes.map(n => n.id).filter(id => L[id]);
    const fx = {}, fy = {}; ids.forEach(id => { fx[id] = 0; fy[id] = 0; });
    // repulsion between every pair
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = L[ids[i]], b = L[ids[j]];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) {                                   // deterministic separation by index pair
        dx = ((i * 7 + j * 13) % 11 - 5) * 0.001;
        dy = ((i * 5 + j * 17) % 11 - 5) * 0.001;
        if (dx === 0 && dy === 0) dx = 0.001;
        d2 = dx * dx + dy * dy;
      }
      const f = 0.0009 / d2, d = Math.sqrt(d2);
      fx[ids[i]] += f * dx / d; fy[ids[i]] += f * dy / d; fx[ids[j]] -= f * dx / d; fy[ids[j]] -= f * dy / d;
    }
    // springs along edges (stronger pull for heavier co-traded volume)
    const wmax = Math.max(1, ...data.edges.map(e => e.weight));
    for (const e of data.edges) {
      const a = L[e.a], b = L[e.b]; if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1e-3, rest = 0.16;
      const k = 0.02 * (0.4 + 0.6 * e.weight / wmax), f = k * (d - rest);
      fx[e.a] += f * dx / d; fy[e.a] += f * dy / d; fx[e.b] -= f * dx / d; fy[e.b] -= f * dy / d;
    }
    // gentle pull toward centre to keep the graph on-canvas
    for (const id of ids) { fx[id] += (0.5 - L[id].x) * 0.01; fy[id] += (0.5 - L[id].y) * 0.01; }
    for (const id of ids) {
      const p = L[id];
      p.vx = (p.vx + fx[id]) * 0.82; p.vy = (p.vy + fy[id]) * 0.82;
      p.x = Math.max(0.04, Math.min(0.96, p.x + p.vx)); p.y = Math.max(0.05, Math.min(0.95, p.y + p.vy));
    }
    return state;
  }

  // drawNetwork(canvas, data, state, {hoverId, theme}) — nodes sized by value, coloured by tier
  // (desk distinct), edge thickness ∝ weight, labels. Records hit-positions on the canvas state.
  function drawNetwork(canvas, data, state, opts) {
    if (!canvas || !state) return;
    opts = opts || {};
    const hov = opts.hoverId || null, T = mkTheme(opts.theme);
    const r = setup(canvas); const x = r.ctx, w = r.w, h = r.h, st = r.st;
    if (!x) return;
    if (x.clearRect) x.clearRect(0, 0, w, h);
    const L = state.layout || {};
    const pad = 26, X = p => pad + p.x * (w - 2 * pad), Y = p => pad + p.y * (h - 2 * pad);
    const nwmax = Math.max(1, ...data.nodes.map(n => n.value));
    const wmax = Math.max(1, ...data.edges.map(e => e.weight));
    const incident = e => hov && (e.a === hov || e.b === hov);
    // edges
    for (const e of data.edges) {
      const a = L[e.a], b = L[e.b]; if (!a || !b) continue;
      const on = incident(e);
      x.strokeStyle = on ? T.accent : T.line;
      x.globalAlpha = hov ? (on ? 0.95 : 0.10) : 0.45;
      x.lineWidth = Math.max(0.6, Math.min(7, (e.weight / wmax) * 6)) * (on ? 1.6 : 1);
      x.beginPath(); x.moveTo(X(a), Y(a)); x.lineTo(X(b), Y(b)); x.stroke();
    }
    x.globalAlpha = 1;
    // nodes
    const hits = [];
    for (const n of data.nodes) {
      const p = L[n.id]; if (!p) continue;
      const rad = 6 + 18 * Math.sqrt(Math.max(0, n.value) / nwmax);
      const cx = X(p), cy = Y(p);
      hits.push({ id: n.id, x: cx, y: cy, r: rad });
      const dim = hov && hov !== n.id && !data.edges.some(e => incident(e) && (e.a === n.id || e.b === n.id));
      x.globalAlpha = dim ? 0.32 : 1;
      x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2);
      x.fillStyle = n.isDesk ? T.desk : T.tier(n.tier); x.fill();
      if (n.isDesk) { x.strokeStyle = T.text; x.lineWidth = 2; x.stroke(); }
      else if (n.isPlayer) { x.strokeStyle = T.accent; x.lineWidth = 2.5; x.stroke(); }
      else if (n.id === hov) { x.strokeStyle = T.text; x.lineWidth = 1.5; x.stroke(); }
      x.globalAlpha = dim ? 0.4 : 1;
      x.fillStyle = T.text; x.font = '9px monospace'; x.textAlign = 'center'; x.textBaseline = 'top';
      x.fillText(n.isDesk ? 'DESK' : n.id, cx, cy + rad + 1);
    }
    x.globalAlpha = 1; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    st.netHits = hits;
    state.netHits = hits;
  }

  // ============================================================================
  //  HIT-TESTING — map a canvas-local CSS-px point back to an id (or null).
  // ============================================================================
  function hitTreemap(canvas, x, y) {
    const st = _canvasState.get(canvas); if (!st || !st.treemapHits) return null;
    for (const t of st.treemapHits) { if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t.id; }
    return null;
  }
  function hitNetwork(canvas, x, y) {
    const st = _canvasState.get(canvas); if (!st || !st.netHits) return null;
    let best = null, bd = 1e9;
    for (const n of st.netHits) { const dx = x - n.x, dy = y - n.y, d = Math.sqrt(dx * dx + dy * dy); if (d <= n.r + 3 && d < bd) { bd = d; best = n.id; } }
    return best;
  }

  // ============================================================================
  //  SANKEY DATA — money/value FLOW over a tick window, engine-agnostic (browser + Node).
  //
  //  sankeyData(world, mode, frame, windowTicks=30) -> { mode, fromTick, toTick, nodes, links }
  //    nodes: [{ id, col, label, value, color }]   (col = 0-based left→right column index)
  //    links: [{ source, target, value }]          (value > 0)
  //
  //  mode 'finance' = MONEY FLOW over the window. The 4 system accounts are nodes; the window's
  //    cumulative per-tick deltas telescope to the balance delta between snapshotAt(fromTick) and
  //    snapshotAt(toTick). Columns: [WORLD_FAUCET] -> [FIRMS] -> [SINK_BURN, NPC_DESK, CONTRACT_ESCROW].
  //      WORLD_FAUCET->FIRMS = minted     = b.bal.WORLD_FAUCET - a.bal.WORLD_FAUCET
  //      FIRMS->SINK_BURN    = burned     = a.bal.SINK_BURN     - b.bal.SINK_BURN
  //      FIRMS<->NPC_DESK / FIRMS<->CONTRACT_ESCROW = net window flow, routed by which side gained.
  //    (Harness asserts Σ faucet-outflow == minted and Σ sink-inflow == burned over [fromTick,toTick].)
  //
  //  mode 'market' = VALUE/THROUGHPUT FLOW up the supply chain over the window. Columns by tier:
  //    T0 -> T1 -> T2 -> T3 -> RETAIL. Links = recipe edges (input good -> output good) weighted by
  //    the OUTPUT good's traded volume over the window (snapshots' ev.trades), plus T3 -> RETAIL =
  //    retail-sold volume (ev.retail). Node value = its throughput (Σ incident link values).
  // ============================================================================

  // Resolve the [fromTick, toTick] window the aggregation covers. toTick = the displayed/current tick;
  // fromTick = the earliest recorded snapshot tick >= toTick - windowTicks (so both ends have snapshots).
  function sankeyWindow(world, frame, windowTicks) {
    const W = windowTicks || 30;
    const snaps = (world.snapshots && world.snapshots()) || [];
    const toTick = frame ? frame.tick : world.tick;
    if (!snaps.length) return { fromTick: toTick, toTick };
    const minRec = snaps[0].tick;
    const fromTick = Math.max(minRec, toTick - W);
    return { fromTick, toTick };
  }

  function sankeyData(world, mode, frame, windowTicks) {
    if (mode === 'finance') return sankeyFinance(world, frame, windowTicks);
    return sankeyMarket(world, frame, windowTicks);
  }

  // money-flow palette (host theme overrides via colours baked onto nodes; headless-safe fallbacks)
  const _FIN_COL = {
    WORLD_FAUCET: '#4fd896', FIRMS: '#9be7ff',
    SINK_BURN: '#ff6f6f', NPC_DESK: '#9be7ff', CONTRACT_ESCROW: '#ffd35a',
  };
  const _FIN_LABEL = {
    WORLD_FAUCET: 'FAUCET', FIRMS: 'FIRMS',
    SINK_BURN: 'SINK', NPC_DESK: 'DESK', CONTRACT_ESCROW: 'ESCROW',
  };
  function sankeyFinance(world, frame, windowTicks) {
    const { fromTick, toTick } = sankeyWindow(world, frame, windowTicks);
    const a = world.snapshotAt ? world.snapshotAt(toTick) : null;     // window END
    const b = world.snapshotAt ? world.snapshotAt(fromTick) : null;   // window START
    // columns: 0 = faucet, 1 = firms pool, 2 = the three sinks/counterparties
    const nodes = [
      { id: 'WORLD_FAUCET', col: 0, label: _FIN_LABEL.WORLD_FAUCET, value: 0, color: _FIN_COL.WORLD_FAUCET },
      { id: 'FIRMS',        col: 1, label: _FIN_LABEL.FIRMS,        value: 0, color: _FIN_COL.FIRMS },
      { id: 'SINK_BURN',       col: 2, label: _FIN_LABEL.SINK_BURN,       value: 0, color: _FIN_COL.SINK_BURN },
      { id: 'NPC_DESK',        col: 2, label: _FIN_LABEL.NPC_DESK,        value: 0, color: _FIN_COL.NPC_DESK },
      { id: 'CONTRACT_ESCROW', col: 2, label: _FIN_LABEL.CONTRACT_ESCROW, value: 0, color: _FIN_COL.CONTRACT_ESCROW },
    ];
    const links = [];
    if (a && b) {
      const minted = b.bal.WORLD_FAUCET - a.bal.WORLD_FAUCET;   // faucet falls as it mints
      const burned = a.bal.SINK_BURN - b.bal.SINK_BURN;         // sink rises as money is burned
      if (minted > 0) links.push({ source: 'WORLD_FAUCET', target: 'FIRMS', value: minted });
      if (burned > 0) links.push({ source: 'FIRMS', target: 'SINK_BURN', value: burned });
      // NPC_DESK & CONTRACT_ESCROW: net direction over the window (route FIRMS->X if X gained money)
      for (const acct of ['NPC_DESK', 'CONTRACT_ESCROW']) {
        const delta = a.bal[acct] - b.bal[acct];               // change in that account over window
        if (delta > 0) links.push({ source: 'FIRMS', target: acct, value: delta });
        else if (delta < 0) links.push({ source: acct, target: 'FIRMS', value: -delta });
      }
    }
    // node value = Σ incident link values (its throughput); faucet/firms naturally largest
    const byId = {}; for (const n of nodes) byId[n.id] = n;
    for (const l of links) { if (byId[l.source]) byId[l.source].value += l.value; if (byId[l.target]) byId[l.target].value += l.value; }
    return { mode: 'finance', fromTick, toTick, nodes, links };
  }

  // supply-chain VALUE flow: recipe edges weighted by the output good's traded volume over the window.
  function sankeyMarket(world, frame, windowTicks) {
    const { fromTick, toTick } = sankeyWindow(world, frame, windowTicks);
    const snaps = (world.snapshots && world.snapshots()) || [];
    // aggregate traded volume per good and retail-sold volume per good over (fromTick, toTick]
    const tradeVol = {}, retailVol = {};
    for (const g of world.GKEYS) { tradeVol[g] = 0; retailVol[g] = 0; }
    for (const sn of snaps) {
      if (sn.tick > toTick || sn.tick <= fromTick) continue;   // window is (fromTick, toTick]
      const ev = sn.ev || {};
      for (const t of (ev.trades || [])) { const v = t.vol || 0; if (v > 0) tradeVol[t.good] = (tradeVol[t.good] || 0) + v; }
      for (const r of (ev.retail || [])) { const v = r.sold || 0; if (v > 0) retailVol[r.good] = (retailVol[r.good] || 0) + v; }
    }
    // nodes: one per good (col = its tier) + a RETAIL sink in the rightmost column (col = 4)
    const nodes = [];
    const byId = {};
    for (const g of world.GKEYS) {
      const n = { id: g, col: world.GOODS[g].tier, label: g, value: 0, color: _tierColor(world.GOODS[g].tier) };
      nodes.push(n); byId[g] = n;
    }
    const retail = { id: 'RETAIL', col: 4, label: 'RETAIL', value: 0, color: _tierColor(3) };
    nodes.push(retail); byId.RETAIL = retail;
    // links: input good -> output good, weighted by OUTPUT good's traded volume (value pulled up the chain)
    const links = [];
    for (const g of world.GKEYS) {
      const spec = world.GOODS[g], w = tradeVol[g] || 0;
      if (!spec.recipe || w <= 0) continue;
      for (const ing of Object.keys(spec.recipe)) {
        links.push({ source: ing, target: g, value: w });
      }
    }
    // T3 finished goods -> RETAIL sink, weighted by retail-sold volume
    for (const g of world.GKEYS) {
      if (world.GOODS[g].tier !== 3) continue;
      const v = retailVol[g] || 0;
      if (v > 0) links.push({ source: g, target: 'RETAIL', value: v });
    }
    // node throughput = Σ incident link values
    for (const l of links) { if (byId[l.source]) byId[l.source].value += l.value; if (byId[l.target]) byId[l.target].value += l.value; }
    return { mode: 'market', fromTick, toTick, nodes, links };
  }
  // tier palette matching mkTheme's default tier ramp (host can override per-node colour downstream).
  function _tierColor(t) { const tiers = ['#e0a64a', '#9fb0c8', '#3fb6b2', '#ffd35a']; return t < 0 ? '#9be7ff' : (tiers[t] || '#888'); }

  // ----------------------------------------------------------------------------
  //  drawSankey(canvas, layout, opts) — a 2D ribbon Sankey from sankeyData's layout.
  //  Node columns (x = col), node height ∝ value within its column; curved ribbons between
  //  linked nodes with width ∝ link value, coloured per SOURCE; labels + values. Pure 2D
  //  canvas (deterministic, headless-safe). For reuse in HUD/dashboard; the 3D scenes consume
  //  the SAME layout (node columns + link values).
  // ----------------------------------------------------------------------------
  function drawSankey(canvas, layout, opts) {
    if (!canvas || !layout) return;
    opts = opts || {};
    const T = mkTheme(opts.theme);
    const r = setup(canvas); const x = r.ctx, w = r.w, h = r.h, st = r.st;
    if (!x) return;
    st.sankeyHits = [];
    if (x.clearRect) x.clearRect(0, 0, w, h);
    const nodes = layout.nodes || [], links = layout.links || [];
    if (!nodes.length) return;
    const padX = 18, padY = 22, gapY = 8;
    const cols = nodes.reduce((m, n) => Math.max(m, n.col), 0) + 1;
    const colX = c => cols <= 1 ? padX : padX + (w - 2 * padX) * (c / (cols - 1));
    const nodeW = 12;
    // place each node within its column: stack by value, normalised to the tallest column.
    const byCol = {}; for (const n of nodes) (byCol[n.col] || (byCol[n.col] = [])).push(n);
    let maxColSum = 1;
    for (const c in byCol) { const s = byCol[c].reduce((a, n) => a + Math.max(0, n.value), 0); if (s > maxColSum) maxColSum = s; }
    const avail = h - 2 * padY;
    const pos = {};
    for (const c in byCol) {
      const list = byCol[c];
      const sum = list.reduce((a, n) => a + Math.max(0, n.value), 0);
      const totalGap = gapY * Math.max(0, list.length - 1);
      const scale = (avail - totalGap) * (sum / maxColSum) / Math.max(1, sum);
      let cy = padY + (avail - (sum * scale + totalGap)) / 2;   // centre the column vertically
      const cx = colX(+c);
      for (const n of list) {
        const nh = Math.max(2, Math.max(0, n.value) * scale);
        pos[n.id] = { x: cx, y: cy, w: nodeW, h: nh, cx: cx + nodeW / 2, color: n.color };
        cy += nh + gapY;
      }
    }
    // ribbons: width ∝ value, coloured per source, drawn first (under nodes). Stack at each endpoint.
    const outAt = {}, inAt = {};
    const colorOf = n => (n && n.color) || T.accent;
    const linkW = Math.max(1, ...links.map(l => l.value));
    for (const l of links) {
      const sp = pos[l.source], tp = pos[l.target]; if (!sp || !tp) continue;
      const lw = Math.max(1, (l.value / linkW) * Math.min(sp.h, tp.h));
      const sy = (outAt[l.source] = (outAt[l.source] || 0)) + sp.y; outAt[l.source] += lw;
      const ty = (inAt[l.target] = (inAt[l.target] || 0)) + tp.y; inAt[l.target] += lw;
      const x0 = sp.x + sp.w, x1 = tp.x, mx = (x0 + x1) / 2;
      x.beginPath();
      x.moveTo(x0, sy);
      x.bezierCurveTo(mx, sy, mx, ty, x1, ty);
      x.lineTo(x1, ty + lw);
      x.bezierCurveTo(mx, ty + lw, mx, sy + lw, x0, sy + lw);
      x.closePath();
      x.fillStyle = colorOf(sp); x.globalAlpha = 0.4; x.fill();
    }
    x.globalAlpha = 1;
    // nodes (pillars) + labels
    x.font = '9px monospace'; x.textBaseline = 'middle';
    for (const n of nodes) {
      const p = pos[n.id]; if (!p) continue;
      x.fillStyle = p.color; x.fillRect(p.x, p.y, p.w, p.h);
      st.sankeyHits.push({ id: n.id, x: p.x, y: p.y, w: p.w, h: p.h });
      x.fillStyle = T.label; x.textAlign = n.col === 0 ? 'left' : 'right';
      const lx = n.col === 0 ? p.x + p.w + 3 : p.x - 3;
      x.fillText(n.label, lx, p.y + p.h / 2);
    }
    x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  }

  // ============================================================================
  const api = {
    treemapData, networkData, financeFlows, sankeyData,
    squarify, heatColor,
    drawTreemap, drawMoneyFlow, drawSankey,
    initNetwork, relaxNetwork, drawNetwork,
    hitTreemap, hitNetwork,
    TIER_NAMES,
  };
  root.MagnateViz = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
