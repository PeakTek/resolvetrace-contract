/**
 * Shared types for the conformance harness.
 *
 * Each test case is a small async function that returns a {@link CaseResult}.
 * The runner aggregates results and prints a report.
 */

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface CaseResult {
  /** Short identifier, e.g. "connectivity.minimal-envelope". */
  id: string;
  /** Human-readable description printed in TAP/pretty output. */
  description: string;
  status: CaseStatus;
  /** Milliseconds the case took. */
  durationMs: number;
  /** Free-form details. For failures, include the reason + observed response. */
  details?: Record<string, unknown>;
  /** Error message when {@link status} is "fail". */
  message?: string;
}

export interface ResolvedConformanceConfig {
  endpoint: string;
  apiKey: string;
  /** Optional additional endpoints for the endpoint-parity case. */
  additionalEndpoints: string[];
  /** Path to the Python client directory (defaults to `./python-client`). */
  pythonClientPath: string;
  /** Python executable (defaults to `python3`). */
  pythonExecutable: string;
  /** When true, collect all results without exiting on first failure. */
  reportOnly: boolean;
  /** When true, skip cases that require outbound network traffic. */
  skipNetwork: boolean;
  /** Milliseconds to budget for rate-limit case (0 skips). */
  rateLimitBurstMs: number;
  /** Max requests to issue during the rate-limit burst. */
  rateLimitMaxRequests: number;
  /** Output format: "pretty" | "tap". */
  format: 'pretty' | 'tap';
}

/** A registered case the runner can execute. */
export interface CaseDefinition {
  id: string;
  description: string;
  /**
   * Run the case against the resolved config. May return a single result
   * or an array — some cases (e.g. schema conformance) emit one result
   * per fixture.
   */
  run(config: ResolvedConformanceConfig): Promise<CaseResult | CaseResult[]>;
}
