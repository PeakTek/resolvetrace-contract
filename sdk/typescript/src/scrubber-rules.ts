/**
 * Embedded copy of `schemas/scrubber-rules.matrix.json`.
 *
 * This module is the sole build-time place where the matrix lives on the TS
 * side. The JSON file under `schemas/` is the contract-repo source of truth;
 * the digest-parity test loads that file at test time and asserts its hash
 * matches the committed `RULES_DIGEST` constant here. Keeping the object
 * inline (rather than importing the JSON) sidesteps ESM JSON-import quirks
 * and lets the tree-shaker drop this constant from bundles that do not ship
 * the scrubber.
 */

/** Rule-kind discriminator. */
export type RuleKind = 'attribute' | 'user-configured-selector' | 'regex';

/** Shape of a single rule in the matrix. */
export interface RuleDefinition {
  id: string;
  kind: RuleKind;
  /** Attribute name — present on `kind === 'attribute'` rules that target an attribute. */
  attribute?: string;
  /** CSS selector — present on `kind === 'attribute'` rules that target a selector. */
  selector?: string;
  /** Regex source text — present on `kind === 'regex'` rules. */
  pattern?: string;
  /** Regex flags in the ECMAScript dialect — present on `kind === 'regex'` rules. */
  flags?: string;
  /** Optional post-match validation hook (e.g. Luhn). */
  postCheck?: 'luhn' | 'luhn-sin';
}

/** Top-level matrix shape. */
export interface RulesMatrix {
  version: string;
  notes: string;
  redactionTokenTemplate: string;
  overflowToken: string;
  rules: RuleDefinition[];
}

/**
 * Canonical Stage-1 rule matrix — byte-identical to
 * `schemas/scrubber-rules.matrix.json` up to key ordering. The digest-parity
 * test loads the JSON from disk, re-canonicalizes, and verifies this.
 */
export const RULES_MATRIX: RulesMatrix = {
  version: '1.0.0',
  notes:
    'Stage-1 deterministic scrubber ruleset. Patterns are shared between ' +
    'TypeScript (ECMAScript dialect) and Python (re dialect); we prefer ' +
    'portable anchors (\\b, \\d, character classes) and avoid lookbehind / ' +
    'lookahead so both engines compile identical regex semantics. Known ' +
    'trade-offs: regex:email uses a simplified RFC-5322 subset and may ' +
    'miss quoted local-parts; regex:phone-e164 requires the literal + ' +
    'prefix (no country code means no match); regex:sin-ca requires a ' +
    'post-check SIN Luhn pass (weights 1,2,1,2,1,2,1,2,1); regex:creditcard ' +
    'requires a post-check standard Luhn pass. Rule execution order is ' +
    'defined by the array order and MUST be preserved; attribute / ' +
    'selector rules run before regex rules. Changing a rule id, pattern, ' +
    'flags, or order is a breaking change that bumps rulesDigest.',
  redactionTokenTemplate: '[REDACTED:{rule}]',
  overflowToken: '[REDACTED_OVERFLOW]',
  rules: [
    { id: 'attr:password-input', kind: 'attribute', selector: 'input[type="password"]' },
    { id: 'attr:data-rt-mask', kind: 'attribute', attribute: 'data-rt-mask' },
    { id: 'attr:data-private', kind: 'attribute', attribute: 'data-private' },
    { id: 'selector:user-configured', kind: 'user-configured-selector' },
    {
      id: 'regex:email',
      kind: 'regex',
      pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      flags: 'gi',
    },
    { id: 'regex:ssn-us', kind: 'regex', pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', flags: 'g' },
    {
      id: 'regex:sin-ca',
      kind: 'regex',
      pattern: '\\b\\d{3}[- ]?\\d{3}[- ]?\\d{3}\\b',
      flags: 'g',
      postCheck: 'luhn-sin',
    },
    {
      id: 'regex:creditcard',
      kind: 'regex',
      pattern: '\\b(?:\\d[ -]?){12,18}\\d\\b',
      flags: 'g',
      postCheck: 'luhn',
    },
    { id: 'regex:phone-e164', kind: 'regex', pattern: '\\+\\d{8,15}', flags: 'g' },
  ],
};

/**
 * Canonical JSON serialization of the matrix used for digest computation.
 * Keys sorted alphabetically, no insignificant whitespace. Matches
 * `JSON.stringify` with key-sorted replacer semantics and
 * `json.dumps(m, sort_keys=True, separators=(",", ":"))` on the Python side.
 */
export function canonicalizeMatrix(matrix: RulesMatrix): string {
  return stableStringify(matrix);
}

/**
 * Pre-computed digest for the shipped `RULES_MATRIX`, matching the content
 * of `schemas/scrubber-rules.digest.txt`. The SDK stamps this on every
 * envelope — callers must never mutate `RULES_MATRIX` without regenerating
 * this value (the digest-parity test fails loud when they drift).
 */
export const RULES_DIGEST =
  'sha256:bd7872828dbfd9970006fbea22c24a137b27c48fb1d6dd635a88d4d09c0b28ec';

/**
 * Compute the digest from a matrix at runtime. Used by the digest-parity
 * test; not on the envelope hot path. Resolves to the same `sha256:<hex>`
 * string format stamped in `RULES_DIGEST`.
 */
export async function computeRulesDigest(matrix: RulesMatrix): Promise<string> {
  const canon = canonicalizeMatrix(matrix);
  const bytes = new TextEncoder().encode(canon);
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'computeRulesDigest: Web Crypto subtle API is not available in this runtime',
    );
  }
  const buf = await subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

// ---------------------------------------------------------------------------
// Stable JSON stringify (key-sorted, no-whitespace) — hand-rolled to keep the
// zero-dep guarantee. Output matches Python's
// `json.dumps(..., sort_keys=True, separators=(",", ":"))` for the subset of
// JSON values we actually emit (no floats, no NaN/Infinity, no undefined).
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('stableStringify: non-finite numbers are not JSON-representable');
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      parts[i] = JSON.stringify(key) + ':' + stableStringify(obj[key]);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`stableStringify: unsupported value of type ${typeof value}`);
}
