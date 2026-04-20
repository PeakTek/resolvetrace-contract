/**
 * Minimal envelope builder for cases that need to POST a hand-crafted event
 * rather than going through the SDK.
 *
 * The shape must line up with `schemas/events.json#/definitions/EventEnvelope`.
 */

import { generateUlid } from './ulid.ts';

export interface MinimalEventOptions {
  type?: string;
  eventId?: string;
  attributes?: Record<string, unknown>;
  rulesDigest?: string;
}

export interface MinimalEnvelope {
  eventId: string;
  type: string;
  capturedAt: string;
  scrubber: {
    version: string;
    rulesDigest: string;
    applied: string[];
    budgetExceeded: boolean;
  };
  attributes?: Record<string, unknown>;
  sdk: { name: string; version: string };
}

export function buildMinimalEnvelope(opts: MinimalEventOptions = {}): MinimalEnvelope {
  const envelope: MinimalEnvelope = {
    eventId: opts.eventId ?? generateUlid(),
    type: opts.type ?? 'conformance.smoke',
    capturedAt: new Date().toISOString(),
    scrubber: {
      version: 'conformance@0.1.0',
      rulesDigest:
        opts.rulesDigest ??
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      applied: [],
      budgetExceeded: false,
    },
    sdk: { name: '@peaktek/resolvetrace-conformance', version: '0.1.0' },
  };
  if (opts.attributes) envelope.attributes = opts.attributes;
  return envelope;
}
