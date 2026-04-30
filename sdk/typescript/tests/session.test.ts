import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import {
  endpointStorageKey,
  SessionManager,
  type SessionTransport,
} from '../src/session.js';
import { IdentityState } from '../src/identity.js';
import {
  SessionRecoveryFailedError,
  SessionRequiredError,
  SessionUnknownError,
} from '../src/errors.js';
import {
  DEFAULT_SESSION_INACTIVITY_MS,
  DEFAULT_SESSION_MAX_DURATION_MS,
} from '../src/constants.js';

const ENDPOINT = 'https://ingest.example.com';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Mock transport whose start/end calls are sniffable. */
function makeSessionTransport(opts: {
  startImpl?: () => Promise<void>;
  endImpl?: () => Promise<void>;
} = {}): {
  transport: SessionTransport;
  startCalls: unknown[];
  endCalls: unknown[];
} {
  const startCalls: unknown[] = [];
  const endCalls: unknown[] = [];
  const transport: SessionTransport = {
    postSessionStart: async (payload) => {
      startCalls.push(payload);
      if (opts.startImpl) await opts.startImpl();
    },
    postSessionEnd: async (payload) => {
      endCalls.push(payload);
      if (opts.endImpl) await opts.endImpl();
    },
  };
  return { transport, startCalls, endCalls };
}

/**
 * Build a fetch mock that responds to `/v1/session/start`, `/v1/session/end`,
 * and `/v1/events` with the given event-batch responder.
 */
function fetchMock(
  eventsResponder: (callIndex: number) => Response,
): ReturnType<typeof vi.fn> {
  let eventsCallIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/events')) {
      const idx = eventsCallIndex++;
      return eventsResponder(idx);
    }
    return new Response('', { status: 202 });
  });
}

function getEventsCalls(
  fetchImpl: ReturnType<typeof vi.fn>,
): Array<RequestInit> {
  return fetchImpl.mock.calls
    .filter(([u]) => String(u).endsWith('/v1/events'))
    .map(([, init]) => init as RequestInit);
}

function getSessionStartCalls(
  fetchImpl: ReturnType<typeof vi.fn>,
): Array<RequestInit> {
  return fetchImpl.mock.calls
    .filter(([u]) => String(u).endsWith('/v1/session/start'))
    .map(([, init]) => init as RequestInit);
}

function read<T>(init: RequestInit): T {
  return JSON.parse(init.body as string) as T;
}

describe('SessionManager state machine', () => {
  let setTimerSpy: ReturnType<typeof vi.fn>;
  let clearTimerSpy: ReturnType<typeof vi.fn>;
  let timers: Array<{ id: number; cb: () => void; deadlineMs: number; cleared: boolean }>;
  let nextTimerId: number;
  let nowMs: number;

  beforeEach(() => {
    timers = [];
    nextTimerId = 1;
    nowMs = 1_700_000_000_000;
    setTimerSpy = vi.fn((cb: () => void, ms: number) => {
      const id = nextTimerId++;
      timers.push({ id, cb, deadlineMs: nowMs + ms, cleared: false });
      return id;
    });
    clearTimerSpy = vi.fn((handle: unknown) => {
      const t = timers.find((x) => x.id === handle);
      if (t) t.cleared = true;
    });
  });

  function advance(deltaMs: number): void {
    nowMs += deltaMs;
    // Fire any timers whose absolute deadline has passed. Iterate by index so
    // timers added during a callback (e.g. via rollover → ensureStarted) are
    // considered in subsequent passes.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const t of timers) {
        if (!t.cleared && t.deadlineMs <= nowMs) {
          t.cleared = true;
          t.cb();
          progressed = true;
        }
      }
    }
  }

  function makeMgr(
    overrides: Partial<{
      autoSession: boolean;
      sessionInactivityMs: number;
      sessionMaxDurationMs: number;
      sessionAttributes: () => Record<string, unknown>;
      onError: (err: Error) => void;
    }> = {},
  ): {
    mgr: SessionManager;
    transport: SessionTransport;
    startCalls: unknown[];
    endCalls: unknown[];
    identity: IdentityState;
  } {
    const { transport, startCalls, endCalls } = makeSessionTransport();
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      onError: overrides.onError,
      autoSession: overrides.autoSession,
      sessionInactivityMs: overrides.sessionInactivityMs,
      sessionMaxDurationMs: overrides.sessionMaxDurationMs,
      sessionAttributes: overrides.sessionAttributes,
      now: () => nowMs,
      setTimer: setTimerSpy as unknown as (cb: () => void, ms: number) => unknown,
      clearTimer: clearTimerSpy as unknown as (handle: unknown) => void,
    });
    return { mgr, transport, startCalls, endCalls, identity };
  }

  // 1. Lazy start
  it('lazy-starts on first ensureStarted and posts session start once', async () => {
    const { mgr, startCalls } = makeMgr();
    expect(mgr.getId()).toBeNull();
    const id = mgr.ensureStarted();
    expect(id).toMatch(ULID_RE);
    expect(mgr.getId()).toBe(id);
    // Allow the fire-and-forget start to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(startCalls.length).toBe(1);
  });

  // 2. No double-start
  it('does not re-issue session-start on subsequent captures', async () => {
    const { mgr, startCalls } = makeMgr();
    const id = mgr.ensureStarted();
    mgr.noteActivity();
    const id2 = mgr.ensureStarted();
    mgr.noteActivity();
    const id3 = mgr.ensureStarted();
    await Promise.resolve();
    await Promise.resolve();
    expect(id).toBe(id2);
    expect(id).toBe(id3);
    expect(startCalls.length).toBe(1);
  });

  // 3. Inactivity rollover
  it('rolls the session over after inactivity timeout', async () => {
    const { mgr, startCalls, endCalls } = makeMgr({
      sessionInactivityMs: 60_000,
    });
    const id1 = mgr.ensureStarted();
    await Promise.resolve();
    await Promise.resolve();
    expect(startCalls.length).toBe(1);

    // Trip the inactivity timer.
    advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(endCalls.length).toBe(1);
    expect((endCalls[0] as { ended_reason: string }).ended_reason).toBe('inactivity');
    expect(mgr.getId()).toBeNull();

    // Next capture lazy-starts a fresh session.
    const id2 = mgr.ensureStarted();
    expect(id2).not.toBe(id1);
    await Promise.resolve();
    await Promise.resolve();
    expect(startCalls.length).toBe(2);
  });

  // 4. Max-duration rollover
  it('rolls the session over after max-duration timeout', async () => {
    const { mgr, startCalls, endCalls } = makeMgr({
      sessionInactivityMs: 60_000,
      sessionMaxDurationMs: 120_000,
    });
    mgr.ensureStarted();
    await Promise.resolve();
    await Promise.resolve();
    // Periodic activity keeps the inactivity timer fresh; the max-duration
    // timer is independent and trips at 120s regardless.
    for (let t = 0; t < 12; t++) {
      advance(10_000);
      mgr.noteActivity();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(endCalls.length).toBe(1);
    expect((endCalls[0] as { ended_reason: string }).ended_reason).toBe('max_duration');
    expect(mgr.getId()).toBeNull();
    expect(startCalls.length).toBe(1);
  });

  // 11/12. autoSession: false
  it('autoSession:false drops captures with session_required and accepts after restart', () => {
    const { mgr } = makeMgr({ autoSession: false });
    expect(() => mgr.ensureStarted()).toThrow(SessionRequiredError);
    const id = mgr.restart();
    expect(id).toMatch(ULID_RE);
    expect(mgr.ensureStarted()).toBe(id);
  });

  // 16. restart() synchronous return
  it('restart() returns a new ULID synchronously and updates session.id immediately', async () => {
    const { mgr, startCalls, endCalls } = makeMgr();
    const oldId = mgr.ensureStarted();
    await Promise.resolve();
    await Promise.resolve();
    const newId = mgr.restart();
    expect(newId).toMatch(ULID_RE);
    expect(newId).not.toBe(oldId);
    expect(mgr.getId()).toBe(newId);
    await Promise.resolve();
    await Promise.resolve();
    expect(endCalls.length).toBeGreaterThanOrEqual(1);
    expect(startCalls.length).toBe(2);
  });

  // 15. end() awaits
  it('end() awaits postSessionEnd and clears the session', async () => {
    let resolveEnd: (() => void) | null = null;
    const { transport, endCalls } = makeSessionTransport({
      endImpl: () =>
        new Promise<void>((r) => {
          resolveEnd = r;
        }),
    });
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      now: () => nowMs,
      setTimer: setTimerSpy as unknown as (cb: () => void, ms: number) => unknown,
      clearTimer: clearTimerSpy as unknown as (handle: unknown) => void,
    });
    mgr.ensureStarted();
    await Promise.resolve();
    let endResolved = false;
    const endPromise = mgr.end().then(() => {
      endResolved = true;
    });
    // Allow microtasks to flush; end should still be pending.
    await Promise.resolve();
    expect(endResolved).toBe(false);
    expect(endCalls.length).toBe(1);
    resolveEnd!();
    await endPromise;
    expect(endResolved).toBe(true);
    expect(mgr.getId()).toBeNull();
  });

  // 17. Config validation
  it('rejects sessionInactivityMs < 1000 and > default at construction', () => {
    expect(() =>
      createClient({
        apiKey: 'rt_live_test_token',
        endpoint: ENDPOINT,
        sessionInactivityMs: 500,
        transport: vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch,
      }),
    ).toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_live_test_token',
        endpoint: ENDPOINT,
        sessionInactivityMs: DEFAULT_SESSION_INACTIVITY_MS + 1,
        transport: vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch,
      }),
    ).toThrow();
  });

  it('rejects sessionMaxDurationMs < 1000 and > default at construction', () => {
    expect(() =>
      createClient({
        apiKey: 'rt_live_test_token',
        endpoint: ENDPOINT,
        sessionMaxDurationMs: 999,
        transport: vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch,
      }),
    ).toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_live_test_token',
        endpoint: ENDPOINT,
        sessionMaxDurationMs: DEFAULT_SESSION_MAX_DURATION_MS + 1,
        transport: vi.fn(async () => new Response('', { status: 202 })) as unknown as typeof fetch,
      }),
    ).toThrow();
  });
});

describe('SessionManager persistence (sessionStorage)', () => {
  let storage: Record<string, string>;
  let originalSessionStorage: PropertyDescriptor | undefined;
  let originalWindow: PropertyDescriptor | undefined;
  let originalDocument: PropertyDescriptor | undefined;

  beforeEach(() => {
    storage = {};
    originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (k in storage ? storage[k]! : null),
        setItem: (k: string, v: string) => {
          storage[k] = v;
        },
        removeItem: (k: string) => {
          delete storage[k];
        },
        clear: () => {
          storage = {};
        },
        key: () => null,
        length: 0,
      } satisfies Storage,
    });
  });

  afterEach(() => {
    if (originalSessionStorage) {
      Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
    } else {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: undefined,
      });
    }
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: undefined,
      });
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: undefined,
      });
    }
  });

  // 5. Persistence restore
  it('restores a fresh session record without re-issuing session-start', async () => {
    const key = endpointStorageKey(ENDPOINT);
    const now = 1_700_000_000_000;
    storage[key] = JSON.stringify({
      session_id: '01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z',
      started_at: new Date(now - 60_000).toISOString(),
      last_activity_at: new Date(now - 1_000).toISOString(),
    });
    const { transport, startCalls } = makeSessionTransport();
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      now: () => now,
    });
    expect(mgr.getId()).toBe('01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z');
    const id = mgr.ensureStarted();
    expect(id).toBe('01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z');
    await Promise.resolve();
    await Promise.resolve();
    expect(startCalls.length).toBe(0);
  });

  // 6. Stale restore discard (inactivity)
  it('discards stored sessions whose last_activity_at exceeds inactivity window', async () => {
    const key = endpointStorageKey(ENDPOINT);
    const now = 1_700_000_000_000;
    storage[key] = JSON.stringify({
      session_id: '01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z',
      started_at: new Date(now - 60 * 60_000).toISOString(),
      last_activity_at: new Date(now - 60 * 60_000).toISOString(), // 60 min ago
    });
    const { transport, startCalls } = makeSessionTransport();
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      sessionInactivityMs: 30 * 60_000,
      now: () => now,
    });
    expect(mgr.getId()).toBeNull();
    const id = mgr.ensureStarted();
    expect(id).not.toBe('01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z');
    await Promise.resolve();
    await Promise.resolve();
    expect(startCalls.length).toBe(1);
  });

  // 7. Stale restore discard (max-duration)
  it('discards stored sessions whose started_at exceeds max-duration', async () => {
    const key = endpointStorageKey(ENDPOINT);
    const now = 1_700_000_000_000;
    storage[key] = JSON.stringify({
      session_id: '01HZK3X4Q2P5RXX7ZZ7ZZ7ZZ7Z',
      started_at: new Date(now - 13 * 60 * 60_000).toISOString(), // 13 hours ago
      last_activity_at: new Date(now - 1_000).toISOString(),
    });
    const { transport } = makeSessionTransport();
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      now: () => now,
    });
    expect(mgr.getId()).toBeNull();
  });

  // 18. sessionStorage unavailable
  it('warns once via onError when sessionStorage throws', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    const errors: Error[] = [];
    const { transport } = makeSessionTransport();
    const identity = new IdentityState();
    const mgr = new SessionManager({
      endpoint: ENDPOINT,
      transport,
      identity,
      onError: (err) => errors.push(err),
      now: () => 1_700_000_000_000,
    });
    // Construction probes storage.
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/sessionStorage/);
    // ensureStarted still works in-memory.
    const id = mgr.ensureStarted();
    expect(id).toMatch(ULID_RE);
  });
});

describe('Identity decoration through createClient', () => {
  // 8. Identity before capture
  it('identify(...) before first capture flows through to /v1/session/start and decorates the envelope', async () => {
    const fetchImpl = fetchMock(() => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.identify('u_42', { plan: 'pro' });
    client.track('page_view');
    await client.flush();
    // Allow fire-and-forget session start to settle.
    await Promise.resolve();
    await Promise.resolve();

    const startCalls = getSessionStartCalls(fetchImpl);
    expect(startCalls.length).toBe(1);
    const startBody = read<{ identify?: { user_id: string; traits?: Record<string, unknown> } }>(
      startCalls[0]!,
    );
    expect(startBody.identify).toEqual({ user_id: 'u_42', traits: { plan: 'pro' } });

    const eventsCalls = getEventsCalls(fetchImpl);
    expect(eventsCalls.length).toBe(1);
    const eventsBody = read<{ events: Array<{ actor?: { user_id: string } }> }>(eventsCalls[0]!);
    expect(eventsBody.events[0]!.actor).toEqual({ user_id: 'u_42', traits: { plan: 'pro' } });
  });

  // 9. Identity mid-session
  it('identify(...) mid-session decorates only subsequent envelopes; no extra session-start', async () => {
    const fetchImpl = fetchMock(() => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.track('page_view');
    await client.flush();
    client.identify('u_42');
    client.track('button_click');
    await client.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(getSessionStartCalls(fetchImpl).length).toBe(1);
    const eventsCalls = getEventsCalls(fetchImpl);
    expect(eventsCalls.length).toBe(2);
    const first = read<{ events: Array<{ actor?: unknown }> }>(eventsCalls[0]!);
    const second = read<{ events: Array<{ actor?: { user_id: string } }> }>(eventsCalls[1]!);
    expect(first.events[0]!.actor).toBeUndefined();
    expect(second.events[0]!.actor).toEqual({ user_id: 'u_42' });
  });

  // 10. Identity clear
  it('identify(null) clears the actor on subsequent envelopes', async () => {
    const fetchImpl = fetchMock(() => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.identify('u_42');
    client.track('page_view');
    await client.flush();
    client.identify(null);
    client.track('button_click');
    await client.flush();
    await Promise.resolve();
    await Promise.resolve();

    const eventsCalls = getEventsCalls(fetchImpl);
    expect(eventsCalls.length).toBe(2);
    const first = read<{ events: Array<{ actor?: { user_id: string } }> }>(eventsCalls[0]!);
    const second = read<{ events: Array<{ actor?: unknown }> }>(eventsCalls[1]!);
    expect(first.events[0]!.actor).toEqual({ user_id: 'u_42' });
    expect(second.events[0]!.actor).toBeUndefined();
  });
});

describe('autoSession: false through createClient', () => {
  // 11. autoSession: false drops with session_required
  it('drops captures with session_required when no session is active', async () => {
    const fetchImpl = fetchMock(() => new Response('', { status: 202 }));
    const errors: Error[] = [];
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      autoSession: false,
      onError: (err) => errors.push(err),
      transport: fetchImpl as unknown as typeof fetch,
    });
    expect(client.session.id).toBeNull();
    const eventId = client.track('page_view');
    expect(eventId).toBe('');
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(SessionRequiredError);
    await client.flush();
    expect(getEventsCalls(fetchImpl).length).toBe(0);
  });

  // 12. autoSession: false explicit start
  it('accepts captures after an explicit session.restart()', async () => {
    const fetchImpl = fetchMock(() => new Response('', { status: 202 }));
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      autoSession: false,
      transport: fetchImpl as unknown as typeof fetch,
    });
    const id = client.session.restart();
    expect(id).toMatch(ULID_RE);
    expect(client.session.id).toBe(id);
    client.track('page_view');
    await client.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(getEventsCalls(fetchImpl).length).toBe(1);
  });
});

describe('session_unknown recovery through createClient', () => {
  // 13. session_unknown recovery
  it('re-issues session-start and retries the batch on 409', async () => {
    let eventsCallIndex = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/events')) {
        const idx = eventsCallIndex++;
        if (idx === 0) {
          return new Response(
            JSON.stringify({ error: 'session_unknown', message: 'unknown' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('', { status: 202 });
      }
      return new Response('', { status: 202 });
    });
    const errors: Error[] = [];
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      onError: (err) => errors.push(err),
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.track('page_view');
    await client.flush();
    await Promise.resolve();
    await Promise.resolve();
    // First start, the 409, then a re-issued start, then the retry.
    expect(getEventsCalls(fetchImpl).length).toBe(2);
    expect(getSessionStartCalls(fetchImpl).length).toBeGreaterThanOrEqual(2);
    // No SessionRecoveryFailedError should have surfaced.
    expect(
      errors.some((e) => e instanceof SessionRecoveryFailedError),
    ).toBe(false);
  });

  // 14. session_unknown double failure
  it('drops the batch and emits session_recovery_failed when 409 repeats', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/events')) {
        return new Response(
          JSON.stringify({ error: 'session_unknown', message: 'still unknown' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    });
    const errors: Error[] = [];
    const client = createClient({
      apiKey: 'rt_live_test_token',
      endpoint: ENDPOINT,
      onError: (err) => errors.push(err),
      transport: fetchImpl as unknown as typeof fetch,
    });
    client.track('page_view');
    const sessionIdBefore = client.session.id;
    await client.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      errors.some(
        (e) =>
          e instanceof SessionRecoveryFailedError ||
          (e instanceof SessionUnknownError && e.code === 'session.unknown'),
      ),
    ).toBe(true);
    expect(
      errors.some((e) => e instanceof SessionRecoveryFailedError),
    ).toBe(true);
    expect(client.session.id).toBe(sessionIdBefore);
  });
});
