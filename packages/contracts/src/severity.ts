import type { MetricDirection } from "./metrics.js";

/** Evaluated severity levels: healthy renders green, warning amber/orange, critical red. */
export const SEVERITY_LEVELS = ["healthy", "warning", "critical"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/**
 * Severity states seen by renderers: the evaluated levels plus the distinct
 * `not-evaluated` state (no safe default or user override exists); renderers
 * keep the normal green base color and claim nothing about provider health.
 */
export const SEVERITY_STATES = [...SEVERITY_LEVELS, "not-evaluated"] as const;
export type SeverityState = (typeof SEVERITY_STATES)[number];

/** What the threshold numbers are compared against. */
export const SEVERITY_THRESHOLD_BASES = ["percent", "absolute"] as const;
export type SeverityThresholdBasis = (typeof SEVERITY_THRESHOLD_BASES)[number];

/**
 * Direction-aware threshold data. For `upper-bound` metrics severity worsens
 * as the value rises (warningAt <= criticalAt); for `lower-bound` metrics it
 * worsens as the value falls (warningAt >= criticalAt). Each bound is
 * independently optional — a lone warning threshold colors amber only, a lone
 * critical threshold red only — but at least one must be present for the set
 * to evaluate. Thresholds are data; default values live with the central
 * severity policy, not in contracts.
 */
export interface SeverityThresholdSet {
  readonly direction: MetricDirection;
  readonly basis: SeverityThresholdBasis;
  readonly warningAt?: number;
  readonly criticalAt?: number;
}
