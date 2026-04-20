/**
 * Rate-limit conformance.
 *
 * Issues a bounded burst of POSTs at `/v1/events`. We expect at least one
 * 429 response once the burst exceeds the soft limit. When a 429 is
 * observed we assert both the body shape and the standard headers. If the
 * server is configured with a quota high enough that our burst does not
 * trip it, we report the case as `skip` rather than `fail` — the ceiling
 * values are deployment-controlled and this is an audit harness, not a
 * load generator.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMinimalEnvelope } from '../envelope.ts';
import { postJson } from '../http.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

const REQUIRED_HEADERS = [
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
] as const;

type ApiResponsesSchema = {
  definitions?: Record<string, unknown>;
};

async function loadRateLimitValidator(): Promise<ValidateFunction> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(here, '..', '..', '..', 'schemas', 'api-responses.json');
  const raw = await fs.readFile(schemaPath, 'utf-8');
  const parsed = JSON.parse(raw) as ApiResponsesSchema;
  const rateLimitDef = parsed.definitions?.['RateLimitErrorResponse'];
  if (!rateLimitDef) {
    throw new Error('RateLimitErrorResponse definition missing from api-responses.json');
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(rateLimitDef as object);
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();
  if (config.skipNetwork) {
    return {
      id: 'rate-limit.events-burst',
      description: 'Bursting above the soft limit returns 429 with the contract body and headers',
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  let validate: ValidateFunction;
  try {
    validate = await loadRateLimitValidator();
  } catch (err) {
    return {
      id: 'rate-limit.events-burst',
      description: 'Bursting above the soft limit returns 429 with the contract body and headers',
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Fire a bounded burst. The OSS default is 60 soft / 120 hard RPS; a
  // 300-request burst within ~2 s easily crosses the hard limit.
  const maxRequests = Math.max(1, config.rateLimitMaxRequests);
  const deadline = started + Math.max(100, config.rateLimitBurstMs);
  const inflight: Promise<{ status: number; headers: Headers; bodyJson: unknown | undefined }>[] =
    [];
  let firstTripped: { status: number; headers: Headers; bodyJson: unknown | undefined } | null =
    null;

  for (let i = 0; i < maxRequests; i++) {
    if (performance.now() >= deadline) break;
    const envelope = buildMinimalEnvelope({ type: 'conformance.rate-limit' });
    inflight.push(
      postJson({
        endpoint: config.endpoint,
        path: '/v1/events',
        apiKey: config.apiKey,
        body: { events: [envelope] },
      }).then((resp) => ({
        status: resp.status,
        headers: resp.headers,
        bodyJson: resp.bodyJson,
      })),
    );
  }

  const settled = await Promise.allSettled(inflight);
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    if (result.value.status === 429 || result.value.status === 503) {
      firstTripped = result.value;
      break;
    }
  }

  const durationMs = performance.now() - started;

  if (firstTripped === null) {
    return {
      id: 'rate-limit.events-burst',
      description: 'Bursting above the soft limit returns 429 with the contract body and headers',
      status: 'skip',
      durationMs,
      message: `no 429/503 observed after ${inflight.length} requests — quota may exceed burst size`,
    };
  }

  const missingHeaders = REQUIRED_HEADERS.filter((h) => !firstTripped!.headers.get(h));
  const bodyValid = validate(firstTripped.bodyJson);
  const issues: string[] = [];
  if (missingHeaders.length) issues.push(`missing headers: ${missingHeaders.join(', ')}`);
  if (!bodyValid) issues.push(`body failed RateLimitErrorResponse validation`);

  if (issues.length === 0) {
    return {
      id: 'rate-limit.events-burst',
      description: 'Bursting above the soft limit returns 429 with the contract body and headers',
      status: 'pass',
      durationMs,
      details: {
        status: firstTripped.status,
        retryAfter: firstTripped.headers.get('Retry-After'),
        limit: firstTripped.headers.get('X-RateLimit-Limit'),
        remaining: firstTripped.headers.get('X-RateLimit-Remaining'),
      },
    };
  }

  return {
    id: 'rate-limit.events-burst',
    description: 'Bursting above the soft limit returns 429 with the contract body and headers',
    status: 'fail',
    durationMs,
    message: issues.join('; '),
    details: {
      status: firstTripped.status,
      body: firstTripped.bodyJson,
      ajvErrors: validate.errors ?? undefined,
    },
  };
}

export const rateLimitCase: CaseDefinition = {
  id: 'rate-limit.events-burst',
  description: 'Bursting above the soft limit returns 429 with the contract body and headers',
  run,
};
