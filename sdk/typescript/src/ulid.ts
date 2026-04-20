/**
 * ULID (Crockford base32, 26 chars) generator — cryptographically random.
 *
 * Format: 48-bit timestamp (ms since epoch) || 80-bit randomness, encoded as
 * 26 Crockford base32 characters. Alphabet excludes I, L, O, U.
 *
 * This module is deliberately dependency-free and works in Node 18+, modern
 * browsers, and edge runtimes. `Math.random()` is never used — all randomness
 * comes from `crypto.getRandomValues()`. A Node `crypto.randomBytes()` fallback
 * is kept for older embedded runtimes that lack `globalThis.crypto`.
 */

import { getCrypto } from './runtime.js';

/**
 * Crockford base32 alphabet — digits 0-9 followed by uppercase letters with
 * I, L, O, U removed. Order is canonical.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Regex a valid ULID string must match. */
export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Returns the 48-bit timestamp component as a 10-char Crockford base32 string.
 * Exported for testability.
 */
export function encodeTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError('ULID timestamp must be a non-negative finite number');
  }
  if (ms > 0xffffffffffff) {
    // 2^48 - 1. The ULID spec caps here.
    throw new RangeError('ULID timestamp exceeds 48 bits');
  }
  let remainder = Math.floor(ms);
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    const mod = remainder % 32;
    out[i] = CROCKFORD_ALPHABET[mod]!;
    remainder = (remainder - mod) / 32;
  }
  return out.join('');
}

/**
 * Encodes 10 random bytes as 16 Crockford base32 characters.
 * Uses a straightforward bit-reader — no external dependency.
 */
function encodeRandomness(bytes: Uint8Array): string {
  if (bytes.length !== 10) {
    throw new RangeError('ULID randomness must be exactly 10 bytes');
  }
  // 80 bits / 5 bits per char = 16 chars.
  let out = '';
  let bitBuffer = 0;
  let bitCount = 0;
  for (let i = 0; i < 10; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i]!;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const index = (bitBuffer >>> bitCount) & 0x1f;
      out += CROCKFORD_ALPHABET[index]!;
      // Clear consumed bits by masking. JS bitwise ops are 32-bit, which is
      // safe here because we never buffer more than 12 bits at a time (8 + 4).
      bitBuffer &= (1 << bitCount) - 1;
    }
  }
  return out;
}

/** Fill `out` with cryptographically strong bytes. Throws when no CSPRNG is available. */
function fillRandomBytes(out: Uint8Array): void {
  const c = getCrypto();
  if (c) {
    c.getRandomValues(out);
    return;
  }
  // Deferred Node fallback — avoids a hard dep on 'node:crypto' in browsers.
  // Using `require` is intentional: it resolves at runtime under Node and is
  // simply absent in the browser build (tree-shaken or unreached).
  const req = (globalThis as { require?: NodeRequire }).require;
  if (typeof req === 'function') {
    try {
      const nodeCrypto = req('node:crypto') as { randomFillSync(buf: Uint8Array): Uint8Array };
      nodeCrypto.randomFillSync(out);
      return;
    } catch {
      // fallthrough to error
    }
  }
  throw new Error(
    'No cryptographically secure RNG available in this environment; refusing to generate a ULID with Math.random.',
  );
}

/** Generate a 26-char Crockford base32 ULID. `now` is injectable for tests. */
export function generateUlid(now: Date = new Date()): string {
  const ts = encodeTimestamp(now.getTime());
  const rand = new Uint8Array(10);
  fillRandomBytes(rand);
  const randStr = encodeRandomness(rand);
  return ts + randStr;
}

/** Returns true iff `s` is a syntactically valid ULID string. */
export function isUlid(s: string): boolean {
  return typeof s === 'string' && ULID_REGEX.test(s);
}
