/**
 * Metric model: metric kinds, direction-aware severity basis, display units,
 * and coverage/window semantics shared by every action family.
 */

/**
 * Usage category ids offered by the first Usage catalog. `five-hour`,
 * `seven-day`, `monthly-mcp`, and `fable` are rolling/reset windows; `credits`
 * and `resets` are evergreen Codex categories with no window reset (a remaining
 * credit pool and a rate-limit reset-credit count), so their snapshot coverage
 * is `evergreen`, never `rolling-window`. `fable` is a claude-code-only weekly
 * scoped usage window (the Fable model's rolling weekly percentage), so it is a
 * plain `usage-percent` upper-bound `rolling-window` category like `seven-day`.
 * `credit-spend` is a claude-code-only extra-usage SPEND category (the OAuth
 * usage response's `spend` object): an upper-bound `usage-spend` money metric
 * with `current-period` coverage — distinct from the Codex `credits` count pool.
 */
export const USAGE_WINDOW_IDS = ["five-hour", "seven-day", "monthly-mcp", "credits", "resets", "fable", "credit-spend"] as const;
export type UsageWindowId = (typeof USAGE_WINDOW_IDS)[number];

/**
 * Coverage kinds: what span of provider truth a value describes.
 * `evergreen` marks a remaining pool with no reset period.
 */
export const COVERAGE_KINDS = ["rolling-window", "month-to-date", "current-period", "evergreen"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export interface RollingWindowCoverage {
  readonly kind: "rolling-window";
  readonly window: UsageWindowId;
}

export interface MonthToDateCoverage {
  readonly kind: "month-to-date";
}

/** Provider-defined billing/reset period (for example Runpod billing history). */
export interface CurrentPeriodCoverage {
  readonly kind: "current-period";
}

export interface EvergreenCoverage {
  readonly kind: "evergreen";
}

export type SnapshotCoverage = RollingWindowCoverage | MonthToDateCoverage | CurrentPeriodCoverage | EvergreenCoverage;

/**
 * Metric kinds available to the Usage action family. `usage-percent` is the
 * rolling-window percentage-used metric (upper-bound). `usage-credits` is a
 * remaining evergreen credit pool (lower-bound), conceptually the balance
 * `remaining-credits` metric surfaced inside the Usage family. `usage-resets` is
 * an evergreen count of available rate-limit reset credits (lower-bound): fewer
 * available resets is worse, and the count drives an earliest-expiry countdown.
 * `usage-spend` is an extra-usage SPEND metric (upper-bound, money unit): the
 * displayed number is the percent of the spend cap consumed, but severity is
 * judged on the absolute money SPENT (more spent is worse) — a
 * display-value-vs-severity-basis split like `usage-resets`.
 */
export const USAGE_METRIC_KINDS = ["usage-percent", "usage-credits", "usage-resets", "usage-spend"] as const;
export type UsageMetricKind = (typeof USAGE_METRIC_KINDS)[number];

/** Metric kinds available to the Balance action family. */
export const BALANCE_METRIC_KINDS = [
  "current-month-spend",
  "current-period-spend",
  "used-time",
  "remaining-balance",
  "remaining-credits",
  "remaining-tokens",
  "remaining-characters",
] as const;
export type BalanceMetricKind = (typeof BALANCE_METRIC_KINDS)[number];

export const METRIC_KINDS = [...USAGE_METRIC_KINDS, ...BALANCE_METRIC_KINDS] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * Direction-aware severity basis: upper-bound metrics get worse as they rise,
 * lower-bound metrics get worse as they fall, `none` carries no severity basis.
 */
export const METRIC_DIRECTIONS = ["upper-bound", "lower-bound", "none"] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

/** Semantic direction of each metric kind (not a threshold policy). */
export const METRIC_KIND_DIRECTION: Readonly<Record<MetricKind, MetricDirection>> = {
  "usage-percent": "upper-bound",
  "usage-credits": "lower-bound",
  "usage-resets": "lower-bound",
  "usage-spend": "upper-bound",
  "current-month-spend": "upper-bound",
  "current-period-spend": "upper-bound",
  "used-time": "upper-bound",
  "remaining-balance": "lower-bound",
  "remaining-credits": "lower-bound",
  "remaining-tokens": "lower-bound",
  "remaining-characters": "lower-bound",
};

/**
 * Display unit info for normalized values. `duration-hours` means the
 * normalized value is a decimal-hours duration; `count` is a bare integer
 * cardinality (e.g. available reset credits) with no unit word; presentation
 * formatting (minutes vs hours:minutes, currency symbols, compaction) belongs
 * to the display boundary, not to contracts.
 */
export const DISPLAY_UNITS = ["percent", "money", "duration-hours", "credits", "tokens", "characters", "count"] as const;
export type DisplayUnit = (typeof DISPLAY_UNITS)[number];

/** Semantic unit of each metric kind. */
export const METRIC_KIND_UNIT: Readonly<Record<MetricKind, DisplayUnit>> = {
  "usage-percent": "percent",
  "usage-credits": "credits",
  "usage-resets": "count",
  "usage-spend": "money",
  "current-month-spend": "money",
  "current-period-spend": "money",
  "used-time": "duration-hours",
  "remaining-balance": "money",
  "remaining-credits": "credits",
  "remaining-tokens": "tokens",
  "remaining-characters": "characters",
};
