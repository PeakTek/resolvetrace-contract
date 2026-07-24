/**
 * Server-advertised replay clip capability (`client.session.replayClips`).
 *
 * The backend advertises whether a session may curate multiple replay clips via
 * an optional `replay: { clips }` block on the `/v1/session/start` response. The
 * SDK reads it with NO host config and surfaces it so the report widget can
 * adapt (single- vs multi-clip). OSS / older backends omit the block ⇒ the SDK
 * falls back to the single-clip baseline.
 *
 * These run under vitest's node env — the widget itself is browser-only, so the
 * capability plumbing (transport parse → SessionManager field/getter → callback)
 * is what's asserted here; the widget re-mount is exercised by the browser
 * smoke-test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { SessionManager } from '../src/session.js';
import { IdentityState } from '../src/identity.js';
import type { SessionStartAcceptance } from '../src/types.js';

const ENDPOINT = 'https://ingest.example.com';
const VALID_CODE = 'AB7K2MNP';

/**
 * Answer `/v1/session/start` with the supplied body; every other path (events/
 * end) with a bare 202. The start body is what the SDK parses to surface the
 * capability. Note: a malformed `supportCode` fails the WHOLE parse (acceptance
 * becomes null), so every capability body carries a valid code.
 */
function fetchMock(startBody: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/session/start')) {
      return new Response(JSON.stringify(startBody), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 202 });
  });
}

/** Let the fire-and-forget start promise + applyStartAcceptance settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('client.session.replayClips', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 'single' before any session has started", () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      autoSession: false,
      transport: fetchMock({}) as unknown as typeof fetch,
    });
    expect(client.session.id).toBeNull();
    expect(client.session.replayClips).toBe('single');
  });

  it("upgrades to 'multi' when the start response advertises it", async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({
        sessionId: 'x',
        acceptedAt: '2026-07-23T00:00:00.000Z',
        supportCode: VALID_CODE,
        replay: { clips: 'multi' },
      }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.replayClips).toBe('multi');
  });

  it("stays 'single' when the server advertises clips:single", async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({
        supportCode: VALID_CODE,
        replay: { clips: 'single' },
      }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.replayClips).toBe('single');
  });

  it("stays 'single' when the start response omits the replay block (OSS/older backend)", async () => {
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({ supportCode: VALID_CODE }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.replayClips).toBe('single');
  });

  it("stays 'single' on a malformed replay block (unknown clips value / wrong type)", async () => {
    const bad = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({
        supportCode: VALID_CODE,
        replay: { clips: 'lots' },
      }) as unknown as typeof fetch,
    });
    bad.capture({ type: 'view.start' });
    await settle();
    expect(bad.session.replayClips).toBe('single');

    const wrongType = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({
        supportCode: VALID_CODE,
        replay: 5,
      }) as unknown as typeof fetch,
    });
    wrongType.capture({ type: 'view.start' });
    await settle();
    expect(wrongType.session.replayClips).toBe('single');
  });

  it("stays 'single' when the acceptance is unusable (bad support code) even if clips:multi", async () => {
    // A malformed supportCode voids the whole acceptance — the capability rides
    // on a usable body, so it cannot leak through a rejected parse.
    const client = createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: fetchMock({
        supportCode: 'abc',
        replay: { clips: 'multi' },
      }) as unknown as typeof fetch,
    });
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.replayClips).toBe('single');
  });
});

describe('SessionManager — onStartAcceptance capability callback', () => {
  it('fires onStartAcceptance with the granted capability and exposes it via getReplayClips', async () => {
    const seen: SessionStartAcceptance[] = [];
    const acceptance: SessionStartAcceptance = {
      supportCode: VALID_CODE,
      replayClips: 'multi',
    };
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport: {
        postSessionStart: async () => acceptance,
        postSessionEnd: async () => {},
      },
      identity: new IdentityState(),
      onStartAcceptance: (a) => seen.push(a),
    });

    expect(mgr.getReplayClips()).toBe('single'); // before the start resolves
    mgr.ensureStarted();
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.replayClips).toBe('multi');
    expect(mgr.getReplayClips()).toBe('multi');
  });

  it("leaves getReplayClips at 'single' when the server grants none", async () => {
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport: {
        postSessionStart: async () => ({ supportCode: VALID_CODE, replayClips: 'single' }),
        postSessionEnd: async () => {},
      },
      identity: new IdentityState(),
    });
    mgr.ensureStarted();
    await settle();
    expect(mgr.getReplayClips()).toBe('single');
  });
});
