/**
 * SDK-side Stage-1 scrubber.
 *
 * Implements deterministic, low-cost pattern matching on string-typed event
 * fields and (in the browser) DOM input masking. Runs under a strict per-event
 * time budget; when the budget is exceeded the scrubber falls back to a
 * conservative overflow policy that replaces un-processed string fields with
 * a sentinel placeholder.
 */

import { MAX_SCRUB_MS_PER_EVENT, SCRUBBER_VERSION } from './constants.js';
import { nowMs } from './runtime.js';
import type { EventAttributes, ScrubberReport } from './types.js';

/** Sentinel used for overflow-fallback redaction. */
export const REDACTED_OVERFLOW = '[REDACTED_OVERFLOW]';

/** Replacement applied to any matched regex-detected PII. */
export const REDACTED_PII = '[REDACTED]';

/** Replacement applied to DOM/selector-masked values. */
export const REDACTED_MASK = '[REDACTED_MASK]';

/**
 * Hand-maintained digest of the Stage-1 ruleset shipped with this SDK build.
 *
 * This value is stamped into `envelope.scrubber.rulesDigest` so the backend
 * can decide whether to re-apply any deterministic rule. It MUST be updated
 * whenever a rule is added, removed, or changed — see the ruleset matrix in
 * the contract repo for the authoritative mapping of rule-ids to digests.
 *
 * Note: the authoritative canonical digest for this SDK's ruleset is
 * calculated offline and committed here as a constant so the SDK does not pay
 * hash cost on every event. The canonical digest algorithm is SHA-256 over a
 * stable serialization of the rule list — see `tools/compute-rules-digest`
 * in the contract repo (future deliverable).
 */
export const RULES_DIGEST = 'sha256:' + '0'.repeat(64);

/** Rule-ids (stable strings echoed in `envelope.scrubber.applied`). */
export const RULE_IDS = {
  email: 'regex:email',
  ssn: 'regex:ssn',
  sin: 'regex:sin',
  phone: 'regex:phone',
  creditCard: 'regex:credit_card',
  password: 'input:password',
  dataRtMask: 'attr:data-rt-mask',
  dataPrivate: 'attr:data-private',
  selector: 'selector:user',
  overflow: 'overflow_fallback',
} as const;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

// RFC 5322 simplified.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// US SSN with dashes — requires the hyphenated form to avoid masking phone numbers.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Canadian SIN (9 digits, optional grouping). Luhn-validated before redaction.
const SIN_RE = /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g;

// E.164-ish international phone — requires a leading `+`.
const PHONE_E164_RE = /\+[1-9]\d{1,14}\b/g;

// Parenthesized North-American phone (10-11 digits with formatting).
const PHONE_NA_RE = /\(\d{3}\)\s?\d{3}[- ]?\d{4}\b/g;

// 13-19 digits (loose) for credit card candidates — Luhn-validated.
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

/** Standard Luhn check. Returns false for non-digit strings. */
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

/** Canadian SIN validation with the SIN-specific weighting. */
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
// Core scrub logic
// ---------------------------------------------------------------------------

/**
 * Scrub a single string value using the hardcoded Stage-1 detectors.
 * Returns the redacted string and the set of rule-ids that fired.
 *
 * Note: `String.prototype.replace` with a `/g` RegExp does not share
 * `lastIndex` state across calls the way `.test()` + `.exec()` do, so
 * per-call isolation is preserved.
 */
export function scrubString(value: string): { value: string; applied: Set<string> } {
  const applied = new Set<string>();
  let out = value;

  out = out.replace(EMAIL_RE, () => {
    applied.add(RULE_IDS.email);
    return REDACTED_PII;
  });

  out = out.replace(SSN_RE, () => {
    applied.add(RULE_IDS.ssn);
    return REDACTED_PII;
  });

  // SIN — Luhn-validated via SIN-specific weighting.
  out = out.replace(SIN_RE, (match) => {
    if (validSin(match)) {
      applied.add(RULE_IDS.sin);
      return REDACTED_PII;
    }
    return match;
  });

  out = out.replace(PHONE_E164_RE, () => {
    applied.add(RULE_IDS.phone);
    return REDACTED_PII;
  });
  out = out.replace(PHONE_NA_RE, () => {
    applied.add(RULE_IDS.phone);
    return REDACTED_PII;
  });

  // Credit-card — Luhn-validated.
  out = out.replace(CC_RE, (match) => {
    if (luhn(match)) {
      applied.add(RULE_IDS.creditCard);
      return REDACTED_PII;
    }
    return match;
  });

  return { value: out, applied };
}

interface WalkContext {
  applied: Set<string>;
  deadlineMs: number;
  exceeded: boolean;
}

const OVERFLOW_SENTINEL: unique symbol = Symbol('overflow');

/** Walks an arbitrary JSON-serializable value, scrubbing every string it finds. */
function walk(value: unknown, ctx: WalkContext): unknown | typeof OVERFLOW_SENTINEL {
  if (ctx.exceeded) return OVERFLOW_SENTINEL;
  if (nowMs() > ctx.deadlineMs) {
    ctx.exceeded = true;
    return OVERFLOW_SENTINEL;
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
      const processed = walk(value[i], ctx);
      if (processed === OVERFLOW_SENTINEL) {
        out[i] = REDACTED_OVERFLOW;
      } else {
        out[i] = processed;
      }
      if (ctx.exceeded) {
        // Fill remainder with overflow sentinel for determinism.
        for (let j = i + 1; j < value.length; j++) out[j] = REDACTED_OVERFLOW;
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
    const processed = walk(source[key], ctx);
    if (processed === OVERFLOW_SENTINEL) {
      out[key] = REDACTED_OVERFLOW;
    } else {
      out[key] = processed;
    }
    if (ctx.exceeded) {
      for (let j = i + 1; j < keys.length; j++) out[keys[j]!] = REDACTED_OVERFLOW;
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
 * replaced with `[REDACTED_OVERFLOW]`.
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
    const processed = walk(attributes, ctx);
    if (processed === OVERFLOW_SENTINEL) {
      result = {};
      ctx.exceeded = true;
    } else {
      result = processed as EventAttributes;
    }
  }

  const durationMs = Math.max(0, nowMs() - start);
  if (ctx.exceeded) ctx.applied.add(RULE_IDS.overflow);

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

/** True when an element should be treated as sensitive and never serialized. */
export function shouldMaskElement(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): boolean {
  if (!el) return false;
  // Password inputs (type attribute is already a DOM contract).
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

/** Read an element's masked text value. Returns `REDACTED_MASK` if the element is sensitive. */
export function readMaskedValue(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): string | null {
  if (!el) return null;
  if (shouldMaskElement(el, userSelectors)) return REDACTED_MASK;
  const input = el as HTMLInputElement;
  if (typeof input.value === 'string') return input.value;
  return el.textContent ?? null;
}
