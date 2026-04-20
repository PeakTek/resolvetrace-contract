/**
 * Runtime detection helpers.
 *
 * Kept in one place so transport / queue / ULID modules all agree on what
 * environment they are running in.
 */

/** True when `window` and `document` look browser-like. */
export function isBrowser(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { document?: unknown }).document !== 'undefined'
  );
}

/** Free-form runtime identifier suitable for `envelope.sdk.runtime`. */
export function detectRuntime(): string {
  if (isBrowser()) return 'browser';
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  const node = proc?.versions?.node;
  if (node) return `node-${node.split('.')[0] ?? 'unknown'}`;
  return 'unknown';
}

/** Access the global `crypto` object in a way that works in Node 18+ and browsers. */
export function getCrypto(): Crypto | undefined {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') return c;
  return undefined;
}

/** A monotonically-increasing high-resolution timestamp (ms). */
export function nowMs(): number {
  const perf = (globalThis as { performance?: { now: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
