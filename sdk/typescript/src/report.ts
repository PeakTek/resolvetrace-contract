/**
 * In-app problem reporting (Wave-25, feature #5).
 *
 * `client.reportProblem({ description })` emits the canonical
 * `support.report_submitted` event through the normal `capture()` pipeline so
 * the SDK-side Stage-1 scrubber and the session machinery apply, then returns
 * the client-generated event id.
 *
 * What the event carries (all under the open `attributes` bag so no public
 * contract / schema change is needed — see the design note in client.ts):
 *   - `attributes.description`  — the user's free-text description. The user
 *     explicitly chose to send this, but it still runs through the scrubber.
 *   - `attributes.supportCode`  — `client.session.supportCode` (W22) when one
 *     has been minted. Carried in `attributes`, NOT in a top-level `context`,
 *     to avoid the contract rule that a present `context` must also carry the
 *     four required global-context fields (releaseVersion / locale / market /
 *     diagnosticsLevel) which the SDK cannot synthesize. If the caller supplies
 *     a complete `context`, `supportCode` is additionally mirrored there.
 *   - `attributes.recentContext` — a short, metadata-only breadcrumb trail of
 *     the most recent events (type / capturedAt / severity / httpStatus only).
 *     NO raw form content and NO arbitrary caller attributes (doc-18
 *     `report_controls`).
 *   - `attributes.source`       — "api" or "widget", so consumers can tell a
 *     programmatic report from a widget submission.
 *
 * This module is pure data-shaping (browser + node safe); the client owns the
 * `capture()` call and the recent-context buffer.
 */

import { EVENT_TYPES } from './constants.js';
import type { RecentContextEntry } from './recent-context.js';
import type { EventAttributes, EventContext, EventInput } from './types.js';

/** Where a report originated. */
export type ReportSource = 'api' | 'widget';

/** Input accepted by `client.reportProblem()`. */
export interface ReportProblemInput {
  /**
   * The user's free-text description of the problem. Required and non-empty.
   * Runs through the Stage-1 scrubber on submit like any other string field.
   */
  description: string;
  /**
   * Optional extra attributes to merge onto the report event (e.g. an app
   * area, a ticket category). These are caller-controlled and scrubbed; they
   * MUST NOT be used to smuggle raw form inputs.
   */
  attributes?: EventAttributes;
  /**
   * Optional full `EventContext`. When supplied (carrying the four required
   * global-context fields), the report event uses it as its top-level
   * `context` and the support code is mirrored onto it as well.
   */
  context?: EventContext;
}

/** Maximum retained length of the user description (defense-in-depth bound). */
export const MAX_REPORT_DESCRIPTION_LENGTH = 4000;

/** Inputs the client passes to build the report event. */
export interface BuildReportEventArgs {
  input: ReportProblemInput;
  supportCode: string | null;
  recentContext: RecentContextEntry[];
  source: ReportSource;
}

/**
 * Build the `EventInput` for a `support.report_submitted` event. The returned
 * value is handed to `client.capture()` so scrubbing / session / context
 * enrichment all apply. Throws a `TypeError` if `description` is missing/blank
 * so the caller can surface a clear validation error.
 */
export function buildReportEvent(args: BuildReportEventArgs): EventInput {
  const { input, supportCode, recentContext, source } = args;
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.description !== 'string' ||
    input.description.trim().length === 0
  ) {
    throw new TypeError(
      'reportProblem requires a non-empty `description` string.',
    );
  }

  const description = input.description.slice(0, MAX_REPORT_DESCRIPTION_LENGTH);

  // Start from any caller-supplied attributes, then layer the report fields on
  // top so the canonical keys win over a colliding caller key.
  const attributes: EventAttributes = {
    ...(input.attributes ?? {}),
    description,
    source,
    recentContext,
  };
  if (supportCode !== null) {
    attributes.supportCode = supportCode;
  }

  const event: EventInput = {
    type: EVENT_TYPES.SUPPORT_REPORT_SUBMITTED,
    severity: 'info',
    attributes,
  };

  // If the caller supplied a complete context, carry it top-level and mirror
  // the support code onto it too (it is a valid optional EventContext field).
  if (input.context && typeof input.context === 'object') {
    const ctx: EventContext = { ...input.context };
    if (supportCode !== null && ctx.supportCode === undefined) {
      ctx.supportCode = supportCode;
    }
    event.context = ctx;
  }

  return event;
}
