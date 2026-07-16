/**
 * SDK-side replay policy + masking configuration.
 *
 * Replay capture (rrweb) is the richest auto-capture signal, so it is gated by
 * an explicit, multi-layer policy that is **off by default** and **masks on by
 * default** (a hard default, never an allow-list). The layers are, in order:
 *
 *   1. browser-only          — no-op outside a browser runtime;
 *   2. `enabled`             — master switch (default false);
 *   3. diagnostics-level     — only `standard` / `assisted_support` by default;
 *   4. route deny-list       — never record while on a denied route;
 *   5. per-session sampling  — `sampleRate` fraction of eligible sessions.
 *
 * Tenant settings are the eventual source of truth (Wave-24 A2 surfaces them).
 * For now the SDK accepts a policy via `autoCapture.replay` config; a documented
 * hook (`policyProvider`, see `RecorderDeps`) lets a later wave fetch tenant
 * settings and override this resolved default at start time without a code
 * change here.
 */

import {
  DEFAULT_REPLAY_SAMPLE_RATE,
  REPLAY_ALLOWED_DIAGNOSTICS_LEVELS,
} from '../../constants.js';
import { ConfigError } from '../../errors.js';
import type { DiagnosticsLevel, ReplayMode } from '../../types.js';

/**
 * The rrweb masking configuration. Input + attribute masking are **hard
 * defaults** a host can never disable, so anything a user types is always
 * redacted. The one relaxable layer is STATIC text (labels/headings): via
 * `maskAllText` a host may switch from "mask every text node" (default) to
 * "mask only tagged text". Block/text selectors are otherwise additive only.
 */
export interface ReplayMaskingConfig {
  /** rrweb `maskAllInputs`. Forced `true`. */
  readonly maskAllInputs: true;
  /** rrweb `maskTextSelector`. `'*'` (mask all text) unless `maskAllText:false`. */
  readonly maskTextSelector: string;
  /** rrweb `maskInputOptions` — every input type masked. */
  readonly maskInputOptions: Readonly<Record<string, true>>;
  /** rrweb `blockSelector`. Elements matching are fully blocked from capture. */
  readonly blockSelector: string;
  /** rrweb `recordCanvas`. Forced `false` (canvas may hold raw pixels). */
  readonly recordCanvas: false;
  /** rrweb `collectFonts`. Forced `false`. */
  readonly collectFonts: false;
}

/** Fully-resolved, validated replay policy (browser-only). */
export interface ResolvedReplayConfig {
  /**
   * Trigger model: `'auto'` (default, session-driven) / `'off'` (never) /
   * `'manual'` (only between `replay.start()` / `replay.stop()`) / `'review'`
   * (like `'manual'`, but buffered locally and uploaded only on `submit()`).
   * Independent of `enabled`, which remains the master gate.
   */
  readonly mode: ReplayMode;
  /** Master switch. Default `false` (replay is opt-in / tenant-gated). */
  readonly enabled: boolean;
  /** Fraction of eligible sessions to record, in [0, 1]. Default 0. */
  readonly sampleRate: number;
  /** Route names / path prefixes on which replay must NOT record. */
  readonly denyRoutes: ReadonlyArray<string>;
  /** Minimum diagnostics level required to record. */
  readonly minDiagnosticsLevel: DiagnosticsLevel;
  /** The (hard-defaulted) rrweb masking configuration. */
  readonly masking: ReplayMaskingConfig;
}

/** Default block selector — maps the SDK's masking conventions to rrweb. */
export const DEFAULT_REPLAY_BLOCK_SELECTOR = '[data-rt-mask],[data-private]';
/** Default text-mask selector — mask every text node. */
export const DEFAULT_REPLAY_MASK_TEXT_SELECTOR = '*';

/** The non-negotiable masking floor. Built fresh so callers can't mutate it. */
export function defaultMaskingConfig(): ReplayMaskingConfig {
  return {
    maskAllInputs: true,
    maskTextSelector: DEFAULT_REPLAY_MASK_TEXT_SELECTOR,
    maskInputOptions: {
      password: true,
      email: true,
      text: true,
      tel: true,
      number: true,
      search: true,
      url: true,
      textarea: true,
      select: true,
      date: true,
      'datetime-local': true,
      month: true,
      week: true,
      time: true,
      color: true,
    },
    blockSelector: DEFAULT_REPLAY_BLOCK_SELECTOR,
    recordCanvas: false,
    collectFonts: false,
  };
}

const ALLOWED_LEVELS = new Set<DiagnosticsLevel>([
  'essential',
  'standard',
  'assisted_support',
]);

/** Default minimum diagnostics level (lowest level that is still allowed). */
const DEFAULT_MIN_DIAGNOSTICS_LEVEL: DiagnosticsLevel = 'standard';

/** The disabled, fully-masked default policy. */
export function defaultReplayConfig(): ResolvedReplayConfig {
  return {
    mode: 'auto',
    enabled: false,
    sampleRate: DEFAULT_REPLAY_SAMPLE_RATE,
    denyRoutes: [],
    minDiagnosticsLevel: DEFAULT_MIN_DIAGNOSTICS_LEVEL,
    masking: defaultMaskingConfig(),
  };
}

function resolveStringArray(raw: unknown, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      'config.invalid',
      `\`autoCapture.replay.${label}\` must be an array of strings.`,
    );
  }
  return raw.map((s, i) => {
    if (typeof s !== 'string' || s.length === 0) {
      throw new ConfigError(
        'config.invalid',
        `\`autoCapture.replay.${label}[${i}]\` must be a non-empty string.`,
      );
    }
    return s;
  });
}

/**
 * Validate + normalize the `autoCapture.replay` option. Accepts:
 *   - `undefined` / `false` → the disabled, fully-masked default;
 *   - `true`               → enabled with masking + other defaults;
 *   - an options object     → per-key validation (rejects unknown keys).
 *
 * Masking is never weakened: `maskTextSelector` / `blockSelector` are only
 * *extended* (a host may broaden them, never disable masking).
 */
export function resolveReplayConfig(
  raw: unknown,
  allowedKeys: ReadonlySet<string>,
): ResolvedReplayConfig {
  const defaults = defaultReplayConfig();
  if (raw === undefined) return defaults;
  if (typeof raw === 'boolean') {
    return { ...defaults, enabled: raw };
  }
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(
      'config.invalid',
      '`autoCapture.replay` must be a boolean or an options object if provided.',
    );
  }

  const opts = raw as Record<string, unknown>;
  for (const key of Object.keys(opts)) {
    if (!allowedKeys.has(key)) {
      throw new ConfigError(
        'config.invalid',
        `Unknown autoCapture.replay option: "${key}". Allowed: ${Array.from(
          allowedKeys,
        )
          .sort()
          .join(', ')}.`,
      );
    }
  }

  // mode --------------------------------------------------------------------
  let mode = defaults.mode;
  if (opts.mode !== undefined) {
    if (
      opts.mode !== 'auto' &&
      opts.mode !== 'manual' &&
      opts.mode !== 'off' &&
      opts.mode !== 'review'
    ) {
      throw new ConfigError(
        'config.invalid',
        "`autoCapture.replay.mode` must be one of: 'auto', 'manual', 'off', 'review'.",
      );
    }
    mode = opts.mode;
  }

  // enabled -----------------------------------------------------------------
  let enabled = defaults.enabled;
  if (opts.enabled !== undefined) {
    if (typeof opts.enabled !== 'boolean') {
      throw new ConfigError(
        'config.invalid',
        '`autoCapture.replay.enabled` must be a boolean if provided.',
      );
    }
    enabled = opts.enabled;
  }

  // sampleRate --------------------------------------------------------------
  let sampleRate = defaults.sampleRate;
  if (opts.sampleRate !== undefined) {
    const v = opts.sampleRate;
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < 0 ||
      v > 1
    ) {
      throw new ConfigError(
        'config.invalid',
        '`autoCapture.replay.sampleRate` must be a number in [0, 1].',
      );
    }
    sampleRate = v;
  }

  // denyRoutes --------------------------------------------------------------
  const denyRoutes = resolveStringArray(opts.denyRoutes, 'denyRoutes');

  // minDiagnosticsLevel -----------------------------------------------------
  let minDiagnosticsLevel = defaults.minDiagnosticsLevel;
  if (opts.minDiagnosticsLevel !== undefined) {
    const v = opts.minDiagnosticsLevel;
    if (typeof v !== 'string' || !ALLOWED_LEVELS.has(v as DiagnosticsLevel)) {
      throw new ConfigError(
        'config.invalid',
        `\`autoCapture.replay.minDiagnosticsLevel\` must be one of: ${Array.from(
          ALLOWED_LEVELS,
        )
          .sort()
          .join(', ')}.`,
      );
    }
    minDiagnosticsLevel = v as DiagnosticsLevel;
  }

  // masking — inputs/attributes are ALWAYS masked; the only relaxable layer is
  // STATIC text (labels), via `maskAllText`. ------------------------------
  const base = defaultMaskingConfig();

  // maskAllText (default true): mask every text node. When false, only text
  // inside tagged elements is masked, so static labels stay readable in replay.
  // This NEVER affects inputs — `maskAllInputs` stays forced on.
  let maskAllText = true;
  if (opts.maskAllText !== undefined) {
    if (typeof opts.maskAllText !== 'boolean') {
      throw new ConfigError(
        'config.invalid',
        '`autoCapture.replay.maskAllText` must be a boolean if provided.',
      );
    }
    maskAllText = opts.maskAllText;
  }

  let hostMaskText: string | undefined;
  if (opts.maskTextSelector !== undefined) {
    if (typeof opts.maskTextSelector !== 'string' || opts.maskTextSelector.length === 0) {
      throw new ConfigError(
        'config.invalid',
        '`autoCapture.replay.maskTextSelector` must be a non-empty string.',
      );
    }
    hostMaskText = opts.maskTextSelector;
  }

  // maskAllText → '*' (mask every text node). Otherwise mask only text inside
  // tagged elements (the block selector) plus any host-added selector.
  const maskTextSelector = maskAllText
    ? DEFAULT_REPLAY_MASK_TEXT_SELECTOR
    : hostMaskText
      ? `${DEFAULT_REPLAY_BLOCK_SELECTOR},${hostMaskText}`
      : DEFAULT_REPLAY_BLOCK_SELECTOR;

  let blockSelector = base.blockSelector;
  if (opts.blockSelector !== undefined) {
    if (typeof opts.blockSelector !== 'string' || opts.blockSelector.length === 0) {
      throw new ConfigError(
        'config.invalid',
        '`autoCapture.replay.blockSelector` must be a non-empty string.',
      );
    }
    blockSelector = `${base.blockSelector},${opts.blockSelector}`;
  }

  return {
    mode,
    enabled,
    sampleRate,
    denyRoutes,
    minDiagnosticsLevel,
    masking: { ...base, maskTextSelector, blockSelector },
  };
}

/** True when `level` meets or exceeds the policy's minimum. */
export function diagnosticsLevelAllows(
  level: DiagnosticsLevel | undefined,
  min: DiagnosticsLevel,
): boolean {
  const order: Record<DiagnosticsLevel, number> = {
    essential: 0,
    standard: 1,
    assisted_support: 2,
  };
  // No declared level → fall back to the lowest-consent level (`essential`),
  // which only passes when the policy explicitly allows essential.
  const effective = level ?? 'essential';
  return order[effective] >= order[min];
}

/** True when `route` is denied by the policy (exact match or prefix). */
export function routeIsDenied(
  route: string,
  denyRoutes: ReadonlyArray<string>,
): boolean {
  for (const deny of denyRoutes) {
    if (route === deny) return true;
    if (deny.length > 0 && route.startsWith(deny)) return true;
  }
  return false;
}

/**
 * Stable digest of the masking config, for the manifest `scrubber` block so the
 * backend has audit parity on exactly which masking was applied. This is a
 * documentation/audit field, not a security control.
 */
export { REPLAY_ALLOWED_DIAGNOSTICS_LEVELS };
