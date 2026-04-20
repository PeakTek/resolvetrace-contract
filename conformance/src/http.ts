/**
 * Thin wrapper around `fetch` that adds consistent Authorization handling,
 * `Cache-Control: no-store`, and structured error capture.
 *
 * The conformance harness deliberately does NOT use the SDK's batching
 * transport for non-SDK cases — we want to drive exact request shapes so we
 * can assert the server's raw behaviour (e.g. "returns 400 on bad fixture").
 */

export interface IngestResponse {
  status: number;
  headers: Headers;
  bodyText: string;
  bodyJson: unknown | undefined;
}

export interface PostOptions {
  endpoint: string;
  path: string;
  apiKey: string;
  body: unknown;
  extraHeaders?: Record<string, string>;
  /** Fetch implementation override (tests only). */
  fetchImpl?: typeof fetch;
}

export async function postJson(opts: PostOptions): Promise<IngestResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = joinUrl(opts.endpoint, opts.path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(opts.extraHeaders ?? {}),
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
  const bodyText = await res.text();
  let bodyJson: unknown | undefined;
  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    bodyJson = undefined;
  }
  return { status: res.status, headers: res.headers, bodyText, bodyJson };
}

export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * Redact the Authorization header value for diagnostic output.
 * Mirrors the convention from the ResolveTrace SDK: `Bearer [REDACTED:<prefix>]`.
 */
export function redactBearer(apiKey: string): string {
  const prefix = apiKey.slice(0, 4);
  return `Bearer [REDACTED:${prefix}]`;
}
