/**
 * Public entry point for `@peaktek/resolvetrace-sdk`.
 *
 * Customer code imports directly from the package root:
 *
 * ```ts
 * import { createClient } from '@peaktek/resolvetrace-sdk';
 *
 * const rt = createClient({
 *   apiKey: process.env.RT_KEY!,
 *   endpoint: 'https://ingest.resolvetrace.com',
 * });
 *
 * rt.track('page_view', { path: '/home' });
 * ```
 */

export { ResolveTraceClient, createClient } from './client.js';
export {
  ConfigError,
  ResolveTraceError,
  TransportError,
  BudgetExceededError,
  SessionUnknownError,
  SessionRecoveryFailedError,
  SessionRequiredError,
} from './errors.js';
export type { ResolveTraceErrorCode } from './errors.js';
export type {
  ActorIdentity,
  AttributeValue,
  AutoCaptureOptions,
  ClientOptions,
  Diagnostics,
  DiagnosticsLevel,
  EventAttributes,
  EventBatchAcceptedResponse,
  EventBatchRequest,
  EventContext,
  EventEnvelope,
  EventInput,
  FlushOptions,
  FlushResult,
  IsoDateTime,
  KnownEventType,
  MaskSelector,
  ScrubberReport,
  SdkIdentity,
  SessionEndOptions,
  SessionEndPayload,
  SessionEndReason,
  SessionStartPayload,
  SessionStartResponse,
  SessionUnknownErrorBody,
  Severity,
  ShutdownOptions,
  Ulid,
} from './types.js';
export { generateUlid, isUlid } from './ulid.js';
export { EVENT_TYPES, SCHEMA_VERSION, SDK_NAME, SDK_VERSION } from './constants.js';
// Auto-capture framework surface (browser-only). A2 reuses the masked-selector
// helper for breadcrumb target descriptors and the `CaptureSource` contract to
// register error/network/perf sources.
export {
  AutoCapture,
  defaultSources,
  describeTarget,
  describeForm,
  isInteractiveTarget,
  isMaskedTarget,
  MASKED_TOKEN,
} from './autocapture/index.js';
export type {
  AutoCaptureDeps,
  CaptureContext,
  CaptureSource,
  Teardown,
} from './autocapture/index.js';
export type { ReplayOptions, ReplayMode } from './types.js';
// In-app problem reporting (Wave-25). The report API lives on the client
// (`client.reportProblem`); the optional one-click widget is exported here so a
// host can mount it explicitly, independent of the `reportWidget` config option.
export { mountReportWidget } from './report-widget.js';
export type {
  ReportWidgetClient,
  ReportWidgetHandle,
  MountReportWidgetOptions,
} from './report-widget.js';
export type {
  ReportProblemInput,
  ReportSource,
} from './report.js';
export type {
  ReportWidgetOptions,
  ReportWidgetPosition,
} from './types.js';
// Masked replay (rrweb) adapter surface (Wave-24, browser-only). Exposed so
// hosts / tests can reference the policy + chunk types; the recorder is driven
// by the client's session lifecycle.
export {
  ReplayRecorder,
  ReplayChunker,
  ReplayTransport,
  resolveReplayConfig,
  defaultReplayConfig,
  defaultMaskingConfig,
  DEFAULT_REPLAY_BLOCK_SELECTOR,
  DEFAULT_REPLAY_MASK_TEXT_SELECTOR,
} from './autocapture/replay/index.js';
export type {
  ResolvedReplayConfig,
  ReplayMaskingConfig,
  ReplayChunk,
  ReplayManifestBody,
  ReplaySignedUrlBody,
  ReplayScrubberReport,
  ReplayPolicyProvider,
} from './autocapture/replay/index.js';
