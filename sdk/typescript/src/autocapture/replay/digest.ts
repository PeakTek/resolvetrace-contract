/**
 * SHA-256 helpers for replay chunks.
 *
 * Browsers and Node 18+ both expose the Web Crypto `subtle` API on
 * `globalThis.crypto`, so the primary path is dependency-free. A Node
 * `node:crypto` fallback is kept for runtimes where `subtle` is unavailable.
 */

/** Lower-case hex of a byte buffer. */
function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Compute the lower-case hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;
  if (subtle) {
    // Copy into a standalone ArrayBuffer-backed view so `subtle.digest` gets a
    // clean `BufferSource` (avoids SharedArrayBuffer typing on `bytes.buffer`).
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const hash = await subtle.digest('SHA-256', copy);
    return toHex(hash);
  }
  // Node fallback — resolved lazily so the browser build never references it.
  const req = (globalThis as { require?: NodeRequire }).require;
  if (typeof req === 'function') {
    const nodeCrypto = req('node:crypto') as {
      createHash(alg: string): {
        update(d: Uint8Array): { digest(enc: string): string };
      };
    };
    return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  }
  throw new Error('No SHA-256 implementation available in this runtime.');
}

/** Compute a `sha256:<hex>` digest of a UTF-8 string (for config digests). */
export async function sha256PrefixedOfString(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hex = await sha256Hex(bytes);
  return `sha256:${hex}`;
}
