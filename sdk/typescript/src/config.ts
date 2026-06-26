/**
 * Validation of the `ResolveTraceClient` constructor options.
 *
 * The SDK accepts exactly two wire-affecting arguments (`apiKey`, `endpoint`)
 * plus a small set of strictly-local hooks. Any other option is rejected
 * at construction time.
 */

import {
  ALLOWED_AUTOCAPTURE_KEYS,
  ALLOWED_OPTION_KEYS,
  ALLOWED_REPORT_WIDGET_KEYS,
  REPORT_WIDGET_POSITIONS,
  DEFAULT_AUTO_CAPTURE_MAX_EVENTS_PER_SESSION,
  DEFAULT_ERROR_STATUS_THRESHOLD,
  DEFAULT_DEAD_CLICK_WINDOW_MS,
  DEFAULT_RAGE_CLICK_THRESHOLD,
  DEFAULT_RAGE_CLICK_WINDOW_MS,
  DEFAULT_REPEATED_SUBMIT_THRESHOLD,
  DEFAULT_REPEATED_SUBMIT_WINDOW_MS,
  DEFAULT_SESSION_INACTIVITY_MS,
  DEFAULT_SESSION_MAX_DURATION_MS,
  MAX_API_KEY_BYTES,
  MIN_SESSION_TIMEOUT_MS,
} from './constants.js';
import { ALLOWED_REPLAY_KEYS } from './constants.js';
import { ConfigError } from './errors.js';
import {
  defaultReplayConfig,
  resolveReplayConfig,
} from './autocapture/replay/policy.js';
import type { ResolvedReplayConfig } from './autocapture/replay/policy.js';
import type { ClientOptions, ReportWidgetOptions } from './types.js';

/** Fully-resolved, validated auto-capture configuration (browser-only). */
export interface ResolvedAutoCaptureConfig {
  enabled: boolean;
  rageClick: boolean;
  deadClick: boolean;
  repeatedSubmit: boolean;
  // Breadcrumb sources (Wave-21 A2).
  errorJs: boolean;
  errorApi: boolean;
  apiLatency: boolean;
  errorResource: boolean;
  longTask: boolean;
  rageClickThreshold: number;
  rageClickWindowMs: number;
  deadClickWindowMs: number;
  repeatedSubmitThreshold: number;
  repeatedSubmitWindowMs: number;
  /** HTTP status at or above which a network breadcrumb is an `error.api`. */
  errorStatusThreshold: number;
  maxEventsPerSession: number;
  /** Masked replay (rrweb) capture policy (browser-only; off by default). */
  replay: ResolvedReplayConfig;
}

/** Normalized, validated options used internally. */
export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  endpointUrl: URL;
  onError: ((err: Error) => void) | undefined;
  beforeSend: ClientOptions['beforeSend'];
  beforeSendTimeoutMs: number;
  debug: boolean;
  transport: typeof fetch | undefined;
  maskSelectors: string[];
  sessionInactivityMs: number;
  sessionMaxDurationMs: number;
  autoSession: boolean;
  sessionAttributes: (() => Record<string, unknown>) | undefined;
  autoCapture: ResolvedAutoCaptureConfig;
  /**
   * Validated report-widget config. `null` when the host did not request the
   * one-click widget (the default); an options object (always carrying
   * `enabled: true`) when auto-mount was requested via config.
   */
  reportWidget: ReportWidgetOptions | null;
}

/** Hosts that are allowed to use `http://` (dev / loopback). */
const HTTP_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

function isLoopbackOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (HTTP_ALLOWED_HOSTS.has(h)) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

/** Count UTF-8 byte length of a string without pulling in `Buffer`. */
function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // Fallback approximation — works for ASCII keys.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/** Validate a positive-integer tunable, falling back to a default. */
function resolvePositiveInt(
  raw: unknown,
  fallback: number,
  label: string,
): number {
  if (raw === undefined) return fallback;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw <= 0
  ) {
    throw new ConfigError(
      'config.invalid',
      `\`autoCapture.${label}\` must be a positive integer.`,
    );
  }
  return raw;
}

/** Validate a boolean tunable, falling back to a default. */
function resolveBool(raw: unknown, fallback: boolean, label: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new ConfigError(
      'config.invalid',
      `\`autoCapture.${label}\` must be a boolean if provided.`,
    );
  }
  return raw;
}

/**
 * Validate + normalize the `autoCapture` option. Accepts:
 *   - `undefined`  → everything on (browser-gated at install time).
 *   - `true`/`false` → master switch, all defaults otherwise.
 *   - an options object → per-key validation (rejects unknown keys, like the
 *     top-level option allow-list).
 */
function resolveAutoCapture(raw: unknown): ResolvedAutoCaptureConfig {
  const defaults: ResolvedAutoCaptureConfig = {
    enabled: true,
    rageClick: true,
    deadClick: true,
    repeatedSubmit: true,
    errorJs: true,
    errorApi: true,
    apiLatency: true,
    errorResource: true,
    longTask: true,
    rageClickThreshold: DEFAULT_RAGE_CLICK_THRESHOLD,
    rageClickWindowMs: DEFAULT_RAGE_CLICK_WINDOW_MS,
    deadClickWindowMs: DEFAULT_DEAD_CLICK_WINDOW_MS,
    repeatedSubmitThreshold: DEFAULT_REPEATED_SUBMIT_THRESHOLD,
    repeatedSubmitWindowMs: DEFAULT_REPEATED_SUBMIT_WINDOW_MS,
    errorStatusThreshold: DEFAULT_ERROR_STATUS_THRESHOLD,
    maxEventsPerSession: DEFAULT_AUTO_CAPTURE_MAX_EVENTS_PER_SESSION,
    replay: defaultReplayConfig(),
  };

  if (raw === undefined) return defaults;
  if (typeof raw === 'boolean') return { ...defaults, enabled: raw };
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(
      'config.invalid',
      '`autoCapture` must be a boolean or an options object if provided.',
    );
  }

  const opts = raw as Record<string, unknown>;
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_AUTOCAPTURE_KEYS.has(key)) {
      throw new ConfigError(
        'config.invalid',
        `Unknown autoCapture option: "${key}". Allowed: ${Array.from(
          ALLOWED_AUTOCAPTURE_KEYS,
        )
          .sort()
          .join(', ')}.`,
      );
    }
  }

  return {
    enabled: resolveBool(opts.enabled, defaults.enabled, 'enabled'),
    rageClick: resolveBool(opts.rageClick, defaults.rageClick, 'rageClick'),
    deadClick: resolveBool(opts.deadClick, defaults.deadClick, 'deadClick'),
    repeatedSubmit: resolveBool(
      opts.repeatedSubmit,
      defaults.repeatedSubmit,
      'repeatedSubmit',
    ),
    errorJs: resolveBool(opts.errorJs, defaults.errorJs, 'errorJs'),
    errorApi: resolveBool(opts.errorApi, defaults.errorApi, 'errorApi'),
    apiLatency: resolveBool(opts.apiLatency, defaults.apiLatency, 'apiLatency'),
    errorResource: resolveBool(
      opts.errorResource,
      defaults.errorResource,
      'errorResource',
    ),
    longTask: resolveBool(opts.longTask, defaults.longTask, 'longTask'),
    rageClickThreshold: resolvePositiveInt(
      opts.rageClickThreshold,
      defaults.rageClickThreshold,
      'rageClickThreshold',
    ),
    rageClickWindowMs: resolvePositiveInt(
      opts.rageClickWindowMs,
      defaults.rageClickWindowMs,
      'rageClickWindowMs',
    ),
    deadClickWindowMs: resolvePositiveInt(
      opts.deadClickWindowMs,
      defaults.deadClickWindowMs,
      'deadClickWindowMs',
    ),
    repeatedSubmitThreshold: resolvePositiveInt(
      opts.repeatedSubmitThreshold,
      defaults.repeatedSubmitThreshold,
      'repeatedSubmitThreshold',
    ),
    repeatedSubmitWindowMs: resolvePositiveInt(
      opts.repeatedSubmitWindowMs,
      defaults.repeatedSubmitWindowMs,
      'repeatedSubmitWindowMs',
    ),
    errorStatusThreshold: resolvePositiveInt(
      opts.errorStatusThreshold,
      defaults.errorStatusThreshold,
      'errorStatusThreshold',
    ),
    maxEventsPerSession: resolvePositiveInt(
      opts.maxEventsPerSession,
      defaults.maxEventsPerSession,
      'maxEventsPerSession',
    ),
    replay: resolveReplayConfig(opts.replay, ALLOWED_REPLAY_KEYS),
  };
}

/**
 * Validate + normalize the `reportWidget` option. Accepts:
 *   - `undefined` / `false` → no auto-mounted widget (`null`).
 *   - `true`                → auto-mount with all defaults.
 *   - an options object     → per-key validation (rejects unknown keys, like
 *     the top-level option allow-list); auto-mount unless `enabled: false`.
 *
 * The widget itself is browser-only; this resolver only normalizes config and
 * never touches the DOM, so it is safe to run in node.
 */
function resolveReportWidget(raw: unknown): ReportWidgetOptions | null {
  if (raw === undefined || raw === false) return null;
  if (raw === true) return { enabled: true };
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(
      'config.invalid',
      '`reportWidget` must be a boolean or an options object if provided.',
    );
  }

  const opts = raw as Record<string, unknown>;
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_REPORT_WIDGET_KEYS.has(key)) {
      throw new ConfigError(
        'config.invalid',
        `Unknown reportWidget option: "${key}". Allowed: ${Array.from(
          ALLOWED_REPORT_WIDGET_KEYS,
        )
          .sort()
          .join(', ')}.`,
      );
    }
  }

  if (opts.enabled !== undefined && typeof opts.enabled !== 'boolean') {
    throw new ConfigError(
      'config.invalid',
      '`reportWidget.enabled` must be a boolean if provided.',
    );
  }
  if (opts.enabled === false) return null;

  if (
    opts.position !== undefined &&
    (typeof opts.position !== 'string' ||
      !REPORT_WIDGET_POSITIONS.has(opts.position))
  ) {
    throw new ConfigError(
      'config.invalid',
      `\`reportWidget.position\` must be one of: ${Array.from(
        REPORT_WIDGET_POSITIONS,
      )
        .sort()
        .join(', ')}.`,
    );
  }

  const stringKeys = [
    'buttonText',
    'title',
    'placeholder',
    'submitText',
    'successText',
    'errorText',
    'className',
  ] as const;
  for (const key of stringKeys) {
    const v = opts[key];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      throw new ConfigError(
        'config.invalid',
        `\`reportWidget.${key}\` must be a non-empty string if provided.`,
      );
    }
  }

  // Re-assemble a clean, typed options object (always enabled here).
  const out: ReportWidgetOptions = { enabled: true };
  if (opts.position !== undefined) {
    out.position = opts.position as ReportWidgetOptions['position'];
  }
  for (const key of stringKeys) {
    if (opts[key] !== undefined) {
      (out as Record<string, unknown>)[key] = opts[key];
    }
  }
  return out;
}

export function resolveConfig(input: unknown): ResolvedConfig {
  if (input === null || typeof input !== 'object') {
    throw new ConfigError('config.invalid', 'ResolveTrace options must be an object.');
  }
  const opts = input as Record<string, unknown>;

  // Reject any unknown / forbidden keys (tenantId, environment, region, etc.).
  for (const key of Object.keys(opts)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new ConfigError(
        'config.unknown_option',
        `Unknown ResolveTrace option: "${key}". The SDK accepts exactly: ${Array.from(
          ALLOWED_OPTION_KEYS,
        )
          .sort()
          .join(', ')}.`,
      );
    }
  }

  // apiKey ---------------------------------------------------------------
  const apiKey = opts.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new ConfigError('config.api_key_invalid', '`apiKey` must be a non-empty string.');
  }
  if (utf8ByteLength(apiKey) > MAX_API_KEY_BYTES) {
    throw new ConfigError(
      'config.api_key_too_large',
      `\`apiKey\` exceeds the ${MAX_API_KEY_BYTES}-byte maximum.`,
    );
  }

  // endpoint -------------------------------------------------------------
  const endpoint = opts.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new ConfigError(
      'config.endpoint_invalid',
      '`endpoint` must be a non-empty HTTPS URL string.',
    );
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new ConfigError(
      'config.endpoint_invalid',
      `\`endpoint\` is not a valid URL: ${endpoint}`,
    );
  }
  if (endpointUrl.protocol !== 'https:') {
    if (endpointUrl.protocol !== 'http:' || !isLoopbackOrLocalHost(endpointUrl.hostname)) {
      throw new ConfigError(
        'config.endpoint_invalid',
        '`endpoint` must use https:// (http:// is only permitted for localhost / .local development).',
      );
    }
  }

  // onError --------------------------------------------------------------
  const onError = opts.onError;
  if (onError !== undefined && typeof onError !== 'function') {
    throw new ConfigError('config.invalid', '`onError` must be a function if provided.');
  }

  // beforeSend ----------------------------------------------------------
  const beforeSend = opts.beforeSend;
  if (beforeSend !== undefined && typeof beforeSend !== 'function') {
    throw new ConfigError('config.invalid', '`beforeSend` must be a function if provided.');
  }

  // beforeSendTimeoutMs -------------------------------------------------
  const beforeSendTimeoutMsRaw = opts.beforeSendTimeoutMs;
  let beforeSendTimeoutMs = 4;
  if (beforeSendTimeoutMsRaw !== undefined) {
    if (
      typeof beforeSendTimeoutMsRaw !== 'number' ||
      !Number.isFinite(beforeSendTimeoutMsRaw) ||
      beforeSendTimeoutMsRaw <= 0
    ) {
      throw new ConfigError(
        'config.invalid',
        '`beforeSendTimeoutMs` must be a positive finite number.',
      );
    }
    // Users may lower the budget but never raise it above the 4 ms envelope.
    beforeSendTimeoutMs = Math.min(beforeSendTimeoutMsRaw, 4);
  }

  // debug ---------------------------------------------------------------
  const debug = opts.debug === true;

  // transport -----------------------------------------------------------
  const transport = opts.transport;
  if (transport !== undefined && typeof transport !== 'function') {
    throw new ConfigError(
      'config.invalid',
      '`transport` must be a fetch-compatible function if provided.',
    );
  }

  // maskSelectors -------------------------------------------------------
  const maskSelectorsRaw = opts.maskSelectors;
  let maskSelectors: string[] = [];
  if (maskSelectorsRaw !== undefined) {
    if (!Array.isArray(maskSelectorsRaw)) {
      throw new ConfigError('config.invalid', '`maskSelectors` must be an array of strings.');
    }
    maskSelectors = maskSelectorsRaw.map((s, i) => {
      if (typeof s !== 'string' || s.length === 0) {
        throw new ConfigError(
          'config.invalid',
          `\`maskSelectors[${i}]\` must be a non-empty string.`,
        );
      }
      return s;
    });
  }

  // sessionInactivityMs -------------------------------------------------
  const sessionInactivityMsRaw = opts.sessionInactivityMs;
  let sessionInactivityMs = DEFAULT_SESSION_INACTIVITY_MS;
  if (sessionInactivityMsRaw !== undefined) {
    if (
      typeof sessionInactivityMsRaw !== 'number' ||
      !Number.isFinite(sessionInactivityMsRaw) ||
      sessionInactivityMsRaw < MIN_SESSION_TIMEOUT_MS ||
      sessionInactivityMsRaw > DEFAULT_SESSION_INACTIVITY_MS
    ) {
      throw new ConfigError(
        'config.session_inactivity_invalid',
        `\`sessionInactivityMs\` must be a finite number between ${MIN_SESSION_TIMEOUT_MS} and ${DEFAULT_SESSION_INACTIVITY_MS}.`,
      );
    }
    sessionInactivityMs = sessionInactivityMsRaw;
  }

  // sessionMaxDurationMs ------------------------------------------------
  const sessionMaxDurationMsRaw = opts.sessionMaxDurationMs;
  let sessionMaxDurationMs = DEFAULT_SESSION_MAX_DURATION_MS;
  if (sessionMaxDurationMsRaw !== undefined) {
    if (
      typeof sessionMaxDurationMsRaw !== 'number' ||
      !Number.isFinite(sessionMaxDurationMsRaw) ||
      sessionMaxDurationMsRaw < MIN_SESSION_TIMEOUT_MS ||
      sessionMaxDurationMsRaw > DEFAULT_SESSION_MAX_DURATION_MS
    ) {
      throw new ConfigError(
        'config.session_max_duration_invalid',
        `\`sessionMaxDurationMs\` must be a finite number between ${MIN_SESSION_TIMEOUT_MS} and ${DEFAULT_SESSION_MAX_DURATION_MS}.`,
      );
    }
    sessionMaxDurationMs = sessionMaxDurationMsRaw;
  }

  // autoSession ---------------------------------------------------------
  const autoSessionRaw = opts.autoSession;
  if (autoSessionRaw !== undefined && typeof autoSessionRaw !== 'boolean') {
    throw new ConfigError('config.invalid', '`autoSession` must be a boolean if provided.');
  }
  const autoSession = autoSessionRaw === undefined ? true : autoSessionRaw;

  // autoCapture ---------------------------------------------------------
  const autoCapture = resolveAutoCapture(opts.autoCapture);

  // reportWidget --------------------------------------------------------
  const reportWidget = resolveReportWidget(opts.reportWidget);

  // sessionAttributes ---------------------------------------------------
  const sessionAttributesRaw = opts.sessionAttributes;
  if (
    sessionAttributesRaw !== undefined &&
    typeof sessionAttributesRaw !== 'function'
  ) {
    throw new ConfigError(
      'config.invalid',
      '`sessionAttributes` must be a function if provided.',
    );
  }

  return {
    apiKey,
    endpoint,
    endpointUrl,
    onError: onError as ((err: Error) => void) | undefined,
    beforeSend: beforeSend as ClientOptions['beforeSend'],
    beforeSendTimeoutMs,
    debug,
    transport: transport as typeof fetch | undefined,
    maskSelectors,
    sessionInactivityMs,
    sessionMaxDurationMs,
    autoSession,
    sessionAttributes: sessionAttributesRaw as
      | (() => Record<string, unknown>)
      | undefined,
    autoCapture,
    reportWidget,
  };
}

/** Redact an Authorization header value to `Bearer [REDACTED:<prefix>]`. */
export function redactAuth(apiKey: string): string {
  const prefix = apiKey.slice(0, 8);
  return `Bearer [REDACTED:${prefix}]`;
}
