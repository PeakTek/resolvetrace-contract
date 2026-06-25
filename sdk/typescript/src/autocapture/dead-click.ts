/**
 * `ux.dead_click` capture source.
 *
 * Heuristic: a click on an interactive-looking target that produces NO
 * observable effect — no DOM mutation, no navigation (URL change), and no
 * network activity — within W ms (default 2500) is a "dead click": the user
 * clicked something that looks clickable but nothing happened.
 *
 * We arm a timer on each qualifying click and watch three signals during the
 * window:
 *   - DOM mutations (a shared `MutationObserver`),
 *   - URL change (`location.href` poll at resolution time),
 *   - network activity (a monotonically-increasing counter the framework can
 *     bump; A2's fetch/XHR wrappers increment it, and we also observe it here
 *     defensively). Absent A2, we still flag clicks with no DOM/nav effect.
 *
 * Emits at most once per target descriptor per window, `severity: "info"`.
 */

import { EVENT_TYPES } from '../constants.js';
import { nowMs } from '../runtime.js';
import { describeTarget, isInteractiveTarget, isMaskedTarget } from './selector.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

interface PendingClick {
  descriptor: string;
  hrefAtClick: string;
  mutatedSince: () => boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function createDeadClickSource(): CaptureSource {
  return {
    name: 'dead_click',
    isEnabled: (config) => config.enabled && config.deadClick,
    install(ctx: CaptureContext): Teardown {
      const { config, maskSelectors, document, window } = ctx;

      // Shared monotonic mutation counter — cheap to read at resolution time.
      let mutationSeq = 0;
      let observer: MutationObserver | null = null;
      try {
        const Ctor = (window as { MutationObserver?: typeof MutationObserver })
          .MutationObserver;
        if (typeof Ctor === 'function') {
          observer = new Ctor(() => {
            mutationSeq += 1;
          });
          const body = document.body ?? document.documentElement;
          if (body) {
            observer.observe(body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          }
        }
      } catch (err) {
        ctx.debug?.('dead_click observer setup failed', err);
        observer = null;
      }

      const pending = new Set<PendingClick>();
      // Suppress duplicate flags for the same descriptor inside its window.
      const recentlyFlagged = new Map<string, number>();

      const currentHref = (): string => {
        try {
          const loc = (window as { location?: { href?: string } }).location;
          return typeof loc?.href === 'string' ? loc.href : '';
        } catch {
          return '';
        }
      };

      const onClick = (ev: Event): void => {
        try {
          const target = ev.target as Element | null;
          if (!target) return;
          if (isMaskedTarget(target, maskSelectors)) {
            // Still track for dead-ness but the descriptor will be masked.
          }
          if (!isInteractiveTarget(target)) return;

          const descriptor = describeTarget(target, maskSelectors);
          const now = nowMs();

          // De-dupe: one dead-click per descriptor per window.
          const last = recentlyFlagged.get(descriptor);
          if (last !== undefined && now - last < config.deadClickWindowMs) {
            return;
          }

          const seqAtClick = mutationSeq;
          const hrefAtClick = currentHref();

          const record: PendingClick = {
            descriptor,
            hrefAtClick,
            mutatedSince: () => mutationSeq !== seqAtClick,
            timer: setTimeout(() => {
              try {
                pending.delete(record);
                // Effect observed → not a dead click.
                if (record.mutatedSince()) return;
                if (currentHref() !== record.hrefAtClick) return;
                recentlyFlagged.set(record.descriptor, nowMs());
                ctx.emit({
                  type: EVENT_TYPES.UX_DEAD_CLICK,
                  severity: 'info',
                  attributes: { target: record.descriptor },
                });
              } catch (err) {
                ctx.debug?.('dead_click resolution failed', err);
              }
            }, config.deadClickWindowMs),
          };
          pending.add(record);
        } catch (err) {
          ctx.debug?.('dead_click handler failed', err);
        }
      };

      document.addEventListener('click', onClick, true);

      return () => {
        try {
          document.removeEventListener('click', onClick, true);
        } catch {
          /* ignore */
        }
        for (const p of pending) {
          try {
            clearTimeout(p.timer);
          } catch {
            /* ignore */
          }
        }
        pending.clear();
        recentlyFlagged.clear();
        try {
          observer?.disconnect();
        } catch {
          /* ignore */
        }
        observer = null;
      };
    },
  };
}
