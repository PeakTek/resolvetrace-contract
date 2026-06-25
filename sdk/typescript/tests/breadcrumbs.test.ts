/**
 * Wave-21 A2 breadcrumb capture-source unit tests.
 *
 * Covers the four breadcrumb sources — `error.js`, `error.api` +
 * `perf.api_latency` (fetch + XHR), `error.resource`, and `perf.long_task` —
 * under a hand-rolled minimal browser mock (no jsdom). The privacy guarantees
 * (no request/response bodies, no headers, scrubbed URLs / query values) are
 * asserted directly, plus teardown-restores-originals, opt-out, and the
 * per-session ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiSource } from '../src/autocapture/api.js';
import { createErrorJsSource } from '../src/autocapture/error-js.js';
import { createErrorResourceSource } from '../src/autocapture/error-resource.js';
import { createLongTaskSource } from '../src/autocapture/long-task.js';
import { scrubUrl, REDACTED_QUERY_VALUE } from '../src/autocapture/url.js';
import { AutoCapture } from '../src/autocapture/index.js';
import type { CaptureContext } from '../src/autocapture/types.js';
import { resolveConfig } from '../src/config.js';
import type { ResolvedAutoCaptureConfig } from '../src/config.js';
import type { EventInput } from '../src/types.js';

// ---------------------------------------------------------------------------
// Minimal browser mock
// ---------------------------------------------------------------------------

interface FakeEvent {
  type: string;
  target: unknown;
  error?: unknown;
  reason?: unknown;
  message?: string;
}

/** A window/document stand-in with capture-aware add/removeEventListener. */
class FakeWindow {
  private listeners: Array<{
    type: string;
    handler: (ev: FakeEvent) => void;
    capture: boolean;
  }> = [];
  location = { href: 'https://app.test/checkout' };
  // Slots the api source wraps.
  fetch?: unknown;
  XMLHttpRequest?: unknown;
  PerformanceObserver?: unknown;
  MutationObserver?: unknown;

  addEventListener(
    type: string,
    handler: (ev: FakeEvent) => void,
    capture?: boolean,
  ): void {
    this.listeners.push({ type, handler, capture: capture === true });
  }
  removeEventListener(
    type: string,
    handler: (ev: FakeEvent) => void,
    capture?: boolean,
  ): void {
    this.listeners = this.listeners.filter(
      (l) =>
        !(l.type === type && l.handler === handler && l.capture === (capture === true)),
    );
  }
  dispatch(ev: FakeEvent, capture = false): void {
    for (const l of [...this.listeners]) {
      if (l.type === ev.type && l.capture === capture) l.handler(ev);
    }
  }
  listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeElement {
  tagName: string;
  parentElement: FakeElement | null = null;
  className = '';
  private readonly attrs = new Map<string, string>();
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') this.className = v;
      else this.attrs.set(k, v);
    }
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  matches(): boolean {
    return false;
  }
  get attributes(): {
    length: number;
    item(i: number): { name: string; value: string } | null;
  } {
    const e = Array.from(this.attrs.entries());
    return {
      length: e.length,
      item: (i: number) => (e[i] ? { name: e[i]![0], value: e[i]![1] } : null),
    };
  }
}

function defaultConfig(
  overrides: Partial<ResolvedAutoCaptureConfig> = {},
): ResolvedAutoCaptureConfig {
  return {
    ...resolveConfig({ apiKey: 'k', endpoint: 'https://e.test' }).autoCapture,
    ...overrides,
  };
}

function makeCtx(
  win: FakeWindow,
  config: ResolvedAutoCaptureConfig,
  emitted: EventInput[],
  maskSelectors: string[] = [],
): CaptureContext {
  return {
    config,
    maskSelectors,
    document: {} as unknown as Document,
    window: win as unknown as Window & typeof globalThis,
    emit: (event) => {
      emitted.push(event);
      return true;
    },
  };
}

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.stubGlobal('performance', { now: () => now });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// URL scrubbing — the network privacy guarantee
// ===========================================================================

describe('scrubUrl', () => {
  it('keeps origin + path but REDACTS every query value', () => {
    const out = scrubUrl(
      'https://api.test/v1/users/42?token=secrettoken&email=alice@example.com',
    );
    expect(out).toContain('https://api.test/v1/users/42');
    // Parameter NAMES are kept (structural); VALUES are gone.
    expect(out).toContain(`token=${REDACTED_QUERY_VALUE}`);
    expect(out).toContain(`email=${REDACTED_QUERY_VALUE}`);
    expect(out).not.toContain('secrettoken');
    expect(out).not.toContain('alice@example.com');
  });

  it('drops the fragment entirely', () => {
    const out = scrubUrl('https://api.test/p?a=1#access_token=leak');
    expect(out).not.toContain('leak');
    expect(out).not.toContain('#');
  });

  it('never emits a raw query string even for an unparseable URL', () => {
    const out = scrubUrl('not a url ?secret=value');
    expect(out).not.toContain('secret=value');
  });

  it('resolves a relative URL against the page base and redacts its query', () => {
    const out = scrubUrl('/api/orders?card=4111111111111111', 'https://app.test/');
    expect(out).toContain('https://app.test/api/orders');
    expect(out).toContain(`card=${REDACTED_QUERY_VALUE}`);
    expect(out).not.toContain('4111111111111111');
  });
});

// ===========================================================================
// error.js
// ===========================================================================

describe('error.js', () => {
  it('captures an uncaught error with message, type, and stack', () => {
    const win = new FakeWindow();
    const emitted: EventInput[] = [];
    const teardown = createErrorJsSource().install(
      makeCtx(win, defaultConfig(), emitted),
    );
    const err = new TypeError('cannot read x of undefined');
    err.stack = 'TypeError: cannot read x of undefined\n  at foo (app.js:1:1)';
    win.dispatch({ type: 'error', target: win, error: err, message: err.message });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.js');
    expect(emitted[0]!.severity).toBe('error');
    expect(emitted[0]!.attributes!.errorType).toBe('TypeError');
    expect(emitted[0]!.attributes!.message).toBe('cannot read x of undefined');
    expect(emitted[0]!.attributes!.stack).toContain('foo (app.js');
    teardown();
    expect(win.listenerCount()).toBe(0);
  });

  it('captures an unhandled promise rejection', () => {
    const win = new FakeWindow();
    const emitted: EventInput[] = [];
    const teardown = createErrorJsSource().install(
      makeCtx(win, defaultConfig(), emitted),
    );
    win.dispatch({
      type: 'unhandledrejection',
      target: win,
      reason: new Error('async boom'),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.js');
    expect(emitted[0]!.attributes!.kind).toBe('unhandledrejection');
    expect(emitted[0]!.attributes!.message).toBe('async boom');
    teardown();
  });
});

// ===========================================================================
// error.api + perf.api_latency — fetch
// ===========================================================================

function installApi(
  win: FakeWindow,
  emitted: EventInput[],
  cfg = defaultConfig(),
): () => void {
  return createApiSource().install(makeCtx(win, cfg, emitted));
}

describe('fetch wrapping', () => {
  it('success (<400) emits perf.api_latency with durationMs + httpStatus', async () => {
    const win = new FakeWindow();
    const seen: { input: unknown; init: unknown }[] = [];
    win.fetch = async (input: unknown, init: unknown) => {
      seen.push({ input, init });
      now += 25;
      return { status: 200 } as Response;
    };
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);

    const res = await (win.fetch as typeof fetch)(
      'https://api.test/v1/items?q=shoes',
    );
    expect((res as { status: number }).status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('perf.api_latency');
    expect(emitted[0]!.httpStatus).toBe(200);
    expect(emitted[0]!.durationMs).toBe(25);
    expect(emitted[0]!.attributes!.method).toBe('GET');
    // URL scrubbed: query value redacted.
    expect(emitted[0]!.attributes!.url).toContain('https://api.test/v1/items');
    expect(emitted[0]!.attributes!.url).not.toContain('shoes');
    teardown();
  });

  it('status >= 400 emits error.api (no perf.api_latency)', async () => {
    const win = new FakeWindow();
    win.fetch = async () => ({ status: 503 }) as Response;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    await (win.fetch as typeof fetch)('https://api.test/v1/down', {
      method: 'POST',
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.api');
    expect(emitted[0]!.severity).toBe('error');
    expect(emitted[0]!.httpStatus).toBe(503);
    expect(emitted[0]!.attributes!.method).toBe('POST');
    teardown();
  });

  it('network failure (rejection) emits error.api with no httpStatus and re-rejects', async () => {
    const win = new FakeWindow();
    const boom = new Error('network down');
    win.fetch = async () => {
      throw boom;
    };
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    await expect((win.fetch as typeof fetch)('https://api.test/x')).rejects.toBe(
      boom,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.api');
    expect(emitted[0]!.httpStatus).toBeUndefined();
    expect(emitted[0]!.attributes!.networkError).toBe(true);
    teardown();
  });

  it('NEVER reads request or response bodies', async () => {
    const win = new FakeWindow();
    let bodyConsumed = false;
    win.fetch = async (_input: unknown, _init: unknown) =>
      ({
        status: 200,
        // If the wrapper ever called these, the test would observe it.
        text: () => {
          bodyConsumed = true;
          return Promise.resolve('SENSITIVE');
        },
        json: () => {
          bodyConsumed = true;
          return Promise.resolve({ secret: 'SENSITIVE' });
        },
      }) as unknown as Response;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    await (win.fetch as typeof fetch)('https://api.test/v1/secret', {
      method: 'POST',
      body: JSON.stringify({ password: 'hunter2', card: '4111111111111111' }),
    });
    // Wrapper must not have touched the response body...
    expect(bodyConsumed).toBe(false);
    // ...and nothing emitted may carry the request body content.
    const blob = JSON.stringify(emitted);
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('4111111111111111');
    teardown();
  });

  it('only emits ONE event per request (no double-emit)', async () => {
    const win = new FakeWindow();
    win.fetch = async () => ({ status: 200 }) as Response;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    await (win.fetch as typeof fetch)('https://api.test/x');
    expect(emitted).toHaveLength(1);
    teardown();
  });

  it('teardown restores the original fetch', async () => {
    const win = new FakeWindow();
    const original = async () => ({ status: 200 }) as Response;
    win.fetch = original;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    expect(win.fetch).not.toBe(original); // wrapped
    teardown();
    expect(win.fetch).toBe(original); // restored
  });
});

// ===========================================================================
// error.api + perf.api_latency — XMLHttpRequest
// ===========================================================================

/**
 * A minimal XHR class whose prototype the api source patches. `simulate()`
 * drives a request to a terminal `loadend` with a given status.
 */
class FakeXHR {
  status = 0;
  private listeners = new Map<string, Array<() => void>>();
  // Patched by the source; original implementations below.
  open(_method: string, _url: string): void {
    /* original no-op */
  }
  send(_body?: unknown): void {
    /* original no-op */
  }
  addEventListener(type: string, cb: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  fire(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  /** Open + send + reach terminal state with `status`. */
  simulate(method: string, url: string, status: number): void {
    this.open(method, url);
    this.send();
    this.status = status;
    this.fire('loadend');
  }
}

describe('XMLHttpRequest wrapping', () => {
  it('success path emits perf.api_latency; teardown restores prototype', () => {
    const win = new FakeWindow();
    win.XMLHttpRequest = FakeXHR as unknown;
    const origOpen = FakeXHR.prototype.open;
    const origSend = FakeXHR.prototype.send;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    expect(FakeXHR.prototype.open).not.toBe(origOpen); // patched

    const xhr = new FakeXHR();
    now += 12;
    xhr.simulate('GET', 'https://api.test/v1/profile?uid=99', 200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('perf.api_latency');
    expect(emitted[0]!.httpStatus).toBe(200);
    expect(emitted[0]!.attributes!.url).not.toContain('99');

    teardown();
    expect(FakeXHR.prototype.open).toBe(origOpen); // restored
    expect(FakeXHR.prototype.send).toBe(origSend);
  });

  it('status >= 400 emits error.api', () => {
    const win = new FakeWindow();
    win.XMLHttpRequest = FakeXHR as unknown;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    new FakeXHR().simulate('POST', 'https://api.test/v1/save', 500);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.api');
    expect(emitted[0]!.httpStatus).toBe(500);
    teardown();
  });

  it('status 0 (network error) emits error.api with no httpStatus, once', () => {
    const win = new FakeWindow();
    win.XMLHttpRequest = FakeXHR as unknown;
    const emitted: EventInput[] = [];
    const teardown = installApi(win, emitted);
    const xhr = new FakeXHR();
    xhr.open('GET', 'https://api.test/v1/x');
    xhr.send();
    xhr.status = 0;
    xhr.fire('loadend'); // single terminal callback
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.api');
    expect(emitted[0]!.httpStatus).toBeUndefined();
    teardown();
  });
});

// ===========================================================================
// error.resource
// ===========================================================================

describe('error.resource', () => {
  it('captures an img load failure with masked descriptor + scrubbed URL', () => {
    const win = new FakeWindow();
    const emitted: EventInput[] = [];
    const teardown = createErrorResourceSource().install(
      makeCtx(win, defaultConfig(), emitted),
    );
    const img = new FakeElement('img', {
      id: 'hero',
      src: 'https://cdn.test/a.png?sig=secretsig',
    });
    win.dispatch({ type: 'error', target: img }, true); // capture phase
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('error.resource');
    expect(emitted[0]!.severity).toBe('warn');
    expect(emitted[0]!.attributes!.resourceType).toBe('img');
    expect(emitted[0]!.attributes!.target).toContain('#hero');
    expect(emitted[0]!.attributes!.resourceUrl).toContain('https://cdn.test/a.png');
    expect(emitted[0]!.attributes!.resourceUrl).not.toContain('secretsig');
    teardown();
  });

  it('ignores window-targeted (runtime) errors — those are error.js', () => {
    const win = new FakeWindow();
    const emitted: EventInput[] = [];
    const teardown = createErrorResourceSource().install(
      makeCtx(win, defaultConfig(), emitted),
    );
    win.dispatch({ type: 'error', target: win }, true);
    expect(emitted).toHaveLength(0);
    teardown();
  });
});

// ===========================================================================
// perf.long_task
// ===========================================================================

/** A controllable PerformanceObserver mock. */
function makeFakePO(): {
  ctor: unknown;
  fire(entries: Array<{ duration: number; name?: string }>): void;
  observeCalls: Array<{ entryTypes?: string[] }>;
  disconnected: () => boolean;
} {
  let cb: ((list: { getEntries(): unknown[] }) => void) | null = null;
  const observeCalls: Array<{ entryTypes?: string[] }> = [];
  let disconnected = false;
  class FakePO {
    constructor(callback: (list: { getEntries(): unknown[] }) => void) {
      cb = callback;
    }
    observe(opts: { entryTypes?: string[] }): void {
      observeCalls.push(opts);
    }
    disconnect(): void {
      disconnected = true;
    }
  }
  return {
    ctor: FakePO as unknown,
    fire(entries) {
      cb?.({ getEntries: () => entries });
    },
    observeCalls,
    disconnected: () => disconnected,
  };
}

describe('perf.long_task', () => {
  it('emits perf.long_task with durationMs for each reported entry', () => {
    const win = new FakeWindow();
    const po = makeFakePO();
    win.PerformanceObserver = po.ctor;
    const emitted: EventInput[] = [];
    const teardown = createLongTaskSource().install(
      makeCtx(win, defaultConfig(), emitted),
    );
    expect(po.observeCalls[0]?.entryTypes).toEqual(['longtask']);
    po.fire([{ duration: 87.4, name: 'self' }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('perf.long_task');
    expect(emitted[0]!.severity).toBe('info');
    expect(emitted[0]!.durationMs).toBe(87);
    teardown();
    expect(po.disconnected()).toBe(true);
  });

  it('no-ops cleanly when PerformanceObserver is unavailable', () => {
    const win = new FakeWindow();
    win.PerformanceObserver = undefined;
    const emitted: EventInput[] = [];
    expect(() =>
      createLongTaskSource().install(makeCtx(win, defaultConfig(), emitted)),
    ).not.toThrow();
    expect(emitted).toHaveLength(0);
  });
});

// ===========================================================================
// Framework integration: opt-out + ceiling
// ===========================================================================

describe('breadcrumb framework integration', () => {
  it('per-signal opt-out disables a breadcrumb source', () => {
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { errorJs: false, longTask: false },
    });
    expect(createErrorJsSource().isEnabled(cfg.autoCapture)).toBe(false);
    expect(createLongTaskSource().isEnabled(cfg.autoCapture)).toBe(false);
    // Network source stays enabled (apiLatency/errorApi still on).
    expect(createApiSource().isEnabled(cfg.autoCapture)).toBe(true);
    expect(createErrorResourceSource().isEnabled(cfg.autoCapture)).toBe(true);
  });

  it('disabling both apiLatency and errorApi disables the api source', () => {
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { apiLatency: false, errorApi: false },
    });
    expect(createApiSource().isEnabled(cfg.autoCapture)).toBe(false);
  });

  it('per-session ceiling drops breadcrumbs past the cap', () => {
    const emitted: EventInput[] = [];
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { maxEventsPerSession: 1 },
    });
    const ac = new AutoCapture({
      config: cfg,
      emit: (e) => emitted.push(e),
      sources: [],
    });
    const gate = (
      ac as unknown as { gatedEmit(e: EventInput): boolean }
    ).gatedEmit.bind(ac);
    expect(gate({ type: 'error.js' })).toBe(true);
    expect(gate({ type: 'perf.long_task' })).toBe(false); // ceiling hit
    expect(emitted).toHaveLength(1);
  });

  it('errorStatusThreshold is configurable', () => {
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { errorStatusThreshold: 500 },
    });
    expect(cfg.autoCapture.errorStatusThreshold).toBe(500);
  });
});
