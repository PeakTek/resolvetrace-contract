/**
 * Typed error classes thrown by the ResolveTrace SDK.
 *
 * All errors extend `Error` and carry a stable `code` string property so
 * host-app `onError` handlers can discriminate without brittle `instanceof`
 * chains across bundler boundaries.
 */

import type { Ulid } from './types.js';

export type ResolveTraceErrorCode =
  | 'config.invalid'
  | 'config.unknown_option'
  | 'config.api_key_invalid'
  | 'config.endpoint_invalid'
  | 'config.api_key_too_large'
  | 'config.session_inactivity_invalid'
  | 'config.session_max_duration_invalid'
  | 'transport.network'
  | 'transport.http'
  | 'transport.timeout'
  | 'transport.retries_exhausted'
  | 'transport.payload_too_large'
  | 'scrub.budget_exceeded'
  | 'queue.backpressure'
  | 'client.shutdown'
  | 'session.unknown'
  | 'session.recovery_failed'
  | 'session.required'
  | 'session.storage_unavailable';

/** Base class for all SDK errors. */
export class ResolveTraceError extends Error {
  public readonly code: ResolveTraceErrorCode;

  constructor(code: ResolveTraceErrorCode, message: string) {
    super(message);
    this.name = 'ResolveTraceError';
    this.code = code;
    // Restore prototype for ES5/ES2015 interop with bundlers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the caller supplies invalid constructor options. */
export class ConfigError extends ResolveTraceError {
  constructor(code: ResolveTraceErrorCode, message: string) {
    super(code, message);
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/** Thrown for HTTP / network transport failures that escape the retry envelope. */
export class TransportError extends ResolveTraceError {
  public readonly status?: number;

  constructor(code: ResolveTraceErrorCode, message: string, status?: number) {
    super(code, message);
    this.name = 'TransportError';
    if (status !== undefined) this.status = status;
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

/** Thrown by internal scrub-budget guards. Never propagates to the host app. */
export class BudgetExceededError extends ResolveTraceError {
  constructor(message: string = 'Scrub budget exceeded') {
    super('scrub.budget_exceeded', message);
    this.name = 'BudgetExceededError';
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }
}

/**
 * Surfaced to the client when the server responds 409 with
 * `{ "error": "session_unknown" }` for an events batch. Carries the affected
 * session ID(s) so the recovery path can re-issue session start and retry.
 */
export class SessionUnknownError extends ResolveTraceError {
  /** Session IDs the server could not resolve for the requesting tenant. */
  public readonly unresolvedSessionIds: Ulid[];

  constructor(unresolvedSessionIds: Ulid[], message?: string) {
    super(
      'session.unknown',
      message ??
        'Server reported the session ID is not known. Re-issue session start and retry.',
    );
    this.name = 'SessionUnknownError';
    this.unresolvedSessionIds = unresolvedSessionIds;
    Object.setPrototypeOf(this, SessionUnknownError.prototype);
  }
}

/**
 * Surfaced via `onError` when the SDK's one-shot session-unknown recovery
 * fails (server still reports `session_unknown` after the re-issued start).
 * The events batch is dropped; the session ID is NOT rolled.
 */
export class SessionRecoveryFailedError extends ResolveTraceError {
  public readonly unresolvedSessionIds: Ulid[];

  constructor(unresolvedSessionIds: Ulid[], message?: string) {
    super(
      'session.recovery_failed',
      message ??
        'Session recovery failed: server still reports session_unknown after re-issued start.',
    );
    this.name = 'SessionRecoveryFailedError';
    this.unresolvedSessionIds = unresolvedSessionIds;
    Object.setPrototypeOf(this, SessionRecoveryFailedError.prototype);
  }
}

/** Thrown when `capture()` runs without an active session in `autoSession: false` mode. */
export class SessionRequiredError extends ResolveTraceError {
  constructor(message?: string) {
    super(
      'session.required',
      message ??
        'No active session. Call client.session.restart() before capture, or enable autoSession.',
    );
    this.name = 'SessionRequiredError';
    Object.setPrototypeOf(this, SessionRequiredError.prototype);
  }
}
