/* =============================================================================
 *  engine/data/index.mjs  —  the NDArray matrix/tensor STORE  (Story P3.1, ADR-D2)
 *
 *  WHAT THIS IS: the first-class `engine/data` data spine — a thin NDArray VIEW
 *  over a single contiguous typed-array backing buffer, with ZERO-COPY
 *  slice/reshape/transpose views and the five frozen data KINDS. No per-cell
 *  objects, no per-frame allocation, no heavyweight tensor dependency (D2).
 *
 *  NDArray SHAPE (the exact view the encode phase depends on):
 *    {
 *      data:   Float32Array | Float64Array | Int32Array | Uint8Array,  // contiguous backing
 *      shape:  number[],            // e.g. [rows, cols] or [t, n, f]
 *      stride: number[],            // row-major default; views reuse buffer w/ new stride/offset
 *      offset: number,              // element offset into `data`
 *      dtype:  'f32' | 'f64' | 'i32' | 'u8',
 *      kind:   'field' | 'timeseries' | 'graph' | 'points' | 'paramspace',
 *      meta:   { axes?:string[], t?:number, adjacency?:boolean }   // kind-specific hints
 *    }
 *
 *  HEADLESS-SAFE / GPU-FREE / PURE by construction (INV-1, INV-6):
 *    - imports NOTHING from apps/**, editor/**, conformance/** (INV-6 firewall);
 *    - NO hard import of THREE / Tweakpane — this module never touches vendor;
 *    - NO app-specific (Magnate) names — engine-only vocabulary;
 *    - loads & runs in plain Node >=20 with NO GPU/DOM, never throwing;
 *    - constructors VALIDATE and return a typed {ok:false, reason} on a malformed
 *      shape/dtype/kind — NEVER a partial or half-built view.
 *
 *  Native ESM (D1): resolved via the P2.1 import-map; no bundler.
 * ========================================================================== */

/** Module identity (semver). A bump is an explicit, versioned change. */
export const VERSION = '0.1.0-p3.1-data';
/** Human-readable module identity. */
export const NAME = 'engine/data';

/* -----------------------------------------------------------------------------
 *  FROZEN vocabularies (mirrors contracts/data-kinds.json + the D2 dtype set).
 *  These are duplicated as plain constants (NOT imported from contracts/, which
 *  the firewall forbids) — the contracts JSON is the source of truth and a drift
 *  is a breaking, semver-versioned change keyed by the conformance suite.
 * ------------------------------------------------------------------------- */

/** dtype -> TypedArray constructor. dtype ∈ {f32,f64,i32,u8} (D2). */
const DTYPE_CTOR = Object.freeze({
  f32: Float32Array,
  f64: Float64Array,
  i32: Int32Array,
  u8: Uint8Array,
});

/** The frozen data KINDS (contracts/data-kinds.json). */
const KINDS = Object.freeze(['field', 'timeseries', 'graph', 'points', 'paramspace']);

/* -----------------------------------------------------------------------------
 *  Internal helpers (pure).
 * ------------------------------------------------------------------------- */

/** A typed {ok:false, reason} error result — never a throw, never a partial. */
function err(reason) { return { ok: false, reason }; }

/** Is `x` one of the four supported TypedArrays? */
function isTypedArray(x) {
  return x instanceof Float32Array || x instanceof Float64Array
      || x instanceof Int32Array || x instanceof Uint8Array;
}

/** Infer the dtype string from a TypedArray instance (or null). */
function dtypeOf(ta) {
  if (ta instanceof Float32Array) return 'f32';
  if (ta instanceof Float64Array) return 'f64';
  if (ta instanceof Int32Array) return 'i32';
  if (ta instanceof Uint8Array) return 'u8';
  return null;
}

/** Row-major (C-order) contiguous strides for a shape. */
function rowMajorStride(shape) {
  const n = shape.length;
  const stride = new Array(n);
  let acc = 1;
  for (let i = n - 1; i >= 0; i--) {
    stride[i] = acc;
    acc *= shape[i];
  }
  return stride;
}

/** Product of a shape (number of logical elements). */
function numel(shape) {
  let p = 1;
  for (let i = 0; i < shape.length; i++) p *= shape[i];
  return p;
}

/** Validate a shape: a non-empty array of non-negative safe integers. */
function shapeError(shape) {
  if (!Array.isArray(shape) || shape.length === 0) return 'shape must be a non-empty number[]';
  for (let i = 0; i < shape.length; i++) {
    const d = shape[i];
    if (!Number.isInteger(d) || d < 0) return `shape[${i}] must be a non-negative integer (got ${String(d)})`;
  }
  return null;
}

/** Is `nd` a structurally-valid NDArray view (duck-typed)? */
export function isNDArray(nd) {
  return !!nd && isTypedArray(nd.data)
    && Array.isArray(nd.shape) && Array.isArray(nd.stride)
    && Number.isInteger(nd.offset)
    && typeof nd.dtype === 'string' && DTYPE_CTOR[nd.dtype]
    && typeof nd.kind === 'string' && KINDS.includes(nd.kind)
    && nd.shape.length === nd.stride.length;
}

/* -----------------------------------------------------------------------------
 *  data.ndarray(typedArray, shape, {dtype, kind, meta}) — CONSTRUCT a store.
 *
 *  Wraps a CONTIGUOUS typed-array backing buffer in an NDArray view. The backing
 *  is NOT copied — the view shares the buffer. Row-major strides are computed.
 *  `graph` sets meta.adjacency=true; `timeseries` records meta.t (axis index).
 *
 *  Returns the NDArray on success, or a typed {ok:false, reason} on a malformed
 *  input — never a partial view.
 * ------------------------------------------------------------------------- */
export function ndarray(typedArray, shape, opts = {}) {
  if (!isTypedArray(typedArray)) {
    return err('data.ndarray: typedArray must be a Float32Array|Float64Array|Int32Array|Uint8Array');
  }
  const se = shapeError(shape);
  if (se) return err('data.ndarray: ' + se);

  // dtype: explicit must match the backing; default inferred from the backing.
  const inferred = dtypeOf(typedArray);
  let dtype = opts.dtype;
  if (dtype === undefined || dtype === null) {
    dtype = inferred;
  } else if (!DTYPE_CTOR[dtype]) {
    return err(`data.ndarray: dtype must be one of f32|f64|i32|u8 (got "${String(dtype)}")`);
  } else if (dtype !== inferred) {
    return err(`data.ndarray: dtype "${dtype}" does not match the backing TypedArray (${inferred})`);
  }

  // kind: required, must be one of the five frozen kinds.
  const kind = opts.kind;
  if (!KINDS.includes(kind)) {
    return err(`data.ndarray: kind must be one of ${KINDS.join('|')} (got "${String(kind)}")`);
  }

  // The contiguous backing must hold exactly (or at least) the logical elements.
  const need = numel(shape.slice());
  if (typedArray.length < need) {
    return err(`data.ndarray: backing length ${typedArray.length} < shape product ${need}`);
  }

  // graph is a square adjacency matrix; timeseries names an axis as `t`.
  if (kind === 'graph' && !(shape.length === 2 && shape[0] === shape[1])) {
    return err(`data.ndarray: kind 'graph' requires a square [n,n] adjacency shape (got [${shape.join(',')}])`);
  }

  // meta — kind-specific hints. Cloned so callers can't mutate our frozen view.
  const meta = {};
  if (opts.meta && typeof opts.meta === 'object') {
    if (Array.isArray(opts.meta.axes)) meta.axes = opts.meta.axes.slice();
    if (Number.isInteger(opts.meta.t)) meta.t = opts.meta.t;
    if (typeof opts.meta.adjacency === 'boolean') meta.adjacency = opts.meta.adjacency;
  }
  if (kind === 'graph') meta.adjacency = true;          // graph => adjacency hint set
  if (kind === 'timeseries' && meta.t === undefined) meta.t = 0;  // timeseries => default t-axis 0

  return {
    data: typedArray,
    shape: shape.slice(),
    stride: rowMajorStride(shape.slice()),
    offset: 0,
    dtype,
    kind,
    meta,
  };
}

/* -----------------------------------------------------------------------------
 *  data.view(nd, {slice | reshape | transpose}) — ZERO-COPY view.
 *
 *  Returns a NEW {shape, stride, offset} over the SAME backing buffer (no copy).
 *  Exactly one of slice / reshape / transpose is honored per call.
 *
 *  slice:     [ [start,stop?,step?] | number | null, ... ]  per axis.
 *             A number selects + DROPS that axis; null/[] keeps the whole axis.
 *  reshape:   number[] — re-views the SAME logical (contiguous) elements; one
 *             dimension may be -1 (inferred). Requires a contiguous source.
 *  transpose: number[] axis permutation (default = full reverse).
 * ------------------------------------------------------------------------- */
export function view(nd, op = {}) {
  if (!isNDArray(nd)) return err('data.view: first argument is not a valid NDArray');

  const keys = ['slice', 'reshape', 'transpose'].filter((k) => op[k] !== undefined);
  if (keys.length !== 1) {
    return err('data.view: pass exactly one of {slice|reshape|transpose}');
  }
  const which = keys[0];

  if (which === 'transpose') return viewTranspose(nd, op.transpose);
  if (which === 'reshape') return viewReshape(nd, op.reshape);
  return viewSlice(nd, op.slice);
}

/** transpose: permute axes (shape + stride), same buffer/offset/data. */
function viewTranspose(nd, perm) {
  const n = nd.shape.length;
  let p = perm;
  if (p === true || p === undefined || p === null) {
    p = [];
    for (let i = n - 1; i >= 0; i--) p.push(i);   // default: full reverse
  }
  if (!Array.isArray(p) || p.length !== n) {
    return err(`data.view: transpose perm must be a length-${n} axis permutation`);
  }
  const seen = new Array(n).fill(false);
  for (const a of p) {
    if (!Number.isInteger(a) || a < 0 || a >= n || seen[a]) {
      return err(`data.view: transpose perm must be a permutation of 0..${n - 1}`);
    }
    seen[a] = true;
  }
  return cloneView(nd, p.map((a) => nd.shape[a]), p.map((a) => nd.stride[a]), nd.offset);
}

/** reshape: re-view the SAME contiguous elements with a new shape (one -1 allowed). */
function viewReshape(nd, newShape) {
  if (!Array.isArray(newShape) || newShape.length === 0) {
    return err('data.view: reshape requires a non-empty number[]');
  }
  if (!isContiguous(nd)) {
    return err('data.view: reshape requires a contiguous source view (slice/transpose first materializes ordering)');
  }
  const total = numel(nd.shape);
  let inferIdx = -1, known = 1;
  for (let i = 0; i < newShape.length; i++) {
    const d = newShape[i];
    if (d === -1) {
      if (inferIdx !== -1) return err('data.view: reshape allows at most one inferred (-1) dimension');
      inferIdx = i;
    } else if (!Number.isInteger(d) || d < 0) {
      return err(`data.view: reshape[${i}] must be a non-negative integer or -1`);
    } else {
      known *= d;
    }
  }
  const out = newShape.slice();
  if (inferIdx !== -1) {
    if (known === 0 || total % known !== 0) {
      return err(`data.view: reshape cannot infer -1 dimension (total ${total} not divisible by ${known})`);
    }
    out[inferIdx] = total / known;
  } else if (known !== total) {
    return err(`data.view: reshape product ${known} != element count ${total}`);
  }
  return cloneView(nd, out, rowMajorStride(out), nd.offset);
}

/** slice: per-axis [start,stop,step] / index / null. Integer index DROPS the axis. */
function viewSlice(nd, spec) {
  if (!Array.isArray(spec)) return err('data.view: slice must be an array (one entry per axis)');
  if (spec.length > nd.shape.length) {
    return err(`data.view: slice has more axes (${spec.length}) than the view (${nd.shape.length})`);
  }
  const shape = [];
  const stride = [];
  let offset = nd.offset;

  for (let ax = 0; ax < nd.shape.length; ax++) {
    const dim = nd.shape[ax];
    const st = nd.stride[ax];
    const s = ax < spec.length ? spec[ax] : null;

    if (s === null || s === undefined || (Array.isArray(s) && s.length === 0)) {
      shape.push(dim); stride.push(st);                // keep whole axis
      continue;
    }
    if (typeof s === 'number') {                        // integer index DROPS the axis
      const idx = s < 0 ? dim + s : s;
      if (!Number.isInteger(idx) || idx < 0 || idx >= dim) {
        return err(`data.view: slice index ${s} out of range for axis ${ax} (dim ${dim})`);
      }
      offset += idx * st;
      continue;
    }
    if (Array.isArray(s)) {
      let [start = 0, stop = dim, step = 1] = s;
      if (!Number.isInteger(step) || step === 0) return err(`data.view: slice step must be a non-zero integer (axis ${ax})`);
      if (start < 0) start = dim + start;
      if (stop < 0) stop = dim + stop;
      start = Math.max(0, Math.min(start, dim));
      stop = Math.max(0, Math.min(stop, dim));
      let len;
      if (step > 0) len = Math.max(0, Math.ceil((stop - start) / step));
      else len = Math.max(0, Math.ceil((start - stop) / -step));
      offset += start * st;
      shape.push(len); stride.push(st * step);
      continue;
    }
    return err(`data.view: slice entry for axis ${ax} must be null, a number, or [start,stop,step]`);
  }
  return cloneView(nd, shape, stride, offset);
}

/** Build a new view object over the SAME data buffer (zero-copy). */
function cloneView(nd, shape, stride, offset) {
  return {
    data: nd.data,                 // SAME backing buffer (zero-copy)
    shape,
    stride,
    offset,
    dtype: nd.dtype,
    kind: nd.kind,
    meta: nd.meta,                 // shared hints (view-only consumers do not mutate)
  };
}

/** Is the view contiguous in row-major (C) order? */
function isContiguous(nd) {
  const want = rowMajorStride(nd.shape);
  if (nd.stride.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (nd.shape[i] === 1) continue;        // size-1 axes carry no order constraint
    if (nd.stride[i] !== want[i]) return false;
  }
  return true;
}

/* -----------------------------------------------------------------------------
 *  HELPERS — at / set / row / col. All honor stride + offset (work on views).
 * ------------------------------------------------------------------------- */

/** Flat backing index for a multi-index (no bounds enforcement beyond ndim). */
function flatIndex(nd, idx) {
  let f = nd.offset;
  for (let i = 0; i < nd.shape.length; i++) f += idx[i] * nd.stride[i];
  return f;
}

/** at(nd, ...idx) -> the scalar at a logical multi-index, honoring stride/offset. */
export function at(nd, ...idx) {
  if (!isNDArray(nd)) return err('data.at: not a valid NDArray');
  if (idx.length !== nd.shape.length) return err(`data.at: expected ${nd.shape.length} indices, got ${idx.length}`);
  for (let i = 0; i < idx.length; i++) {
    if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= nd.shape[i]) {
      return err(`data.at: index ${idx[i]} out of range for axis ${i} (dim ${nd.shape[i]})`);
    }
  }
  return nd.data[flatIndex(nd, idx)];
}

/** set(nd, idx[], value) -> writes the scalar; returns {ok:true} or {ok:false}. */
export function set(nd, idx, value) {
  if (!isNDArray(nd)) return err('data.set: not a valid NDArray');
  if (!Array.isArray(idx) || idx.length !== nd.shape.length) {
    return err(`data.set: expected an index array of length ${nd.shape.length}`);
  }
  for (let i = 0; i < idx.length; i++) {
    if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= nd.shape[i]) {
      return err(`data.set: index ${idx[i]} out of range for axis ${i} (dim ${nd.shape[i]})`);
    }
  }
  nd.data[flatIndex(nd, idx)] = value;
  return { ok: true };
}

/** row(nd, i) -> a ZERO-COPY view of row i of a 2-D matrix (drops axis 0). */
export function row(nd, i) {
  if (!isNDArray(nd)) return err('data.row: not a valid NDArray');
  if (nd.shape.length !== 2) return err('data.row: requires a 2-D view');
  return viewSlice(nd, [i, null]);
}

/** col(nd, j) -> a ZERO-COPY view of column j of a 2-D matrix (drops axis 1). */
export function col(nd, j) {
  if (!isNDArray(nd)) return err('data.col: not a valid NDArray');
  if (nd.shape.length !== 2) return err('data.col: requires a 2-D view');
  return viewSlice(nd, [null, j]);
}

/* -----------------------------------------------------------------------------
 *  MATERIALIZE — copy a (possibly strided) view into a fresh CONTIGUOUS NDArray.
 *  Used by transform operators that need a packed row-major matrix; NOT zero-copy
 *  by design (the only place engine/data allocates a new buffer).
 * ------------------------------------------------------------------------- */
export function materialize(nd) {
  if (!isNDArray(nd)) return err('data.materialize: not a valid NDArray');
  const Ctor = DTYPE_CTOR[nd.dtype];
  const total = numel(nd.shape);
  const out = new Ctor(total);
  const ndim = nd.shape.length;
  const idx = new Array(ndim).fill(0);
  for (let k = 0; k < total; k++) {
    out[k] = nd.data[flatIndex(nd, idx)];
    // increment the multi-index (row-major / last axis fastest)
    for (let a = ndim - 1; a >= 0; a--) {
      if (++idx[a] < nd.shape[a]) break;
      idx[a] = 0;
    }
  }
  return ndarray(out, nd.shape.slice(), {
    dtype: nd.dtype,
    kind: nd.kind,
    meta: nd.meta,
  });
}

/* -----------------------------------------------------------------------------
 *  The engine/data surface descriptor — plain, serializable, reflection-friendly.
 * ------------------------------------------------------------------------- */
export const KIND_VALUES = KINDS;
export const DTYPE_VALUES = Object.freeze(Object.keys(DTYPE_CTOR));

export const data = Object.freeze({
  name: NAME,
  version: VERSION,
  kinds: KINDS,
  dtypes: DTYPE_VALUES,
  ndarray, view, at, set, row, col, materialize, isNDArray,
});

export default data;
