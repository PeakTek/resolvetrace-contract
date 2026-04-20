/**
 * Typed error classes thrown by the ResolveTrace SDK.
 *
 * All errors extend `Error` and carry a stable `code` string property so
 * host-app `onError` handlers can discriminate without brittle `instanceof`
 * chains across bundler boundaries.
 */

export type ResolveTraceErrorCode =
  | 'config.invalid'
  | 'config.unknown_option'
  | 'config.api_key_invalid'
  | 'config.endpoint_invalid'
  | 'config.api_key_too_large'
  | 'transport.network'
  | 'transport.http'
  | 'transport.timeout'
  | 'transport.retries_exhausted'
  | 'transport.payload_too_large'
  | 'scrub.budget_exceeded'
  | 'queue.backpressure'
  | 'client.shutdown';

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
