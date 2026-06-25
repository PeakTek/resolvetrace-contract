/**
 * `error.resource` capture source.
 *
 * Resource load failures (a broken `<img>`, a 404'd `<script>`, a missing
 * `<link>` stylesheet) do not bubble — they only fire an `'error'` event in the
 * *capture* phase on `window`. We listen there and, for the resource-bearing
 * element types, emit an `error.resource` breadcrumb with a masked element
 * descriptor (`describeTarget`) and the scrubbed resource URL. `severity:
 * "warn"` — a missing asset is degraded UX, not a hard failure.
 *
 * We must NOT confuse these with `error.js` runtime errors: a runtime error
 * dispatched on `window` is an `ErrorEvent` whose `target` is the window/document
 * itself, whereas a resource error's `target` is the failing element. We filter
 * to the known resource element tags and ignore everything else.
 */

import { EVENT_TYPES } from '../constants.js';
import { describeTarget } from './selector.js';
import { scrubUrl } from './url.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

/** Tags that load an external resource and surface a capture-phase error. */
const RESOURCE_TAGS: ReadonlySet<string> = new Set([
  'IMG',
  'SCRIPT',
  'LINK',
  'AUDIO',
  'VIDEO',
  'SOURCE',
  'TRACK',
]);

/** Read the resource URL attribute appropriate to the element type. */
function resourceUrl(el: Element): string {
  try {
    // `<link>` uses `href`; most others use `src`. Try both.
    const src = el.getAttribute?.('src');
    if (typeof src === 'string' && src.length > 0) return src;
    const href = el.getAttribute?.('href');
    if (typeof href === 'string' && href.length > 0) return href;
  } catch {
    /* ignore */
  }
  return '';
}

export function createErrorResourceSource(): CaptureSource {
  return {
    name: 'error_resource',
    isEnabled: (config) => config.enabled && config.errorResource,
    install(ctx: CaptureContext): Teardown {
      const { window, maskSelectors } = ctx;

      const onError = (ev: Event): void => {
        try {
          const target = (ev as { target?: unknown }).target as Element | null;
          // No element target, or a window/document target → this is a runtime
          // error (handled by error.js), not a resource load failure.
          if (!target || !target.tagName) return;
          if (!RESOURCE_TAGS.has(target.tagName)) return;

          const base =
            (window as { location?: { href?: string } }).location?.href;
          const rawUrl = resourceUrl(target);

          ctx.emit({
            type: EVENT_TYPES.ERROR_RESOURCE,
            severity: 'warn',
            attributes: {
              target: describeTarget(target, maskSelectors),
              resourceType: target.tagName.toLowerCase(),
              resourceUrl: scrubUrl(rawUrl, base),
            },
          });
        } catch (err) {
          ctx.debug?.('error_resource handler failed', err);
        }
      };

      // Capture phase is REQUIRED: resource errors do not bubble.
      window.addEventListener('error', onError, true);

      return () => {
        try {
          window.removeEventListener('error', onError, true);
        } catch {
          /* ignore */
        }
      };
    },
  };
}
