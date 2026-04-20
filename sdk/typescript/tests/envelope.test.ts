import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../src/envelope.js';
import { SDK_NAME, SDK_VERSION } from '../src/constants.js';
import { ULID_REGEX } from '../src/ulid.js';

describe('envelope builder', () => {
  it('produces a shape matching the wire schema', () => {
    const envelope = buildEnvelope({ type: 'page_view', attributes: { path: '/home' } });
    expect(envelope.eventId).toMatch(ULID_REGEX);
    expect(envelope.type).toBe('page_view');
    expect(envelope.capturedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(envelope.sdk.name).toBe(SDK_NAME);
    expect(envelope.sdk.version).toBe(SDK_VERSION);
    expect(envelope.sdk.runtime).toBeDefined();
    expect(envelope.scrubber.version).toContain(SDK_VERSION);
    expect(envelope.scrubber.rulesDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.scrubber.budgetExceeded).toBe(false);
    expect(Array.isArray(envelope.scrubber.applied)).toBe(true);
  });

  it('stamps scrubber fields even when attributes are empty', () => {
    const envelope = buildEnvelope({ type: 'heartbeat' });
    expect(envelope.scrubber).toBeDefined();
    expect(typeof envelope.scrubber.version).toBe('string');
    expect(typeof envelope.scrubber.rulesDigest).toBe('string');
    expect(envelope.scrubber.applied).toEqual([]);
    expect(envelope.scrubber.budgetExceeded).toBe(false);
  });

  it('redacts email in attribute values', () => {
    const envelope = buildEnvelope({
      type: 'signup',
      attributes: { form: { email: 'alice@example.com', note: 'hello' } },
    });
    const attrs = envelope.attributes as { form: { email: string; note: string } };
    expect(attrs.form.email).not.toContain('@example.com');
    expect(attrs.form.note).toBe('hello');
    expect(envelope.scrubber.applied).toContain('regex:email');
  });

  it('redacts Luhn-valid credit-card numbers', () => {
    const envelope = buildEnvelope({
      type: 'checkout',
      attributes: { cc: '4111 1111 1111 1111' }, // valid test card
    });
    const attrs = envelope.attributes as { cc: string };
    expect(attrs.cc).not.toMatch(/4111.*1111/);
    expect(envelope.scrubber.applied).toContain('regex:creditcard');
  });

  it('leaves non-Luhn card-shaped strings alone', () => {
    const envelope = buildEnvelope({
      type: 'test',
      attributes: { num: '1234 5678 9012 3456' }, // not Luhn-valid
    });
    expect((envelope.attributes as { num: string }).num).toBe('1234 5678 9012 3456');
    expect(envelope.scrubber.applied).not.toContain('regex:creditcard');
  });

  it('rejects invalid event types', () => {
    expect(() => buildEnvelope({ type: '' })).toThrow();
    expect(() => buildEnvelope({ type: 'has space' })).toThrow();
    expect(() => buildEnvelope({ type: 'a'.repeat(200) })).toThrow();
  });

  it('accepts an ISO-8601 capturedAt override', () => {
    const envelope = buildEnvelope({ type: 't', capturedAt: '2026-04-20T00:00:00.000Z' });
    expect(envelope.capturedAt).toBe('2026-04-20T00:00:00.000Z');
  });

  it('marks budgetExceeded when the scrub budget is exhausted', () => {
    // A zero-ms budget is guaranteed to trip the overflow path because any
    // function-call overhead advances the clock past the deadline.
    const attrs: Record<string, unknown> = { note: 'hello world' };
    const envelope = buildEnvelope(
      { type: 'big', attributes: attrs },
      { scrubBudgetMs: -1 },
    );
    expect(envelope.scrubber.budgetExceeded).toBe(true);
    expect(envelope.scrubber.applied).toContain('overflow_fallback');
  });
});
