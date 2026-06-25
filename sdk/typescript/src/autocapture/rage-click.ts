/**
 * `ux.rage_click` capture source.
 *
 * Heuristic: N+ clicks (default 3) on the *same masked target* within a sliding
 * window (default 1000ms) is a rage burst. We emit ONCE per burst (when the
 * threshold is first crossed) with the masked target descriptor + `clickCount`,
 * `severity: "warn"`. Further clicks on the same target inside the same window
 * extend the burst but do not re-emit, so a long mash produces one event, not a
 * flood.
 */

import { EVENT_TYPES } from '../constants.js';
import { nowMs } from '../runtime.js';
import { describeTarget } from './selector.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

interface BurstState {
  descriptor: string;
  count: number;
  windowStart: number;
  emitted: boolean;
}

export function createRageClickSource(): CaptureSource {
  return {
    name: 'rage_click',
    isEnabled: (config) => config.enabled && config.rageClick,
    install(ctx: CaptureContext): Teardown {
      const { config, maskSelectors, document } = ctx;
      let state: BurstState | null = null;

      const onClick = (ev: Event): void => {
        try {
          const target = ev.target as Element | null;
          if (!target) return;
          const descriptor = describeTarget(target, maskSelectors);
          const now = nowMs();

          if (
            state &&
            state.descriptor === descriptor &&
            now - state.windowStart <= config.rageClickWindowMs
          ) {
            state.count += 1;
          } else {
            // New burst (different target, or window elapsed).
            state = {
              descriptor,
              count: 1,
              windowStart: now,
              emitted: false,
            };
          }

          if (!state.emitted && state.count >= config.rageClickThreshold) {
            state.emitted = true;
            ctx.emit({
              type: EVENT_TYPES.UX_RAGE_CLICK,
              severity: 'warn',
              attributes: {
                target: state.descriptor,
                clickCount: state.count,
              },
            });
          }
        } catch (err) {
          ctx.debug?.('rage_click handler failed', err);
        }
      };

      document.addEventListener('click', onClick, true);
      return () => {
        try {
          document.removeEventListener('click', onClick, true);
        } catch {
          /* ignore */
        }
        state = null;
      };
    },
  };
}
