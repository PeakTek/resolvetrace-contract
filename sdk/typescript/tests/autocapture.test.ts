/**
 * Auto-capture framework + frustration-signal unit tests.
 *
 * These run under vitest's `node` environment with a hand-rolled, minimal DOM
 * mock (no jsdom dependency) that supports just enough for the heuristics:
 * capture-phase `addEventListener`/`removeEventListener` + `dispatchEvent`,
 * element `tagName`/attributes/`parentElement`, a `MutationObserver`, and a
 * mutable `location.href`.
 *
 * Time is controlled two ways: `vi.useFakeTimers()` for the dead-click
 * `setTimeout`, and a stubbed `performance.now` for the sliding windows that
 * `nowMs()` reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoCapture } from '../src/autocapture/index.js';
import {
  describeTarget,
  describeForm,
  MASKED_TOKEN,
} from '../src/autocapture/selector.js';
import { createRageClickSource } from '../src/autocapture/rage-click.js';
import { createDeadClickSource } from '../src/autocapture/dead-click.js';
import { createRepeatedSubmitSource } from '../src/autocapture/repeated-submit.js';
import type { CaptureContext } from '../src/autocapture/types.js';
import { resolveConfig } from '../src/config.js';
import type { ResolvedAutoCaptureConfig } from '../src/config.js';
import type { EventInput } from '../src/types.js';

// ---------------------------------------------------------------------------
// Minimal DOM mock
// ---------------------------------------------------------------------------

interface Listener {
  type: string;
  handler: (ev: FakeEvent) => void;
  capture: boolean;
}

class FakeElement {
  tagName: string;
  parentElement: FakeElement | null = null;
  private readonly attrs = new Map<string, string>();
  className = '';

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') this.className = v;
      else this.attrs.set(k, v);
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name) || (name === 'class' && this.className.length > 0);
  }
  matches(): boolean {
    return false;
  }
  get attributes(): { length: number; item(i: number): { name: string; value: string } | null } {
    const entries = Array.from(this.attrs.entries());
    return {
      length: entries.length,
      item: (i: number) =>
        entries[i] ? { name: entries[i]![0], value: entries[i]![1] } : null,
    };
  }
  appendTo(parent: FakeElement): this {
    this.parentElement = parent;
    return this;
  }
}

interface FakeEvent {
  type: string;
  target: FakeElement | null;
}

class FakeDocument {
  body: FakeElement;
  documentElement: FakeElement;
  private listeners: Listener[] = [];

  constructor() {
    this.documentElement = new FakeElement('HTML');
    this.body = new FakeElement('BODY');
    this.body.parentElement = this.documentElement;
  }

  addEventListener(type: string, handler: (ev: FakeEvent) => void, capture?: boolean): void {
    this.listeners.push({ type, handler, capture: capture === true });
  }
  removeEventListener(type: string, handler: (ev: FakeEvent) => void, capture?: boolean): void {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.handler === handler && l.capture === (capture === true)),
    );
  }
  dispatch(type: string, target: FakeElement | null): void {
    const ev: FakeEvent = { type, target };
    for (const l of [...this.listeners]) {
      if (l.type === type) l.handler(ev);
    }
  }
  listenerCount(): number {
    return this.listeners.length;
  }
}

// A MutationObserver mock the test can fire manually.
type MutationCb = () => void;
let activeObserverCb: MutationCb | null = null;
class FakeMutationObserver {
  private readonly cb: MutationCb;
  constructor(cb: MutationCb) {
    this.cb = cb;
    activeObserverCb = cb;
  }
  observe(): void {
    /* no-op */
  }
  disconnect(): void {
    if (activeObserverCb === this.cb) activeObserverCb = null;
  }
}
function fireMutation(): void {
  activeObserverCb?.();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function defaultConfig(
  overrides: Partial<ResolvedAutoCaptureConfig> = {},
): ResolvedAutoCaptureConfig {
  return { ...resolveConfig({ apiKey: 'k', endpoint: 'https://e.test' }).autoCapture, ...overrides };
}

function makeCtx(
  doc: FakeDocument,
  win: unknown,
  config: ResolvedAutoCaptureConfig,
  emitted: EventInput[],
  maskSelectors: string[] = [],
): CaptureContext {
  return {
    config,
    maskSelectors,
    document: doc as unknown as Document,
    window: win as Window & typeof globalThis,
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
  activeObserverCb = null;
});

// ===========================================================================
// Masking helper — the privacy guarantee
// ===========================================================================

describe('describeTarget masking', () => {
  it('NEVER includes inner text or input values, only structural tokens', () => {
    const input = new FakeElement('input', {
      type: 'email',
      name: 'email',
      id: 'login-email',
    });
    // Simulate that a developer set .value / textContent with raw PII.
    (input as unknown as { value: string }).value = 'alice@example.com';
    (input as unknown as { textContent: string }).textContent = 'alice@example.com';

    const d = describeTarget(input as unknown as Element, []);

    expect(d).not.toContain('alice@example.com');
    expect(d).not.toContain('alice');
    // It DOES carry safe structural tokens.
    expect(d).toContain('input');
    expect(d).toContain('[type=email]');
    expect(d).toContain('[name=email]');
    expect(d).toContain('#login-email');
  });

  it('collapses a data-rt-mask element to an opaque token', () => {
    const el = new FakeElement('button', { 'data-rt-mask': '', id: 'secret' });
    const d = describeTarget(el as unknown as Element, []);
    expect(d).toBe(MASKED_TOKEN);
    expect(d).not.toContain('secret');
  });

  it('masks when an ANCESTOR is sensitive', () => {
    const wrapper = new FakeElement('div', { 'data-private': '' });
    const child = new FakeElement('button', { id: 'pay-now' });
    child.parentElement = wrapper;
    const d = describeTarget(child as unknown as Element, []);
    expect(d).toBe(MASKED_TOKEN);
    expect(d).not.toContain('pay-now');
  });

  it('drops PII-shaped id/class tokens and routes through the scrubber', () => {
    const el = new FakeElement('a', { id: 'user-alice@example.com' });
    const d = describeTarget(el as unknown as Element, []);
    expect(d).not.toContain('alice@example.com');
  });

  it('describeForm resolves to the enclosing form descriptor', () => {
    const form = new FakeElement('form', { id: 'checkout', name: 'checkout' });
    const btn = new FakeElement('button', { type: 'submit' });
    btn.parentElement = form;
    const d = describeForm(btn as unknown as Element, []);
    expect(d).toContain('form');
    expect(d).toContain('#checkout');
  });
});

// ===========================================================================
// rage_click
// ===========================================================================

describe('ux.rage_click', () => {
  it('emits once when N clicks hit the same target within the window', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const cfg = defaultConfig();
    const teardown = createRageClickSource().install(
      makeCtx(doc, {}, cfg, emitted),
    );
    const btn = new FakeElement('button', { id: 'go' });
    btn.parentElement = doc.body;

    doc.dispatch('click', btn);
    doc.dispatch('click', btn);
    expect(emitted).toHaveLength(0); // below threshold (3)
    doc.dispatch('click', btn);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('ux.rage_click');
    expect(emitted[0]!.severity).toBe('warn');
    expect(emitted[0]!.attributes!.clickCount).toBe(3);
    expect(emitted[0]!.attributes!.target).toContain('#go');

    // A 4th click in the same burst does NOT re-emit.
    doc.dispatch('click', btn);
    expect(emitted).toHaveLength(1);
    teardown();
  });

  it('does not fire when clicks exceed the window', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const teardown = createRageClickSource().install(
      makeCtx(doc, {}, defaultConfig(), emitted),
    );
    const btn = new FakeElement('button', { id: 'go' });
    doc.dispatch('click', btn);
    now += 600;
    doc.dispatch('click', btn);
    now += 600; // total 1200ms > 1000ms window from first click
    doc.dispatch('click', btn);
    expect(emitted).toHaveLength(0);
    teardown();
  });
});

// ===========================================================================
// dead_click
// ===========================================================================

describe('ux.dead_click', () => {
  it('flags an interactive click with no DOM mutation / nav in the window', () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const win = { MutationObserver: FakeMutationObserver, location: { href: 'https://x.test/a' } };
    const teardown = createDeadClickSource().install(
      makeCtx(doc, win, defaultConfig(), emitted),
    );
    const btn = new FakeElement('button', { id: 'noop' });
    btn.parentElement = doc.body;
    doc.dispatch('click', btn);
    vi.advanceTimersByTime(2500);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('ux.dead_click');
    expect(emitted[0]!.severity).toBe('info');
    expect(emitted[0]!.attributes!.target).toContain('#noop');
    teardown();
  });

  it('does NOT flag when a DOM mutation occurs in the window', () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const win = { MutationObserver: FakeMutationObserver, location: { href: 'https://x.test/a' } };
    const teardown = createDeadClickSource().install(
      makeCtx(doc, win, defaultConfig(), emitted),
    );
    const btn = new FakeElement('button', { id: 'works' });
    btn.parentElement = doc.body;
    doc.dispatch('click', btn);
    fireMutation(); // something happened
    vi.advanceTimersByTime(2500);
    expect(emitted).toHaveLength(0);
    teardown();
  });

  it('does NOT flag when navigation occurs in the window', () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const win = { MutationObserver: FakeMutationObserver, location: { href: 'https://x.test/a' } };
    const teardown = createDeadClickSource().install(
      makeCtx(doc, win, defaultConfig(), emitted),
    );
    const link = new FakeElement('a', { href: '/b' });
    link.parentElement = doc.body;
    doc.dispatch('click', link);
    win.location.href = 'https://x.test/b'; // navigated
    vi.advanceTimersByTime(2500);
    expect(emitted).toHaveLength(0);
    teardown();
  });

  it('ignores clicks on non-interactive targets', () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const win = { MutationObserver: FakeMutationObserver, location: { href: 'https://x.test/a' } };
    const teardown = createDeadClickSource().install(
      makeCtx(doc, win, defaultConfig(), emitted),
    );
    const div = new FakeElement('div', { class: 'plain' });
    div.parentElement = doc.body;
    doc.dispatch('click', div);
    vi.advanceTimersByTime(2500);
    expect(emitted).toHaveLength(0);
    teardown();
  });
});

// ===========================================================================
// repeated_submit
// ===========================================================================

describe('ux.repeated_submit', () => {
  it('emits when the same form is submitted N times within the window', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const teardown = createRepeatedSubmitSource().install(
      makeCtx(doc, {}, defaultConfig(), emitted),
    );
    const form = new FakeElement('form', { id: 'login' });
    form.parentElement = doc.body;
    doc.dispatch('submit', form);
    expect(emitted).toHaveLength(0);
    doc.dispatch('submit', form);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('ux.repeated_submit');
    expect(emitted[0]!.severity).toBe('warn');
    expect(emitted[0]!.attributes!.submitCount).toBe(2);
    expect(emitted[0]!.attributes!.target).toContain('#login');
    teardown();
  });

  it('resets after the window elapses', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const teardown = createRepeatedSubmitSource().install(
      makeCtx(doc, {}, defaultConfig(), emitted),
    );
    const form = new FakeElement('form', { id: 'login' });
    doc.dispatch('submit', form);
    now += 4000; // > 3000ms window
    doc.dispatch('submit', form);
    expect(emitted).toHaveLength(0);
    teardown();
  });

  it('does not include raw form field content', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const teardown = createRepeatedSubmitSource().install(
      makeCtx(doc, {}, defaultConfig(), emitted),
    );
    const form = new FakeElement('form', { id: 'login' });
    (form as unknown as { textContent: string }).textContent = 'super-secret-password';
    doc.dispatch('submit', form);
    doc.dispatch('submit', form);
    expect(JSON.stringify(emitted)).not.toContain('super-secret-password');
    teardown();
  });
});

// ===========================================================================
// Framework: opt-out, ceiling, teardown
// ===========================================================================

describe('AutoCapture framework', () => {
  it('per-signal opt-out skips disabled sources', () => {
    const doc = new FakeDocument();
    const emitted: EventInput[] = [];
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { rageClick: false },
    });
    const ac = new AutoCapture({
      config: cfg,
      emit: (e) => emitted.push(e),
      sources: [createRageClickSource(), createRepeatedSubmitSource()],
    });
    // isEnabled reflects config — rage disabled, repeated enabled.
    expect(createRageClickSource().isEnabled(cfg.autoCapture)).toBe(false);
    expect(createRepeatedSubmitSource().isEnabled(cfg.autoCapture)).toBe(true);
    void ac;
    void doc;
  });

  it('enforces the per-session ceiling on emitted events', () => {
    const emitted: EventInput[] = [];
    const cfg = resolveConfig({
      apiKey: 'k',
      endpoint: 'https://e.test',
      autoCapture: { maxEventsPerSession: 2 },
    });
    const ac = new AutoCapture({ config: cfg, emit: (e) => emitted.push(e), sources: [] });
    // Drive the gate directly via a synthetic source ctx.
    const gate = (ac as unknown as { gatedEmit(e: EventInput): boolean }).gatedEmit.bind(ac);
    expect(gate({ type: 'ux.rage_click' })).toBe(true);
    expect(gate({ type: 'ux.rage_click' })).toBe(true);
    expect(gate({ type: 'ux.rage_click' })).toBe(false); // ceiling hit
    expect(emitted).toHaveLength(2);
    // resetSessionBudget lets it emit again (new session).
    ac.resetSessionBudget();
    expect(gate({ type: 'ux.rage_click' })).toBe(true);
    expect(emitted).toHaveLength(3);
  });

  it('install() is a no-op outside a browser', () => {
    const emitted: EventInput[] = [];
    const cfg = resolveConfig({ apiKey: 'k', endpoint: 'https://e.test' });
    const ac = new AutoCapture({ config: cfg, emit: (e) => emitted.push(e) });
    // No window/document globals in the node test env → no-op, no throw.
    expect(() => ac.install()).not.toThrow();
    expect(ac.getEmittedCount()).toBe(0);
  });

  it('a throwing source does not break install of others', () => {
    const cfg = resolveConfig({ apiKey: 'k', endpoint: 'https://e.test' });
    // Force browser-ish globals so install proceeds.
    const doc = new FakeDocument();
    vi.stubGlobal('window', { MutationObserver: FakeMutationObserver });
    vi.stubGlobal('document', doc);
    const errors: Error[] = [];
    let goodInstalled = false;
    const bad = {
      name: 'bad',
      isEnabled: () => true,
      install: () => {
        throw new Error('boom');
      },
    };
    const good = {
      name: 'good',
      isEnabled: () => true,
      install: () => {
        goodInstalled = true;
        return () => undefined;
      },
    };
    const ac = new AutoCapture({
      config: cfg,
      emit: () => undefined,
      reportError: (e) => errors.push(e),
      sources: [bad, good],
    });
    expect(() => ac.install()).not.toThrow();
    expect(goodInstalled).toBe(true);
    expect(errors.map((e) => e.message)).toContain('boom');
    ac.shutdown();
  });
});
