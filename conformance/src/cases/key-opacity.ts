/**
 * API-key opacity: the SDK must treat the `apiKey` string as an opaque
 * token. The contract (ADR-0008) forbids parsing, decoding, or branching
 * on the key's internal structure.
 *
 * We assert this indirectly by constructing a client with a weird-but-valid
 * key string, intercepting the outbound request via a fetch override, and
 * confirming:
 *   - the client invokes fetch (i.e. does not refuse to construct),
 *   - the `Authorization` header value exactly equals `Bearer <apiKey>`,
 *   - the key is not parsed, decoded, or otherwise mutated (byte-equal compare).
 *
 * The case also covers two additional malformed shapes that a naive
 * implementation might mistake for a JWT (three dots, base64-like chunks):
 * both must be sent verbatim.
 */

import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

const OPAQUE_KEYS: Array<{ label: string; key: string }> = [
  { label: 'standard', key: 'rt_live_abcdef0123456789' },
  { label: 'with-unicode', key: 'rt_live_☀-test-★-opaque' },
  { label: 'jwt-shaped', key: 'eyJhbGciOiJub25lIn0.eyJjbGFpbSI6InRlc3QifQ.' },
  { label: 'trailing-slash', key: 'rt_live_needs_literal_/_character' },
  { label: 'url-unsafe', key: 'rt_live_with+plus&amp=equals' },
];

async function run(config: ResolvedConformanceConfig): Promise<CaseResult[]> {
  const sdk = await import('@peaktek/resolvetrace-sdk');
  const results: CaseResult[] = [];

  for (const sample of OPAQUE_KEYS) {
    const started = performance.now();
    const id = `key-opacity.${sample.label}`;
    const description = `SDK sends ${sample.label} key verbatim as Bearer token`;
    try {
      let observedAuth: string | null = null;
      let observedCalled = false;

      const fakeFetch: typeof fetch = async (input, init) => {
        observedCalled = true;
        const headers = init?.headers;
        if (headers instanceof Headers) {
          observedAuth = headers.get('Authorization');
        } else if (Array.isArray(headers)) {
          for (const [k, v] of headers) {
            if (k.toLowerCase() === 'authorization') observedAuth = v;
          }
        } else if (headers && typeof headers === 'object') {
          for (const [k, v] of Object.entries(headers as Record<string, string>)) {
            if (k.toLowerCase() === 'authorization') observedAuth = v;
          }
        }
        // Return a quick, valid-looking 202. Body is irrelevant here.
        void input;
        return new Response(
          JSON.stringify({ accepted: 1, duplicates: 0, receivedAt: new Date().toISOString() }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = sdk.createClient({
        apiKey: sample.key,
        endpoint: 'http://127.0.0.1:1',
        transport: fakeFetch,
      });
      client.capture({ type: 'conformance.key-opacity' });
      await client.flush({ timeoutMs: 5_000 });
      await client.shutdown({ timeoutMs: 1_000 });

      const expected = `Bearer ${sample.key}`;
      const durationMs = performance.now() - started;

      if (!observedCalled) {
        results.push({
          id,
          description,
          status: 'fail',
          durationMs,
          message: 'SDK did not invoke the fetch override (queue never drained)',
        });
      } else if (observedAuth === expected) {
        results.push({
          id,
          description,
          status: 'pass',
          durationMs,
          details: { keyLength: sample.key.length },
        });
      } else {
        results.push({
          id,
          description,
          status: 'fail',
          durationMs,
          message: 'Authorization header was modified from verbatim Bearer <apiKey>',
          details: { expectedLen: expected.length, observedLen: observedAuth?.length ?? 0 },
        });
      }
    } catch (err) {
      results.push({
        id,
        description,
        status: 'fail',
        durationMs: performance.now() - started,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // `config` is unused because this case is SDK-local. Suppress the
  // TS-unused warning without adding noise to the runner.
  void config;
  return results;
}

export const keyOpacityCase: CaseDefinition = {
  id: 'key-opacity',
  description: 'SDK treats the apiKey as opaque and sends it verbatim',
  run,
};
