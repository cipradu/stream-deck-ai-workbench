/**
 * Shared failure classification vocabulary (rules section 11). Provider
 * adapters classify provider-specific failures into these categories; they
 * never invent local categories, retry flags, or UI messages.
 */
export const ERROR_CATEGORIES = [
  "missing-credentials",
  "invalid-credentials",
  "insufficient-credential-scope",
  "unauthorized-expired",
  "rate-limited",
  "timeout",
  "abort",
  "network-failure",
  "http-status-failure",
  "provider-unavailable",
  "validation-drift",
  "unsupported-capability",
  "no-data-yet",
  "stale-cached-value",
  "not-implemented",
  "probe-required",
  "settings-validation-failure",
  "unknown-sanitized-failure",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Retry classes: how the central scheduler is allowed to react to a
 * classified outcome. Backoff timings and policy values live with the
 * central retry/refresh policy, not in contracts.
 */
export const RETRY_CLASSES = [
  "no-retry",
  "healthy-poll",
  "transient-retry",
  "rate-limit-backoff",
  "credential-settings-refresh",
  "manual-refresh",
  "probe-gated",
] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

/** Shared shape attaching retryability classification to an error category. */
export interface ErrorRetryability {
  readonly category: ErrorCategory;
  readonly retryClass: RetryClass;
}

/**
 * Shape of the central category-to-retry-class policy mapping. The concrete
 * mapping values belong to the central error/retry policy units.
 */
export type ErrorCategoryRetryClassMap = Readonly<Record<ErrorCategory, RetryClass>>;
