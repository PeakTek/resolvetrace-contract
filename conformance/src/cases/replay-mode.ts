/**
 * Replay trigger-mode contract (SDK-local, always runs).
 *
 * The replay trigger model is a neutral SDK mechanism: the SDK exposes a
 * `mode` of 'auto' | 'manual' | 'off' plus a public `client.replay.start()` /
 * `client.replay.stop()` handle. Which trigger a deployment actually honors is
 * a server/tenant decision — the SDK carries no consent or entitlement logic.
 *
 * This case pins the *public contract* so every SDK build ships the same three
 * modes and the same safe handle shape:
 *
 *   1. `mode` defaults to 'auto', and the shorthand `replay: true` also resolves
 *      to 'auto' — enabling replay never silently changes the trigger.
 *   2. All three documented modes resolve; any other value is rejected at config
 *      time (fail-fast, not silently coerced).
 *   3. `client.replay` is always present with callable `start`/`stop`, and both
 *      are a safe no-op off the browser (start → false, stop → no throw). A host
 *      can wire the manual handle unconditionally without runtime guards.
 *
 * Like the replay-masking layer in `masking-parity`, this is SDK-local: it never
 * touches the network, so it runs even under `--skip-network`.
 */

import type { CaseDefinition, CaseResult } from '../types.ts';

const MODES = ['auto', 'manual', 'off'] as const;

async function run(): Promise<CaseResult> {
  const started = performance.now();
  const id = 'replay-mode.contract';
  const description =
    'Replay trigger modes (auto/manual/off) and the public start/stop handle ship identically';
  try {
    const sdk = await import('@peaktek/resolvetrace-sdk');
    const failures: string[] = [];

    // resolveReplayConfig validates option keys against an allow-set; supply
    // exactly the keys we exercise.
    const allowed = new Set(['mode', 'enabled']);

    // 1. Default + shorthand both resolve to 'auto'.
    const defaultMode = sdk.defaultReplayConfig().mode;
    if (defaultMode !== 'auto') {
      failures.push(`defaultReplayConfig().mode is '${String(defaultMode)}', expected 'auto'`);
    }
    const shorthandMode = sdk.resolveReplayConfig(true, allowed).mode;
    if (shorthandMode !== 'auto') {
      failures.push(`resolveReplayConfig(true).mode is '${String(shorthandMode)}', expected 'auto'`);
    }

    // 2. Every documented mode resolves to itself.
    for (const mode of MODES) {
      const resolved = sdk.resolveReplayConfig({ mode }, allowed).mode;
      if (resolved !== mode) {
        failures.push(`mode '${mode}' resolved to '${String(resolved)}'`);
      }
    }

    // …and an undocumented mode is rejected, not coerced.
    let rejected = false;
    try {
      sdk.resolveReplayConfig({ mode: 'sometimes' as never }, allowed);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      failures.push('an invalid replay mode was accepted (expected a ConfigError)');
    }

    // 3. The public manual handle is always present and safe to call. Off the
    // browser (this harness runs in Node) auto-capture never installs, so the
    // handle must degrade to a no-op rather than throw.
    const client = sdk.createClient({
      apiKey: 'rt_conformance_placeholder',
      endpoint: 'http://127.0.0.1:0',
      transport: async () =>
        new Response(
          JSON.stringify({ accepted: 0, duplicates: 0, receivedAt: new Date().toISOString() }),
          { status: 202 },
        ),
    });
    if (typeof client.replay?.start !== 'function' || typeof client.replay?.stop !== 'function') {
      failures.push('client.replay.start/stop are not both callable');
    } else {
      const startResult = await client.replay.start();
      if (startResult !== false) {
        failures.push(`client.replay.start() off-browser returned ${String(startResult)}, expected false`);
      }
      try {
        client.replay.stop();
      } catch (err) {
        failures.push(`client.replay.stop() threw off-browser: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = performance.now() - started;
    if (failures.length > 0) {
      return { id, description, status: 'fail', durationMs, message: failures.join('; ') };
    }
    return {
      id,
      description,
      status: 'pass',
      durationMs,
      details: { defaultMode, modes: [...MODES] },
    };
  } catch (err) {
    return {
      id,
      description,
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const replayModeCase: CaseDefinition = {
  id: 'replay-mode',
  description:
    'Replay trigger-mode contract: auto/manual/off resolve, invalid rejected, manual handle is a safe no-op off-browser',
  run,
};
