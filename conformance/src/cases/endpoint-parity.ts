/**
 * Endpoint-swap parity: when the caller supplies additional endpoints,
 * re-run the connectivity + schema smoke cases against each and assert the
 * response shapes are structurally identical.
 *
 * This is the audit-surface form of ADR-0009's promise: identical contract
 * across deployment shapes. If no additional endpoints are configured, the
 * case skips cleanly — it is intentionally optional.
 */

import { buildMinimalEnvelope } from '../envelope.ts';
import { postJson } from '../http.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

interface Probe {
  endpoint: string;
  status: number;
  bodyKeys: string[];
  bodyJson: unknown | undefined;
}

async function probe(endpoint: string, apiKey: string): Promise<Probe> {
  const envelope = buildMinimalEnvelope({ type: 'conformance.endpoint-parity' });
  const response = await postJson({
    endpoint,
    path: '/v1/events',
    apiKey,
    body: { events: [envelope] },
  });
  const keys =
    response.bodyJson && typeof response.bodyJson === 'object'
      ? Object.keys(response.bodyJson as Record<string, unknown>).sort()
      : [];
  return {
    endpoint,
    status: response.status,
    bodyKeys: keys,
    bodyJson: response.bodyJson,
  };
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();

  if (config.skipNetwork) {
    return {
      id: 'endpoint-parity',
      description: 'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  if (config.additionalEndpoints.length === 0) {
    return {
      id: 'endpoint-parity',
      description: 'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
      status: 'skip',
      durationMs: 0,
      message: 'no --additional-endpoint values supplied; case is optional',
    };
  }

  try {
    const probes = await Promise.all([
      probe(config.endpoint, config.apiKey),
      ...config.additionalEndpoints.map((e) => probe(e, config.apiKey)),
    ]);

    const primaryProbe = probes[0];
    if (!primaryProbe) {
      throw new Error('no probes were executed');
    }
    const primary = primaryProbe;
    const mismatches: string[] = [];
    for (let i = 1; i < probes.length; i++) {
      const probeResult = probes[i];
      if (!probeResult) continue;
      const p = probeResult;
      if (p.status !== primary.status) {
        mismatches.push(`${p.endpoint}: status ${p.status} vs primary ${primary.status}`);
      }
      if (JSON.stringify(p.bodyKeys) !== JSON.stringify(primary.bodyKeys)) {
        mismatches.push(
          `${p.endpoint}: body keys ${JSON.stringify(p.bodyKeys)} vs primary ${JSON.stringify(primary.bodyKeys)}`,
        );
      }
    }
    const durationMs = performance.now() - started;
    if (mismatches.length === 0) {
      return {
        id: 'endpoint-parity',
        description:
          'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
        status: 'pass',
        durationMs,
        details: {
          endpoints: probes.map((p) => `${p.endpoint} -> ${p.status}`),
          sharedKeys: primary.bodyKeys,
        },
      };
    }
    return {
      id: 'endpoint-parity',
      description:
        'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
      status: 'fail',
      durationMs,
      message: mismatches.join('; '),
      details: { probes },
    };
  } catch (err) {
    return {
      id: 'endpoint-parity',
      description:
        'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const endpointParityCase: CaseDefinition = {
  id: 'endpoint-parity',
  description:
    'Primary endpoint and each additional endpoint return structurally identical 2xx bodies',
  run,
};
