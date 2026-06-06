"use strict";
/*
 * econ-core.js — Magnate's deterministic economy, extracted verbatim from magnate.html.
 *
 * One economy core, many front-ends (this mirrors the production architecture: a headless
 * pure-Go `econ-core` held to golden-vector parity, fronted by different clients). The 2D
 * dashboard (magnate.html), the Three.js city (magnate-3d.html) and the Babylon.js city
 * (magnate-3d-babylon.html) all drive THIS file, so they are guaranteed to show the *same*
 * economy. Parity with magnate.html's inline engine is asserted by verify_parity.mjs.
 *
 * The ONLY differences from magnate.html's inline model are I/O, not logic:
 *   - the player's auto-trade flag is a parameter (was a DOM checkbox read),
 *   - render/toast/selector side-effects are removed,
 *   - step() RETURNS a structured `events` object (trades / retail / contracts) so a view
 *     can animate without re-deriving anything. Event collection consumes no RNG, so the
 *     deterministic RNG call order — and therefore every price/balance — is byte-identical.
 *
 * Works in the browser (window.MagnateCore) and in Node (module.exports) for headless tests.
 * All money is in integer minor units (cents). createWorld(seed) returns one world.
 */
(function (root) {

  function createWorld(seed, opts) {
    opts = opts || {};
    let autoPlayer = opts.autoPlayer !== false;   // player auto-trades unless explicitly disabled

    // ---------- deterministic RNG (LCG; exact 31-bit, BigInt to avoid float drift) ----------
    function RNG(s) { this.s = (s >>> 0); }
    RNG.prototype.next = function () { this.s = Number((1103515245n * BigInt(this.s) + 12345n) & 0x7FFFFFFFn); return this.s; };
    RNG.prototype.frac = function () { return this.next() / 0x7FFFFFFF; };
    RNG.prototype.jitter = function (x, p) { return x * (1 + (this.frac() * 2 - 1) * p); };

    // ---------- content config (identical to magnate.html) ----------
    const CENTS = 100, c = x => Math.round(x * CENTS);
    const GOODS = {
      ore: { tier: 0, base: 10, recipe: null }, coal: { tier: 0, base: 8, recipe: null }, sand: { tier: 0, base: 6, recipe: null },
      steel: { tier: 1, base: 34, recipe: { ore: 2, coal: 1 } }, glass: { tier: 1, base: 20, recipe: { sand: 2 } },
      circuit: { tier: 2, base: 110, recipe: { steel: 1, glass: 1 } }, chassis: { tier: 2, base: 90, recipe: { steel: 2 } },
      phone: { tier: 3, base: 320, recipe: { circuit: 2, glass: 1 } }, car: { tier: 3, base: 300, recipe: { chassis: 2, circuit: 1 } },
    };
    const GKEYS = Object.keys(GOODS);
    const RETAIL = { phone: { D0: 320, eps: 1.6 }, car: { D0: 200, eps: 1.3 } };
    const MARKET_FEE = 0.02, UPKEEP_RATE = 0.0015, START_CASH = 200000, PREF_HALFLIFE = 6, REF_QUAL_VOL = 3;
    const DESK_SPREAD = 0.08, DESK_DEPTH = 4, DESK_TARGET = 12, DESK_SEED = 8, BOND_PCT = 0.10;
    const PLAYER = 'PLAYER';

    // ---------- state ----------
    let rng, firms, bal, START_CONST, pref, hist, tick, faucetMinted, conserved;
    let playerOrders = [], orderLog = [], nwHist = [], lastVol = {}, lastQual = {}, lastClear = {}, ohlc = {};
    let playerPlan = {}, deskInv = {}, contracts = [], contractSeq = 0, prevRank = {};
    let nwHistAll = {}, deskBalHist = [];   // per-firm net-worth history + NPC_DESK balance history (for inspector sparklines)
    let snapshots = [];                     // ring buffer of per-tick state snapshots (time-scrubber replay)

    function reset(s) {
      rng = new RNG(s);
      const npcSpecs = GKEYS.concat(['car']);                 // 10 NPCs cover every good + extra car maker
      firms = [{ id: PLAYER, specialty: 'phone', inv: {}, cap: 7, fv: c(120000) }];
      npcSpecs.forEach((sp, i) => firms.push({ id: 'NPC' + i, specialty: sp, inv: {}, cap: 7, fv: c(120000) }));
      bal = {}; firms.forEach(f => bal[f.id] = c(START_CASH));
      bal.WORLD_FAUCET = 0; bal.SINK_BURN = 0; bal.NPC_DESK = 0; bal.CONTRACT_ESCROW = 0;   // all four system accounts
      START_CONST = Object.values(bal).reduce((a, b) => a + b, 0);
      deskInv = {}; GKEYS.forEach(g => deskInv[g] = DESK_SEED); contracts = []; contractSeq = 0;
      const warm = { 0: 40, 1: 20, 2: 10, 3: 0 };
      firms.forEach(f => { GKEYS.forEach(g => f.inv[g] = warm[GOODS[g].tier]); });
      pref = {}; hist = {}; GKEYS.forEach(g => { pref[g] = c(GOODS[g].base); hist[g] = []; ohlc[g] = []; });
      playerPlan = {}; playerPlan[firms[0].specialty] = firms[0].cap;
      tick = 0; faucetMinted = 0; conserved = true; playerOrders = []; orderLog = []; nwHist = []; lastVol = {}; lastQual = {}; lastClear = {}; prevRank = {};
      nwHistAll = {}; firms.forEach(f => nwHistAll[f.id] = []); deskBalHist = []; snapshots = [];
    }

    function transfer(src, dst, amt) { amt = Math.round(amt); bal[src] -= amt; bal[dst] += amt; }
    function invOf(id) { return id === 'NPC_DESK' ? deskInv : firms.find(f => f.id === id).inv; }
    function moneySupply() { return firms.reduce((a, f) => a + bal[f.id], 0); }
    function netWorth(f) { let v = bal[f.id] + f.fv; for (const g of GKEYS) v += f.inv[g] * pref[g]; return v; }
    function checkConserve() { let s = 0; for (const k in bal) s += bal[k]; return s === START_CONST; }

    // ---------- uniform-price batch auction (identical to magnate.html clearBook) ----------
    function clearBook(buys, sells) {
      if (!buys.length || !sells.length) return null;
      const prices = [...new Set(buys.concat(sells).map(o => o.p))].sort((a, b) => a - b);
      let bestP = null, bestV = -1;
      for (const p of prices) {
        let dq = 0, sq = 0;
        for (const o of buys) if (o.p >= p) dq += o.q;
        for (const o of sells) if (o.p <= p) sq += o.q;
        const v = Math.min(dq, sq); if (v > bestV) { bestV = v; bestP = p; }
      }
      if (bestV <= 0) return null;
      const p = bestP, eb = buys.filter(o => o.p >= p), es = sells.filter(o => o.p <= p);
      const matched = Math.min(eb.reduce((a, o) => a + o.q, 0), es.reduce((a, o) => a + o.q, 0));
      const alloc = (side, want) => {
        const total = side.reduce((a, o) => a + o.q, 0);
        if (total <= want) return side.map(o => ({ id: o.id, q: o.q }));
        const out = side.map(o => ({ id: o.id, q: Math.floor(o.q * want / total), cap: o.q }));
        let given = out.reduce((a, o) => a + o.q, 0), r = want - given;
        const keys = side.map(() => rng.next()); const order = side.map((_, i) => i).sort((p, q) => keys[p] - keys[q]); let k = 0;
        while (r > 0) { const i = order[k % order.length]; if (out[i].q < out[i].cap) { out[i].q++; r--; } k++; if (k > order.length * 8) break; }
        return out.map(o => ({ id: o.id, q: o.q }));
      };
      const bf = alloc(eb, matched).filter(o => o.q > 0), sf = alloc(es, matched).filter(o => o.q > 0);
      return { p, bf, sf, matched };
    }

    // ---------- one tick — RETURNS events (logic identical to magnate.html step()) ----------
    function step() {
      tick++;
      const a = 2 / (PREF_HALFLIFE + 1);
      const ev = { tick, trades: [], retail: [], contracts: [] };   // view animation feed (no RNG consumed)
      const prevRef = {}; GKEYS.forEach(g => prevRef[g] = pref[g]);
      // 1) production
      function produce(f, g) {
        const spec = GOODS[g];
        if (!spec.recipe) { f.inv[g]++; transfer(f.id, 'SINK_BURN', Math.max(1, (pref[g] / 16) | 0)); return true; }
        if (Object.entries(spec.recipe).every(([k, n]) => f.inv[k] >= n)) { for (const [k, n] of Object.entries(spec.recipe)) f.inv[k] -= n; f.inv[g]++; transfer(f.id, 'SINK_BURN', Math.max(1, (pref[g] / 20) | 0)); return true; }
        return false;
      }
      for (const f of firms) {
        if (f.id === PLAYER) {
          let used = 0;
          for (const [g, runs] of Object.entries(playerPlan)) { for (let i = 0; i < runs && used < f.cap; i++) { if (produce(f, g)) used++; else break; } }
        } else { for (let i = 0; i < f.cap; i++) produce(f, f.specialty); }
      }
      // 2) orders
      const books = {}; GKEYS.forEach(g => books[g] = { buys: [], sells: [] });
      const placeBuy = (fid, k, need) => { const bp = Math.round(rng.jitter(pref[k] * 1.04, 0.05)); const q = Math.min(need, Math.floor(bal[fid] / (bp * 1.02))); if (q > 0) books[k].buys.push({ id: fid, p: bp, q }); };
      for (const f of firms) {
        if (f.id === PLAYER) {
          if (!autoPlayer) continue;
          for (const g of GKEYS) if (f.inv[g] > 3) books[g].sells.push({ id: PLAYER, p: Math.round(rng.jitter(pref[g] * 0.97, 0.05)), q: f.inv[g] - 3 });
          for (const [g, runs] of Object.entries(playerPlan)) { const spec = GOODS[g]; if (spec.recipe) for (const [k, n] of Object.entries(spec.recipe)) { const need = n * runs * 2 - f.inv[k]; if (need > 0) placeBuy(PLAYER, k, need); } }
        } else {
          const g = f.specialty, spec = GOODS[g];
          if (f.inv[g] > 3) books[g].sells.push({ id: f.id, p: Math.round(rng.jitter(pref[g] * 0.97, 0.05)), q: f.inv[g] - 3 });
          if (spec.recipe) for (const [k, n] of Object.entries(spec.recipe)) { const need = n * f.cap * 2 - f.inv[k]; if (need > 0) placeBuy(f.id, k, need); }
        }
      }
      // NPC_DESK market-maker: two-sided quotes around the reference (no RNG)
      for (const g of GKEYS) {
        const bid = Math.round(pref[g] * (1 - DESK_SPREAD / 2)), ask = Math.round(pref[g] * (1 + DESK_SPREAD / 2));
        const want = DESK_TARGET - deskInv[g]; if (want > 0) books[g].buys.push({ id: 'NPC_DESK', p: bid, q: Math.min(want, DESK_DEPTH) });
        if (deskInv[g] > 0) books[g].sells.push({ id: 'NPC_DESK', p: ask, q: Math.min(deskInv[g], DESK_DEPTH) });
      }
      // player manual orders (clamped so no balance goes negative)
      for (const o of playerOrders) {
        let q = o.qty;
        if (o.side === 'sell') q = Math.min(q, firms[0].inv[o.good]);
        else q = Math.min(q, Math.floor(bal[PLAYER] / (o.price * 1.02)));
        if (q > 0) {
          (o.side === 'buy' ? books[o.good].buys : books[o.good].sells).push({ id: PLAYER, p: o.price, q });
          orderLog.unshift({ tick, side: o.side, good: o.good, px: o.price, qty: q, status: 'submitted' });
        } else orderLog.unshift({ tick, side: o.side, good: o.good, px: o.price, qty: o.qty, status: 'rejected · funds/stock' });
      }
      playerOrders = [];
      // 3) clear + settle
      for (const g of GKEYS) {
        const r = clearBook(books[g].buys, books[g].sells);
        if (!r) { hist[g].push(pref[g]); lastVol[g] = 0; lastClear[g] = null; continue; }
        for (const o of r.bf) { bal[o.id] -= r.p * o.q; invOf(o.id)[g] += o.q; transfer(o.id, 'SINK_BURN', Math.round(r.p * o.q * MARKET_FEE)); }
        for (const o of r.sf) { bal[o.id] += r.p * o.q; invOf(o.id)[g] -= o.q; transfer(o.id, 'SINK_BURN', Math.round(r.p * o.q * MARKET_FEE)); }
        const qual = r.matched >= REF_QUAL_VOL && new Set(r.bf.map(o => o.id)).size >= 2 && new Set(r.sf.map(o => o.id)).size >= 2;
        if (qual) pref[g] = Math.round(pref[g] * (1 - a) + r.p * a);
        hist[g].push(pref[g]); lastVol[g] = r.matched; lastQual[g] = qual; lastClear[g] = r.p;
        for (const o of r.bf.concat(r.sf)) if (o.id === PLAYER) { const e = orderLog.find(x => x.tick === tick && x.good === g && x.status === 'submitted'); if (e) e.status = 'filled @' + (r.p / CENTS).toFixed(0); }
        // event: a market trade cleared (drives flow particles / price pops in the city view)
        ev.trades.push({ good: g, tier: GOODS[g].tier, price: r.p, vol: r.matched, qual,
          buyers: [...new Set(r.bf.map(o => o.id))], sellers: [...new Set(r.sf.map(o => o.id))] });
      }
      // 3b) B2B contracts: bond releases on completion / forfeits to SINK_BURN on breach
      for (const ct of contracts) {
        if (ct.status !== 'active') continue;
        if (firms[0].inv[ct.good] >= ct.qty) {
          firms[0].inv[ct.good] -= ct.qty; deskInv[ct.good] += ct.qty;
          bal.NPC_DESK -= ct.price * ct.qty; bal.PLAYER += ct.price * ct.qty;
          ct.delivered++; ct.ticksLeft--;
          if (ct.ticksLeft <= 0) { bal.CONTRACT_ESCROW -= ct.bond; bal.PLAYER += ct.bond; ct.status = 'completed'; ev.contracts.push({ id: ct.id, good: ct.good, status: 'completed', bond: ct.bond }); }
          else ev.contracts.push({ id: ct.id, good: ct.good, status: 'delivered', qty: ct.qty });
        } else { bal.CONTRACT_ESCROW -= ct.bond; bal.SINK_BURN += ct.bond; ct.status = 'breached'; ev.contracts.push({ id: ct.id, good: ct.good, status: 'breached', bond: ct.bond }); }
      }
      // 4) retail faucet on T3 + scarcity price discovery
      for (const g in RETAIL) {
        const rp = RETAIL[g], p = pref[g];
        let qd = Math.round(rp.D0 * Math.pow(GOODS[g].base * CENTS / Math.max(1, p), rp.eps));
        const supply = firms.reduce((a, f) => a + f.inv[g], 0); let sold = 0;
        for (const f of firms.slice().sort((x, y) => y.inv[g] - x.inv[g])) {
          if (qd <= 0) break; const take = Math.min(f.inv[g], qd); if (take <= 0) continue;
          f.inv[g] -= take; qd -= take; sold += take; transfer('WORLD_FAUCET', f.id, p * take); faucetMinted += p * take;
        }
        const ratio = rp.D0 / Math.max(1, supply), lo = c(GOODS[g].base) * 0.5, hi = c(GOODS[g].base) * 2;
        pref[g] = Math.round(Math.min(hi, Math.max(lo, pref[g] * (1 + 0.05 * (Math.min(ratio, 2) - 1)))));
        if (hist[g].length) hist[g][hist[g].length - 1] = pref[g];
        lastVol[g] = sold; lastClear[g] = pref[g];
        ev.retail.push({ good: g, sold, price: pref[g] });
      }
      // 5) upkeep sink
      for (const f of firms) transfer(f.id, 'SINK_BURN', Math.round(f.fv * UPKEEP_RATE));
      // OHLC+volume candle per good
      for (const g of GKEYS) {
        const o = prevRef[g], cl = pref[g], tp = (lastClear[g] == null ? cl : lastClear[g]);
        ohlc[g].push({ o, c: cl, h: Math.max(o, cl, tp), l: Math.min(o, cl, tp), v: lastVol[g] || 0 }); if (ohlc[g].length > 60) ohlc[g].shift();
      }
      // 6) conservation invariant
      conserved = checkConserve();
      nwHist.push(netWorth(firms[0])); if (nwHist.length > 120) nwHist.shift();
      for (const f of firms) { const h = nwHistAll[f.id] || (nwHistAll[f.id] = []); h.push(netWorth(f)); if (h.length > 120) h.shift(); }
      deskBalHist.push(bal.NPC_DESK); if (deskBalHist.length > 120) deskBalHist.shift();
      const _rk = firms.slice().sort((x, y) => netWorth(y) - netWorth(x)); _rk.forEach((f, i) => prevRank[f.id] = i + 1);
      ev.conserved = conserved;
      // snapshot this tick's full state for the time-scrubber (deep copy; replay is read-only)
      const snap = { tick, bal: { ...bal }, pref: { ...pref }, deskInv: { ...deskInv }, inv: {}, fv: {}, contracts: contracts.map(c => ({ ...c })), conserved, ev };
      for (const f of firms) { snap.inv[f.id] = { ...f.inv }; snap.fv[f.id] = f.fv; }
      snapshots.push(snap); if (snapshots.length > 120) snapshots.shift();
      return ev;
    }

    // ---------- B2B contract (mirrors magnate.html's ct-form handler; price in cents) ----------
    function sign(good, qty, priceCents, ticks) {
      if (!(qty > 0 && priceCents > 0 && ticks > 0)) return { ok: false, reason: 'positive qty/price/ticks required' };
      const bond = Math.round(priceCents * qty * ticks * BOND_PCT);
      if (bal[PLAYER] < bond) return { ok: false, reason: 'insufficient cash for bond', bond };
      bal[PLAYER] -= bond; bal.CONTRACT_ESCROW += bond;
      const ct = { id: ++contractSeq, good, qty, price: priceCents, ticksLeft: ticks, delivered: 0, bond, status: 'active' };
      contracts.push(ct);
      return { ok: true, contract: ct, bond };
    }

    reset(seed);

    // live references are intentional — a viewer reads them each frame
    return {
      step, sign, reset,
      setPlan(p) { playerPlan = p; },
      setAuto(v) { autoPlayer = v !== false; },
      setSpecialty(g) { firms[0].specialty = g; playerPlan = {}; playerPlan[g] = firms[0].cap; },
      queueOrder(o) { playerOrders.push(o); },
      netWorth, moneySupply, checkConserve,
      ranked() { return firms.slice().sort((x, y) => netWorth(y) - netWorth(x)); },
      get tick() { return tick; }, get firms() { return firms; }, get bal() { return bal; }, get pref() { return pref; },
      get deskInv() { return deskInv; }, get contracts() { return contracts; }, get hist() { return hist; }, get ohlc() { return ohlc; },
      get nwHist() { return nwHist; }, get orderLog() { return orderLog; }, get prevRank() { return prevRank; },
      histOf(id) { return id === 'NPC_DESK' ? deskBalHist.slice() : (nwHistAll[id] ? nwHistAll[id].slice() : []); },   // net-worth series per firm; balance series for the desk
      // ---- time-scrubber: replay the last ~120 ticks from per-tick snapshots ----
      snapshots() { return snapshots; },
      snapshotAt(t) { for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i].tick === t) return snapshots[i]; return null; },
      snapRange() { return snapshots.length ? { min: snapshots[0].tick, max: snapshots[snapshots.length - 1].tick } : { min: 0, max: 0 }; },
      nwFromSnap(snap, id) { if (!snap) return 0; let v = snap.bal[id] + (snap.fv[id] || 0); const iv = snap.inv[id] || {}; for (const g of GKEYS) v += (iv[g] || 0) * snap.pref[g]; return v; },
      get conserved() { return conserved; }, get faucetMinted() { return faucetMinted; }, get START_CONST() { return START_CONST; },
      get playerPlan() { return playerPlan; },
      GOODS, GKEYS, RETAIL, CENTS, PLAYER, BOND_PCT,
      DESK: { SPREAD: DESK_SPREAD, DEPTH: DESK_DEPTH, TARGET: DESK_TARGET, SEED: DESK_SEED },   // market-maker params (for the desk inspector)
      ACCOUNTS: ['WORLD_FAUCET', 'SINK_BURN', 'NPC_DESK', 'CONTRACT_ESCROW'],
    };
  }

  const api = { createWorld };
  root.MagnateCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
