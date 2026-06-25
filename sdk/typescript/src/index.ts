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
  SessionUnknownErrorBody,
  Severity,
  ShutdownOptions,
  Ulid,
} from './types.js';
export { generateUlid, isUlid } from './ulid.js';
export { EVENT_TYPES, SCHEMA_VERSION, SDK_NAME, SDK_VERSION } from './constants.js';
