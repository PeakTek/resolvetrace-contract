/**
 * Replay signed-URL flow: request a presigned URL, PUT a tiny payload to it,
 * then finalize the manifest.
 *
 * The case is deliberately small — a few bytes of placeholder rrweb — so
 * the harness is fast and can run against deployments with tight quotas.
 */

import crypto from 'node:crypto';

import { postJson } from '../http.ts';
import { generateUlid } from '../ulid.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

interface SignedUrlResponse {
  uploadUrl?: string;
  key?: string;
  expiresAt?: string;
  maxBytes?: number;
  requiredHeaders?: Record<string, string>;
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult> {
  const started = performance.now();
  if (config.skipNetwork) {
    return {
      id: 'replay.signed-url-flow',
      description: 'Signed-URL issuance + upload + manifest completion succeeds',
      status: 'skip',
      durationMs: 0,
      message: '--skip-network set',
    };
  }

  try {
    const sessionId = generateUlid();
    const sequence = 0;
    const chunkBody = Buffer.from('conformance-placeholder-rrweb', 'utf-8');
    const approxBytes = chunkBody.byteLength;

    const signed = await postJson({
      endpoint: config.endpoint,
      path: '/v1/replay/signed-url',
      apiKey: config.apiKey,
      body: {
        sessionId,
        sequence,
        approxBytes,
        contentType: 'application/vnd.resolvetrace.replay+rrweb',
      },
    });
    if (signed.status < 200 || signed.status >= 300) {
      return {
        id: 'replay.signed-url-flow',
        description: 'Signed-URL issuance + upload + manifest completion succeeds',
        status: 'fail',
        durationMs: performance.now() - started,
        message: `/v1/replay/signed-url returned ${signed.status}`,
        details: { body: signed.bodyJson ?? signed.bodyText.slice(0, 256) },
      };
    }
    const signedBody = signed.bodyJson as SignedUrlResponse;
    if (!signedBody.uploadUrl || !signedBody.key) {
      return {
        id: 'replay.signed-url-flow',
        description: 'Signed-URL issuance + upload + manifest completion succeeds',
        status: 'fail',
        durationMs: performance.now() - started,
        message: 'response missing uploadUrl or key',
        details: { body: signed.bodyJson },
      };
    }

    const uploadHeaders: Record<string, string> = {
      'Content-Type': 'application/vnd.resolvetrace.replay+rrweb',
    };
    for (const [k, v] of Object.entries(signedBody.requiredHeaders ?? {})) {
      uploadHeaders[k] = v;
    }
    const uploadResponse = await fetch(signedBody.uploadUrl, {
      method: 'PUT',
      headers: uploadHeaders,
      body: chunkBody,
    });
    if (uploadResponse.status >= 300) {
      return {
        id: 'replay.signed-url-flow',
        description: 'Signed-URL issuance + upload + manifest completion succeeds',
        status: 'fail',
        durationMs: performance.now() - started,
        message: `presigned PUT returned ${uploadResponse.status}`,
      };
    }

    const sha256 = crypto.createHash('sha256').update(chunkBody).digest('hex');
    const manifestBody = {
      sessionId,
      sequence,
      key: signedBody.key,
      bytes: chunkBody.byteLength,
      sha256,
      clientUploadedAt: new Date().toISOString(),
      scrubber: {
        version: 'conformance@0.1.0',
        rulesDigest:
          'sha256:bd7872828dbfd9970006fbea22c24a137b27c48fb1d6dd635a88d4d09c0b28ec',
        applied: [],
        budgetExceeded: false,
      },
    };
    const manifest = await postJson({
      endpoint: config.endpoint,
      path: '/v1/replay/complete',
      apiKey: config.apiKey,
      body: manifestBody,
    });
    const durationMs = performance.now() - started;
    if (manifest.status >= 200 && manifest.status < 300) {
      return {
        id: 'replay.signed-url-flow',
        description: 'Signed-URL issuance + upload + manifest completion succeeds',
        status: 'pass',
        durationMs,
        details: {
          signedUrlStatus: signed.status,
          uploadStatus: uploadResponse.status,
          manifestStatus: manifest.status,
          uploadUrl: redactUploadUrl(signedBody.uploadUrl),
        },
      };
    }
    return {
      id: 'replay.signed-url-flow',
      description: 'Signed-URL issuance + upload + manifest completion succeeds',
      status: 'fail',
      durationMs,
      message: `/v1/replay/complete returned ${manifest.status}`,
      details: { body: manifest.bodyJson ?? manifest.bodyText.slice(0, 256) },
    };
  } catch (err) {
    return {
      id: 'replay.signed-url-flow',
      description: 'Signed-URL issuance + upload + manifest completion succeeds',
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Avoid logging signed query strings (they include short-lived credentials). */
function redactUploadUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}?[REDACTED_SIGNED_PARAMS]`;
  } catch {
    return '[unparseable-url]';
  }
}

export const replayCase: CaseDefinition = {
  id: 'replay.signed-url-flow',
  description: 'Signed-URL issuance + upload + manifest completion succeeds',
  run,
};

/**
 * Clip-capability enforcement: the server must enforce the replay clip
 * capability it advertises on session-start.
 *
 *   - A server that advertises `replay.clips = "single"` (or omits it — the
 *     baseline) MUST reject a `clipIndex > 0` upload request with
 *     `403 multi_clip_not_permitted`. Recording is a single clip per session.
 *   - A server that advertises `replay.clips = "multi"` MUST NOT reject a
 *     `clipIndex > 0` as unpermitted (it granted the capability).
 *
 * Capability-aware so the case is correct against any conformant deployment,
 * single- or multi-clip. `clipIndex` is optional in the request schema, so a
 * server predating it would reject with a schema 400 (not the policy 403) — that
 * surfaces as a clear failure naming the mismatch.
 */
async function runClipCapability(
  config: ResolvedConformanceConfig,
): Promise<CaseResult> {
  const id = 'replay.clip-capability';
  const description =
    'The server enforces the replay clip capability it advertises (single rejects clipIndex > 0)';
  const started = performance.now();
  if (config.skipNetwork) {
    return { id, description, status: 'skip', durationMs: 0, message: '--skip-network set' };
  }

  try {
    const sessionId = generateUlid();

    // 1) Learn the advertised capability from the session-start response.
    const start = await postJson({
      endpoint: config.endpoint,
      path: '/v1/session/start',
      apiKey: config.apiKey,
      body: { sessionId, startedAt: new Date().toISOString() },
    });
    if (start.status < 200 || start.status >= 300) {
      return {
        id,
        description,
        status: 'fail',
        durationMs: performance.now() - started,
        message: `/v1/session/start returned ${start.status}`,
        details: { body: start.bodyJson ?? start.bodyText.slice(0, 256) },
      };
    }
    const advertised =
      (start.bodyJson as { replay?: { clips?: string } })?.replay?.clips ?? 'single';

    // 2) Attempt a second-clip upload request (clipIndex > 0).
    const res = await postJson({
      endpoint: config.endpoint,
      path: '/v1/replay/signed-url',
      apiKey: config.apiKey,
      body: {
        sessionId,
        sequence: 1,
        approxBytes: 32,
        contentType: 'application/vnd.resolvetrace.replay+rrweb',
        clipIndex: 1,
      },
    });
    const durationMs = performance.now() - started;
    const body = (res.bodyJson ?? {}) as { error?: string };
    const rejectedAsUnpermitted =
      res.status === 403 && body.error === 'multi_clip_not_permitted';

    if (advertised === 'multi') {
      if (rejectedAsUnpermitted) {
        return {
          id,
          description,
          status: 'fail',
          durationMs,
          message:
            'server advertised replay.clips = multi but rejected clipIndex > 0 as multi_clip_not_permitted',
          details: { advertised, secondClipStatus: res.status },
        };
      }
      return { id, description, status: 'pass', durationMs, details: { advertised, secondClipStatus: res.status } };
    }

    // single (or unadvertised): clipIndex > 0 must be rejected.
    if (rejectedAsUnpermitted) {
      return { id, description, status: 'pass', durationMs, details: { advertised, secondClipStatus: res.status } };
    }
    return {
      id,
      description,
      status: 'fail',
      durationMs,
      message: `server advertised replay.clips = ${advertised} but did not reject clipIndex > 0 with 403 multi_clip_not_permitted (got ${res.status}${body.error ? ` ${body.error}` : ''})`,
      details: { body: res.bodyJson ?? res.bodyText.slice(0, 256) },
    };
  } catch (err) {
    return {
      id,
      description,
      status: 'fail',
      durationMs: performance.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const replayClipCapabilityCase: CaseDefinition = {
  id: 'replay.clip-capability',
  description:
    'The server enforces the replay clip capability it advertises (single rejects clipIndex > 0)',
  run: runClipCapability,
};
