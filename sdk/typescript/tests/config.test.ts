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
});
