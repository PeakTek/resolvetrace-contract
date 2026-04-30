/**
 * Envelope builder.
 *
 * Takes a user-supplied `EventInput`, runs Stage-1 scrubbing, and returns a
 * fully-formed `EventEnvelope` that matches the published wire schema.
 */

import { SDK_NAME, SDK_VERSION } from './constants.js';
import { detectRuntime } from './runtime.js';
import { scrubAttributes } from './scrubber.js';
import type { ActorIdentity, EventEnvelope, EventInput } from './types.js';
import { generateUlid, isUlid } from './ulid.js';

const EVENT_TYPE_RE = /^[a-zA-Z0-9_.\-:/]+$/;

/**
 * Build an event envelope.
 *
 * Invariants:
 * - A fresh ULID is generated per event via `crypto.getRandomValues()`.
 * - `capturedAt` defaults to the current wall clock in ISO-8601 form.
 * - `scrubber` is always present — it reports the Stage-1 pass even when the
 *   attribute bag is empty.
 */
export function buildEnvelope(
  input: EventInput,
  opts: {
    scrubBudgetMs?: number;
    now?: () => Date;
    actor?: ActorIdentity;
  } = {},
): EventEnvelope {
  if (!input || typeof input !== 'object') {
    throw new TypeError('capture(event) requires an object argument');
  }
  if (typeof input.type !== 'string' || !EVENT_TYPE_RE.test(input.type)) {
    throw new TypeError(
      `Event type "${String(input.type)}" is invalid — must match /^[a-zA-Z0-9_.\\-:/]+$/`,
    );
  }
  if (input.type.length > 128) {
    throw new TypeError('Event type exceeds 128 characters');
  }
  if (input.sessionId !== undefined && !isUlid(input.sessionId)) {
    throw new TypeError('sessionId, if provided, must be a ULID');
  }

  const now = opts.now ? opts.now() : new Date();

  let capturedAt: string;
  if (input.capturedAt === undefined) {
    capturedAt = now.toISOString();
  } else if (input.capturedAt instanceof Date) {
    capturedAt = input.capturedAt.toISOString();
  } else if (typeof input.capturedAt === 'string') {
    // Trust the caller but re-serialize via Date to canonicalize the form.
    const d = new Date(input.capturedAt);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(`capturedAt is not a valid ISO-8601 string: ${input.capturedAt}`);
    }
    capturedAt = d.toISOString();
  } else {
    throw new TypeError('capturedAt must be a Date or ISO-8601 string');
  }

  const scrubbed = scrubAttributes(input.attributes, opts.scrubBudgetMs);

  const envelope: EventEnvelope = {
    eventId: generateUlid(now),
    type: input.type,
    capturedAt,
    scrubber: scrubbed.report,
    sdk: {
      name: SDK_NAME,
      version: SDK_VERSION,
      runtime: detectRuntime(),
    },
  };
  if (input.sessionId) envelope.sessionId = input.sessionId;
  if (scrubbed.attributes !== undefined) envelope.attributes = scrubbed.attributes;
  if (opts.actor !== undefined) envelope.actor = opts.actor;
  return envelope;
}

/**
 * Approximate the JSON-serialized byte size of a value without fully
 * serializing it twice. Currently implemented as a straightforward
 * `JSON.stringify(...).length` in UTF-16 code units; callers that need
 * accurate byte counts should pass the result through a `TextEncoder`.
 */
export function approximateJsonBytes(value: unknown): number {
  const s = JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  return s.length;
}
