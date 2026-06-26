/**
 * Recent-context ring buffer.
 *
 * `client.reportProblem()` attaches a short, bounded trail of the most recent
 * events the SDK captured (breadcrumb-style) so a support report carries the
 * shape of what the user was doing right before they hit "report a problem".
 *
 * Privacy (doc-18 `report_controls`): this trail must NOT carry raw form
 * content or arbitrary caller attributes. We therefore record only a small,
 * fixed set of *metadata* descriptors per event — the event `type`, its
 * capture timestamp, and (when present) `severity` / `httpStatus`. We never
 * copy the event's `attributes` bag into the trail. The resulting `report`
 * event still passes through the normal Stage-1 scrubber on submit, so even
 * these string descriptors are redacted if they ever match a rule.
 *
 * The buffer is process-wide-lived but per-client (one instance per
 * `ResolveTraceClient`) and bounded to a small ceiling so it cannot grow
 * without limit. It is runtime-agnostic (browser + node safe).
 */

import type { EventInput, IsoDateTime, Severity } from './types.js';

/** Default number of recent events retained for a problem report. */
export const DEFAULT_RECENT_CONTEXT_SIZE = 20;

/**
 * A single breadcrumb descriptor. Deliberately metadata-only: no `attributes`,
 * no free text beyond the canonical/custom event `type` string.
 */
export interface RecentContextEntry {
  /** Event type (e.g. "ux.rage_click", "error.api", "page_view"). */
  type: string;
  /** Capture wall-clock for the event. */
  capturedAt: IsoDateTime;
  /** Severity classification, when the event carried one. */
  severity?: Severity;
  /** HTTP status, when the event carried one (api-oriented breadcrumbs). */
  httpStatus?: number;
}

/**
 * Bounded ring buffer of recent event descriptors. `record()` is called from
 * the client's single `capture()` ingress; `snapshot()` returns a defensive
 * copy of the retained entries (oldest first) for inclusion in a report.
 */
export class RecentContextBuffer {
  private readonly capacity: number;
  private readonly entries: RecentContextEntry[] = [];

  constructor(capacity: number = DEFAULT_RECENT_CONTEXT_SIZE) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /**
   * Record a metadata-only descriptor for a captured event. Never throws and
   * never copies the caller's attribute bag. The own `support.report_submitted`
   * event is excluded by the caller so a report does not breadcrumb itself.
   */
  record(event: EventInput, capturedAt: IsoDateTime): void {
    const entry: RecentContextEntry = {
      type: event.type,
      capturedAt,
    };
    if (event.severity !== undefined) entry.severity = event.severity;
    if (typeof event.httpStatus === 'number') entry.httpStatus = event.httpStatus;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /**
   * Return up to `limit` of the most recent entries (oldest first). A defensive
   * shallow copy is returned so callers cannot mutate the buffer.
   */
  snapshot(limit: number = this.capacity): RecentContextEntry[] {
    const n = Math.min(this.entries.length, Math.max(0, Math.floor(limit)));
    const start = this.entries.length - n;
    return this.entries.slice(start).map((e) => ({ ...e }));
  }

  /** Test/observability hook: current retained count. */
  get size(): number {
    return this.entries.length;
  }
}
