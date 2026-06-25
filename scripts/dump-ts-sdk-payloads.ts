/**
 * dump-ts-sdk-payloads.ts
 *
 * Drives the TypeScript SDK through a fixed sequence of lifecycle scenarios
 * under a recording fetch transport, capturing every outbound HTTP body that
 * the SDK would have sent on the wire. The captures are written to stdout as
 * JSON Lines — one `{ scenario, path, body }` object per line — so a separate
 * validator can stream them and validate each body against the matching JSON
 * Schema definition.
 *
 * No network I/O happens. The recording transport returns a synthetic 202
 * response with a minimal JSON body so the SDK's success path is exercised
 * the same way it would be against a live ingest service.
 *
 * Scenario IDs are stable. If a future language adds its own dumper, it must
 * implement the same scenario IDs so a symmetric validator can be plugged in
 * without renaming.
 */

// Import from the SDK's compiled `dist/` rather than its TypeScript source.
// The dist tree carries `.d.ts` files generated for the SDK's own tsconfig
// (which has the DOM lib enabled); importing src/ instead would pull DOM
// types into the contract repo's root tsc run, which has lib: ["ES2022"]
// only. The CI job runs `npm --prefix sdk/typescript run build` before this
// script so dist/ is always current.
import { createClient } from '../sdk/typescript/dist/client.js';
import type { ResolveTraceClient } from '../sdk/typescript/dist/client.js';

const SDK_ENDPOINT = 'https://ingest.example.com';
const SDK_API_KEY = 'rt_test_dumper_token';

interface Capture {
  readonly scenario: string;
  readonly path: string;
  readonly body: unknown;
}

/**
 * Build a fetch-compatible recording transport. Every invocation appends a
 * `{ scenario, path, body }` capture and returns a synthetic 202 response so
 * the SDK proceeds along its success path.
 */
type FetchArgs = Parameters<typeof fetch>;

function makeRecordingFetch(
  captures: Capture[],
  scenario: { current: string },
): typeof fetch {
  const impl = async (
    input: FetchArgs[0],
    init?: FetchArgs[1],
  ): Promise<Response> => {
    const urlString =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const url = new URL(urlString);
    const path = url.pathname;

    let body: unknown = null;
    const rawBody = (init as { body?: unknown } | undefined)?.body;
    if (typeof rawBody === 'string' && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    captures.push({ scenario: scenario.current, path, body });

    // The events endpoint expects a JSON success body; sessions endpoints
    // accept an empty body. Returning the events shape unconditionally is
    // safe because the session helpers only check the status code.
    const responseBody = JSON.stringify({
      accepted: Array.isArray(
        (body as { events?: unknown[] } | null)?.events,
      )
        ? ((body as { events: unknown[] }).events.length)
        : 0,
      duplicates: 0,
      receivedAt: new Date().toISOString(),
    });
    return new Response(responseBody, {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return impl as typeof fetch;
}

/** Build a fresh client wired to a fresh recording transport. */
function makeClient(
  captures: Capture[],
  scenario: { current: string },
): ResolveTraceClient {
  return createClient({
    apiKey: SDK_API_KEY,
    endpoint: SDK_ENDPOINT,
    transport: makeRecordingFetch(captures, scenario),
  });
}

/**
 * Drain the SDK's event queue so the recording transport has seen every
 * outbound batch, then shut the client down to release timers. Tolerates
 * shutdown errors — we only care that captures were collected.
 */
async function settle(client: ResolveTraceClient): Promise<void> {
  try {
    await client.flush({ timeoutMs: 5_000 });
  } catch {
    /* swallow — captures already recorded */
  }
  try {
    await client.shutdown({ timeoutMs: 5_000 });
  } catch {
    /* swallow — captures already recorded */
  }
}

async function runScenario(
  id: string,
  drive: (
    client: ResolveTraceClient,
    captures: Capture[],
    scenario: { current: string },
  ) => Promise<void>,
): Promise<Capture[]> {
  const captures: Capture[] = [];
  const scenario = { current: id };
  const client = makeClient(captures, scenario);
  try {
    await drive(client, captures, scenario);
  } finally {
    await settle(client);
  }
  return captures;
}

/**
 * Filter out `/v1/session/end` captures with `reason: "shutdown"` that come
 * from the implicit `client.shutdown()` we invoke in `settle()` to release
 * timers. They are not part of any scenario's contract surface — every
 * scenario tests a specific intended end cause (or doesn't end the session
 * at all). Without this filter, scenarios that do NOT call `session.end()`
 * still emit a stray shutdown-reason end body, which is noise.
 *
 * Scenarios that intentionally test ending the session (e.g. `explicit-end`)
 * still see their `reason: "explicit"` capture because that one happens
 * during `drive()`, before `settle()` runs.
 */
function dropImplicitShutdownEnds(captures: Capture[]): Capture[] {
  return captures.filter((c) => {
    if (c.path !== '/v1/session/end') return true;
    const reason = (c.body as { reason?: unknown } | null)?.reason;
    return reason !== 'shutdown';
  });
}

interface BrowserGlobals {
  href: string;
  userAgent: string;
  innerWidth: number;
  innerHeight: number;
}

// --- Minimal interactive DOM for auto-capture scenarios --------------------
//
// The browser auto-capture sources register capture-phase `click` / `submit`
// listeners and a `MutationObserver`. To exercise them end-to-end (so the
// emitted `ux.*` wire payloads are captured + schema-validated), the dumper
// provides a tiny DOM that supports just enough: elements with attributes, a
// dispatchable document, and a fireable MutationObserver. Real `setTimeout`
// drives the dead-click window.

interface DumperListener {
  type: string;
  handler: (ev: { type: string; target: DumperElement | null }) => void;
}

class DumperElement {
  tagName: string;
  parentElement: DumperElement | null = null;
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

class DumperDocument {
  body = new DumperElement('BODY');
  documentElement = new DumperElement('HTML');
  private listeners: DumperListener[] = [];
  addEventListener(
    type: string,
    handler: DumperListener['handler'],
  ): void {
    this.listeners.push({ type, handler });
  }
  removeEventListener(type: string, handler: DumperListener['handler']): void {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.handler === handler),
    );
  }
  dispatch(type: string, target: DumperElement | null): void {
    for (const l of [...this.listeners]) {
      if (l.type === type) l.handler({ type, target });
    }
  }
}

let dumperMutationCb: (() => void) | null = null;
class DumperMutationObserver {
  constructor(cb: () => void) {
    dumperMutationCb = cb;
  }
  observe(): void {
    /* no-op */
  }
  disconnect(): void {
    dumperMutationCb = null;
  }
}

interface BrowserHandles {
  document: DumperDocument;
  window: { location: { href: string } };
}

/**
 * Define the browser globals the SDK probes (`window`, `document`, `location`,
 * `navigator`, `innerWidth`, `innerHeight`, plus a no-op `sessionStorage` and a
 * fireable `MutationObserver`) and return the live handles plus a restore fn.
 * Without these, `isBrowser()` is false under node and the SDK never enters its
 * browser-only branches (UA lift on session-start, page-context enrichment on
 * `page_view`, and the auto-capture install) — the exact blind spot that let a
 * browser-only session-start defect ship.
 */
function installBrowserGlobals(g: BrowserGlobals): {
  restore: () => void;
  handles: BrowserHandles;
} {
  const store = new Map<string, string>();
  const doc = new DumperDocument();
  const win = {
    location: { href: g.href },
    MutationObserver: DumperMutationObserver,
  };
  const values: Record<string, unknown> = {
    window: win,
    document: doc,
    location: win.location,
    navigator: { userAgent: g.userAgent },
    innerWidth: g.innerWidth,
    innerHeight: g.innerHeight,
    MutationObserver: DumperMutationObserver,
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  };
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const [key, value] of Object.entries(values)) {
    saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const restore = () => {
    for (const [key, desc] of saved) {
      if (desc) {
        Object.defineProperty(globalThis, key, desc);
      } else {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          value: undefined,
        });
      }
    }
  };
  return { restore, handles: { document: doc, window: win } };
}

/**
 * Like `runScenario`, but installs browser globals for the duration of the run
 * so the SDK's `isBrowser()`-gated code paths execute — the `client.userAgent`
 * lift on session-start and the page-context enrichment on `page_view` events.
 * Critically, this also exercises the session-start body shape produced in a
 * browser, so the validator catches any re-introduction of a stray top-level
 * key (e.g. an `attributes` bag) that `SessionStartRequest`'s
 * `additionalProperties: false` rejects with HTTP 400. A node-only harness
 * never enters these branches, which is how that defect reached production.
 * Globals are restored afterwards so every other scenario stays in node.
 */
async function runBrowserScenario(
  id: string,
  drive: (client: ResolveTraceClient, handles: BrowserHandles) => Promise<void>,
): Promise<Capture[]> {
  const { restore, handles } = installBrowserGlobals({
    href: 'https://example.com/checkout',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    innerWidth: 1440,
    innerHeight: 900,
  });
  try {
    const captures: Capture[] = [];
    const scenario = { current: id };
    // The client installs auto-capture in its constructor (browser-gated), so
    // the listeners are live for the duration of `drive`.
    const client = makeClient(captures, scenario);
    try {
      await drive(client, handles);
    } finally {
      await settle(client);
    }
    return captures;
  } finally {
    restore();
  }
}

/** Helper: append an element under the document body. */
function el(
  handles: BrowserHandles,
  tag: string,
  attrs: Record<string, string> = {},
): DumperElement {
  const e = new DumperElement(tag, attrs);
  e.parentElement = handles.document.body;
  return e;
}

async function main(): Promise<void> {
  const all: Capture[] = [];

  // Scenario 1: basic-capture
  //   - createClient
  //   - capture one event
  // Expected captures (post-filter):
  //   POST /v1/session/start, POST /v1/events
  all.push(
    ...dropImplicitShutdownEnds(
      await runScenario('basic-capture', async (client) => {
        client.capture({ type: 'test.event' });
      }),
    ),
  );

  // Scenario 2: identified-capture
  //   - createClient
  //   - identify(userId) BEFORE the first capture so the identity is folded
  //     into both the session-start `identify` block and the event `actor`.
  //   - capture one event
  // Expected captures (post-filter):
  //   POST /v1/session/start (with identify), POST /v1/events (with actor)
  all.push(
    ...dropImplicitShutdownEnds(
      await runScenario('identified-capture', async (client) => {
        client.identify('user_test_123');
        client.capture({ type: 'test.event' });
      }),
    ),
  );

  // Scenario 3: identified-with-traits
  //   - As scenario 2 but with a traits bag.
  all.push(
    ...dropImplicitShutdownEnds(
      await runScenario('identified-with-traits', async (client) => {
        client.identify('user_test_123', { plan: 'pro', tier: 2 });
        client.capture({ type: 'test.event' });
      }),
    ),
  );

  // Scenario 4: explicit-end
  //   - createClient → capture → session.end()
  // Expected captures (post-filter):
  //   POST /v1/session/start, POST /v1/events, POST /v1/session/end
  //   (the end body carries reason: "explicit"; the shutdown-reason end body
  //    that `settle()` would emit on the no-op closed session is filtered.)
  all.push(
    ...dropImplicitShutdownEnds(
      await runScenario('explicit-end', async (client) => {
        client.capture({ type: 'test.event' });
        await client.flush({ timeoutMs: 5_000 });
        await client.session.end({ timeoutMs: 5_000 });
      }),
    ),
  );

  // Scenario 5: multiple-events-one-batch
  //   - Three rapid captures, all under the same session.
  // Expected captures (post-filter):
  //   POST /v1/session/start, POST /v1/events (one batch carrying 3 events)
  all.push(
    ...dropImplicitShutdownEnds(
      await runScenario('multiple-events-one-batch', async (client) => {
        client.capture({ type: 'test.event.one' });
        client.capture({ type: 'test.event.two' });
        client.capture({ type: 'test.event.three' });
      }),
    ),
  );

  // Scenario 6: browser-page-view
  //   - A `page_view` under simulated browser globals, so the SDK takes its
  //     browser-only paths: the `client.userAgent` lift on session-start and
  //     page-context enrichment (pageUrl + viewport) on the `page_view` event.
  // Expected captures (post-filter):
  //   POST /v1/session/start (client.userAgent, NO top-level `attributes`),
  //   POST /v1/events (page_view with attributes.context)
  // This is the only scenario that exercises the `isBrowser()` branch. The
  // session-start body it produces is validated against `SessionStartRequest`
  // (`additionalProperties: false`); if any browser-only code re-attaches a
  // stray top-level key such as an `attributes` bag, validation fails here.
  // A node-only dumper never enters this branch — the original blind spot.
  all.push(
    ...dropImplicitShutdownEnds(
      await runBrowserScenario('browser-page-view', async (client) => {
        client.track('page_view');
      }),
    ),
  );

  // Scenario 7: autocapture-rage-click
  //   - Three rapid clicks on the same interactive target trigger one
  //     `ux.rage_click` emitted through the real auto-capture listener.
  // Expected captures (post-filter):
  //   POST /v1/session/start, POST /v1/events (ux.rage_click, severity warn)
  all.push(
    ...dropImplicitShutdownEnds(
      await runBrowserScenario(
        'autocapture-rage-click',
        async (client, handles) => {
          // Lazy-start the session so events carry a sessionId.
          client.capture({ type: 'view.start' });
          const btn = el(handles, 'button', { id: 'submit-order' });
          handles.document.dispatch('click', btn);
          handles.document.dispatch('click', btn);
          handles.document.dispatch('click', btn);
        },
      ),
    ),
  );

  // Scenario 8: autocapture-repeated-submit
  //   - Two submits of the same form trigger one `ux.repeated_submit`.
  all.push(
    ...dropImplicitShutdownEnds(
      await runBrowserScenario(
        'autocapture-repeated-submit',
        async (client, handles) => {
          client.capture({ type: 'view.start' });
          const form = el(handles, 'form', { id: 'login', name: 'login' });
          handles.document.dispatch('submit', form);
          handles.document.dispatch('submit', form);
        },
      ),
    ),
  );

  // Scenario 9: autocapture-dead-click
  //   - One click on an interactive target with no DOM mutation / nav within
  //     the (short, test-tuned) window triggers one `ux.dead_click`.
  all.push(
    ...dropImplicitShutdownEnds(
      await runBrowserScenario(
        'autocapture-dead-click',
        async (client, handles) => {
          client.capture({ type: 'view.start' });
          const btn = el(handles, 'button', { id: 'dead' });
          handles.document.dispatch('click', btn);
          // Wait out the dead-click window (default 2500ms) with no effect.
          await new Promise((r) => setTimeout(r, 2700));
        },
      ),
    ),
  );

  // Emit each capture as one JSON Lines record on stdout. The validator reads
  // this stream line-by-line; the format is also human-greppable when a CI
  // failure needs eyeballing.
  for (const c of all) {
    process.stdout.write(`${JSON.stringify(c)}\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[dump-ts-sdk-payloads] unhandled error: ${msg}`);
  process.exit(1);
});
