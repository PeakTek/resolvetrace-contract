/**
 * Small ULID generator, duplicated from the TS SDK so the conformance
 * harness can build raw envelopes without reaching into SDK internals.
 *
 * Crockford base32, 26 chars, 48 bits timestamp + 80 bits randomness.
 * The format matches `^[0-9A-HJKMNP-TV-Z]{26}$` per `schemas/events.json`.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateUlid(now: Date = new Date()): string {
  const ms = now.getTime();
  const timePart = encodeTime(ms);
  const randPart = encodeRandom(10);
  return timePart + randPart;
}

function encodeTime(ms: number): string {
  let value = ms;
  const out: string[] = [];
  for (let i = 9; i >= 0; i--) {
    const mod = value % 32;
    out[i] = CROCKFORD[mod]!;
    value = Math.floor(value / 32);
  }
  return out.join('');
}

function encodeRandom(bytes: number): string {
  const out: string[] = [];
  for (let i = 0; i < bytes + 6; i++) {
    out.push(CROCKFORD[Math.floor(Math.random() * 32)]!);
  }
  // bytes=10 -> output is 16 chars, matching ULID random part
  return out.slice(0, 16).join('');
}
