import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transport, backoffDelay, parseRetryAfter } from '../src/transport.js';
import { resolveConfig } from '../src/config.js';
import { buildEnvelope } from '../src/envelope.js';
import type { ResolvedConfig } from '../src/config.js';

const OK_CFG = {
  apiKey: 'rt_live_test_token',
  endpoint: 'https://ingest.example.com',
};

function makeCfg(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({ ...OK_CFG, ...overrides });
}

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  return new Response(status === 202 ? JSON.stringify({ accepted: 0, duplicates: 0, receivedAt: new Date().toISOString() }) : '', {
    status,
    headers: h,
  });
}

describe('transport helpers', () => {
  it('parseRetryAfter handles seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(' 10 ')).toBe(10000);
  });

  it('parseRetryAfter clamps to 60s', () => {
    expect(parseRetryAfter('3600')).toBe(60_000);
  });

  it('parseRetryAfter returns null on nonsense', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('never')).toBeNull();
  });

  it('backoffDelay is bounded', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const wait = backoffDelay(attempt);
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('Transport', () => {
  let sleepCalls: number[];
  let sleepImpl: (ms: number) => Promise<void>;

  beforeEach(() => {
    sleepCalls = [];
    sleepImpl = (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
  });

  it('posts a batch to /v1/events with the right headers', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(202));
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'page_view' }));
    await t.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://ingest.example.com/v1/events');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer rt_live_test_token');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init!.body as string);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
  });

  it('batches up to MAX_BATCH_EVENTS in a single request', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(202));
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    for (let i = 0; i < 150; i++) {
      t.enqueue(buildEnvelope({ type: 'x' }));
    }
    await t.flush();
    // 150 events across batches of 100 = 2 requests.
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstBody = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(firstBody.events.length).toBeLessThanOrEqual(100);
  });

  it('retries on 429 and honors Retry-After', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return makeResponse(429, { 'Retry-After': '2' });
      return makeResponse(202);
    });
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'x' }));
    await t.flush();
    expect(attempt).toBe(2);
    expect(sleepCalls[0]).toBe(2000);
  });

  it('retries on 503 and then succeeds', async () => {
    const responses = [makeResponse(503), makeResponse(502), makeResponse(202)];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'x' }));
    await t.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_ATTEMPTS and records max429RetriesExhausted', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(503));
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'x' }));
    await t.flush();
    // 1 initial + 5 retries = 6 attempts total.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(t.snapshot().max429RetriesExhaustedCount).toBe(1);
  });

  it('does not retry on 400', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(400));
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'x' }));
    await t.flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('drops events above the queue cap (tail-drop)', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(202));
    const t = new Transport(makeCfg(), {
      fetchImpl,
      sleep: sleepImpl,
      maxQueueEvents: 3,
      maxQueueBytes: 1024 * 1024,
    });
    for (let i = 0; i < 5; i++) {
      t.enqueue(buildEnvelope({ type: 'x' }));
    }
    const snap = t.snapshot();
    expect(snap.eventsAccepted).toBe(3);
    expect(snap.eventsDropped.backpressure).toBe(2);
  });

  it('diagnostics snapshot includes a lastError on failure', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(400));
    const t = new Transport(makeCfg(), { fetchImpl, sleep: sleepImpl });
    t.enqueue(buildEnvelope({ type: 'x' }));
    await t.flush();
    expect(t.snapshot().lastError).not.toBeNull();
    expect(t.snapshot().lastError!.code).toBeTypeOf('string');
  });
});
