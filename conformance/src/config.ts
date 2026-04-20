/**
 * Config resolution for the conformance harness.
 *
 * Supports both environment variables and command-line flags. Env takes a
 * lower precedence than explicit flags, matching the convention of CI
 * runners where `CONFORMANCE_*` vars are pre-set.
 *
 * Recognized env:
 *   - CONFORMANCE_ENDPOINT (required unless `--endpoint` is given)
 *   - CONFORMANCE_API_KEY  (required unless `--api-key` is given)
 *   - CONFORMANCE_ADDITIONAL_ENDPOINTS  comma-separated list
 *   - CONFORMANCE_PYTHON_CLIENT_PATH
 *   - CONFORMANCE_PYTHON_BIN (default "python3")
 *   - CONFORMANCE_REPORT_ONLY ("1" / "true")
 *   - CONFORMANCE_SKIP_NETWORK ("1" / "true")
 *   - CONFORMANCE_FORMAT ("pretty" | "tap", default "pretty")
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedConformanceConfig } from './types.ts';

const DEFAULT_PYTHON_BIN = 'python3';
const DEFAULT_FORMAT: 'pretty' | 'tap' = 'pretty';
const DEFAULT_RATE_LIMIT_BURST_MS = 2_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 300;

function envFlag(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function envList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ParseArgsResult {
  config: ResolvedConformanceConfig;
  showHelp: boolean;
}

/**
 * Hand-parse argv so we stay zero-dep (no `commander` / `yargs`). The CLI
 * surface is intentionally small; the full set of options is documented in
 * `conformance/README.md`.
 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const args = [...argv];
  let endpoint = process.env.CONFORMANCE_ENDPOINT ?? '';
  let apiKey = process.env.CONFORMANCE_API_KEY ?? '';
  let additionalEndpoints = envList('CONFORMANCE_ADDITIONAL_ENDPOINTS');
  let pythonClientPath = process.env.CONFORMANCE_PYTHON_CLIENT_PATH ?? '';
  const pythonExecutable = process.env.CONFORMANCE_PYTHON_BIN ?? DEFAULT_PYTHON_BIN;
  let reportOnly = envFlag('CONFORMANCE_REPORT_ONLY');
  let skipNetwork = envFlag('CONFORMANCE_SKIP_NETWORK');
  let format: 'pretty' | 'tap' =
    process.env.CONFORMANCE_FORMAT === 'tap' ? 'tap' : DEFAULT_FORMAT;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '-h':
      case '--help':
        showHelp = true;
        break;
      case '--endpoint':
        if (next === undefined) throw new Error('--endpoint requires a value');
        endpoint = next;
        i++;
        break;
      case '--api-key':
        if (next === undefined) throw new Error('--api-key requires a value');
        apiKey = next;
        i++;
        break;
      case '--additional-endpoint':
        if (next === undefined) throw new Error('--additional-endpoint requires a value');
        additionalEndpoints = [...additionalEndpoints, next];
        i++;
        break;
      case '--python-client-path':
        if (next === undefined) throw new Error('--python-client-path requires a value');
        pythonClientPath = next;
        i++;
        break;
      case '--report-only':
        reportOnly = true;
        break;
      case '--skip-network':
        skipNetwork = true;
        break;
      case '--format':
        if (next === 'tap' || next === 'pretty') {
          format = next;
          i++;
        } else {
          throw new Error('--format must be "pretty" or "tap"');
        }
        break;
      default:
        if (arg && arg.startsWith('--')) {
          throw new Error(`unknown flag: ${arg}`);
        }
    }
  }

  if (!showHelp) {
    if (!endpoint) {
      throw new Error(
        'missing --endpoint (or CONFORMANCE_ENDPOINT). Run with --help for usage.',
      );
    }
    if (!apiKey) {
      throw new Error(
        'missing --api-key (or CONFORMANCE_API_KEY). Run with --help for usage.',
      );
    }
  }

  if (!pythonClientPath) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    pythonClientPath = path.resolve(here, '..', 'python-client');
  }

  return {
    showHelp,
    config: {
      endpoint,
      apiKey,
      additionalEndpoints,
      pythonClientPath,
      pythonExecutable,
      reportOnly,
      skipNetwork,
      rateLimitBurstMs: DEFAULT_RATE_LIMIT_BURST_MS,
      rateLimitMaxRequests: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      format,
    },
  };
}

export function helpText(): string {
  return [
    'resolvetrace-conformance — validate a ResolveTrace deployment against the published contract',
    '',
    'Usage:',
    '  resolvetrace-conformance --endpoint <url> --api-key <key> [options]',
    '',
    'Options:',
    '  --endpoint <url>              Target ingest endpoint (env: CONFORMANCE_ENDPOINT)',
    '  --api-key <key>               Opaque bearer token (env: CONFORMANCE_API_KEY)',
    '  --additional-endpoint <url>   Extra endpoint for endpoint-parity (repeatable)',
    '  --python-client-path <path>   Override path to ./python-client',
    '  --report-only                 Collect all results without failing the process',
    '  --skip-network                Only run cases that do not require outbound HTTP',
    '  --format pretty|tap           Output format (default: pretty)',
    '  -h, --help                    Show this help text',
    '',
    'Env vars mirror the flags: CONFORMANCE_* (see conformance/README.md).',
    '',
    'Exit codes:',
    '  0    all cases passed or --report-only',
    '  1    one or more cases failed',
    '  2    configuration error',
  ].join('\n');
}
