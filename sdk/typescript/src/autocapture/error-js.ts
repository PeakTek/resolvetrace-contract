/**
 * `error.js` capture source.
 *
 * Listens for uncaught JavaScript errors (`window` `'error'`) and unhandled
 * promise rejections (`window` `'unhandledrejection'`) and emits an `error.js`
 * breadcrumb carrying the error message, error type/name, and the stack — all
 * routed through the Stage-1 scrubber by `capture()`, so any PII shape in a
 * message or stack frame is redacted before enqueue. `severity: "error"`.
 *
 * We never read DOM/input state here — only the Error object the browser
 * surfaces. Listener bodies are wrapped in try/catch so a capture failure can
 * never escalate into a second uncaught error.
 */

import { EVENT_TYPES } from '../constants.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

/** Cap stack length defensively; the scrubber + payload caps also apply. */
const MAX_STACK_LEN = 8 * 1024;

interface ExtractedError {
  message: string;
  errorType: string;
  stack: string | undefined;
}

/** Pull a safe { message, errorType, stack } out of an arbitrary thrown value. */
function extractError(value: unknown): ExtractedError {
  if (value instanceof Error) {
    return {
      message: String(value.message ?? ''),
      errorType: value.name || 'Error',
      stack:
        typeof value.stack === 'string'
          ? value.stack.slice(0, MAX_STACK_LEN)
          : undefined,
    };
  }
  // Non-Error throws (strings, objects). Keep a bounded string form; never
  // serialize the whole object (could carry arbitrary nested PII).
  if (typeof value === 'string') {
    return { message: value, errorType: 'string', stack: undefined };
  }
  return {
    message: '',
    errorType: typeof value,
    stack: undefined,
  };
}

export function createErrorJsSource(): CaptureSource {
  return {
    name: 'error_js',
    isEnabled: (config) => config.enabled && config.errorJs,
    install(ctx: CaptureContext): Teardown {
      const { window } = ctx;

      const emitError = (extracted: ExtractedError, kind: string): void => {
        try {
          ctx.emit({
            type: EVENT_TYPES.ERROR_JS,
            severity: 'error',
            attributes: {
              kind,
              message: extracted.message,
              errorType: extracted.errorType,
              ...(extracted.stack !== undefined
                ? { stack: extracted.stack }
                : {}),
            },
          });
        } catch (err) {
          ctx.debug?.('error_js emit failed', err);
        }
      };

      const onError = (ev: Event): void => {
        try {
          // `ErrorEvent` carries `.error` (the thrown value) plus `.message`.
          const ee = ev as ErrorEvent;
          const thrown =
            (ee as { error?: unknown }).error ?? (ee.message as unknown);
          const extracted = extractError(thrown);
          // Prefer the ErrorEvent.message when the thrown value had none.
          if (!extracted.message && typeof ee.message === 'string') {
            extracted.message = ee.message;
          }
          emitError(extracted, 'error');
        } catch (err) {
          ctx.debug?.('error_js onerror handler failed', err);
        }
      };

      const onRejection = (ev: Event): void => {
        try {
          const reason = (ev as PromiseRejectionEvent).reason as unknown;
          emitError(extractError(reason), 'unhandledrejection');
        } catch (err) {
          ctx.debug?.('error_js onrejection handler failed', err);
        }
      };

      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onRejection);

      return () => {
        try {
          window.removeEventListener('error', onError);
        } catch {
          /* ignore */
        }
        try {
          window.removeEventListener('unhandledrejection', onRejection);
        } catch {
          /* ignore */
        }
      };
    },
  };
}
