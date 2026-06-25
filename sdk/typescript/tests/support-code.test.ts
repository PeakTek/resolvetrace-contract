import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';

const ENDPOINT = 'https://ingest.example.com';
const VALID_CODE = 'AB7K2MNP';

/**
 * Build a fetch mock that answers `/v1/session/start` with the supplied body +
 * status and every other path (events/end) with a bare 202. The start body is
 * what the SDK parses to surface `client.session.supportCode`.
 */
function fetchMock(start: {
  status?: number;
  body?: unknown;
  rawBody?: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/session/start')) {
      const status = start.status ?? 201;
      const body =
        start.rawBody !== undefined
          ? start.rawBody
          : JSON.stringify(start.body ?? {});
      return new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 202 });
  });
}

/**
 * Let the fire-and-forget start promise (fetch + response.json() + the
 * applyStartAcceptance continuation) fully resolve before asserting.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('client.session.supportCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is null before any session has started', () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      autoSession: false,
      transport: fetchMock({ body: { supportCode: VALID_CODE } }) as unknown as typeof fetch,
    });
    // autoSession:false → no start fired yet.
    expect(client.session.id).toBeNull();
    expect(client.session.supportCode).toBeNull();
  });

  it('reflects the supportCode carried by the start response', async () => {
    const fetchImpl = fetchMock({
      status: 201,
      body: { sessionId: 'x', acceptedAt: '2026-06-25T00:00:00.000Z', supportCode: VALID_CODE },
    });
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchImpl as unknown as typeof fetch,
    });

    // First capture lazy-starts the session and fires session-start.
    client.capture({ type: 'view.start' });
    // Not blocked on the start response: code may still be null synchronously.
    expect(client.session.id).not.toBeNull();

    await settle();

    expect(client.session.supportCode).toBe(VALID_CODE);
  });

  it('stays null when the start response omits a support code', async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({ status: 201, body: { acceptedAt: 'x' } }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.supportCode).toBeNull();
  });

  it('stays null (and does not throw) on a malformed / non-JSON start response', async () => {
    const onError = vi.fn();
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      onError,
      transport: fetchMock({ status: 201, rawBody: 'not json{{{' }) as unknown as typeof fetch,
    });
    expect(() => client.capture({ type: 'view.start' })).not.toThrow();
    await settle();
    expect(client.session.supportCode).toBeNull();
  });

  it('ignores a malformed supportCode (wrong length / charset)', async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      // lowercase + too short → rejected by the canonical pattern.
      transport: fetchMock({ status: 201, body: { supportCode: 'abc' } }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.supportCode).toBeNull();
  });

  it('clears the support code when the session ends', async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({ status: 201, body: { supportCode: VALID_CODE } }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.supportCode).toBe(VALID_CODE);

    await client.session.end();
    expect(client.session.supportCode).toBeNull();
  });
});
