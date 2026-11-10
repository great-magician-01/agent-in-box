/** Exponential reconnect policy with bounded jitter. */

export interface ReconnectPolicy {
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Upper bound for any retry delay. */
  maxDelayMs: number;
  /** Exponential multiplier applied per failed attempt. */
  multiplier: number;
  /** Fraction of the delay that may be added/subtracted as jitter (0..1). */
  jitterRatio: number;
  /** Maximum consecutive failures before the connector gives up. */
  maxAttempts: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
};

export function resolveReconnectPolicy(
  overrides: Partial<ReconnectPolicy> | undefined,
  defaults: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
): ReconnectPolicy {
  const merged = { ...defaults, ...overrides };
  if (merged.initialDelayMs < 0) {
    throw new Error("initialDelayMs must be >= 0");
  }
  if (merged.maxDelayMs < merged.initialDelayMs) {
    throw new Error("maxDelayMs must be >= initialDelayMs");
  }
  if (merged.multiplier < 1) {
    throw new Error("multiplier must be >= 1");
  }
  if (merged.jitterRatio < 0 || merged.jitterRatio > 1) {
    throw new Error("jitterRatio must be between 0 and 1");
  }
  if (merged.maxAttempts < 1) {
    throw new Error("maxAttempts must be >= 1");
  }
  return merged;
}

/**
 * Computes the delay before retry number `attempt` (1-based).
 * `random` is injectable so tests can make the policy deterministic.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  const exponential = policy.initialDelayMs * Math.pow(policy.multiplier, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (policy.jitterRatio === 0) {
    return Math.round(capped);
  }
  const jitter = capped * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}
