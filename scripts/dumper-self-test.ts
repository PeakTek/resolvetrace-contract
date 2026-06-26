/**
 * dumper-self-test.ts
 *
 * Guards against a *silently shrinking* SDK dumper. `validate-sdk-output.ts`
 * proves that every capture the dumper DOES emit is schema-valid — but it
 * cannot notice when a scenario stops emitting captures (e.g. a refactor breaks
 * a browser-only branch, or an auto-capture source quietly stops firing). A
 * dropped scenario would then pass `validate-sdk-output` vacuously.
 *
 * This self-test pins the dumper's output to an explicit expectation:
 *
 *   1. Every scenario in {@link EXPECTED_SCENARIOS} is present.
 *   2. No scenario the dumper emits is *missing* from the expectation set
 *      (a new scenario must be declared here, so coverage is reviewed).
 *   3. At least {@link MIN_TOTAL_CAPTURES} captures total.
 *   4. Every canonical event type in {@link EXPECTED_EVENT_TYPES} appears on the
 *      wire of at least one `/v1/events` body. This is the event-type coverage
 *      gate: the taxonomy families (view / action / error / perf / ux /
 *      support), plus the replay legs, must all be exercised by SDK output.
 *
 * Run via `npm run selftest:dumper`. Wired into the anti-drift
 * `validate-sdk-output` job so a regression blocks the PR.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const DUMPER_SCRIPT = resolve(__dirname, 'dump-ts-sdk-payloads.ts');

/**
 * Every scenario the dumper is expected to emit. Adding a scenario to the
 * dumper without listing it here fails the self-test (forcing a review of the
 * new coverage); removing/breaking a scenario also fails it.
 */
const EXPECTED_SCENARIOS: readonly string[] = [
  'basic-capture',
  'identified-capture',
  'identified-with-traits',
  'explicit-end',
  'multiple-events-one-batch',
  'browser-page-view',
  'autocapture-rage-click',
  'autocapture-repeated-submit',
  'autocapture-dead-click',
  'autocapture-error-js',
  'autocapture-api-latency',
  'autocapture-error-api',
  'autocapture-api-latency-xhr',
  'autocapture-error-resource',
  'autocapture-long-task',
  'support-report-submitted',
  'canonical-app-events',
  'replay-upload',
];

/**
 * Canonical taxonomy types (plus the custom `page_view`) that the SDK emits on
 * the `/v1/events` wire across the scenario set. Covers every family:
 *   view.*   — view.start, view.end
 *   action.* — action.click, action.submit, action.navigation
 *   error.*  — error.js, error.api, error.resource
 *   perf.*   — perf.api_latency, perf.long_task
 *   ux.*     — ux.rage_click, ux.dead_click, ux.repeated_submit (frustration)
 *   support.*— support.report_submitted (W25; with a breadcrumb trail)
 */
const EXPECTED_EVENT_TYPES: readonly string[] = [
  'view.start',
  'view.end',
  'action.click',
  'action.submit',
  'action.navigation',
  'error.js',
  'error.api',
  'error.resource',
  'perf.api_latency',
  'perf.long_task',
  'ux.rage_click',
  'ux.dead_click',
  'ux.repeated_submit',
  'support.report_submitted',
  'page_view',
];

/** Replay legs (W24) the dumper must drive on the SDK wire. */
const EXPECTED_REPLAY_PATHS: readonly string[] = [
  '/v1/replay/signed-url',
  '/v1/replay/complete',
];

/**
 * Lower bound on total captures. Set below the current count (35+) with margin
 * so a benign reordering does not trip it, but any meaningful drop does. Update
 * deliberately when scenarios are added.
 */
const MIN_TOTAL_CAPTURES = 30;

interface Capture {
  readonly scenario: string;
  readonly path: string;
  readonly body: unknown;
}

async function* streamDumperLines(): AsyncIterable<string> {
  const isWindows = process.platform === 'win32';
  const tsxBin = isWindows ? 'tsx.cmd' : 'tsx';
  const tsxPath = resolve(REPO_ROOT, 'node_modules', '.bin', tsxBin);

  const child = spawn(tsxPath, [DUMPER_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: isWindows,
    env: process.env,
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 0));
  });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    yield line;
  }

  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`dumper exited with status ${exitCode}`);
  }
}

function eventTypesOf(body: unknown): string[] {
  if (
    body !== null &&
    typeof body === 'object' &&
    Array.isArray((body as { events?: unknown[] }).events)
  ) {
    const events = (body as { events: unknown[] }).events;
    return events
      .map((e) =>
        e !== null && typeof e === 'object'
          ? (e as { type?: unknown }).type
          : undefined,
      )
      .filter((t): t is string => typeof t === 'string');
  }
  return [];
}

async function main(): Promise<void> {
  const captures: Capture[] = [];
  for await (const line of streamDumperLines()) {
    try {
      captures.push(JSON.parse(line) as Capture);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[dumper-self-test] could not parse dumper line as JSON: ${msg}\n  line: ${line}`,
      );
      process.exit(1);
    }
  }

  const failures: string[] = [];

  // (3) total-count floor.
  if (captures.length < MIN_TOTAL_CAPTURES) {
    failures.push(
      `expected >= ${MIN_TOTAL_CAPTURES} captures, got ${captures.length}`,
    );
  }

  const seenScenarios = new Set(captures.map((c) => c.scenario));

  // (1) every expected scenario present.
  const missingScenarios = EXPECTED_SCENARIOS.filter(
    (s) => !seenScenarios.has(s),
  );
  if (missingScenarios.length > 0) {
    failures.push(
      `missing expected scenario(s): ${missingScenarios.join(', ')} ` +
        `(a scenario stopped emitting captures)`,
    );
  }

  // (2) no undeclared scenario.
  const expectedSet = new Set(EXPECTED_SCENARIOS);
  const undeclared = [...seenScenarios].filter((s) => !expectedSet.has(s));
  if (undeclared.length > 0) {
    failures.push(
      `undeclared scenario(s) in dumper output: ${undeclared.join(', ')} ` +
        `(add them to EXPECTED_SCENARIOS so the new coverage is reviewed)`,
    );
  }

  // (4) event-type coverage.
  const seenTypes = new Set<string>();
  const seenPaths = new Set<string>();
  for (const c of captures) {
    seenPaths.add(c.path);
    for (const t of eventTypesOf(c.body)) seenTypes.add(t);
  }
  const missingTypes = EXPECTED_EVENT_TYPES.filter((t) => !seenTypes.has(t));
  if (missingTypes.length > 0) {
    failures.push(
      `missing expected event type(s) on the /v1/events wire: ` +
        `${missingTypes.join(', ')}`,
    );
  }
  const missingReplay = EXPECTED_REPLAY_PATHS.filter((p) => !seenPaths.has(p));
  if (missingReplay.length > 0) {
    failures.push(
      `missing expected replay leg(s): ${missingReplay.join(', ')}`,
    );
  }

  if (failures.length > 0) {
    console.error('[dumper-self-test] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(
    `[dumper-self-test] OK: ${captures.length} captures, ` +
      `${seenScenarios.size} scenarios, ` +
      `${EXPECTED_EVENT_TYPES.length} event types covered, ` +
      `${EXPECTED_REPLAY_PATHS.length} replay legs.`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[dumper-self-test] unhandled error: ${msg}`);
  process.exit(1);
});
