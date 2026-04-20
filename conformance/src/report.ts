/**
 * Report formatters. Two output styles:
 *
 *   - "pretty": human-readable, colour-free, suitable for terminal runs.
 *   - "tap":    TAP version 13, suitable for CI aggregators that parse it.
 *
 * Both formats emit the same ordering and detail set so a customer can
 * flip between them without losing information.
 */

import type { CaseResult } from './types.ts';

export interface Summary {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  durationMs: number;
}

export function summarize(results: readonly CaseResult[]): Summary {
  const summary: Summary = {
    total: results.length,
    pass: 0,
    fail: 0,
    skip: 0,
    durationMs: 0,
  };
  for (const r of results) {
    summary.durationMs += r.durationMs;
    if (r.status === 'pass') summary.pass++;
    else if (r.status === 'fail') summary.fail++;
    else summary.skip++;
  }
  return summary;
}

export function renderPretty(results: readonly CaseResult[]): string {
  const lines: string[] = [];
  lines.push('ResolveTrace conformance harness');
  lines.push('--------------------------------');
  for (const r of results) {
    const tag =
      r.status === 'pass' ? '[PASS]' : r.status === 'fail' ? '[FAIL]' : '[SKIP]';
    lines.push(`${tag} ${r.id}  (${r.durationMs.toFixed(0)} ms)`);
    lines.push(`       ${r.description}`);
    if (r.message) lines.push(`       reason: ${r.message}`);
    if (r.details) {
      for (const [k, v] of Object.entries(r.details)) {
        lines.push(`       ${k}: ${renderDetail(v)}`);
      }
    }
  }
  const s = summarize(results);
  lines.push('');
  lines.push(
    `summary: ${s.pass} pass, ${s.fail} fail, ${s.skip} skip  (${s.total} cases, ${s.durationMs.toFixed(0)} ms)`,
  );
  return lines.join('\n');
}

export function renderTap(results: readonly CaseResult[]): string {
  const lines: string[] = [];
  lines.push('TAP version 13');
  lines.push(`1..${results.length}`);
  results.forEach((r, idx) => {
    const n = idx + 1;
    const header =
      r.status === 'pass'
        ? `ok ${n} - ${r.id}`
        : r.status === 'skip'
          ? `ok ${n} - ${r.id} # SKIP ${r.message ?? ''}`.trim()
          : `not ok ${n} - ${r.id}`;
    lines.push(header);
    if (r.status === 'fail' || r.details || r.message) {
      lines.push('  ---');
      lines.push(`  description: ${r.description}`);
      lines.push(`  duration_ms: ${r.durationMs.toFixed(0)}`);
      if (r.message) lines.push(`  message: ${r.message}`);
      if (r.details) {
        lines.push('  details:');
        for (const [k, v] of Object.entries(r.details)) {
          lines.push(`    ${k}: ${renderDetail(v)}`);
        }
      }
      lines.push('  ...');
    }
  });
  return lines.join('\n');
}

function renderDetail(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
