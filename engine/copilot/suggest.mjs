/* =============================================================================
 *  engine/copilot/suggest.mjs  —  DETERMINISTIC suggestEncoding (Story P6.2)
 *
 *  WHAT THIS IS: a PURE, DETERMINISTIC heuristic (NO LLM, NO RNG, NO wall-clock)
 *  that maps a DATA SHAPE/KIND to a valid EncodeSpec. Same input -> byte-identical
 *  spec. The returned spec ALWAYS validates clean against engine/encode.validate,
 *  and every recommended channel choice respects the data kind:
 *
 *    paramspace  -> projection-ready POSITION (xy) + COLORMAP of a column, with a
 *                   second SCALE channel so colour is never the sole signal (INV-2).
 *    timeseries  -> POSITION over the value + MOTION (timeline-driven) channel.
 *    graph       -> a FLOW motion channel + colormap of the node weight (flow-graph).
 *    points      -> direct POSITION (xyz) + colormap, paired with a SCALE channel.
 *    field       -> COLORMAP of the scalar field + an OPACITY second channel.
 *
 *  ACCESSIBILITY (INV-2): every COLORMAP recommendation defaults to the
 *  colour-blind-safe VIRIDIS Lut AND is paired with a SECOND non-colour channel,
 *  so colour is never the sole encoding. SUB-WHITE (INV-3) is automatic — the
 *  colormap scale clamps emissive <= 0.85 in engine/encode/scales.
 *
 *  TYPED REJECT: an unsupported / malformed shape returns the typed
 *  { ok:false, code:'SHAPE_MISMATCH', reason } — NEVER a partial / invalid spec a
 *  downstream bindData would reject.
 *
 *  FIREWALL (INV-6): imports ONLY engine/data (isNDArray) + engine/encode
 *  (validate, for the self-check). NO THREE / NO app modules.
 * ========================================================================== */

import { isNDArray } from '../data/index.mjs';
import { validate } from '../encode/index.mjs';

/** The frozen data-kind vocabulary (mirrors engine/data KINDS). */
export const DATA_KINDS = Object.freeze(['field', 'timeseries', 'graph', 'points', 'paramspace']);

function reject(reason) { return { ok: false, code: 'SHAPE_MISMATCH', reason }; }
function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

/* -----------------------------------------------------------------------------
 *  describeShape(dataRef) — normalize ANY accepted input into a plain
 *  {kind, rows, cols, axes} descriptor (PURE; no allocation of the data itself).
 *  Accepts: an NDArray; a plain {kind, shape, axes} descriptor; an array of rows.
 * ------------------------------------------------------------------------- */
export function describeShape(dataRef) {
  if (isNDArray(dataRef)) {
    const shape = dataRef.shape;
    const rows = shape[0] || 0;
    const cols = shape.length >= 2 ? shape[shape.length - 1] : 1;
    const axes = (dataRef.meta && Array.isArray(dataRef.meta.axes)) ? dataRef.meta.axes.slice() : null;
    return { ok: true, kind: dataRef.kind, rows, cols, axes, ndim: shape.length };
  }
  if (isPlainObject(dataRef) && typeof dataRef.kind === 'string') {
    const shape = Array.isArray(dataRef.shape) ? dataRef.shape : [];
    const rows = shape[0] || dataRef.rows || 0;
    const cols = shape.length >= 2 ? shape[shape.length - 1] : (dataRef.cols || 1);
    return { ok: true, kind: dataRef.kind, rows, cols, axes: Array.isArray(dataRef.axes) ? dataRef.axes.slice() : null, ndim: shape.length || (dataRef.ndim || 2) };
  }
  if (Array.isArray(dataRef) && dataRef.length > 0) {
    const first = dataRef[0];
    const cols = Array.isArray(first) ? first.length : (isPlainObject(first) ? Object.keys(first).length : 1);
    const axes = isPlainObject(first) ? Object.keys(first) : null;
    // a bare array has no declared kind — treat as points (xyz scatter) by default.
    return { ok: true, kind: 'points', rows: dataRef.length, cols, axes, ndim: 2 };
  }
  return reject('suggestEncoding: dataRef is not an NDArray, a {kind,shape} descriptor, or an array of rows');
}

/** Pick a column accessor: an NDArray uses "@<root>.<j>"; named axes use the name. */
function colAccessor(root, axes, j) {
  if (axes && axes[j] !== undefined && typeof axes[j] === 'string') return `@${root}.${axes[j]}`;
  return `@${root}.${j}`;
}

/* -----------------------------------------------------------------------------
 *  suggestEncoding(dataRef, opts?) -> EncodeSpec | typed SHAPE_MISMATCH reject.
 *
 *  `opts.dataKey` names the dataMap root the accessors reference (default "data").
 * ------------------------------------------------------------------------- */
export function suggestEncoding(dataRef, opts = {}) {
  const d = describeShape(dataRef);
  if (!d.ok) return d;
  const root = (isPlainObject(opts) && typeof opts.dataKey === 'string') ? opts.dataKey : 'data';
  const axes = d.axes;
  const cols = Math.max(1, d.cols | 0);

  let spec;
  switch (d.kind) {
    case 'paramspace': {
      // High-D parameter space: project to 2-D position (the projection runs in
      // engine/transform BEFORE compile; here we reference @proj.0/@proj.1), colour
      // a salient column, and pair colour with a SCALE channel (INV-2 second signal).
      const colorCol = cols >= 1 ? colAccessor(root, axes, Math.min(cols - 1, 0)) : `@${root}.0`;
      spec = {
        transform: [{ op: 'pca', components: 2, seed: 1, from: root }],
        encode: {
          position: { from: '@proj.0', scale: { type: 'linear', domain: [-1, 1], range: [-10, 10] }, components: 3 },
          color: { from: colorCol, scale: { type: 'colormap', domain: [0, 1] } },
          scale: { from: colorCol, scale: { type: 'sqrt', domain: [0, 1], range: [0.2, 2] } },
        },
      };
      break;
    }
    case 'timeseries': {
      // Time series: value -> position, with a MOTION channel driven by the timeline.
      const valCol = colAccessor(root, axes, Math.min(cols - 1, cols >= 2 ? 1 : 0));
      spec = {
        encode: {
          position: { from: valCol, scale: { type: 'linear', domain: [0, 1], range: [0, 10] }, components: 3 },
          motion: { from: valCol, scale: { type: 'linear', domain: [0, 1], range: [0, 1] } },
          color: { from: valCol, scale: { type: 'colormap', domain: [0, 1] } },
        },
      };
      break;
    }
    case 'graph': {
      // Graph: a FLOW motion channel + colormap of node/edge weight (flow-graph).
      const wCol = colAccessor(root, axes, 0);
      spec = {
        encode: {
          motion: { from: wCol, scale: { type: 'linear', domain: [0, 1], range: [0, 1] } },
          color: { from: wCol, scale: { type: 'colormap', domain: [0, 1] } },
          opacity: { from: wCol, scale: { type: 'linear', domain: [0, 1], range: [0.2, 1] } },
        },
      };
      break;
    }
    case 'points': {
      // Points: direct xyz position + colormap, paired with a SCALE second channel.
      const cCol = colAccessor(root, axes, Math.min(cols - 1, 3 <= cols ? 3 : cols - 1));
      spec = {
        encode: {
          position: { from: colAccessor(root, axes, 0), scale: { type: 'linear' }, components: 3 },
          color: { from: cCol, scale: { type: 'colormap', domain: [0, 1] } },
          scale: { from: cCol, scale: { type: 'sqrt', domain: [0, 1], range: [0.2, 1.5] } },
        },
      };
      break;
    }
    case 'field': {
      // Scalar field: colormap of the field value, paired with an OPACITY channel.
      const fCol = colAccessor(root, axes, 0);
      spec = {
        encode: {
          color: { from: fCol, scale: { type: 'colormap', domain: [0, 1] } },
          opacity: { from: fCol, scale: { type: 'linear', domain: [0, 1], range: [0.1, 1] } },
        },
      };
      break;
    }
    default:
      return reject(`suggestEncoding: unsupported data kind "${String(d.kind)}"`);
  }

  // SELF-CHECK: the heuristic must NEVER return a spec encode.validate rejects.
  const v = validate(spec);
  if (!v.ok) return reject(`suggestEncoding: internal — produced spec failed validate: ${v.errors.join('; ')}`);
  return spec;
}

export const suggest = Object.freeze({ suggestEncoding, describeShape, DATA_KINDS });
export default suggest;
