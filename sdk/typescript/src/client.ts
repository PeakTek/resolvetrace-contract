/**
 * `ResolveTraceClient` — the only class customer code needs to import.
 *
 * The constructor accepts exactly `{ apiKey, endpoint }` plus a small set of
 * strictly-local hooks. Any other option is rejected. See the public README
 * for the supported surface.
 */

import { resolveConfig } from './config.js';
import type { ResolvedConfig } from './config.js';
import { buildEnvelope } from './envelope.js';
import { Transport } from './transport.js';
import type {
  ClientOptions,
  Diagnostics,
  EventAttributes,
  EventInput,
  FlushOptions,
  FlushResult,
  ShutdownOptions,
} from './types.js';

/** Resolve a fetch implementation, preferring the user's injected one. */
function resolveFetch(cfg: ResolvedConfig): typeof fetch {
  if (cfg.transport) return cfg.transport;
  const g = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof g === 'function') {
    // Bind to `globalThis` so browsers that require a receiver keep working.
    return g.bind(globalThis);
  }
  throw new Error(
    'No global `fetch` is available in this runtime. Pass a fetch override via `transport` or upgrade to Node 18+.',
  );
}

/**
 * The dumb-client SDK: opaque `apiKey` in, events out.
 *
 * Customers never configure tenancy, environment, or region on this class;
 * every wire-affecting decision is encoded in their API key and resolved
 * server-side. See the project README for a high-level overview.
 */
export class ResolveTraceClient {
  private readonly config: ResolvedConfig;
  private readonly transport: Transport;

  constructor(options: ClientOptions) {
    this.config = resolveConfig(options);
    const fetchImpl = resolveFetch(this.config);
    this.transport = new Transport(this.config, { fetchImpl });
  }

  /**
   * Enqueue an event. Returns the client-generated ULID assigned to the
   * event so the caller can log / correlate it without waiting for the
   * round-trip.
   */
  capture(event: EventInput): string {
    const envelope = buildEnvelope(event);

    // Run the user-supplied `beforeSend` hook (strictly after Stage-1 scrub).
    if (this.config.beforeSend) {
      const transformed = this.runBeforeSend(envelope);
      if (transformed === null) {
        return envelope.eventId;
      }
      this.transport.enqueue(transformed);
      return transformed.eventId;
    }

    this.transport.enqueue(envelope);
    return envelope.eventId;
  }

  /** Convenience wrapper: `track("page_view", {path: "/home"})`. */
  track(name: string, attrs?: EventAttributes): string {
    return this.capture({ type: name, attributes: attrs });
  }

  /** Forces the queue to drain immediately. Safe to call repeatedly. */
  async flush(opts: FlushOptions = {}): Promise<FlushResult> {
    return this.transport.flush(opts);
  }

  /**
   * Final flush + release of timers. After calling `shutdown()`, `capture()`
   * calls are dropped and `getDiagnostics()` reflects the drop count.
   */
  async shutdown(opts: ShutdownOptions = {}): Promise<void> {
    await this.transport.shutdown(opts);
  }

  /** Read-only counter snapshot for observability. */
  getDiagnostics(): Diagnostics {
    return this.transport.snapshot();
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  private runBeforeSend(envelope: ReturnType<typeof buildEnvelope>) {
    const hook = this.config.beforeSend;
    if (!hook) return envelope;
    try {
      const result = hook(envelope);
      if (result === undefined) return envelope;
      if (result === null) return null;
      return result;
    } catch (err) {
      if (this.config.onError) {
        try {
          this.config.onError(err instanceof Error ? err : new Error(String(err)));
        } catch {
          /* swallow */
        }
      }
      return envelope;
    }
  }
}

/**
 * Factory helper — mirrors the idiomatic `createClient({...})` pattern
 * customers expect from modern TS SDKs.
 */
export function createClient(options: ClientOptions): ResolveTraceClient {
  return new ResolveTraceClient(options);
}
