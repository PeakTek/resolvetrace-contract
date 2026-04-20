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
} from './errors.js';
export type { ResolveTraceErrorCode } from './errors.js';
export type {
  AttributeValue,
  ClientOptions,
  Diagnostics,
  EventAttributes,
  EventBatchAcceptedResponse,
  EventBatchRequest,
  EventEnvelope,
  EventInput,
  FlushOptions,
  FlushResult,
  IsoDateTime,
  MaskSelector,
  ScrubberReport,
  SdkIdentity,
  ShutdownOptions,
  Ulid,
} from './types.js';
export { generateUlid, isUlid } from './ulid.js';
export { SDK_NAME, SDK_VERSION } from './constants.js';
