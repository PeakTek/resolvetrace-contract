/**
 * `perf.long_task` capture source.
 *
 * Uses the Long Tasks API (`PerformanceObserver({ entryTypes: ['longtask'] })`)
 * to observe main-thread tasks the browser reports as blocking (>50ms by spec).
 * Each reported entry becomes a `perf.long_task` breadcrumb carrying its
 * `durationMs`. `severity: "info"` — a long task is a performance signal, not an
 * error.
 *
 * Long Tasks are not universally supported (notably Safari/Firefox have lagged).
 * We guard for the absence of `PerformanceObserver` and for engines that throw
 * when handed the `longtask` entry type, and we no-op cleanly in those cases so
 * the host app is never affected. The observer is disconnected on teardown.
 */

import { EVENT_TYPES } from '../constants.js';
import type { CaptureContext, CaptureSource, Teardown } from './types.js';

interface PerfEntryLike {
  duration?: number;
  name?: string;
  entryType?: string;
}

export function createLongTaskSource(): CaptureSource {
  return {
    name: 'long_task',
    isEnabled: (config) => config.enabled && config.longTask,
    install(ctx: CaptureContext): Teardown {
      const { window } = ctx;

      const POClass = (
        window as { PerformanceObserver?: typeof PerformanceObserver }
      ).PerformanceObserver;
      if (typeof POClass !== 'function') {
        // No Long Tasks support → nothing to wire up.
        ctx.debug?.('long_task: PerformanceObserver unavailable');
        return () => undefined;
      }

      let observer: PerformanceObserver | null = null;

      try {
        observer = new POClass((list) => {
          try {
            const entries: PerfEntryLike[] =
              typeof list.getEntries === 'function'
                ? (list.getEntries() as unknown as PerfEntryLike[])
                : [];
            for (const entry of entries) {
              try {
                const duration =
                  typeof entry.duration === 'number' ? entry.duration : 0;
                ctx.emit({
                  type: EVENT_TYPES.PERF_LONG_TASK,
                  severity: 'info',
                  durationMs: Math.round(duration),
                  attributes: {
                    name: typeof entry.name === 'string' ? entry.name : 'self',
                  },
                });
              } catch (err) {
                ctx.debug?.('long_task entry emit failed', err);
              }
            }
          } catch (err) {
            ctx.debug?.('long_task observer callback failed', err);
          }
        });
        // `entryTypes` throws on engines that don't recognize `longtask`; the
        // try/catch below turns that into a clean no-op.
        observer.observe({ entryTypes: ['longtask'] });
      } catch (err) {
        ctx.debug?.('long_task observe() unsupported', err);
        try {
          observer?.disconnect();
        } catch {
          /* ignore */
        }
        observer = null;
        return () => undefined;
      }

      return () => {
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
