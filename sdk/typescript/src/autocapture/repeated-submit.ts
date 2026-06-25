/**
 * `ux.repeated_submit` capture source.
 *
 * Heuristic: N+ submits (default 2) of the *same form* within a window
 * (default 3000ms) signals a user re-submitting because the first attempt
 * appeared to do nothing (or errored). We key on a masked per-form descriptor,
 * emit once when the threshold is crossed within the window, `severity:
 * "warn"`, with `submitCount`. Subsequent submits inside the same window
 * extend the count but do not re-emit.
 */

import { EVENT_TYPES } from '../constants.js';
import { nowMs } from '../runtime.js';
import { describeForm } from './selector.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

interface SubmitState {
  descriptor: string;
  count: number;
  windowStart: number;
  emitted: boolean;
}

export function createRepeatedSubmitSource(): CaptureSource {
  return {
    name: 'repeated_submit',
    isEnabled: (config) => config.enabled && config.repeatedSubmit,
    install(ctx: CaptureContext): Teardown {
      const { config, maskSelectors, document } = ctx;
      // Keyed by form descriptor so concurrent forms don't cross-contaminate.
      const states = new Map<string, SubmitState>();

      const onSubmit = (ev: Event): void => {
        try {
          const target = ev.target as Element | null;
          if (!target) return;
          const descriptor = describeForm(target, maskSelectors);
          const now = nowMs();

          let state = states.get(descriptor);
          if (
            !state ||
            now - state.windowStart > config.repeatedSubmitWindowMs
          ) {
            state = {
              descriptor,
              count: 1,
              windowStart: now,
              emitted: false,
            };
            states.set(descriptor, state);
          } else {
            state.count += 1;
          }

          if (!state.emitted && state.count >= config.repeatedSubmitThreshold) {
            state.emitted = true;
            ctx.emit({
              type: EVENT_TYPES.UX_REPEATED_SUBMIT,
              severity: 'warn',
              attributes: {
                target: state.descriptor,
                submitCount: state.count,
              },
            });
          }
        } catch (err) {
          ctx.debug?.('repeated_submit handler failed', err);
        }
      };

      document.addEventListener('submit', onSubmit, true);
      return () => {
        try {
          document.removeEventListener('submit', onSubmit, true);
        } catch {
          /* ignore */
        }
        states.clear();
      };
    },
  };
}
