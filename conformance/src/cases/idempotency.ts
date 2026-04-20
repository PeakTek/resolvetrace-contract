/**
 * Idempotency: sending the same envelope (by `eventId`) twice must both
 * return 2xx with no visible error.
 *
 * We cannot peek at the server's state in black-box mode, so we assert
 * the narrower property: the server does not reject a duplicate. The
 * contract guarantees per-event dedup within the 24 h window (ADR-0011).
 */

import { buildMinimalEnvelope } from '../envelope.ts';
import { postJson } from '../http.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

async function run(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();
  if (config.skipNetwork) {
    return {
      id: 'idempotency.duplicate-event-id',
      description: 'Duplicate eventId within the dedup window is accepted both times',
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  try {
    const envelope = buildMinimalEnvelope({ type: 'conformance.idempotency' });
    const body = { events: [envelope] };
    const first = await postJson({
      endpoint: config.endpoint,
      path: '/v1/events',
      apiKey: config.apiKey,
      body,
      extraHeaders: { 'X-Idempotency-Key': `conformance-${envelope.eventId}` },
    });
    const second = await postJson({
      endpoint: config.endpoint,
      path: '/v1/events',
      apiKey: config.apiKey,
      body,
      extraHeaders: { 'X-Idempotency-Key': `conformance-${envelope.eventId}` },
    });
    const durationMs = performance.now() - started;

    const firstOk = first.status >= 200 && first.status < 300;
    const secondOk = second.status >= 200 && second.status < 300;

    if (firstOk && secondOk) {
      return {
        id: 'idempotency.duplicate-event-id',
        description: 'Duplicate eventId within the dedup window is accepted both times',
        status: 'pass',
        durationMs,
        details: {
          firstStatus: first.status,
          secondStatus: second.status,
          idempotentReplayHeader: second.headers.get('X-Idempotent-Replay'),
        },
      };
    }
    return {
      id: 'idempotency.duplicate-event-id',
      description: 'Duplicate eventId within the dedup window is accepted both times',
      status: 'fail',
      durationMs,
      message: `one of the two POSTs returned non-2xx (first=${first.status}, second=${second.status})`,
      details: {
        firstBody: first.bodyJson ?? first.bodyText.slice(0, 256),
        secondBody: second.bodyJson ?? second.bodyText.slice(0, 256),
      },
    };
  } catch (err) {
    return {
      id: 'idempotency.duplicate-event-id',
      description: 'Duplicate eventId within the dedup window is accepted both times',
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const idempotencyCase: CaseDefinition = {
  id: 'idempotency.duplicate-event-id',
  description: 'Duplicate eventId within the dedup window is accepted both times',
  run,
};
