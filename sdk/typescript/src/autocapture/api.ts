/**
 * `error.api` + `perf.api_latency` capture source.
 *
 * Wraps both `window.fetch` and `XMLHttpRequest` so we can observe the *outcome*
 * of API calls — method, scrubbed URL, status, and duration — without ever
 * touching request or response *bodies*. For each completed request we emit
 * exactly one breadcrumb:
 *
 *   - success (a response with status < `errorStatusThreshold`, default 400) →
 *     `perf.api_latency` carrying `durationMs` + `httpStatus`.
 *   - failure (a network/transport error, or status >= the threshold) →
 *     `error.api` carrying `httpStatus` when one is available + `severity:
 *     "error"`.
 *
 * No request ever produces both events ("no double-emit").
 *
 * Privacy (doc-18 `never_collect_raw`):
 *   - We NEVER read `init.body`, the `Request` body, the `Response` body, or any
 *     header (auth tokens, cookies). The Response object is returned to the
 *     caller untouched (its body stream is never consumed by us), so streaming
 *     consumers keep working.
 *   - The URL is run through `scrubUrl` (origin + path + redacted query values)
 *     and then through the Stage-1 scrubber by `capture()`.
 *
 * Semantics preservation:
 *   - The wrappers call through to the *original* `fetch` / `XHR` methods and
 *     return/propagate exactly what they would have, including rejections and
 *     thrown synchronous errors. Instrumentation runs in try/catch so a capture
 *     bug can never change the host call's outcome.
 *   - On teardown we restore the exact original references we captured at
 *     install time (idempotent; only restores if the slot still holds our
 *     wrapper, so we don't clobber a later monkey-patch by another library).
 */

import { EVENT_TYPES } from '../constants.js';
import { nowMs } from '../runtime.js';
import {
  methodFromFetchArgs,
  scrubUrl,
  urlFromFetchInput,
} from './url.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

interface ApiOutcome {
  method: string;
  url: string;
  status: number | undefined;
  durationMs: number;
  failed: boolean;
}

export function createApiSource(): CaptureSource {
  return {
    name: 'api',
    isEnabled: (config) =>
      config.enabled && (config.apiLatency || config.errorApi),
    install(ctx: CaptureContext): Teardown {
      const { config, window } = ctx;
      const threshold = config.errorStatusThreshold;
      const base = (window as { location?: { href?: string } }).location?.href;

      const record = (o: ApiOutcome): void => {
        try {
          const isError = o.failed || (o.status !== undefined && o.status >= threshold);
          if (isError) {
            if (!config.errorApi) return;
            ctx.emit({
              type: EVENT_TYPES.ERROR_API,
              severity: 'error',
              durationMs: Math.round(o.durationMs),
              ...(o.status !== undefined ? { httpStatus: o.status } : {}),
              attributes: {
                method: o.method,
                url: o.url,
                ...(o.failed ? { networkError: true } : {}),
              },
            });
          } else {
            if (!config.apiLatency) return;
            ctx.emit({
              type: EVENT_TYPES.PERF_API_LATENCY,
              severity: 'info',
              durationMs: Math.round(o.durationMs),
              ...(o.status !== undefined ? { httpStatus: o.status } : {}),
              attributes: {
                method: o.method,
                url: o.url,
              },
            });
          }
        } catch (err) {
          ctx.debug?.('api record failed', err);
        }
      };

      const teardowns: Teardown[] = [];

      // --- fetch wrapper -----------------------------------------------------
      const originalFetch = (window as { fetch?: typeof fetch }).fetch;
      if (typeof originalFetch === 'function') {
        const wrapped = function (
          this: unknown,
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ): Promise<Response> {
          let start = 0;
          let method = 'GET';
          let url = 'unknown';
          try {
            start = nowMs();
            method = methodFromFetchArgs(input, init);
            url = scrubUrl(urlFromFetchInput(input), base);
          } catch {
            /* never block the call on instrumentation setup */
          }
          // Call the ORIGINAL fetch with the ORIGINAL args — no body access.
          let promise: Promise<Response>;
          try {
            promise = originalFetch.call(window, input as never, init as never);
          } catch (syncErr) {
            // Synchronous throw — record as a network failure, then re-throw so
            // the host sees identical behavior.
            try {
              record({
                method,
                url,
                status: undefined,
                durationMs: nowMs() - start,
                failed: true,
              });
            } catch {
              /* ignore */
            }
            throw syncErr;
          }
          return promise.then(
            (response) => {
              try {
                // Read ONLY the status code — never the body or headers.
                const status =
                  typeof (response as { status?: unknown })?.status === 'number'
                    ? (response as { status: number }).status
                    : undefined;
                record({
                  method,
                  url,
                  status,
                  durationMs: nowMs() - start,
                  failed: false,
                });
              } catch {
                /* ignore */
              }
              return response; // untouched — body stream still intact
            },
            (err) => {
              try {
                record({
                  method,
                  url,
                  status: undefined,
                  durationMs: nowMs() - start,
                  failed: true,
                });
              } catch {
                /* ignore */
              }
              throw err; // propagate identical rejection
            },
          );
        } as typeof fetch;

        try {
          (window as { fetch?: typeof fetch }).fetch = wrapped;
          teardowns.push(() => {
            try {
              // Only restore if our wrapper is still installed.
              if ((window as { fetch?: typeof fetch }).fetch === wrapped) {
                (window as { fetch?: typeof fetch }).fetch = originalFetch;
              }
            } catch {
              /* ignore */
            }
          });
        } catch (err) {
          ctx.debug?.('fetch wrap failed', err);
        }
      }

      // --- XMLHttpRequest wrapper -------------------------------------------
      const XHR = (
        window as { XMLHttpRequest?: typeof XMLHttpRequest }
      ).XMLHttpRequest;
      if (typeof XHR === 'function' && XHR.prototype) {
        const proto = XHR.prototype;
        const originalOpen = proto.open;
        const originalSend = proto.send;

        if (
          typeof originalOpen === 'function' &&
          typeof originalSend === 'function'
        ) {
          // Per-instance instrumentation state, stashed under a symbol so we
          // never collide with host properties.
          const META = Symbol('resolvetrace.xhr');
          interface XhrMeta {
            method: string;
            url: string;
            start: number;
            done: boolean;
          }

          const open = function (
            this: XMLHttpRequest,
            method: string,
            xhrUrl: string | URL,
          ): void {
            try {
              const m =
                typeof method === 'string' && method.length > 0
                  ? method.toUpperCase()
                  : 'GET';
              const u =
                typeof xhrUrl === 'string' ? xhrUrl : String(xhrUrl ?? '');
              (this as unknown as Record<symbol, XhrMeta>)[META] = {
                method: m,
                url: scrubUrl(u, base),
                start: 0,
                done: false,
              };
            } catch {
              /* ignore — never block open() */
            }
            // Forward to the original with the EXACT original args (including
            // the optional async/user/password trailing arguments) via apply,
            // so XHR semantics are untouched.
            // eslint-disable-next-line prefer-rest-params
            return (originalOpen as (...a: unknown[]) => void).apply(
              this,
              arguments as unknown as unknown[],
            );
          } as typeof proto.open;

          const send = function (
            this: XMLHttpRequest,
            body?: Document | XMLHttpRequestBodyInit | null,
          ): void {
            try {
              const meta = (this as unknown as Record<symbol, XhrMeta>)[META];
              if (meta) {
                meta.start = nowMs();
                const finish = (failed: boolean): void => {
                  try {
                    if (meta.done) return; // no double-emit (load vs error)
                    meta.done = true;
                    const status =
                      typeof this.status === 'number' && this.status > 0
                        ? this.status
                        : undefined;
                    record({
                      method: meta.method,
                      url: meta.url,
                      status,
                      durationMs: nowMs() - meta.start,
                      // A `load` with status 0 (opaque/blocked) counts as a
                      // failure; an explicit error/timeout/abort is a failure.
                      failed: failed || status === undefined,
                    });
                  } catch (err) {
                    ctx.debug?.('xhr finish failed', err);
                  }
                };
                // `loadend` fires once for success, error, timeout, AND abort —
                // exactly one terminal callback per request.
                this.addEventListener('loadend', () => {
                  // Determine failure from readyState/status at terminal time;
                  // a network error surfaces as status 0.
                  finish(false);
                });
              }
            } catch (err) {
              ctx.debug?.('xhr send instrumentation failed', err);
            }
            // NEVER inspect `body` — forward it untouched.
            return originalSend.call(this, body as never);
          } as typeof proto.send;

          try {
            proto.open = open;
            proto.send = send;
            teardowns.push(() => {
              try {
                if (proto.open === open) proto.open = originalOpen;
                if (proto.send === send) proto.send = originalSend;
              } catch {
                /* ignore */
              }
            });
          } catch (err) {
            ctx.debug?.('xhr wrap failed', err);
          }
        }
      }

      return () => {
        for (const t of teardowns) {
          try {
            t();
          } catch {
            /* ignore */
          }
        }
      };
    },
  };
}
