/**
 * Masking parity: the TypeScript SDK and the Python SDK, given the same
 * PII-bearing input, must produce identical redactions.
 *
 * We run both SDKs locally — the server is not in the loop for this case.
 * Specifically we compare the serialized `envelope.scrubber.applied` list
 * and the redacted attribute payload. This is the ADR-0009 cross-language
 * parity check that makes zero-change migration auditable.
 *
 * Invocation pattern for the Python side:
 *   python3 python-client/run_masking.py
 *   (stdin: JSON input, stdout: JSON output)
 *
 * The Python script builds a synthetic envelope using the SDK's internal
 * scrubber; we do not hit the network on either side.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

interface PiiSample {
  id: string;
  description: string;
  attributes: Record<string, unknown>;
  /** Rules expected to fire, in any order. */
  expectedApplied?: string[];
}

interface MaskingOutput {
  applied: string[];
  attributes: Record<string, unknown>;
}

async function loadSamples(): Promise<PiiSample[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, '..', 'fixtures', 'pii-samples.json');
  const raw = await fs.readFile(p, 'utf-8');
  const parsed = JSON.parse(raw) as { samples: PiiSample[] };
  return parsed.samples;
}

async function runTsSdkMasking(sample: PiiSample): Promise<MaskingOutput> {
  // Import the TS SDK lazily so module-load failures bubble up to the case.
  const sdk = await import('@peaktek/resolvetrace-sdk');
  let lastEnvelope: unknown = null;

  // A fetch stub that must never run (beforeSend returns null so nothing
  // is enqueued), but is accepted at construction time to bypass the
  // "no global fetch" guard on older runtimes.
  const unusedFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ accepted: 0, duplicates: 0, receivedAt: new Date().toISOString() }),
      { status: 202 },
    );

  const client = sdk.createClient({
    apiKey: 'rt_conformance_placeholder',
    endpoint: 'http://127.0.0.1:0',
    beforeSend: (envelope) => {
      lastEnvelope = envelope;
      return null; // drop so we never open the network.
    },
    transport: unusedFetch,
  });
  client.capture({ type: 'conformance.parity', attributes: sample.attributes });
  const env = lastEnvelope as {
    attributes?: Record<string, unknown>;
    scrubber: { applied: string[] };
  };
  return {
    applied: [...env.scrubber.applied].sort(),
    attributes: normaliseAttributes(env.attributes ?? {}),
  };
}

async function runPySdkMasking(
  config: ResolvedConformanceConfig,
  sample: PiiSample,
): Promise<MaskingOutput> {
  const scriptPath = path.resolve(config.pythonClientPath, 'run_masking.py');
  const payload = JSON.stringify({ attributes: sample.attributes });
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `python run_masking.py exited with code ${code}: ${stderr.slice(0, 512)}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as MaskingOutput;
        resolve({
          applied: [...parsed.applied].sort(),
          attributes: normaliseAttributes(parsed.attributes),
        });
      } catch (err) {
        reject(
          new Error(
            `python run_masking.py emitted non-JSON output: ${(err as Error).message}`,
          ),
        );
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * We compare *payload*, not internal SDK counters. Normalise to stable
 * JSON text so minor ordering differences in dict iteration do not cause
 * false failures. SDK scrubbers are both deterministic so the payload
 * itself must match exactly once keys are sorted.
 */
function normaliseAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    const v = attrs[key];
    sorted[key] = isObject(v) ? normaliseAttributes(v) : v;
  }
  return sorted;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult[]> {
  const started = performance.now();
  let samples: PiiSample[];
  try {
    samples = await loadSamples();
  } catch (err) {
    return [
      {
        id: 'masking-parity.load-fixtures',
        description: 'Load cross-language PII samples',
        status: 'fail',
        durationMs: performance.now() - started,
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const results: CaseResult[] = [];
  for (const sample of samples) {
    const sampleStarted = performance.now();
    const id = `masking-parity.${sample.id}`;
    try {
      const [tsOut, pyOut] = await Promise.all([
        runTsSdkMasking(sample),
        runPySdkMasking(config, sample),
      ]);
      const appliedEqual = JSON.stringify(tsOut.applied) === JSON.stringify(pyOut.applied);
      const attrsEqual =
        JSON.stringify(tsOut.attributes) === JSON.stringify(pyOut.attributes);
      const durationMs = performance.now() - sampleStarted;
      if (appliedEqual && attrsEqual) {
        results.push({
          id,
          description: sample.description,
          status: 'pass',
          durationMs,
          details: { applied: tsOut.applied },
        });
      } else {
        results.push({
          id,
          description: sample.description,
          status: 'fail',
          durationMs,
          message: !appliedEqual
            ? 'applied rule list differs between TS and Python SDKs'
            : 'redacted attributes differ between TS and Python SDKs',
          details: {
            tsApplied: tsOut.applied,
            pyApplied: pyOut.applied,
            tsAttributes: tsOut.attributes,
            pyAttributes: pyOut.attributes,
          },
        });
      }
    } catch (err) {
      results.push({
        id,
        description: sample.description,
        status: 'fail',
        durationMs: performance.now() - sampleStarted,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export const maskingParityCase: CaseDefinition = {
  id: 'masking-parity',
  description: 'TS and Python SDKs produce identical redactions for the same PII input',
  run,
};
