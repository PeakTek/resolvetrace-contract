/**
 * SDK-side Stage-1 scrubber.
 *
 * Implements deterministic, low-cost pattern matching on string-typed event
 * fields and (in the browser) DOM input masking. The rule set is driven by
 * the canonical `schemas/scrubber-rules.matrix.json` (embedded here as
 * `RULES_MATRIX`) so the TypeScript SDK and the Python SDK emit byte-
 * identical redactions + identical `rulesDigest` for the same input.
 *
 * Runs under a strict per-event time budget; when the budget is exceeded the
 * scrubber falls back to a conservative overflow policy that replaces
 * un-processed string fields with the matrix's `overflowToken` sentinel.
 */

import { MAX_SCRUB_MS_PER_EVENT, SCRUBBER_VERSION } from './constants.js';
import { nowMs } from './runtime.js';
import { RULES_DIGEST, RULES_MATRIX } from './scrubber-rules.js';
import type { RuleDefinition, RulesMatrix } from './scrubber-rules.js';
import type { EventAttributes, ScrubberReport } from './types.js';

/** Sentinel used for overflow-fallback redaction. Sourced from the matrix. */
export const REDACTED_OVERFLOW = RULES_MATRIX.overflowToken;

/** Rule-id echoed in `applied[]` when the overflow path fires. */
export const OVERFLOW_RULE_ID = 'overflow_fallback';

/** Canonical rule ids — re-exported for callers that want to pin strings. */
export const RULE_IDS = {
  passwordInput: 'attr:password-input',
  dataRtMask: 'attr:data-rt-mask',
  dataPrivate: 'attr:data-private',
  userConfiguredSelector: 'selector:user-configured',
  email: 'regex:email',
  ssnUs: 'regex:ssn-us',
  sinCa: 'regex:sin-ca',
  creditCard: 'regex:creditcard',
  phoneE164: 'regex:phone-e164',
  overflow: OVERFLOW_RULE_ID,
} as const;

/** Re-export the committed digest for consumers that need it at build time. */
export { RULES_DIGEST };

/** Build the redaction token for a given rule id. */
export function redactionToken(ruleId: string): string {
  return RULES_MATRIX.redactionTokenTemplate.replace('{rule}', ruleId);
}

// ---------------------------------------------------------------------------
// Luhn validators — shared post-check hooks referenced by the matrix.
// ---------------------------------------------------------------------------

/** Standard Luhn check. Returns false for non-digit strings or strings < 2 digits. */
export function luhn(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 2) return false;
  let sum = 0;
  let alt = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let n = clean.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Canadian SIN validation with the SIN-specific weighting (1,2,1,2,1,2,1,2,1). */
export function validSin(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length !== 9) return false;
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = clean.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    let p = d * weights[i]!;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Rule compilation
// ---------------------------------------------------------------------------

interface CompiledRegexRule {
  id: string;
  regex: RegExp;
  postCheck?: (match: string) => boolean;
}

function compileRegexRule(rule: RuleDefinition): CompiledRegexRule {
  if (rule.pattern === undefined) {
    throw new Error(`rule ${rule.id}: missing pattern`);
  }
  const flags = rule.flags ?? 'g';
  // The matrix flags include `g` (global) plus optionally `i` (case-insensitive).
  // The JavaScript RegExp accepts these verbatim.
  const regex = new RegExp(rule.pattern, flags);
  let postCheck: ((match: string) => boolean) | undefined;
  if (rule.postCheck === 'luhn') postCheck = luhn;
  else if (rule.postCheck === 'luhn-sin') postCheck = validSin;
  return { id: rule.id, regex, postCheck };
}

function buildRegexRules(matrix: RulesMatrix): CompiledRegexRule[] {
  const out: CompiledRegexRule[] = [];
  for (const rule of matrix.rules) {
    if (rule.kind === 'regex') out.push(compileRegexRule(rule));
  }
  return out;
}

/** Compiled regex rules. Order is preserved from the matrix. */
const REGEX_RULES: CompiledRegexRule[] = buildRegexRules(RULES_MATRIX);

// ---------------------------------------------------------------------------
// Core scrub logic
// ---------------------------------------------------------------------------

/**
 * Scrub a single string value using the matrix-driven regex detectors.
 * Returns the redacted string and the set of rule-ids that fired.
 *
 * Note: `String.prototype.replace` with a `/g` RegExp does not share
 * `lastIndex` state across calls the way `.test()` + `.exec()` do, so
 * per-call isolation is preserved.
 */
export function scrubString(value: string): { value: string; applied: Set<string> } {
  const applied = new Set<string>();
  let out = value;
  for (const rule of REGEX_RULES) {
    // `lastIndex` on a /g regex can leak across shared RegExp instances; reset
    // defensively before each pass even though `.replace` does its own reset.
    rule.regex.lastIndex = 0;
    if (rule.postCheck) {
      out = out.replace(rule.regex, (match) => {
        if (rule.postCheck!(match)) {
          applied.add(rule.id);
          return redactionToken(rule.id);
        }
        return match;
      });
    } else {
      out = out.replace(rule.regex, () => {
        applied.add(rule.id);
        return redactionToken(rule.id);
      });
    }
  }
  return { value: out, applied };
}

interface WalkContext {
  applied: Set<string>;
  deadlineMs: number;
  exceeded: boolean;
}

/**
 * Recursively replace every string-leaf in a value with the overflow
 * sentinel, preserving dict / array structure. Used when the budget has
 * already tripped so downstream consumers see a structurally-equivalent
 * payload rather than raw caller data.
 */
function replaceWithOverflow(value: unknown): unknown {
  if (typeof value === 'string') return REDACTED_OVERFLOW;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => replaceWithOverflow(v));
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = replaceWithOverflow(source[key]);
  return out;
}

/** Walks an arbitrary JSON-serializable value, scrubbing every string it finds. */
function walk(value: unknown, ctx: WalkContext): unknown {
  if (ctx.exceeded || nowMs() > ctx.deadlineMs) {
    ctx.exceeded = true;
    return replaceWithOverflow(value);
  }

  if (typeof value === 'string') {
    const result = scrubString(value);
    for (const r of result.applied) ctx.applied.add(r);
    return result.value;
  }
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], ctx);
      if (ctx.exceeded) {
        // Fill remaining slots with overflow-structure so no un-scrubbed
        // data leaks past the budget check.
        for (let j = i + 1; j < value.length; j++) {
          out[j] = replaceWithOverflow(value[j]);
        }
        break;
      }
    }
    return out;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    out[key] = walk(source[key], ctx);
    if (ctx.exceeded) {
      for (let j = i + 1; j < keys.length; j++) {
        const k2 = keys[j]!;
        out[k2] = replaceWithOverflow(source[k2]);
      }
      break;
    }
  }
  return out;
}

/** Result of a full attribute-bag scrub pass. */
export interface ScrubResult {
  attributes: EventAttributes | undefined;
  report: ScrubberReport;
}

/**
 * Run Stage-1 scrubbing on an attribute bag.
 *
 * The scrubber returns both the (possibly-redacted) attributes and a report
 * stamped into `envelope.scrubber`. When the per-event time budget is
 * exceeded, `budgetExceeded = true` and un-processed string fields have been
 * replaced with the matrix's `overflowToken`.
 */
export function scrubAttributes(
  attributes: EventAttributes | undefined,
  budgetMs: number = MAX_SCRUB_MS_PER_EVENT,
): ScrubResult {
  const start = nowMs();
  const ctx: WalkContext = {
    applied: new Set<string>(),
    deadlineMs: start + budgetMs,
    exceeded: false,
  };

  let result: EventAttributes | undefined;
  if (attributes === undefined) {
    result = undefined;
  } else {
    result = walk(attributes, ctx) as EventAttributes;
  }

  const durationMs = Math.max(0, nowMs() - start);
  if (ctx.exceeded) ctx.applied.add(OVERFLOW_RULE_ID);

  const report: ScrubberReport = {
    version: SCRUBBER_VERSION,
    rulesDigest: RULES_DIGEST,
    applied: Array.from(ctx.applied).sort(),
    budgetExceeded: ctx.exceeded,
    durationMs,
  };

  return { attributes: result, report };
}

// ---------------------------------------------------------------------------
// DOM masking hooks (browser-only helpers; no-ops in Node)
// ---------------------------------------------------------------------------

/**
 * True when an element should be treated as sensitive and never serialized.
 *
 * Evaluates the attribute / selector rules in canonical matrix order:
 * 1. `attr:password-input` — `<input type="password">`
 * 2. `attr:data-rt-mask` — element carries `data-rt-mask`
 * 3. `attr:data-private` — element carries `data-private`
 * 4. `selector:user-configured` — matches a caller-supplied CSS selector
 */
export function shouldMaskElement(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type?.toLowerCase?.();
    if (type === 'password') return true;
  }
  if (el.hasAttribute && el.hasAttribute('data-rt-mask')) return true;
  if (el.hasAttribute && el.hasAttribute('data-private')) return true;
  for (const selector of userSelectors) {
    try {
      if (el.matches && el.matches(selector)) return true;
    } catch {
      // Invalid selector — ignore rather than throw from the scrubber.
    }
  }
  return false;
}

/**
 * Matching rule id for an element (used when callers want to stamp
 * `scrubber.applied` with the specific attribute/selector rule that fired).
 * Returns `null` when the element is not masked.
 */
export function matchingMaskRuleId(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): string | null {
  if (!el) return null;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type?.toLowerCase?.();
    if (type === 'password') return RULE_IDS.passwordInput;
  }
  if (el.hasAttribute && el.hasAttribute('data-rt-mask')) return RULE_IDS.dataRtMask;
  if (el.hasAttribute && el.hasAttribute('data-private')) return RULE_IDS.dataPrivate;
  for (const selector of userSelectors) {
    try {
      if (el.matches && el.matches(selector)) return RULE_IDS.userConfiguredSelector;
    } catch {
      // Invalid selector — ignore.
    }
  }
  return null;
}

/**
 * Read an element's masked text value. Returns the rule-specific redaction
 * token when the element is sensitive, the element's current value otherwise.
 */
export function readMaskedValue(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): string | null {
  if (!el) return null;
  const ruleId = matchingMaskRuleId(el, userSelectors);
  if (ruleId) return redactionToken(ruleId);
  const input = el as HTMLInputElement;
  if (typeof input.value === 'string') return input.value;
  return el.textContent ?? null;
}
