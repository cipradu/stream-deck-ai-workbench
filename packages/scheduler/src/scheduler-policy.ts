import { MAX_RETRY_AFTER_SECONDS } from "@ai-workbench/http";
import { Duration, Schedule } from "effect";

export const SCHEDULER_BACKOFF_POLICY = {
  transient: {
    initialDelayMs: 30_000,
    maxDelayMs: 300_000,
  },
  rateLimit: {
    initialDelayMs: 60_000,
    maxDelayMs: 600_000,
    maxRetryAfterMs: MAX_RETRY_AFTER_SECONDS * 1_000,
  },
  stale: {
    ageMultiplier: 2,
    maxDisplayMs: 86_400_000,
  },
  jitter: {
    minRatio: 0,
    maxRatio: 0.2,
  },
} as const;

export const JITTER_MIN_MULTIPLIER = 1 + SCHEDULER_BACKOFF_POLICY.jitter.minRatio;
export const JITTER_MAX_MULTIPLIER = 1 + SCHEDULER_BACKOFF_POLICY.jitter.maxRatio;

/** The shared Effect schedule for scheduler and governor rate-limit fallback delays. */
export function backoffDelaySchedule(initialDelayMs: number, maxDelayMs: number): Schedule.Schedule<Duration.Duration> {
  return Schedule.exponential(Duration.millis(initialDelayMs), 2).pipe(
    Schedule.jitteredWith({ min: JITTER_MIN_MULTIPLIER, max: JITTER_MAX_MULTIPLIER }),
    Schedule.either(Schedule.spaced(Duration.millis(maxDelayMs))),
    Schedule.delays,
    Schedule.delayed(() => Duration.zero),
  );
}

export const TRANSIENT_DELAY_SCHEDULE = backoffDelaySchedule(
  SCHEDULER_BACKOFF_POLICY.transient.initialDelayMs,
  SCHEDULER_BACKOFF_POLICY.transient.maxDelayMs,
);

export const RATE_LIMIT_DELAY_SCHEDULE = backoffDelaySchedule(
  SCHEDULER_BACKOFF_POLICY.rateLimit.initialDelayMs,
  SCHEDULER_BACKOFF_POLICY.rateLimit.maxDelayMs,
);

export function retryAfterDelayMs(retryAfterSeconds: number | undefined): number | undefined {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return undefined;
  }
  return Math.min(Math.trunc(retryAfterSeconds * 1_000), SCHEDULER_BACKOFF_POLICY.rateLimit.maxRetryAfterMs);
}
