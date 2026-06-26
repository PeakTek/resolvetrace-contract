/**
 * Replay (rrweb) capture adapter — Wave-24 feature #1 (Masked Replay), SDK side.
 *
 * Public surface for the client + tests. Captures masked rrweb sessions and
 * uploads chunks via the existing `/v1/replay/*` endpoints (no contract change).
 * Browser-only; mask-on-by-default; off until a policy enables it.
 */

export { ReplayRecorder, defaultReplayConfig } from './recorder.js';
export type {
  RecorderDeps,
  ReplayPolicyProvider,
  RrwebRecordFn,
} from './recorder.js';
export {
  resolveReplayConfig,
  defaultMaskingConfig,
  diagnosticsLevelAllows,
  routeIsDenied,
  DEFAULT_REPLAY_BLOCK_SELECTOR,
  DEFAULT_REPLAY_MASK_TEXT_SELECTOR,
} from './policy.js';
export type {
  ResolvedReplayConfig,
  ReplayMaskingConfig,
} from './policy.js';
export { ReplayChunker } from './chunker.js';
export type { ReplayChunk, ChunkerOptions } from './chunker.js';
export { ReplayTransport } from './transport.js';
export type {
  ReplayManifestBody,
  ReplaySignedUrlBody,
  ReplayScrubberReport,
  ReplayTransportDeps,
} from './transport.js';
export { sha256Hex, sha256PrefixedOfString } from './digest.js';
