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
