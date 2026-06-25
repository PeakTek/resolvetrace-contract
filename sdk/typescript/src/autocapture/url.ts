/**
 * Privacy-safe URL scrubbing for network breadcrumbs.
 *
 * doc-18 `never_collect_raw` lists `full_query_string_values` among the things
 * the SDK must never serialize. Network breadcrumbs (`perf.api_latency` /
 * `error.api`) need *a* URL to be useful for triage, but the raw query string
 * routinely carries tokens, emails, and identifiers. So we keep the structural
 * signal — origin + path + the *names* of query parameters — and redact every
 * query *value* before the string ever reaches the event pipeline.
 *
 * Two rules:
 *   1. NEVER emit a raw query value. Each `?k=v` becomes `?k=[redacted]`. The
 *      parameter *name* is structural (which endpoint/shape) and is kept; the
 *      value is content and is dropped.
 *   2. The whole scrubbed string is still routed through the Stage-1 scrubber
 *      by the caller, so anything PII-shaped that slipped into a path segment or
 *      a parameter *name* is additionally redacted — no new bypass path.
 *
 * The fragment (`#…`) is dropped entirely: it is client-only state, never sent
 * to the server, and frequently carries free text.
 */

/** Token substituted for every redacted query-parameter value. */
export const REDACTED_QUERY_VALUE = '[redacted]';

/** Defense-in-depth cap on the produced descriptor length. */
const MAX_URL_LEN = 512;

/**
 * Resolve a raw request URL (which may be relative) against a base, returning a
 * `URL` or `null` if it cannot be parsed. Best-effort and never throws.
 */
function tryParseUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    /* fall through to base-relative parse */
  }
  if (base) {
    try {
      return new URL(raw, base);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Produce a privacy-safe URL string: `origin + path` with every query-parameter
 * *value* replaced by `[redacted]` and the fragment removed. Parameter *names*
 * are retained (structural). If the input cannot be parsed as a URL, the
 * portion before the first `?` is returned (path-only) so we still emit
 * something useful without leaking a raw query string.
 *
 * The returned string is intended to be passed through the Stage-1 scrubber by
 * the caller (via `capture()`), so no raw value can survive even if it landed in
 * a path segment or a parameter name.
 */
export function scrubUrl(raw: unknown, base?: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';

  const parsed = tryParseUrl(raw, base);
  if (!parsed) {
    // Could not parse — keep only the part before any query string so we never
    // emit raw `?…` values.
    const q = raw.indexOf('?');
    const pathOnly = q >= 0 ? raw.slice(0, q) : raw;
    return pathOnly.slice(0, MAX_URL_LEN);
  }

  // Redact every query value, keeping parameter names.
  let query = '';
  try {
    const keys: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      keys.push(key);
    });
    if (keys.length > 0) {
      query =
        '?' + keys.map((k) => `${k}=${REDACTED_QUERY_VALUE}`).join('&');
    }
  } catch {
    query = '';
  }

  const origin =
    parsed.origin && parsed.origin !== 'null' ? parsed.origin : '';
  const out = `${origin}${parsed.pathname}${query}`;
  return out.slice(0, MAX_URL_LEN);
}

/**
 * Extract the request URL string from the polymorphic first argument to
 * `fetch` (a string, a `URL`, or a `Request`). Never throws.
 */
export function urlFromFetchInput(input: unknown): string {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    const reqUrl = (input as { url?: unknown } | null)?.url;
    if (typeof reqUrl === 'string') return reqUrl;
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Extract the HTTP method from a `fetch` call, defaulting to GET. Looks at the
 * `init.method` first, then a `Request`-shaped input's `method`. Never throws.
 */
export function methodFromFetchArgs(input: unknown, init: unknown): string {
  try {
    const fromInit = (init as { method?: unknown } | null)?.method;
    if (typeof fromInit === 'string' && fromInit.length > 0) {
      return fromInit.toUpperCase();
    }
    const fromReq = (input as { method?: unknown } | null)?.method;
    if (typeof fromReq === 'string' && fromReq.length > 0) {
      return fromReq.toUpperCase();
    }
  } catch {
    /* ignore */
  }
  return 'GET';
}
