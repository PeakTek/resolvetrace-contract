#!/usr/bin/env node
/**
 * Conformance harness entry point.
 *
 * Runs each registered case against the target deployment and prints a
 * report. Exit codes:
 *   0  — all cases passed (or every failure was converted to a report row
 *        in `--report-only` mode)
 *   1  — at least one case failed and `--report-only` is not set
 *   2  — configuration or internal harness error
 */

import { parseArgs, helpText } from './config.ts';
import { connectivityCase } from './cases/connectivity.ts';
import { schemaCase } from './cases/schema.ts';
import { idempotencyCase } from './cases/idempotency.ts';
import { rateLimitCase } from './cases/rate-limit.ts';
import { replayCase } from './cases/replay.ts';
import { maskingParityCase } from './cases/masking-parity.ts';
import { keyOpacityCase } from './cases/key-opacity.ts';
import { endpointParityCase } from './cases/endpoint-parity.ts';
import { renderPretty, renderTap, summarize } from './report.ts';
import type { CaseDefinition, CaseResult } from './types.ts';

const CASES: readonly CaseDefinition[] = [
  connectivityCase,
  schemaCase,
  idempotencyCase,
  rateLimitCase,
  replayCase,
  maskingParityCase,
  keyOpacityCase,
  endpointParityCase,
];

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(helpText() + '\n');
    return 2;
  }

  if (parsed.showHelp) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }

  const { config } = parsed;
  const results: CaseResult[] = [];

  for (const c of CASES) {
    try {
      const started = performance.now();
      const caseResult = await c.run(config);
      const list = Array.isArray(caseResult) ? caseResult : [caseResult];
      for (const r of list) {
        if (typeof r.durationMs !== 'number' || Number.isNaN(r.durationMs)) {
          r.durationMs = performance.now() - started;
        }
      }
      results.push(...list);
      if (!config.reportOnly && list.some((r) => r.status === 'fail')) {
        // Fail-fast mode — break after recording the failing case(s).
        break;
      }
    } catch (err) {
      results.push({
        id: `${c.id}.internal-error`,
        description: c.description,
        status: 'fail',
        durationMs: 0,
        message: err instanceof Error ? err.message : String(err),
      });
      if (!config.reportOnly) break;
    }
  }

  const rendered =
    config.format === 'tap' ? renderTap(results) : renderPretty(results);
  process.stdout.write(rendered + '\n');

  const summary = summarize(results);
  if (config.reportOnly) return 0;
  return summary.fail > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
