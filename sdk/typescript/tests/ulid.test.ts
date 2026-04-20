import { describe, it, expect } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  ULID_REGEX,
  encodeTimestamp,
  generateUlid,
  isUlid,
} from '../src/ulid.js';

describe('ULID', () => {
  it('alphabet excludes I, L, O, U', () => {
    for (const forbidden of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_ALPHABET).not.toContain(forbidden);
    }
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
  });

  it('generates 26-char Crockford strings', () => {
    for (let i = 0; i < 20; i++) {
      const ulid = generateUlid();
      expect(ulid).toHaveLength(26);
      expect(ULID_REGEX.test(ulid)).toBe(true);
      for (const ch of ulid) expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it('timestamp component reflects supplied Date', () => {
    const fixed = new Date('2026-04-20T12:00:00.000Z');
    const expected = encodeTimestamp(fixed.getTime());
    const ulid = generateUlid(fixed);
    expect(ulid.slice(0, 10)).toBe(expected);
  });

  it('is unique over 10 000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generateUlid());
    }
    expect(seen.size).toBe(10_000);
  });

  it('isUlid rejects strings with I, L, O, U', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    // Replace a valid char with O (forbidden).
    expect(isUlid('O1ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isUlid('01IRZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isUlid('too short')).toBe(false);
    expect(isUlid(12345 as unknown as string)).toBe(false);
  });

  it('rejects negative or out-of-range timestamps', () => {
    expect(() => encodeTimestamp(-1)).toThrow(RangeError);
    expect(() => encodeTimestamp(2 ** 48)).toThrow(RangeError);
  });

  it('ULIDs generated in sequence for the same ms sort lexicographically at the prefix', () => {
    const fixed = new Date('2026-04-20T00:00:00.000Z');
    const a = generateUlid(fixed);
    const b = generateUlid(fixed);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });
});
