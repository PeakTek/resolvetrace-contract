import { describe, it, expect, vi } from 'vitest';
import { ResolveTraceClient, createClient } from '../src/client.js';

/** Pull the request init for the call whose URL endpoint matches `path`. */
function findCall(
  fetchImpl: ReturnType<typeof vi.fn>,
  path: string,
): RequestInit | undefined {
  const call = fetchImpl.mock.calls.find(([url]) => String(url).endsWith(path));
  return call ? (call[1] as RequestInit) : undefined;
}

describe('ResolveTraceClient', () => {
  it('constructs via factory and class', () => {
    const opts = {
      apiKey: 'rt_live_test_token',
      endpoint: 'https://ingest.example.com',
      transport: vi.fn(async () =>
        new Response('', { status: 202 }),
      ) as unknown as typeof fetch,
    };
    const a = createClient(opts);
    const b = new ResolveTraceClient(opts);
    expect(a).toBeInstanceOf(ResolveTraceClient);
    expect(b).toBeInstanceOf(ResolveTraceClient);
  });

  it('capture returns a ULID string', () => {
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: 'https://ingest.example.com',
      transport: vi.fn(async () =>
        new Response('', { status: 202 }),
      ) as unknown as typeof fetch,
    });
    const id = client.capture({ type: 'page_view' });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('track is a convenience wrapper over capture', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: 'https://ingest.example.com',
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.track('button_click', { button: 'signup' });
    await client.flush();
    expect(fetchImpl).toHaveBeenCalled();
    const eventsCall = findCall(fetchImpl, '/v1/events');
    expect(eventsCall).toBeDefined();
    const body = JSON.parse(eventsCall!.body as string);
    expect(body.events[0].type).toBe('button_click');
  });

  it('beforeSend can mutate or drop events', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: 'https://ingest.example.com',
      transport: fetchImpl as unknown as typeof fetch,
      beforeSend: (env) => (env.type === 'drop_me' ? null : env),
    });
    client.track('drop_me');
    client.track('keep_me');
    await client.flush();
    const eventsCall = findCall(fetchImpl, '/v1/events');
    expect(eventsCall).toBeDefined();
    const body = JSON.parse(eventsCall!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe('keep_me');
  });

  it('getDiagnostics returns the frozen-shape object', () => {
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: 'https://ingest.example.com',
      transport: vi.fn() as unknown as typeof fetch,
    });
    const diag = client.getDiagnostics();
    expect(diag).toHaveProperty('queueDepth');
    expect(diag).toHaveProperty('queueBytes');
    expect(diag).toHaveProperty('eventsAccepted');
    expect(diag.eventsDropped).toHaveProperty('backpressure');
    expect(diag.eventsDropped).toHaveProperty('scrubOverflow');
    expect(diag.eventsDropped).toHaveProperty('payloadTooLarge');
    expect(diag).toHaveProperty('lastError');
    expect(diag).toHaveProperty('scrubOverflowCount');
    expect(diag).toHaveProperty('max429RetriesExhaustedCount');
  });

  it('rejects forbidden constructor keys', () => {
    for (const bad of ['tenantId', 'environment', 'region', 'featureFlags', 'authStrategy']) {
      expect(
        () =>
          new ResolveTraceClient({
            apiKey: 'rt_live_test_token',
            endpoint: 'https://ingest.example.com',
            [bad]: 'any',
          } as unknown as { apiKey: string; endpoint: string }),
      ).toThrow();
    }
  });
});
