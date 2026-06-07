/* =============================================================================
 *  engine/copilot/runtime-doc.mjs  —  the COPILOT RUNTIME MODEL (doc-export)
 *  (Story P6.1b — SUPERSEDES the retired live-LLM "server seam" framing of ADR-D5)
 *
 *  WHAT THIS IS: a tiny, pure DOC-EXPORT recording the corrected P6 runtime model.
 *  It replaces the retired `server-seam.mjs`. There is intentionally NO runtime
 *  code here, NO Anthropic SDK, NO key, NO network, NO live-model call — and there
 *  must NEVER be. This module states, in machine-readable form, where the AI
 *  runtime actually lives.
 *
 *  THE RUNTIME MODEL (corrected):
 *    1. The AI runtime is the **Claude CLI** — the developer's Claude Code session.
 *       It is NOT an in-app model, NOT an Anthropic API call, NOT a server. The
 *       developer is in the loop: they refine the draft and Claude Code implements
 *       the change locally on the working tree.
 *    2. The FRONTEND is a PROMPT GENERATOR (`./generate.mjs` -> `generatePrompt`):
 *       given a selected target + an effect (from VFX.list) + an optional intent
 *       (+ optional data ref), it produces a PRELIMINARY, well-structured markdown
 *       prompt naming the target + effect + current params + intent + the relevant
 *       engine tool-API action(s) + suggestEncoding's recommendation (if data-
 *       driven) + the file/section context + the guardrails. The developer COPIES
 *       that draft into the Claude CLI, refines it, and Claude Code implements it.
 *    3. The engine TOOL-API (`./index.mjs`) stays: `validate`/`dispatch` -> a
 *       serializable diff. It is the DETERMINISTIC APPLY path the Claude CLI can
 *       emit (the same closed action space a human uses through `editor/`), so an
 *       implemented change is replayable, auditable, and conformance-checkable.
 *    4. DEPLOY: ONLY the production visualization deploys. The prompt generator is
 *       a LOCAL dev/authoring aid — dev-flag gated AND excluded from the production
 *       build artifact; it must NOT ship.
 *
 *  WHY NO SERVER / NO KEY / NO NETWORK: the whole live-LLM-over-HTTP framing of the
 *  old ADR-D5 is RETIRED. There is no in-app inference and no API dependency. The
 *  developer-in-the-loop Claude CLI is the runtime; the firewall (INV-6) forbids
 *  `engine/**` from reaching the network at all, and this model has nothing to
 *  reach.
 *
 *  FIREWALL (INV-6): imports NOTHING. Pure constants/strings. No THREE, no app
 *  modules, no network.
 * ========================================================================== */

/** Module identity. */
export const VERSION = '0.2.0-p6.1b-runtime-doc';
export const NAME = 'engine/copilot/runtime-doc';

/**
 * RUNTIME — the machine-readable record of the corrected P6 runtime model.
 * Frozen so a host/test can assert the model without parsing prose.
 */
export const RUNTIME = Object.freeze({
  /** The AI runtime is the developer's Claude Code CLI session. */
  kind: 'claude-cli',
  /** Human-in-the-loop: the developer refines the draft + implements locally. */
  developerInTheLoop: true,
  /** There is NO in-app model / API / server / live-LLM call. */
  inAppModel: false,
  apiServer: false,
  liveLlmCall: false,
  network: false,
  /** The frontend is a prompt generator producing a preliminary draft prompt. */
  frontend: 'prompt-generator',
  /** The generated prompt is a STARTING DRAFT, not an executed action. */
  promptIsDraft: true,
  /** The engine tool-API remains the deterministic APPLY path (serializable diffs). */
  applyPath: 'engine tool-API (validate/dispatch -> serializable diff)',
  /** Only the production visualization deploys; the generator is dev-flag-gated + build-excluded. */
  deploy: 'visualization-only',
  generatorShipsInProduction: false,
});

/**
 * runtimeModel() — a short human-readable statement of the runtime model.
 * (No runtime behaviour; documentation surface only.)
 */
export function runtimeModel() {
  return [
    'The AI runtime is the Claude CLI (the developer Claude Code session) — developer-in-the-loop.',
    'There is no in-app model, no API key, no server, and no live-LLM call.',
    'The frontend is a PROMPT GENERATOR: generatePrompt(selection, context) emits a preliminary',
    'markdown prompt the developer copies into Claude Code, refines, and implements locally.',
    'The engine tool-API (validate/dispatch -> serializable diff) is the deterministic APPLY path',
    'the Claude CLI can emit. Only the production visualization deploys; the prompt generator is a',
    'local dev/authoring aid, dev-flag gated and excluded from the production build artifact.',
  ].join(' ');
}

export const runtimeDoc = Object.freeze({ NAME, VERSION, RUNTIME, runtimeModel });
export default runtimeDoc;
