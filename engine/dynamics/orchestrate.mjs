/* =============================================================================
 *  engine/dynamics/orchestrate.mjs  —  multi-object ORCHESTRATOR  (Story P5.3)
 *
 *  WHAT THIS IS: the choreography layer that sequences MANY registered dynamics
 *  from ONE DECLARATIVE orchestration spec. It is the generic, app-agnostic engine
 *  primitive behind "the world feels alive": flow-graphs, traffic, staged reveals,
 *  the global day/night cycle — all driven declaratively off the one deterministic
 *  host clock (the `elapsed` the host passes to update()).
 *
 *  THE SPEC (declarative, serialization-first — INV-5, NO functions / NO eval):
 *    {
 *      seed?: number,                    // explicit per-run seed (engine/core makeRng)
 *      nodes: [{
 *        id:         string,             // unique node id (the dependency-graph key)
 *        registryId: string,             // a REGISTERED dynamic id (spin/keyframe/daynight/...)
 *        params?:    object,             // declarative params for that dynamic's factory
 *        trigger?:   {                   // START-ON semantics (declarative predicate map)
 *          kind: 'always'|'at'|'after'|'while',
 *          t?:    number,                // 'at'   : active once elapsed >= t
 *          ref?:  string,                // 'after': active once node `ref` is active/started
 *          cond?: Condition,             // 'while': active while the declarative cond holds
 *        },
 *        dependsOn?: string[],           // ordering + gating edges (active AFTER all deps active)
 *        condition?: Condition,          // an EXTRA always-checked gate (ANDed with the trigger)
 *      }, ...]
 *    }
 *    Condition := { signal:string, op:'lt'|'lte'|'gt'|'gte'|'eq'|'between', value?:number, min?:number, max?:number }
 *
 *  PURE ACTIVE-SET RESOLUTION (INV-1): `resolve(spec, elapsed, signals)` is a PURE
 *  function of (spec, elapsed, seeded state). It computes, for the given `elapsed`,
 *  (1) the ACTIVE set of node ids (start-on / after / while-condition semantics,
 *  gated by dependsOn), and (2) a DETERMINISTIC, STABLE TOPOLOGICAL ORDER over the
 *  active nodes (Kahn's algorithm with a stable id tie-break). No wall-clock, no
 *  global RNG — the same (spec, elapsed, signals) reproduces the same ordered active
 *  set byte-for-byte across runs (and reseeded). `signals` is a plain map the host
 *  feeds (e.g. day/night phase, a counted value) — it carries NO logic, only numbers.
 *
 *  BOUNDED (INV-4): the orchestrated node count is CAPPED at `ORCH_NODE_CAP` and the
 *  per-node dependsOn fan-in at `ORCH_DEP_CAP`; both documented in the descriptor.
 *  The per-frame dispatch is ALLOC-FREE: the order buffer, the active/self/indeg/placed
 *  flag maps, the stably-pre-sorted node list, and the child-handle list are all
 *  pre-built ONCE (makeResolveScratch, at build()); update() drives them via the
 *  alloc-free resolveInto() which reuses every buffer in place and writes the ordered
 *  active ids into the pre-sized order scratch — NO per-frame `new`. (resolve() remains
 *  the PURE allocating resolver behind resolveAt()/read() for the conformance harness;
 *  resolveInto() is its byte-identical alloc-free twin used on the hot path.)
 *
 *  HEADLESS-SAFE (INV-1): a malformed spec / a cyclic dependsOn / an unknown
 *  registryId is handled gracefully (the offending node is dropped from the order,
 *  never a throw). Native ESM (D1); imports nothing app/vendor (INV-6).
 * ========================================================================== */

import { makeRng } from '../core/index.mjs';

/** Hard CAP on the orchestrated node count (INV-4). */
export const ORCH_NODE_CAP = 256;
/** Hard CAP on a single node's dependsOn fan-in (INV-4). */
export const ORCH_DEP_CAP = 64;

/* -----------------------------------------------------------------------------
 *  Declarative condition evaluation — a Condition is a plain {signal,op,...} map
 *  evaluated against a numeric `signals` snapshot. NO functions, NO eval (INV-5).
 * ------------------------------------------------------------------------- */
export function evalCondition(cond, signals) {
  if (!cond || typeof cond !== 'object') return true;          // no condition -> pass
  const sig = signals || {};
  const v = +sig[cond.signal];
  if (!Number.isFinite(v)) return false;                       // unknown/absent signal -> not satisfied
  switch (cond.op) {
    case 'lt':  return v < (+cond.value);
    case 'lte': return v <= (+cond.value);
    case 'gt':  return v > (+cond.value);
    case 'gte': return v >= (+cond.value);
    case 'eq':  return v === (+cond.value);
    case 'between': return v >= (+cond.min) && v <= (+cond.max);
    default: return false;                                     // unknown op -> not satisfied
  }
}

/* -----------------------------------------------------------------------------
 *  PURE active-test for ONE node from its trigger + condition (NOT yet gated by
 *  dependsOn — the dependency gating is applied in resolve() over the whole set).
 * ------------------------------------------------------------------------- */
function nodeSelfActive(node, elapsed, signals, startedBeforeMap) {
  // the extra always-ANDed condition gate (if any).
  if (node.condition && !evalCondition(node.condition, signals)) return false;
  const tr = node.trigger;
  if (!tr || typeof tr !== 'object') return true;              // no trigger -> 'always'
  switch (tr.kind) {
    case 'always': return true;
    case 'at':     return (+elapsed || 0) >= (+tr.t || 0);
    case 'while':  return evalCondition(tr.cond, signals);
    case 'after':  return !!(tr.ref && startedBeforeMap && startedBeforeMap[tr.ref]);
    default:       return true;
  }
}

/**
 * normalizeSpec(spec) — coerce a raw declarative spec into a CAPPED, de-duped,
 * id-keyed node list (pure; built ONCE). Drops malformed nodes; caps node count
 * (ORCH_NODE_CAP) and per-node dependsOn fan-in (ORCH_DEP_CAP). NO functions.
 */
export function normalizeSpec(spec) {
  const raw = (spec && Array.isArray(spec.nodes)) ? spec.nodes : [];
  const nodes = [];
  const seen = Object.create(null);
  for (let i = 0; i < raw.length && nodes.length < ORCH_NODE_CAP; i++) {
    const r = raw[i];
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    if (seen[r.id]) continue;                                  // de-dupe by id (first wins)
    if (typeof r.registryId !== 'string' || !r.registryId) continue;
    const deps = [];
    if (Array.isArray(r.dependsOn)) {
      for (let j = 0; j < r.dependsOn.length && deps.length < ORCH_DEP_CAP; j++) {
        const d = r.dependsOn[j];
        if (typeof d === 'string' && d && d !== r.id) deps.push(d);
      }
    }
    seen[r.id] = true;
    nodes.push({
      id: r.id,
      registryId: r.registryId,
      params: (r.params && typeof r.params === 'object') ? r.params : {},
      trigger: (r.trigger && typeof r.trigger === 'object') ? r.trigger : null,
      dependsOn: deps,
      condition: (r.condition && typeof r.condition === 'object') ? r.condition : null,
      _index: nodes.length,                                    // declaration index (stable tie-break)
    });
  }
  // drop dependsOn edges that reference a non-existent node (so the graph is closed).
  const ids = Object.create(null);
  for (const n of nodes) ids[n.id] = true;
  for (const n of nodes) n.dependsOn = n.dependsOn.filter((d) => ids[d]);
  return nodes;
}

/**
 * resolve(nodes, elapsed, signals) — THE PURE active-set + ordering resolver.
 *
 * Returns { order: string[], active: Record<id,boolean> }:
 *   - a node is ACTIVE iff its own trigger+condition pass AND every node in its
 *     dependsOn is itself active (gating propagates: a node cannot start before
 *     all its dependencies have started). For 'after' triggers the "ref started"
 *     fact is the ref being self-active at this elapsed (a pure, monotone-in-elapsed
 *     predicate — no hidden state).
 *   - `order` is a DETERMINISTIC STABLE TOPOLOGICAL ORDER over the active nodes
 *     (Kahn's algorithm; ties broken by declaration index then id). A dependsOn
 *     CYCLE among active nodes drops the cyclic remainder from the order (never a
 *     throw, never nondeterministic).
 *
 * PURE: depends ONLY on (nodes, elapsed, signals). No wall-clock, no RNG.
 */
export function resolve(nodes, elapsed, signals) {
  const n = nodes.length;
  // (1) self-active (trigger+condition), with 'after' refs resolved against self-active.
  const selfStarted = Object.create(null);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    // for 'after', the ref-started fact = ref's own trigger/condition (NOT dep-gated)
    // — a monotone start signal; compute it without recursion via a first pass.
    selfStarted[nd.id] = nodeSelfActive(nd, elapsed, signals, null);
  }
  // resolve 'after' triggers now that selfStarted is known (one settle pass is
  // sufficient: 'after' depends only on the ref's SELF start, not on dep-gating).
  const self = Object.create(null);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    self[nd.id] = nodeSelfActive(nd, elapsed, signals, selfStarted);
  }
  // (2) dependsOn gating: active iff self AND all deps active. Iterate to a fixpoint
  //     (bounded by n: gating can only turn nodes OFF, monotone, so n passes settle it).
  const active = Object.create(null);
  for (let i = 0; i < n; i++) active[nodes[i].id] = self[nodes[i].id];
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      if (!active[nd.id]) continue;
      for (let d = 0; d < nd.dependsOn.length; d++) {
        if (!active[nd.dependsOn[d]]) { active[nd.id] = false; changed = true; break; }
      }
    }
    if (!changed) break;
  }
  // (3) deterministic stable topological order over the ACTIVE set (Kahn).
  const activeNodes = [];
  for (let i = 0; i < n; i++) if (active[nodes[i].id]) activeNodes.push(nodes[i]);
  // stable input order: declaration index then id (the deterministic tie-break).
  activeNodes.sort((a, b) => (a._index - b._index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const indeg = Object.create(null);
  const isActive = Object.create(null);
  for (const a of activeNodes) { indeg[a.id] = 0; isActive[a.id] = true; }
  for (const a of activeNodes) for (const d of a.dependsOn) if (isActive[d]) indeg[a.id]++;
  // ready queue seeded in stable order; pop the stably-smallest each step.
  const order = [];
  const remaining = activeNodes.slice();
  // simple O(V*E) stable Kahn (V<=ORCH_NODE_CAP): repeatedly take the first ready node.
  const placed = Object.create(null);
  let guard = remaining.length + 1;
  while (order.length < remaining.length && guard-- > 0) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i];
      if (placed[a.id]) continue;
      // ready iff every active dep is already placed.
      let ready = true;
      for (const d of a.dependsOn) { if (isActive[d] && !placed[d]) { ready = false; break; } }
      if (ready) { order.push(a.id); placed[a.id] = true; progressed = true; }
    }
    if (!progressed) break;                                    // a cycle remains -> drop it (no throw)
  }
  return { order, active };
}

/**
 * makeResolveScratch(nodes) — build ONCE the per-instance reusable buffers the
 * ALLOC-FREE resolver writes into across frames (INV-4). All maps are keyed by the
 * (fixed) node ids and a stably-pre-sorted node-reference list is captured so the
 * per-frame resolve neither allocates nor re-sorts. resolveInto() resets these in
 * place every frame — NO per-frame `new`.
 */
export function makeResolveScratch(nodes) {
  const sorted = nodes.slice().sort(
    (a, b) => (a._index - b._index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const selfStarted = Object.create(null);
  const self = Object.create(null);
  const active = Object.create(null);
  const indeg = Object.create(null);
  const placed = Object.create(null);
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i].id;
    selfStarted[id] = false; self[id] = false; active[id] = false;
    indeg[id] = 0; placed[id] = false;
  }
  return {
    sorted,                            // stably pre-sorted node refs (reused; never re-sorted)
    selfStarted, self, active, indeg, placed,
    order: new Array(nodes.length),    // pre-sized order-id buffer (written in place)
    length: 0,                         // count of valid entries in `order` this frame
  };
}

/**
 * resolveInto(nodes, elapsed, signals, scratch) — ALLOC-FREE twin of resolve():
 * computes the SAME deterministic ordered active set, but writes the ordered active
 * ids into scratch.order[0..scratch.length) and reuses scratch's flag/indeg buffers
 * across frames. Allocates NOTHING per call (the buffers/maps are built ONCE by
 * makeResolveScratch). Byte-for-byte equivalent ordering to resolve().active/.order.
 */
export function resolveInto(nodes, elapsed, signals, scratch) {
  const n = nodes.length;
  const { selfStarted, self, active, indeg, placed, sorted, order } = scratch;
  // (1) self-active (trigger+condition), 'after' refs resolved against self-active.
  for (let i = 0; i < n; i++) {
    const id = nodes[i].id;
    selfStarted[id] = nodeSelfActive(nodes[i], elapsed, signals, null);
  }
  for (let i = 0; i < n; i++) {
    const id = nodes[i].id;
    self[id] = nodeSelfActive(nodes[i], elapsed, signals, selfStarted);
  }
  // (2) dependsOn gating to a fixpoint (monotone OFF; n passes settle it).
  for (let i = 0; i < n; i++) active[nodes[i].id] = self[nodes[i].id];
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      if (!active[nd.id]) continue;
      for (let d = 0; d < nd.dependsOn.length; d++) {
        if (!active[nd.dependsOn[d]]) { active[nd.id] = false; changed = true; break; }
      }
    }
    if (!changed) break;
  }
  // (3) deterministic stable topological order over the ACTIVE set (Kahn), iterating
  //     the pre-sorted node refs (a stable sort over a subset preserves relative order,
  //     so this matches resolve()'s sort of the active subset exactly). indeg is unused
  //     by the placement loop but reset here to mirror resolve()'s state precisely.
  for (let i = 0; i < n; i++) { placed[nodes[i].id] = false; indeg[nodes[i].id] = 0; }
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!active[a.id]) continue;
    for (let d = 0; d < a.dependsOn.length; d++) if (active[a.dependsOn[d]]) indeg[a.id]++;
  }
  let count = 0;
  let guard = n + 1;
  let progressed = true;
  while (progressed && guard-- > 0) {
    progressed = false;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (!active[a.id] || placed[a.id]) continue;
      let ready = true;
      for (let d = 0; d < a.dependsOn.length; d++) {
        if (active[a.dependsOn[d]] && !placed[a.dependsOn[d]]) { ready = false; break; }
      }
      if (ready) { order[count++] = a.id; placed[a.id] = true; progressed = true; }
    }
  }
  scratch.length = count;                // valid entries are order[0..count)
  return count;
}

/**
 * createOrchestrator(host, arg, registry) — build a LIVE orchestrator handle.
 *
 * `arg` carries the declarative `spec` (+ optional `seed`) and `signals` (a numeric
 * snapshot map). `registry` is the DynamicsRegistry the node `registryId`s resolve
 * against. On build it instantiates ONE child dynamic per node (via the registry
 * factory) ALLOC-FREE (built once); update(dt,elapsed) resolves the ordered active
 * set PURELY and dispatches each active child IN ORDER. reduceMotion freezes (each
 * child's own reduceMotion gate snaps it to its resting frame).
 *
 * Returns { update, setParams, dispose, read, resolveAt, targets } — the same handle
 * contract as the other dynamics, with `resolveAt(elapsed)` exposing the PURE
 * resolver for the conformance harness (view-only).
 */
export function createOrchestrator(host, arg, registry) {
  const a = arg || {};
  let spec = (a.spec && typeof a.spec === 'object') ? a.spec : { nodes: [] };
  let signals = (a.signals && typeof a.signals === 'object') ? a.signals : Object.create(null);
  const seed = (a.seed >>> 0) || 1;
  // a per-run instance-local seeded RNG (INV-1) — available to children that want it.
  const rng = makeRng(seed);

  let nodes = normalizeSpec(spec);
  let children = buildChildren(host, nodes, registry, rng);
  // pre-built ONCE: the alloc-free resolver's reusable flag/indeg buffers + the
  // pre-sized active-order scratch. update() reuses these in place every frame
  // (no per-frame new); rebuilt only on a spec change (setParams), never per frame.
  let scratch = makeResolveScratch(nodes);
  let disposed = false;

  function buildChildren(h, nodeList, reg, r) {
    const map = Object.create(null);
    if (!reg || typeof reg.get !== 'function') return map;
    for (let i = 0; i < nodeList.length; i++) {
      const nd = nodeList[i];
      const desc = reg.get(nd.registryId);
      if (!desc || typeof desc.factory !== 'function') { map[nd.id] = null; continue; }
      // pass the node params + the orchestrator seed (children seed deterministically).
      const childArg = { ...nd.params };
      if (childArg.seed === undefined) childArg.seed = r.seed;
      try { map[nd.id] = desc.factory(h, childArg); } catch { map[nd.id] = null; }
    }
    return map;
  }

  const handle = {
    get params() { return { spec, signals, seed }; },
    get targets() { return nodes.map((nd) => nd.id); },       // node ids (view)
    get children() { return children; },

    /** resolveAt(elapsed[, sig]) — VIEW-ONLY pure resolver: the ordered active set. */
    resolveAt(elapsed, sig) { return resolve(nodes, +elapsed || 0, sig || signals); },

    update(dt, elapsed) {
      if (disposed) return;
      const t = +elapsed || 0;
      // ALLOC-FREE per-frame dispatch (INV-4): resolveInto writes the ordered active
      // ids into the pre-built scratch.order[0..count) and reuses scratch's flag/indeg
      // buffers across frames — NO per-frame `new`. Same deterministic order as resolve().
      const count = resolveInto(nodes, t, signals, scratch);
      const order = scratch.order;
      // dispatch active children IN ORDER. Each child is reduceMotion-gated itself,
      // so a global reduceMotion freezes every child to its own resting frame.
      for (let i = 0; i < count; i++) {
        const ch = children[order[i]];
        if (ch && typeof ch.update === 'function') {
          try { ch.update(+dt || 0, t); } catch { /* one bad node must not break the frame */ }
        }
      }
    },

    setParams(p) {
      if (disposed) return;
      const np = p || {};
      if (np.spec && typeof np.spec === 'object') spec = np.spec;
      if (np.signals && typeof np.signals === 'object') signals = np.signals;
      // a spec change rebuilds the node graph + children ONCE (not per frame).
      if (np.spec) {
        for (const id in children) { const c = children[id]; if (c && typeof c.dispose === 'function') { try { c.dispose(); } catch { /* swallowed */ } } }
        nodes = normalizeSpec(spec);
        children = buildChildren(host, nodes, registry, rng);
        scratch = makeResolveScratch(nodes);                   // rebuild scratch ONCE per spec change
      } else if (np.signals) {
        // signals-only change: no rebuild (signals are read each resolve).
      }
    },

    /** VIEW-ONLY probe: node count (bounded), the caps, and the current ordered set. */
    read() {
      const r = resolve(nodes, 0, signals);
      return { nodeCount: nodes.length, nodeCap: ORCH_NODE_CAP, depCap: ORCH_DEP_CAP, order: r.order };
    },

    /** VIEW-ONLY: the LIVE per-frame resolve scratch (the pre-built buffers update()
     *  reuses in place). Exposed so the alloc-free claim is testable — its `order`
     *  and flag buffers keep the SAME identity across frames (no per-frame new). */
    get scratch() { return scratch; },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id in children) {
        const c = children[id];
        if (c && typeof c.dispose === 'function') { try { c.dispose(); } catch { /* swallowed */ } }
      }
      children = Object.create(null);
      nodes = [];
      scratch = makeResolveScratch([]);                        // release the per-frame scratch
    },
  };
  return handle;
}

export const orchestrate = Object.freeze({
  ORCH_NODE_CAP,
  ORCH_DEP_CAP,
  normalizeSpec,
  resolve,
  resolveInto,
  makeResolveScratch,
  evalCondition,
  createOrchestrator,
});

export default orchestrate;
