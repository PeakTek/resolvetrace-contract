import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const OK = {
  apiKey: 'rt_live_test_token',
  endpoint: 'https://ingest.resolvetrace.com',
};

describe('resolveConfig', () => {
  it('accepts the happy path', () => {
    const cfg = resolveConfig(OK);
    expect(cfg.apiKey).toBe(OK.apiKey);
    expect(cfg.endpoint).toBe(OK.endpoint);
    expect(cfg.debug).toBe(false);
  });

  it('rejects missing apiKey', () => {
    expect(() => resolveConfig({ endpoint: OK.endpoint })).toThrow(ConfigError);
  });

  it('rejects empty apiKey', () => {
    expect(() => resolveConfig({ apiKey: '', endpoint: OK.endpoint })).toThrow(ConfigError);
  });

  it('rejects apiKey > 4 KiB', () => {
    const big = 'a'.repeat(5000);
    expect(() => resolveConfig({ apiKey: big, endpoint: OK.endpoint })).toThrow(/exceeds/);
  });

  it('rejects missing endpoint', () => {
    expect(() => resolveConfig({ apiKey: OK.apiKey })).toThrow(ConfigError);
  });

  it('rejects http:// against non-loopback hosts', () => {
    expect(() =>
      resolveConfig({ apiKey: OK.apiKey, endpoint: 'http://evil.example.com' }),
    ).toThrow(/https/);
  });

  it('permits http:// for localhost / 127.0.0.1 / *.local', () => {
    for (const endpoint of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://resolvetrace.local',
    ]) {
      expect(() => resolveConfig({ apiKey: OK.apiKey, endpoint })).not.toThrow();
    }
  });

  it('rejects unknown / forbidden option keys', () => {
    const forbidden = ['tenantId', 'environment', 'region', 'featureFlags', 'authStrategy'];
    for (const key of forbidden) {
      expect(() =>
        resolveConfig({ ...OK, [key]: 'nope' }),
      ).toThrow(ConfigError);
    }
  });

  it('accepts local-only hooks', () => {
    const cfg = resolveConfig({
      ...OK,
      onError: () => {},
      beforeSend: (env) => env,
      debug: true,
      maskSelectors: ['.credit-card'],
    });
    expect(cfg.debug).toBe(true);
    expect(cfg.maskSelectors).toEqual(['.credit-card']);
  });

  it('clamps beforeSendTimeoutMs to the 4 ms envelope', () => {
    const cfg = resolveConfig({ ...OK, beforeSendTimeoutMs: 50 });
    expect(cfg.beforeSendTimeoutMs).toBeLessThanOrEqual(4);
  });

  it('rejects non-function beforeSend', () => {
    expect(() =>
      resolveConfig({ ...OK, beforeSend: 'not a function' as unknown as () => void }),
    ).toThrow(ConfigError);
  });

  it('rejects malformed maskSelectors', () => {
    expect(() =>
      resolveConfig({ ...OK, maskSelectors: [''] as unknown as string[] }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ ...OK, maskSelectors: 'not-an-array' as unknown as string[] }),
    ).toThrow(ConfigError);
  });

  // --- autoCapture --------------------------------------------------------
  describe('autoCapture', () => {
    it('defaults everything on with documented defaults', () => {
      const cfg = resolveConfig(OK);
      expect(cfg.autoCapture).toEqual({
        enabled: true,
        rageClick: true,
        deadClick: true,
        repeatedSubmit: true,
        errorJs: true,
        errorApi: true,
        apiLatency: true,
        errorResource: true,
        longTask: true,
        rageClickThreshold: 3,
        rageClickWindowMs: 1000,
        deadClickWindowMs: 2500,
        repeatedSubmitThreshold: 2,
        repeatedSubmitWindowMs: 3000,
        errorStatusThreshold: 400,
        maxEventsPerSession: 200,
      });
    });

    it('accepts a boolean master switch', () => {
      expect(resolveConfig({ ...OK, autoCapture: false }).autoCapture.enabled).toBe(false);
      expect(resolveConfig({ ...OK, autoCapture: true }).autoCapture.enabled).toBe(true);
    });

    it('accepts per-signal opt-out + tunables', () => {
      const cfg = resolveConfig({
        ...OK,
        autoCapture: {
          rageClick: false,
          rageClickThreshold: 5,
          maxEventsPerSession: 10,
        },
      });
      expect(cfg.autoCapture.rageClick).toBe(false);
      expect(cfg.autoCapture.deadClick).toBe(true);
      expect(cfg.autoCapture.rageClickThreshold).toBe(5);
      expect(cfg.autoCapture.maxEventsPerSession).toBe(10);
    });

    it('rejects unknown autoCapture keys', () => {
      expect(() =>
        resolveConfig({ ...OK, autoCapture: { bogus: true } as unknown as object }),
      ).toThrow(ConfigError);
    });

    it('rejects non-positive / non-integer tunables', () => {
      expect(() =>
        resolveConfig({ ...OK, autoCapture: { rageClickThreshold: 0 } }),
      ).toThrow(ConfigError);
      expect(() =>
        resolveConfig({ ...OK, autoCapture: { rageClickWindowMs: -5 } }),
      ).toThrow(ConfigError);
      expect(() =>
        resolveConfig({ ...OK, autoCapture: { maxEventsPerSession: 1.5 } }),
      ).toThrow(ConfigError);
    });

    it('rejects non-boolean per-signal flags', () => {
      expect(() =>
        resolveConfig({
          ...OK,
          autoCapture: { deadClick: 'yes' as unknown as boolean },
        }),
      ).toThrow(ConfigError);
    });
  });
});
