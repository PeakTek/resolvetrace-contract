import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES_DIGEST,
  RULES_MATRIX,
  canonicalizeMatrix,
  computeRulesDigest,
} from '../src/scrubber-rules.js';
import {
  OVERFLOW_RULE_ID,
  REDACTED_OVERFLOW,
  RULE_IDS,
  redactionToken,
  scrubAttributes,
  scrubString,
} from '../src/scrubber.js';

// Path to the canonical schema files at the contract-repo root.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const MATRIX_PATH = path.resolve(repoRoot, 'schemas', 'scrubber-rules.matrix.json');
const DIGEST_PATH = path.resolve(repoRoot, 'schemas', 'scrubber-rules.digest.txt');

describe('scrubber rule matrix', () => {
  it('canonicalization matches Python json.dumps(sort_keys=True, separators=(",",":"))', () => {
    // Minimal fixture chosen to exercise key ordering + escaping.
    const sample = {
      b: 1,
      a: { y: 'hi', x: [true, null, '\\n'] },
      c: [1, 2, 3],
    };
    const canon = canonicalizeMatrix(sample as unknown as typeof RULES_MATRIX);
    // Hand-computed canonical form:
    //   {"a":{"x":[true,null,"\\n"],"y":"hi"},"b":1,"c":[1,2,3]}
    expect(canon).toBe('{"a":{"x":[true,null,"\\\\n"],"y":"hi"},"b":1,"c":[1,2,3]}');
  });

  it('shipped RULES_DIGEST matches the committed schema digest constant', async () => {
    const digestFile = (await readFile(DIGEST_PATH, 'utf-8')).trim();
    expect(RULES_DIGEST).toBe(digestFile);
  });

  it('computeRulesDigest reproduces the committed digest from the embedded matrix', async () => {
    const digestFile = (await readFile(DIGEST_PATH, 'utf-8')).trim();
    const digest = await computeRulesDigest(RULES_MATRIX);
    expect(digest).toBe(digestFile);
  });

  it('computeRulesDigest reproduces the digest from the on-disk matrix file', async () => {
    const raw = await readFile(MATRIX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const digest = await computeRulesDigest(parsed);
    const digestFile = (await readFile(DIGEST_PATH, 'utf-8')).trim();
    expect(digest).toBe(digestFile);
  });

  it('Node sync hash over canonical JSON equals the async subtle-crypto digest', async () => {
    const canon = canonicalizeMatrix(RULES_MATRIX);
    const hex = createHash('sha256').update(canon, 'utf-8').digest('hex');
    expect(`sha256:${hex}`).toBe(RULES_DIGEST);
  });

  it('embedded matrix matches the canonical schema file byte-for-byte once re-canonicalized', async () => {
    const raw = await readFile(MATRIX_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Canonicalize both the on-disk and the embedded forms; if they agree,
    // the embedded TS literal cannot drift from the JSON source of truth
    // without the digest-parity tests tripping.
    expect(canonicalizeMatrix(parsed)).toBe(canonicalizeMatrix(RULES_MATRIX));
  });
});

describe('scrubber runtime behaviour', () => {
  it('redactionToken renders the canonical [REDACTED:<rule>] template', () => {
    expect(redactionToken('regex:email')).toBe('[REDACTED:regex:email]');
    expect(redactionToken('selector:user-configured')).toBe(
      '[REDACTED:selector:user-configured]',
    );
  });

  it('scrubString redacts email via the canonical rule id', () => {
    const { value, applied } = scrubString('mail me at alice@example.com please');
    expect(value).toContain('[REDACTED:regex:email]');
    expect(value).not.toContain('alice@example.com');
    expect(applied.has(RULE_IDS.email)).toBe(true);
  });

  it('scrubString redacts US SSN', () => {
    const { value, applied } = scrubString('SSN 123-45-6789');
    expect(value).toContain('[REDACTED:regex:ssn-us]');
    expect(applied.has(RULE_IDS.ssnUs)).toBe(true);
  });

  it('scrubString redacts Luhn-valid SIN but leaves random 9-digit strings alone', () => {
    // Luhn-valid SIN
    const valid = scrubString('SIN on file: 046-454-286');
    expect(valid.value).toContain('[REDACTED:regex:sin-ca]');
    expect(valid.applied.has(RULE_IDS.sinCa)).toBe(true);

    // Luhn-invalid 9-digit string
    const invalid = scrubString('Order ref 123-456-789');
    expect(invalid.value).toBe('Order ref 123-456-789');
    expect(invalid.applied.has(RULE_IDS.sinCa)).toBe(false);
  });

  it('scrubString redacts Luhn-valid credit cards but not arbitrary 16-digit strings', () => {
    const valid = scrubString('card 4111 1111 1111 1111 authorized');
    expect(valid.value).toContain('[REDACTED:regex:creditcard]');
    expect(valid.applied.has(RULE_IDS.creditCard)).toBe(true);

    const invalid = scrubString('reference 1234 5678 9012 3456');
    expect(invalid.value).toBe('reference 1234 5678 9012 3456');
    expect(invalid.applied.has(RULE_IDS.creditCard)).toBe(false);
  });

  it('scrubString redacts E.164 phones but not bare 10-digit numbers', () => {
    const valid = scrubString('call +14165551234');
    expect(valid.value).toContain('[REDACTED:regex:phone-e164]');
    expect(valid.applied.has(RULE_IDS.phoneE164)).toBe(true);

    const invalid = scrubString('call 4165551234');
    expect(invalid.value).toBe('call 4165551234');
    expect(invalid.applied.has(RULE_IDS.phoneE164)).toBe(false);
  });

  it('scrubAttributes stamps the canonical digest + version on the report', () => {
    const { attributes, report } = scrubAttributes({
      user: { email: 'bob@example.com' },
    });
    const user = attributes!.user as { email: string };
    expect(user.email).toBe('[REDACTED:regex:email]');
    expect(report.rulesDigest).toBe(RULES_DIGEST);
    expect(report.applied).toContain('regex:email');
    expect(report.applied).toEqual([...report.applied].sort());
    expect(report.budgetExceeded).toBe(false);
  });

  it('scrubAttributes sorts the applied list so wire output is deterministic', () => {
    const { report } = scrubAttributes({
      m:
        'Reach me at combo@example.com or +15551230000; ' +
        'my card 4242424242424242 is on file.',
    });
    expect(report.applied).toEqual([
      'regex:creditcard',
      'regex:email',
      'regex:phone-e164',
    ]);
  });

  it('scrubAttributes trips the overflow path when the budget is exhausted', () => {
    const { attributes, report } = scrubAttributes(
      { a: 'x', b: 'y', nested: { c: 'z' } },
      -1,
    );
    expect(report.budgetExceeded).toBe(true);
    expect(report.applied).toContain(OVERFLOW_RULE_ID);
    // Every visible string slot must be replaced with the overflow sentinel.
    const attrs = attributes! as { a: string; b: string; nested: { c: string } };
    expect(attrs.a).toBe(REDACTED_OVERFLOW);
    expect(attrs.b).toBe(REDACTED_OVERFLOW);
    expect(attrs.nested.c).toBe(REDACTED_OVERFLOW);
  });

  it('scrubAttributes passes undefined through unchanged', () => {
    const { attributes, report } = scrubAttributes(undefined);
    expect(attributes).toBeUndefined();
    expect(report.applied).toEqual([]);
    expect(report.budgetExceeded).toBe(false);
  });
});
