/**
 * Connectivity case: `POST /v1/events` with a minimal valid envelope returns 2xx.
 *
 * This is the smoke test — if it fails, most other cases are meaningless.
 */

import { buildMinimalEnvelope } from '../envelope.ts';
import { postJson } from '../http.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

async function run(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();
  if (config.skipNetwork) {
    return {
      id: 'connectivity.minimal-envelope',
      description: 'POST /v1/events with a minimal valid envelope returns 2xx',
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  try {
    const envelope = buildMinimalEnvelope();
    const response = await postJson({
      endpoint: config.endpoint,
      path: '/v1/events',
      apiKey: config.apiKey,
      body: { events: [envelope] },
    });
    const durationMs = performance.now() - started;

    if (response.status >= 200 && response.status < 300) {
      return {
        id: 'connectivity.minimal-envelope',
        description: 'POST /v1/events with a minimal valid envelope returns 2xx',
        status: 'pass',
        durationMs,
        details: { status: response.status },
      };
    }
    return {
      id: 'connectivity.minimal-envelope',
      description: 'POST /v1/events with a minimal valid envelope returns 2xx',
      status: 'fail',
      durationMs,
      message: `unexpected status ${response.status}`,
      details: {
        status: response.status,
        body: response.bodyJson ?? response.bodyText.slice(0, 256),
      },
    };
  } catch (err) {
    const durationMs = performance.now() - started;
    return {
      id: 'connectivity.minimal-envelope',
      description: 'POST /v1/events with a minimal valid envelope returns 2xx',
      status: 'fail',
      durationMs,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const connectivityCase: CaseDefinition = {
  id: 'connectivity.minimal-envelope',
  description: 'POST /v1/events with a minimal valid envelope returns 2xx',
  run,
};
