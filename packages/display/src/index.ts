import {
  type DisplayPreferences,
  type DisplayState,
  type DisplayUnit,
  type ErrorCategory,
  type MetricDirection,
  type NormalizedSnapshot,
  type RendererInput,
  type RetryClass,
  type SeverityState,
  type SeverityThresholdBasis,
  type SeverityThresholdSet,
  type SnapshotCoverage,
  type UsageWindowId,
} from "@ai-workbench/contracts";
import {
  findProviderEntry,
  type DisplayBasis,
  type ProviderCapabilityMetadata,
  type SeverityStrategy,
  type SeverityStrategyReference,
} from "@ai-workbench/provider-registry";
import type { SchedulerOutput, SchedulerStaleReason } from "@ai-workbench/scheduler";

export const packageName = "@ai-workbench/display" as const;

export type RendererSeverityState = "normal" | "warning" | "critical";

const STALE_FAILURE_INDICATOR_LABEL_BY_CATEGORY = {
  "missing-credentials": "AUTH REQUIRED",
  "invalid-credentials": "AUTH REQUIRED",
  "insufficient-credential-scope": "ACCESS DENIED",
  "unauthorized-expired": "AUTH REQUIRED",
  "rate-limited": "RATE LIMITED",
  timeout: "TIMEOUT",
  abort: "REFRESH STOPPED",
  "network-failure": "NETWORK ERROR",
  "http-status-failure": "HTTP ERROR",
  "provider-unavailable": "UNAVAILABLE",
  "validation-drift": "DATA ERROR",
  "unsupported-capability": "UNSUPPORTED",
  "no-data-yet": "NO DATA",
  "stale-cached-value": undefined,
  "not-implemented": "NOT AVAILABLE",
  "probe-required": "SETUP REQUIRED",
  "settings-validation-failure": "CHECK SETTINGS",
  "unknown-sanitized-failure": "REFRESH ERROR",
} as const satisfies Readonly<Record<ErrorCategory, string | undefined>>;

export type StaleFailureIndicatorLabel = NonNullable<(typeof STALE_FAILURE_INDICATOR_LABEL_BY_CATEGORY)[ErrorCategory]>;

export const RENDERER_SEVERITY_STATE_BY_SEVERITY = {
  healthy: "normal",
  "not-evaluated": "normal",
  warning: "warning",
  critical: "critical",
} as const satisfies Readonly<Record<SeverityState, RendererSeverityState>>;

export const DEFAULT_SEVERITY_THRESHOLDS = {
  "upper-bound-usage-percent-default": {
    direction: "upper-bound",
    basis: "percent",
    warningAt: 80,
    criticalAt: 90,
  },
  "lower-bound-remaining-percent-default": {
    direction: "lower-bound",
    basis: "percent",
    warningAt: 20,
    criticalAt: 10,
  },
  "upper-bound-spend-money-default": {
    direction: "upper-bound",
    basis: "absolute",
    warningAt: 40,
    criticalAt: 50,
  },
  "lower-bound-remaining-money-default": {
    direction: "lower-bound",
    basis: "absolute",
    warningAt: 10,
    criticalAt: 5,
  },
  // Codex "resets" default: lower-bound on the DAYS of reset-credit runway (at-or-below edge, like
  // the money/percent defaults). 7 days → warning, 3 days → critical. Basis is absolute (the value is
  // a day count, not a percentage); a user PI floor (also in days) overrides it in the engine.
  "lower-bound-resets-days-default": {
    direction: "lower-bound",
    basis: "absolute",
    warningAt: 7,
    criticalAt: 3,
  },
} as const satisfies Readonly<Record<SeverityStrategyReference, SeverityThresholdSet>>;

export type SeverityThresholdSource = "registry-default" | "user-override";
export type SeverityNotEvaluatedReason =
  | "invalid-value"
  | "missing-severity-strategy"
  | "requires-user-profile"
  | "threshold-basis-mismatch"
  | "threshold-direction-mismatch"
  | "threshold-order-invalid";

export type ResolvedSeverityThresholds =
  | {
      readonly kind: "evaluated";
      readonly source: SeverityThresholdSource;
      readonly thresholds: SeverityThresholdSet;
    }
  | {
      readonly kind: "not-evaluated";
      readonly reason: SeverityNotEvaluatedReason;
    };

export interface ResolveSeverityThresholdsInput {
  readonly capability?: ProviderCapabilityMetadata;
  readonly severityStrategy?: SeverityStrategy;
  readonly metricDirection?: MetricDirection;
  readonly valueBasis?: SeverityThresholdBasis;
  readonly thresholds?: SeverityThresholdSet;
}

export interface SeverityEvaluationInput extends ResolveSeverityThresholdsInput {
  readonly value: number;
}

export interface SeverityEvaluation {
  readonly severity: SeverityState;
  readonly rendererSeverityState: RendererSeverityState;
  readonly thresholdResolution: ResolvedSeverityThresholds;
  readonly basisValue?: number;
}

export interface FormatDisplayValueInput {
  readonly snapshot: NormalizedSnapshot;
  readonly capability?: ProviderCapabilityMetadata;
  readonly displayPreferences?: DisplayPreferences;
  readonly currencyCode?: string;
}

export interface FormattedDisplayValue {
  readonly valueText: string;
  readonly valueLabel: string;
  readonly unit: DisplayUnit;
  readonly displayBasis: DisplayBasis;
  readonly displayValue: number;
  readonly severityBasisValue: number;
  /** Dim unit word for the row under the amount ("credits", "chars", or a currency code with no known symbol); absent when the symbol or time unit is embedded in the amount. */
  readonly unitRowText?: string;
  readonly coverageMarker?: string;
  readonly progressPercent?: number;
  /** Dim secondary line rendered under the gauge value (the credit-spend "$used / $cap" money pair). */
  readonly secondaryLine?: string;
  /** Non-gauge status tone for the credit-spend off/out-of-credits states: neutral (dim) or critical (red, auto-reload on). */
  readonly statusTone?: SpendStatusTone;
}

/** Renderer tone for a non-gauge credit-spend status key: neutral dim ("Off"/"Out") or critical red (out-of-credits + auto-reload on). */
export type SpendStatusTone = "neutral" | "critical";

export interface DisplayFailureContext {
  readonly category: ErrorCategory;
  readonly displayState: DisplayState;
  readonly retryClass: RetryClass;
  readonly safePublicMessage: string;
  readonly reasonCode: string;
  readonly boundary?: string;
  readonly httpStatusClass?: string;
  readonly issueCount?: number;
  readonly providerFailureClass?: string;
  readonly providerReasonCode?: string;
}

export type DisplayFreshness = "fresh" | "stale" | "degraded";

export interface DisplayRendererInput extends RendererInput {
  readonly headerLabel?: string;
  readonly rendererSeverityState: RendererSeverityState;
  readonly freshness: DisplayFreshness;
  readonly valueLabel?: string;
  readonly unit?: DisplayUnit;
  readonly displayBasis?: DisplayBasis;
  readonly displayValue?: number;
  readonly severityBasisValue?: number;
  readonly unitRowText?: string;
  readonly coverageMarker?: string;
  /** Dim secondary line under the gauge value (the credit-spend "$used / $cap" money pair). */
  readonly secondaryLine?: string;
  /** Non-gauge status tone for the credit-spend off/out-of-credits states: neutral (dim) or critical (red). */
  readonly statusTone?: SpendStatusTone;
  readonly staleReason?: SchedulerStaleReason;
  readonly failureContext?: DisplayFailureContext;
  /** Static display-owned label for a retained failed-refresh stale key. */
  readonly failureIndicator?: StaleFailureIndicatorLabel;
  /** Epoch ms the rendered snapshot was fetched; drives the stale-age badge and last-checked time. */
  readonly fetchedAtEpochMs?: number;
  /** Epoch ms of the next window/period reset when the vendor reports one; drives the countdown line. */
  readonly resetsAtEpochMs?: number;
  /** Epoch ms end of the covered data window for lagged spend sources; drives the "thru <date>" marker. */
  readonly dataThroughEpochMs?: number;
  /** Count of additional currency entries beyond the prominent one; drives the "+N" marker. */
  readonly extraCurrencies?: number;
  /** Provider-specific on-key hint for the auth-expired state (registry presentation copy). */
  readonly authExpiredHint?: string;
  /** Provider id for renderer-side artwork lookup; carries no account data. */
  readonly providerId?: string;
  /** Action family so degraded output can keep family-specific copy. */
  readonly actionFamilyId?: "balance" | "usage";
  /** Rolling Usage window carried into presentation-only rendering decisions. */
  readonly usageWindow?: UsageWindowId;
  /** True when the snapshot came from a read-only local fallback source; renderers keep the old stale-badge honesty. */
  readonly sourceFallback?: boolean;
}

export interface BuildRendererInputOptions {
  readonly schedulerOutput: SchedulerOutput;
  /** Header override computed by the action family (provider label · window); also applied to degraded output. */
  readonly headerLabel?: string;
  /** Provider auth-expired hint (registry presentation copy); also applied to degraded output. */
  readonly authExpiredHint?: string;
  /** Provider id for renderer-side artwork lookup; also applied to degraded output. */
  readonly providerId?: string;
  /** Action family for family-specific degraded copy. */
  readonly actionFamilyId?: "balance" | "usage";
  readonly displayPreferences?: DisplayPreferences;
  readonly thresholds?: SeverityThresholdSet;
  readonly capability?: ProviderCapabilityMetadata;
  /**
   * Per-category severity strategy resolved by the action family (e.g. the
   * Codex `credits` category's no-default `requires-user-profile` strategy).
   * Takes precedence over `capability.severityStrategy` so a multi-category
   * capability evaluates each category with its own no-default behavior.
   */
  readonly severityStrategy?: SeverityStrategy;
  readonly currencyCode?: string;
}

export function resolveSeverityThresholds(input: ResolveSeverityThresholdsInput): ResolvedSeverityThresholds {
  const metricDirection = input.metricDirection ?? input.capability?.metricDirection;
  const valueBasis = input.valueBasis ?? thresholdBasisForCapability(input.capability);
  if (input.thresholds !== undefined) {
    return resolveExplicitThresholds(input.thresholds, metricDirection, valueBasis, "user-override");
  }

  const severityStrategy = input.severityStrategy ?? input.capability?.severityStrategy;
  if (severityStrategy === undefined) {
    return { kind: "not-evaluated", reason: "missing-severity-strategy" };
  }

  if (severityStrategy.kind === "requires-user-profile") {
    return { kind: "not-evaluated", reason: "requires-user-profile" };
  }

  return resolveExplicitThresholds(
    DEFAULT_SEVERITY_THRESHOLDS[severityStrategy.reference],
    metricDirection,
    valueBasis,
    "registry-default",
  );
}

export function evaluateSeverity(input: SeverityEvaluationInput): SeverityEvaluation {
  if (!Number.isFinite(input.value)) {
    return severityNotEvaluated({ kind: "not-evaluated", reason: "invalid-value" });
  }

  const thresholdResolution = resolveSeverityThresholds(input);
  if (thresholdResolution.kind === "not-evaluated") {
    return severityNotEvaluated(thresholdResolution);
  }

  const { thresholds } = thresholdResolution;
  const severity =
    thresholds.direction === "upper-bound"
      ? evaluateUpperBoundSeverity(input.value, thresholds)
      : evaluateLowerBoundSeverity(input.value, thresholds);

  return {
    severity,
    rendererSeverityState: RENDERER_SEVERITY_STATE_BY_SEVERITY[severity],
    thresholdResolution,
    basisValue: input.value,
  };
}

export function formatDisplayValue(input: FormatDisplayValueInput): FormattedDisplayValue {
  const capability = input.capability ?? findDisplayCapabilityForSnapshot(input.snapshot);
  const displayBasis = capability?.displayBasis ?? inferDisplayBasis(input.snapshot);
  const coverageMarker = formatCoverageMarker(input.snapshot.coverage);
  const currencyCode = input.currencyCode ?? "USD";

  if (input.snapshot.metricKind === "usage-percent") {
    const usageDisplayMode = input.displayPreferences?.usageDisplayMode ?? "used";
    const severityBasisValue = input.snapshot.value;
    const displayValue = usageDisplayMode === "remaining" ? clampPercent(100 - input.snapshot.value) : clampPercent(input.snapshot.value);
    return formatted({
      snapshot: input.snapshot,
      displayBasis,
      displayValue,
      severityBasisValue,
      valueText: formatPercent(displayValue),
      valueLabel: usageDisplayMode,
      progressPercent: clampPercent(input.snapshot.value),
      coverageMarker,
    });
  }

  if (input.snapshot.metricKind === "usage-credits") {
    // Codex credits category: abbreviated lowercase-k / uppercase-M count (its OWN
    // one-decimal formatter, distinct from the 4-significant-figure balance count),
    // severity-colored as a lower-bound remaining pool. NO dim unit row — the key
    // header already reads "Codex Credits", so a "credits" row is redundant; the
    // amount carries only the "remaining" value label. displayBasis is fixed
    // remaining-value regardless of the passed usage capability.
    return formatted({
      snapshot: input.snapshot,
      displayBasis: "remaining-value",
      displayValue: input.snapshot.value,
      severityBasisValue: input.snapshot.value,
      valueText: formatCreditsAbbrev(input.snapshot.value),
      valueLabel: "remaining",
      coverageMarker,
    });
  }

  if (input.snapshot.metricKind === "usage-resets") {
    // Codex resets category: the PROMINENT number is the available reset-credit COUNT (a plain tiny
    // integer — no thousands separator, no k/M abbreviation, no unit-word row), and the count is the
    // element that takes the severity color, exactly like a balance key tints its money amount. But
    // severity is NOT judged on the count: it is judged on the RUNWAY — the days remaining until the
    // earliest reset-credit expiry (`resetsAtEpochMs`), measured from the snapshot's own
    // `fetchedAtEpochMs` Clock-seam instant (lower-bound: fewer days left is worse). So displayValue =
    // count (shown) while severityBasisValue = daysRemaining (colors the count). With no upcoming
    // expiry there is no runway → NaN basis → the severity engine's not-evaluated (normal) tone. The
    // countdown line renders downstream from resetsAtEpochMs; displayBasis is fixed remaining-value.
    return formatted({
      snapshot: input.snapshot,
      displayBasis: "remaining-value",
      displayValue: input.snapshot.value,
      severityBasisValue: resetsDaysRemaining(input.snapshot),
      valueText: formatResetsCount(input.snapshot.value),
      valueLabel: "available",
      coverageMarker,
    });
  }

  if (input.snapshot.familyId === "usage" && input.snapshot.metricKind === "usage-spend") {
    const spend = input.snapshot;
    if (spend.spendState === "active") {
      const usedValue = spend.usedMinor / 10 ** spend.exponent;

      // Kimi Code reports Extra Usage as money spent. Keep the amount as the prominent value and
      // evaluate the user thresholds against that same upper-bound dollar value; it is not a
      // percentage gauge.
      if (spend.spendDisplay === "money-used") {
        const symbol = CURRENCY_SYMBOLS[spend.currency];
        return formatted({
          snapshot: input.snapshot,
          displayBasis: "current-period-value",
          displayValue: usedValue,
          severityBasisValue: usedValue,
          valueText: symbol === undefined ? formatCountText(usedValue) : formatCurrencyText(usedValue, symbol),
          valueLabel: "spent",
          ...(symbol === undefined ? { unitRowText: spend.currency } : {}),
          coverageMarker,
        });
      }

      // Active spend gauge: the DISPLAYED number is the percent of
      // the cap consumed (rendered like a usage-percent, gauge + progress), but severity is judged on
      // the absolute money SPENT (upper-bound: more spent is worse) — a display-value-vs-severity-basis
      // split like the Codex resets category. The "$used / $cap" pair renders on the dim secondary
      // line, reusing the balance currency formatter with the account currency's symbol/prefix.
      // Plain "$" only — no currency code on the key (owner directive: the amounts read as
      // dollars, the currency word/code is dropped everywhere).
      const prefix = "$";
      const capValue = spend.capMinor / 10 ** spend.exponent;
      return formatted({
        snapshot: input.snapshot,
        displayBasis: "current-period-value",
        displayValue: clampPercent(spend.percent),
        severityBasisValue: usedValue,
        valueText: formatPercent(spend.percent),
        valueLabel: "used",
        progressPercent: clampPercent(spend.percent),
        secondaryLine: `${formatCurrencyText(usedValue, prefix)} / ${formatCurrencyText(capValue, prefix)}`,
      });
    }

    // off / out-of-credits: a non-gauge neutral status word ("Off" /
    // "Out"), NOT a green 0% gauge and NO money. Severity is not evaluated (a NaN basis → the engine's
    // not-evaluated normal tone); the visible tone is driven by statusTone instead — dim by default,
    // critical/red ONLY for out-of-credits with auto-reload on (the imminent-auto-charge burn).
    const isOut = spend.spendState === "out-of-credits";
    return formatted({
      snapshot: input.snapshot,
      displayBasis: "current-period-value",
      displayValue: Number.NaN,
      severityBasisValue: Number.NaN,
      valueText: isOut ? "Out" : "Off",
      valueLabel: "",
      statusTone: isOut && spend.autoReloadOn ? "critical" : "neutral",
    });
  }

  if (input.snapshot.unit === "duration-hours") {
    return formatted({
      snapshot: input.snapshot,
      displayBasis,
      displayValue: input.snapshot.value,
      severityBasisValue: input.snapshot.value,
      valueText: formatDurationHours(input.snapshot.value),
      valueLabel: "used",
      coverageMarker,
    });
  }

  if (input.snapshot.unit === "money") {
    const symbol = CURRENCY_SYMBOLS[currencyCode];
    return formatted({
      snapshot: input.snapshot,
      displayBasis,
      displayValue: input.snapshot.value,
      severityBasisValue: input.snapshot.value,
      // Old working layout: known-symbol currencies embed the symbol in the
      // prominent amount ("$1.17"); unknown currencies keep the amount plain
      // and surface the currency code on the dim unit row.
      valueText: symbol === undefined ? formatCountText(input.snapshot.value) : formatCurrencyText(input.snapshot.value, symbol),
      valueLabel: displayBasis === "remaining-value" ? "remaining" : "spent",
      ...(symbol === undefined ? { unitRowText: currencyCode } : {}),
      coverageMarker,
    });
  }

  // Counts (credits/tokens/characters): thousands-separated prominent amount
  // with the unit word on the dim row (old working layout).
  return formatted({
    snapshot: input.snapshot,
    displayBasis,
    displayValue: input.snapshot.value,
    severityBasisValue: input.snapshot.value,
    valueText: formatCountText(input.snapshot.value),
    valueLabel: displayBasis === "remaining-value" ? "remaining" : "used",
    unitRowText: unitLabel(input.snapshot.unit),
    coverageMarker,
  });
}

export function formatCoverageMarker(coverage: SnapshotCoverage): string | undefined {
  switch (coverage.kind) {
    case "evergreen":
      return undefined;
    case "month-to-date":
      return "current month";
    case "current-period":
      return "current period";
    case "rolling-window":
      return rollingWindowCoverageLabel(coverage.window);
  }
}

export function buildRendererInput(input: BuildRendererInputOptions): DisplayRendererInput {
  const snapshot = input.schedulerOutput.snapshot;
  if (snapshot === undefined) {
    return degradedRendererInput(input.schedulerOutput, {
      ...(input.headerLabel === undefined ? {} : { headerLabel: input.headerLabel }),
      ...(input.authExpiredHint === undefined ? {} : { authExpiredHint: input.authExpiredHint }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.actionFamilyId === undefined ? {} : { actionFamilyId: input.actionFamilyId }),
    });
  }

  const capability = input.capability ?? findDisplayCapabilityForSnapshot(snapshot);
  const value = formatDisplayValue({
    snapshot,
    ...(capability === undefined ? {} : { capability }),
    ...(input.displayPreferences === undefined ? {} : { displayPreferences: input.displayPreferences }),
    ...(input.currencyCode === undefined ? {} : { currencyCode: input.currencyCode }),
  });
  const severity = evaluateSeverity({
    ...(capability === undefined ? {} : { capability }),
    ...(input.severityStrategy === undefined ? {} : { severityStrategy: input.severityStrategy }),
    metricDirection: snapshot.metricDirection,
    valueBasis: thresholdBasisForDisplayUnit(snapshot.unit),
    value: value.severityBasisValue,
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  });
  const failureContext = failureContextFromSchedulerOutput(input.schedulerOutput);
  const isStale = input.schedulerOutput.displayState === "stale";
  const failureIndicator =
    isStale && input.schedulerOutput.staleReason === "refresh-failed" ? staleFailureIndicatorFromContext(failureContext) : undefined;
  const authExpiredHint = input.authExpiredHint ?? capability?.presentation?.authExpiredHint;

  return {
    valueText: value.valueText,
    severity: severity.severity,
    displayState: input.schedulerOutput.displayState,
    stale: isStale,
    ...(value.progressPercent === undefined ? {} : { progressPercent: value.progressPercent }),
    rendererSeverityState: severity.rendererSeverityState,
    freshness: isStale ? "stale" : "fresh",
    headerLabel: input.headerLabel ?? headerLabelForSnapshot(snapshot, input.displayPreferences),
    valueLabel: value.valueLabel,
    unit: value.unit,
    displayBasis: value.displayBasis,
    displayValue: value.displayValue,
    severityBasisValue: value.severityBasisValue,
    ...(value.unitRowText === undefined ? {} : { unitRowText: value.unitRowText }),
    ...(value.coverageMarker === undefined ? {} : { coverageMarker: value.coverageMarker }),
    ...(value.secondaryLine === undefined ? {} : { secondaryLine: value.secondaryLine }),
    ...(value.statusTone === undefined ? {} : { statusTone: value.statusTone }),
    ...(input.schedulerOutput.staleReason === undefined ? {} : { staleReason: input.schedulerOutput.staleReason }),
    ...(failureContext === undefined ? {} : { failureContext }),
    ...(failureIndicator === undefined ? {} : { failureIndicator }),
    fetchedAtEpochMs: snapshot.fetchedAtEpochMs,
    ...(snapshot.resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs: snapshot.resetsAtEpochMs }),
    ...(snapshot.dataThroughEpochMs === undefined ? {} : { dataThroughEpochMs: snapshot.dataThroughEpochMs }),
    ...(snapshot.extraCurrencies === undefined ? {} : { extraCurrencies: snapshot.extraCurrencies }),
    ...(authExpiredHint === undefined ? {} : { authExpiredHint }),
    providerId: input.providerId ?? snapshot.providerId,
    actionFamilyId: input.actionFamilyId ?? snapshot.familyId,
    ...(snapshot.familyId === "usage" && snapshot.coverage.kind === "rolling-window"
      ? { usageWindow: snapshot.coverage.window }
      : {}),
    ...(snapshot.source === "local-fallback" ? { sourceFallback: true } : {}),
  };
}

function headerLabelForSnapshot(snapshot: NormalizedSnapshot, displayPreferences: DisplayPreferences | undefined): string {
  if (displayPreferences?.label !== undefined && displayPreferences.label.trim().length > 0) {
    return displayPreferences.label.trim();
  }

  const entry = findProviderEntry(snapshot.providerId);
  const capability = entry?.capabilities.find((candidate) => candidate.actionFamilyId === snapshot.familyId);
  const providerLabel = capability?.presentation?.headerLabel ?? entry?.productLabel ?? snapshot.providerId;
  if (snapshot.familyId !== "usage" || snapshot.coverage.kind !== "rolling-window") {
    return providerLabel;
  }

  return `${providerLabel} · ${usageWindowShortLabel(snapshot.coverage.window)}`;
}

export function usageWindowShortLabel(window: string): string {
  switch (window) {
    case "five-hour":
      return "5h";
    case "seven-day":
      return "7d";
    case "monthly-mcp":
      return "MCP";
    case "fable":
      return "Fable";
    case "credits":
      return "Credits";
    case "credit-spend":
      return "Credits";
    case "extra-usage":
      return "Extra";
    case "resets":
      return "Resets";
    default:
      return window;
  }
}

/**
 * Header label for an action's key from settings alone (works for degraded
 * output with no snapshot): user label override, else the provider's key
 * header label ("Claude · 5h" for usage windows, vendor label for balance).
 */
export function headerLabelForActionSettings(input: {
  readonly providerId: string;
  readonly familyId: "balance" | "usage";
  readonly windowOrPeriod?: string;
  readonly label?: string;
}): string {
  if (input.label !== undefined && input.label.trim().length > 0) {
    return input.label.trim();
  }

  const entry = findProviderEntry(input.providerId);
  const capability = entry?.capabilities.find((candidate) => candidate.actionFamilyId === input.familyId);
  const providerLabel = capability?.presentation?.headerLabel ?? entry?.productLabel ?? input.providerId;
  if (input.familyId !== "usage" || input.windowOrPeriod === undefined) {
    return providerLabel;
  }

  return `${providerLabel} · ${usageWindowShortLabel(input.windowOrPeriod)}`;
}

export function findDisplayCapabilityForSnapshot(snapshot: NormalizedSnapshot): ProviderCapabilityMetadata | undefined {
  return findProviderEntry(snapshot.providerId)?.capabilities.find(
    (capability) =>
      capability.actionFamilyId === snapshot.familyId &&
      capability.metricKind === snapshot.metricKind &&
      capability.metricDirection === snapshot.metricDirection &&
      capability.displayUnit === snapshot.unit,
  );
}

function resolveExplicitThresholds(
  thresholds: SeverityThresholdSet,
  expectedDirection: MetricDirection | undefined,
  expectedBasis: SeverityThresholdBasis | undefined,
  source: SeverityThresholdSource,
): ResolvedSeverityThresholds {
  if (expectedDirection === undefined || expectedDirection === "none" || thresholds.direction !== expectedDirection) {
    return { kind: "not-evaluated", reason: "threshold-direction-mismatch" };
  }

  if (expectedBasis === undefined || thresholds.basis !== expectedBasis) {
    return { kind: "not-evaluated", reason: "threshold-basis-mismatch" };
  }

  if (!thresholdOrderIsValid(thresholds)) {
    return { kind: "not-evaluated", reason: "threshold-order-invalid" };
  }

  return { kind: "evaluated", source, thresholds };
}

function thresholdOrderIsValid(thresholds: SeverityThresholdSet): boolean {
  const warningAt = thresholds.warningAt;
  const criticalAt = thresholds.criticalAt;
  if (warningAt !== undefined && !Number.isFinite(warningAt)) {
    return false;
  }
  if (criticalAt !== undefined && !Number.isFinite(criticalAt)) {
    return false;
  }
  // Each bound is independently optional, but an empty set evaluates nothing.
  if (warningAt === undefined && criticalAt === undefined) {
    return false;
  }
  if (warningAt === undefined || criticalAt === undefined) {
    return thresholds.direction === "upper-bound" || thresholds.direction === "lower-bound";
  }

  if (thresholds.direction === "upper-bound") {
    return warningAt <= criticalAt;
  }
  if (thresholds.direction === "lower-bound") {
    return warningAt >= criticalAt;
  }
  return false;
}

function severityNotEvaluated(thresholdResolution: ResolvedSeverityThresholds): SeverityEvaluation {
  return {
    severity: "not-evaluated",
    rendererSeverityState: "normal",
    thresholdResolution,
  };
}

function evaluateUpperBoundSeverity(value: number, thresholds: SeverityThresholdSet): SeverityState {
  if (thresholds.criticalAt !== undefined && value >= thresholds.criticalAt) {
    return "critical";
  }
  if (thresholds.warningAt !== undefined && value >= thresholds.warningAt) {
    return "warning";
  }
  return "healthy";
}

function evaluateLowerBoundSeverity(value: number, thresholds: SeverityThresholdSet): SeverityState {
  if (thresholds.criticalAt !== undefined && value <= thresholds.criticalAt) {
    return "critical";
  }
  if (thresholds.warningAt !== undefined && value <= thresholds.warningAt) {
    return "warning";
  }
  return "healthy";
}

function thresholdBasisForCapability(capability: ProviderCapabilityMetadata | undefined): SeverityThresholdBasis | undefined {
  return capability === undefined ? undefined : thresholdBasisForDisplayUnit(capability.displayUnit);
}

function thresholdBasisForDisplayUnit(unit: DisplayUnit): SeverityThresholdBasis {
  return unit === "percent" ? "percent" : "absolute";
}

function formatted(input: {
  readonly snapshot: NormalizedSnapshot;
  readonly displayBasis: DisplayBasis;
  readonly displayValue: number;
  readonly severityBasisValue: number;
  readonly valueText: string;
  readonly valueLabel: string;
  readonly unitRowText?: string | undefined;
  readonly coverageMarker?: string | undefined;
  readonly progressPercent?: number | undefined;
  readonly secondaryLine?: string | undefined;
  readonly statusTone?: SpendStatusTone | undefined;
}): FormattedDisplayValue {
  return {
    valueText: input.valueText,
    valueLabel: input.valueLabel,
    unit: input.snapshot.unit,
    displayBasis: input.displayBasis,
    displayValue: input.displayValue,
    severityBasisValue: input.severityBasisValue,
    ...(input.unitRowText === undefined ? {} : { unitRowText: input.unitRowText }),
    ...(input.coverageMarker === undefined ? {} : { coverageMarker: input.coverageMarker }),
    ...(input.progressPercent === undefined ? {} : { progressPercent: input.progressPercent }),
    ...(input.secondaryLine === undefined ? {} : { secondaryLine: input.secondaryLine }),
    ...(input.statusTone === undefined ? {} : { statusTone: input.statusTone }),
  };
}

/** Closed symbol map from the old working plugin; unknown units get no guessed symbol. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: "$", CNY: "¥", EUR: "€" };

/** Significant figures retained for every balance amount (currency and count). */
const SIGNIFICANT_FIGURES = 4;
/** At or above this magnitude the amount is abbreviated with a k/M/B suffix; below it it renders at natural precision. */
const ABBREVIATION_THRESHOLD = 10_000;

/**
 * Abbreviates an already-4-significant-figure magnitude with a k (1e3) / M (1e6) /
 * B (1e9) suffix. The magnitude MUST be rounded to 4 significant figures before this
 * call (see `formatCurrencyText`/`formatCountText`): rounding first then dividing keeps
 * the abbreviation faithful (49815 → 49820 → "49.82k", not the divide-first "49.81k"),
 * and choosing the unit from the rounded magnitude lets a rounding roll-over promote
 * cleanly (999999 → 1000000 → "1.000M"). `toPrecision` carries the trailing zeros that
 * make the precision explicit ("1.500B", "10.00k").
 */
function abbreviateSignificant(rounded: number): string {
  const divisor = rounded >= 1_000_000_000 ? 1_000_000_000 : rounded >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = rounded >= 1_000_000_000 ? "B" : rounded >= 1_000_000 ? "M" : "k";
  return `${(rounded / divisor).toPrecision(SIGNIFICANT_FIGURES)}${suffix}`;
}

/**
 * Symbol-prefixed currency at 4 significant figures. Below 10,000 it shows natural
 * cents capped at 4 significant figures (17.80 → "$17.80", 179.83 → "$179.8",
 * 1234.56 → "$1235"); at or above 10,000 it abbreviates ("$12.35k"). Zero renders
 * "$0.00" and never blank; negatives lead with the sign before the symbol ("-$5.50").
 */
function formatCurrencyText(amount: number, symbol: string): string {
  const sign = amount < 0 ? "-" : "";
  const rounded = Number(Math.abs(amount).toPrecision(SIGNIFICANT_FIGURES));
  if (rounded >= ABBREVIATION_THRESHOLD) {
    return `${sign}${symbol}${abbreviateSignificant(rounded)}`;
  }
  const integerDigits = rounded < 1 ? 1 : Math.trunc(rounded).toString().length;
  const fractionDigits = Math.max(0, Math.min(2, SIGNIFICANT_FIGURES - integerDigits));
  return `${sign}${symbol}${rounded.toFixed(fractionDigits)}`;
}

/**
 * Count (credits/tokens/characters, and unknown-currency money) at 4 significant
 * figures. Below 10,000 it shows the natural value (4216 → "4216", no separator);
 * at or above 10,000 it abbreviates ("49.82k", "587.8M", "1.500B"). Zero renders "0"
 * and never blank; negatives lead with the sign ("-49.82k").
 */
function formatCountText(value: number): string {
  const sign = value < 0 ? "-" : "";
  const rounded = Number(Math.abs(value).toPrecision(SIGNIFICANT_FIGURES));
  if (rounded >= ABBREVIATION_THRESHOLD) {
    return `${sign}${abbreviateSignificant(rounded)}`;
  }
  return `${sign}${rounded.toString()}`;
}

/**
 * Codex credits abbreviation: lowercase `k`
 * (thousands) / uppercase `M` (millions), ONE decimal with a trailing `.0`
 * dropped, and a bare "0" for zero (or any magnitude that rounds to zero).
 * Examples: 25000→"25k", 25100→"25.1k", 300→"0.3k", 108300→"108.3k",
 * 1_200_000→"1.2M". Distinct from `formatCountText`'s 4-significant-figure
 * balance count (which renders 25000 as "25.00k").
 */
function formatCreditsAbbrev(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "0";
  }
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const useMillions = abs >= 1_000_000;
  const scaled = abs / (useMillions ? 1_000_000 : 1_000);
  const rounded = Math.round(scaled * 10) / 10;
  if (rounded === 0) {
    return "0";
  }
  const text = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
  return `${sign}${text}${useMillions ? "M" : "k"}`;
}

/**
 * Codex resets count: a plain non-negative integer with NO thousands
 * separator and NO k/M abbreviation (available reset-credit counts are tiny, typically 0-2). A
 * non-finite or negative value renders "0". Distinct from the 4-significant-figure balance count
 * (`formatCountText`) and the credits k/M abbreviation (`formatCreditsAbbrev`).
 */
function formatResetsCount(value: number): string {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value).toString() : "0";
}

/** Milliseconds per day; the Codex reset-credit runway severity basis is measured in days. */
const MILLIS_PER_DAY = 86_400_000;

/**
 * Codex resets severity basis: the reset-credit RUNWAY in days — the time
 * from the snapshot's own `fetchedAtEpochMs` (the Clock-seam fetch instant: deterministic, testable,
 * and it advances toward expiry each poll) to the earliest upcoming reset-credit expiry
 * (`resetsAtEpochMs`). Clamped to `>= 0` defensively (the adapter only stores FUTURE expiries, so it
 * is non-negative at fetch; the clamp only guards drift). Returns `NaN` when there is no upcoming
 * expiry (count 0, or a positive count with no future expiry): no runway → the severity engine's
 * invalid-value path → not-evaluated → normal tone, never amber/red.
 */
function resetsDaysRemaining(snapshot: NormalizedSnapshot): number {
  if (snapshot.resetsAtEpochMs === undefined) {
    return Number.NaN;
  }
  return Math.max(0, (snapshot.resetsAtEpochMs - snapshot.fetchedAtEpochMs) / MILLIS_PER_DAY);
}

function inferDisplayBasis(snapshot: NormalizedSnapshot): DisplayBasis {
  if (snapshot.metricKind === "usage-percent") {
    return "bounded-percentage";
  }
  if (snapshot.metricKind === "current-month-spend" || snapshot.metricKind === "current-period-spend") {
    return "current-period-value";
  }
  if (snapshot.metricKind === "used-time") {
    return "used-value";
  }
  return "remaining-value";
}

// Old working display rounded usage percentages to whole numbers.
function formatPercent(value: number): string {
  return `${formatNumber(Math.round(value), 0)}%`;
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(normalized);
}

function formatDurationHours(value: number): string {
  const totalMinutes = Math.max(0, Math.round(value * 60));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function unitLabel(unit: DisplayUnit): string {
  switch (unit) {
    case "characters":
      return "chars";
    case "credits":
      return "credits";
    case "tokens":
      return "tokens";
    case "duration-hours":
      return "hours";
    case "money":
      return "USD";
    case "percent":
      return "%";
    // Unreachable: the only `count`-unit metric (usage-resets) renders through its own
    // formatDisplayValue branch (a plain integer with no unit-word row), never this fallback.
    // Present only to keep the switch total now that `count` is a DisplayUnit.
    case "count":
      return "count";
  }
}

function rollingWindowCoverageLabel(window: Extract<SnapshotCoverage, { readonly kind: "rolling-window" }>["window"]): string {
  switch (window) {
    case "five-hour":
      return "5-hour rolling window";
    case "seven-day":
      return "7-day rolling window";
    case "monthly-mcp":
      return "monthly MCP window";
    // Reachable: claude-code's Fable category is a rolling-window (weekly scoped) usage-percent
    // snapshot, so it routes through this branch like the 5h/7d windows.
    case "fable":
      return "weekly Fable window";
    // Unreachable: the Codex "credits"/"resets" categories carry `evergreen` coverage and the
    // claude-code "credit-spend" category carries `current-period` coverage, so none route through
    // the rolling-window branch. Present only to keep the switch total now that they are
    // `UsageWindowId`s.
    case "credits":
      return "credits pool";
    case "resets":
      return "reset-credits pool";
    case "credit-spend":
      return "extra-usage spend";
    case "extra-usage":
      return "extra-usage spend";
  }
}

function degradedRendererInput(
  schedulerOutput: SchedulerOutput,
  context?: {
    readonly headerLabel?: string;
    readonly authExpiredHint?: string;
    readonly providerId?: string;
    readonly actionFamilyId?: "balance" | "usage";
  },
): DisplayRendererInput {
  const failureContext = failureContextFromSchedulerOutput(schedulerOutput);

  return {
    valueText: valueTextForDegradedState(schedulerOutput.displayState),
    severity: "not-evaluated",
    displayState: schedulerOutput.displayState,
    stale: false,
    rendererSeverityState: "normal",
    freshness: "degraded",
    ...(context?.headerLabel === undefined ? {} : { headerLabel: context.headerLabel }),
    ...(context?.authExpiredHint === undefined ? {} : { authExpiredHint: context.authExpiredHint }),
    ...(context?.providerId === undefined ? {} : { providerId: context.providerId }),
    ...(context?.actionFamilyId === undefined ? {} : { actionFamilyId: context.actionFamilyId }),
    ...(failureContext === undefined ? {} : { failureContext }),
  };
}

function valueTextForDegradedState(displayState: DisplayState): string {
  switch (displayState) {
    case "missing-credentials":
      return "Missing credentials";
    case "invalid-credentials":
      return "Invalid credentials";
    case "unauthorized-expired":
      return "Authorization expired";
    case "rate-limited":
      return "Rate limited";
    case "timeout":
      return "Timed out";
    case "network-failure":
      return "Network failure";
    case "provider-unavailable":
      return "Provider unavailable";
    case "validation-drift":
      return "Validation drift";
    case "unsupported-capability":
      return "Unsupported";
    case "not-implemented":
      return "Not implemented";
    case "settings-invalid":
      return "Settings invalid";
    case "unknown-sanitized-failure":
      return "Unknown failure";
    case "fresh":
    case "stale":
    case "no-data-yet":
      return "No data";
  }
}

function failureContextFromSchedulerOutput(schedulerOutput: SchedulerOutput): DisplayFailureContext | undefined {
  const failure = schedulerOutput.failure;
  if (failure === undefined) {
    return undefined;
  }

  return {
    category: failure.category,
    displayState: failure.displayState,
    retryClass: failure.retryClass,
    safePublicMessage: failure.safePublicMessage,
    reasonCode: failure.diagnostics.reasonCode,
    ...(failure.diagnostics.boundary === undefined ? {} : { boundary: failure.diagnostics.boundary }),
    ...(failure.diagnostics.httpStatusClass === undefined ? {} : { httpStatusClass: failure.diagnostics.httpStatusClass }),
    ...(failure.diagnostics.issueCount === undefined ? {} : { issueCount: failure.diagnostics.issueCount }),
    ...(failure.provider === undefined
      ? {}
      : {
          providerFailureClass: failure.provider.failureClass,
          providerReasonCode: failure.provider.reasonCode,
        }),
  };
}

function staleFailureIndicatorFromContext(context: DisplayFailureContext | undefined): StaleFailureIndicatorLabel | undefined {
  if (context === undefined) {
    return undefined;
  }
  return STALE_FAILURE_INDICATOR_LABEL_BY_CATEGORY[context.category];
}
