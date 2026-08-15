import type { ActionFamilyId } from "./action-family.js";
import type { CurrentPeriodCoverage, DisplayUnit, EvergreenCoverage, MetricDirection, MetricKind, SnapshotCoverage } from "./metrics.js";
import type { BalanceProviderId, ProviderId, StatusProviderId, UsageProviderId } from "./providers.js";

/**
 * Serializable timestamp: Unix epoch milliseconds (UTC). Chosen over ISO
 * strings so staleness math needs no parsing and JSON round-trips exactly.
 */
export type EpochMilliseconds = number;

/**
 * Normalized snapshot: trusted action-family truth after edge validation.
 * Carries only normalized product fields — raw vendor payload fields must
 * never cross into this contract.
 */
export interface NormalizedSnapshotBase {
  readonly familyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly fetchedAtEpochMs: EpochMilliseconds;
}

/** Shared fields carried only by Usage and Balance metric snapshots. */
export interface MetricSnapshotBase extends NormalizedSnapshotBase {
  readonly metricKind: MetricKind;
  readonly metricDirection: MetricDirection;
  readonly unit: DisplayUnit;
  readonly coverage: SnapshotCoverage;
  /** Normalized numeric value in `unit` semantics; for usage-percent this is percent used (0..100). */
  readonly value: number;
  /**
   * Next window/period reset moment when the vendor reports one (usage window
   * reset, balance period reset). Absent means no reset is scheduled — the
   * renderer's "idle" truth, never a defaulted countdown.
   */
  readonly resetsAtEpochMs?: EpochMilliseconds;
  /**
   * End of the covered data window for inherently lagged spend/usage sources
   * (response-derived, never assumed). Drives the dim "thru <date>" marker.
   */
  readonly dataThroughEpochMs?: EpochMilliseconds;
  /**
   * Count of additional vendor-reported currency/balance entries beyond the
   * prominent first one. Identifier-free count only; drives the "+N" marker.
   */
  readonly extraCurrencies?: number;
  /**
   * Where the snapshot came from. Absent means the provider's live endpoint;
   * "local-fallback" marks a read-only local-source fallback (e.g. the Codex
   * session file) so renderers keep the old plugin's staleness honesty.
   */
  readonly source?: "live" | "local-fallback";
}

/**
 * Rolling-window percentage-used Usage snapshot (Claude Code / Codex 5h·7d,
 * z.ai windows). Upper-bound: severity worsens as the percentage rises.
 */
export interface UsagePercentSnapshot extends MetricSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-percent";
  readonly metricDirection: "upper-bound";
  readonly unit: "percent";
}

/**
 * Evergreen credit-pool Usage snapshot (Codex "Credits" category). Lower-bound:
 * severity worsens as the remaining balance falls. Coverage is always
 * `evergreen` — a remaining pool with no window reset.
 */
export interface UsageCreditsSnapshot extends MetricSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-credits";
  readonly metricDirection: "lower-bound";
  readonly unit: "credits";
  readonly coverage: EvergreenCoverage;
}

/**
 * Evergreen reset-credit-count Usage snapshot (Codex "Resets" category). Lower-bound:
 * severity worsens as the count of available rate-limit reset credits falls. Coverage is
 * always `evergreen` (no window reset). `value` is the available count; `resetsAtEpochMs`,
 * when present, is the earliest upcoming reset-credit expiry and drives the countdown line.
 */
export interface UsageResetsSnapshot extends MetricSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-resets";
  readonly metricDirection: "lower-bound";
  readonly unit: "count";
  readonly coverage: EvergreenCoverage;
}

interface UsageSpendActiveSnapshotBase extends MetricSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-spend";
  readonly metricDirection: "upper-bound";
  readonly unit: "money";
  readonly coverage: CurrentPeriodCoverage;
  readonly spendState: "active";
  readonly autoReloadOn: boolean;
  readonly usedMinor: number;
  readonly currency: string;
  readonly exponent: number;
}

/** Capped spend displayed as percent consumed, while absolute money spent drives severity. */
export interface UsageSpendCappedActiveSnapshot extends UsageSpendActiveSnapshotBase {
  readonly spendDisplay?: "percent-of-cap";
  readonly percent: number;
  readonly capMinor: number;
}

/** Money-only spend with no percentage or allowance denominator (for example Kimi Extra Usage). */
export interface UsageSpendMoneyActiveSnapshot extends UsageSpendActiveSnapshotBase {
  readonly spendDisplay: "money-used";
}

export type UsageSpendActiveSnapshot = UsageSpendCappedActiveSnapshot | UsageSpendMoneyActiveSnapshot;

/**
 * Extra-usage SPEND snapshot in a non-gauge STATUS state (Claude Code "Credits" category): `off`
 * (the extra-usage toggle is off) or `out-of-credits` (depleted). Carries no money — the renderer
 * shows a neutral status word ("Off" / "Out"), and the out-of-credits state renders critical only
 * when `autoReloadOn`. The base `value` is `0` (never displayed; severity is not evaluated).
 */
export interface UsageSpendStatusSnapshot extends MetricSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-spend";
  readonly metricDirection: "upper-bound";
  readonly unit: "money";
  readonly coverage: CurrentPeriodCoverage;
  readonly spendState: "off" | "out-of-credits";
  readonly autoReloadOn: boolean;
}

/** Discriminated by `spendState`: the active spend gauge, or a non-gauge off/out-of-credits status. */
export type UsageSpendSnapshot = UsageSpendActiveSnapshot | UsageSpendStatusSnapshot;

/**
 * Discriminated by `metricKind`: percentage-used windows, the evergreen credits pool, the evergreen
 * reset-credit count, or the current-period extra-usage spend guard.
 */
export type UsageSnapshot = UsagePercentSnapshot | UsageCreditsSnapshot | UsageResetsSnapshot | UsageSpendSnapshot;

export interface BalanceSnapshot extends MetricSnapshotBase {
  readonly familyId: "balance";
  readonly providerId: BalanceProviderId;
}

export const INCIDENT_LIFECYCLES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "postmortem",
  "scheduled",
  "in_progress",
  "verifying",
  "completed",
] as const;
export type IncidentLifecycle = (typeof INCIDENT_LIFECYCLES)[number];

export const ACTIVE_INCIDENT_LIFECYCLES = ["investigating", "identified", "monitoring"] as const satisfies readonly IncidentLifecycle[];
export type ActiveIncidentLifecycle = (typeof ACTIVE_INCIDENT_LIFECYCLES)[number];

export const INCIDENT_IMPACTS = ["none", "minor", "major", "critical", "maintenance"] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export const PROVIDER_STATUS_INDICATORS = ["none", "minor", "major", "critical", "maintenance"] as const;
export type ProviderStatusIndicator = (typeof PROVIDER_STATUS_INDICATORS)[number];

/** Impacts eligible for a normalized active-incident snapshot; maintenance is excluded by policy. */
export const STATUS_INCIDENT_IMPACTS = ["none", "minor", "major", "critical"] as const satisfies readonly IncidentImpact[];
export type StatusIncidentImpact = (typeof STATUS_INCIDENT_IMPACTS)[number];

interface StatusSnapshotBase extends NormalizedSnapshotBase {
  readonly familyId: "status";
  readonly providerId: StatusProviderId;
}

export type StrictStatusProviderId = Exclude<StatusProviderId, "openai-api">;

interface StrictStatusSnapshotBase extends StatusSnapshotBase {
  readonly providerId: StrictStatusProviderId;
  readonly providerStatusIndicator?: never;
}

interface OpenAIStatusSnapshotBase extends StatusSnapshotBase {
  readonly providerId: "openai-api";
  readonly providerStatusIndicator: ProviderStatusIndicator;
}

/** A strict-provider zero-count snapshot cannot carry aggregate status or a fabricated highest impact. */
export interface StrictStatusOperationalSnapshot extends StrictStatusSnapshotBase {
  readonly activeIncidentCount: 0;
  readonly highestImpact?: never;
}

/** A strict-provider incident snapshot carries only incident-derived status. */
export interface StrictStatusIncidentSnapshot extends StrictStatusSnapshotBase {
  readonly activeIncidentCount: number;
  readonly highestImpact: StatusIncidentImpact;
}

/** OpenAI zero-count status retains its required aggregate provider indicator. */
export interface OpenAIStatusOperationalSnapshot extends OpenAIStatusSnapshotBase {
  readonly activeIncidentCount: 0;
  readonly highestImpact?: never;
}

/** OpenAI active-incident status keeps aggregate and incident axes distinct. */
export interface OpenAIStatusIncidentSnapshot extends OpenAIStatusSnapshotBase {
  readonly activeIncidentCount: number;
  readonly highestImpact: StatusIncidentImpact;
}

export type StatusOperationalSnapshot = StrictStatusOperationalSnapshot | OpenAIStatusOperationalSnapshot;
export type StatusIncidentSnapshot = StrictStatusIncidentSnapshot | OpenAIStatusIncidentSnapshot;
export type StatusSnapshot = StatusOperationalSnapshot | StatusIncidentSnapshot;

/** Usage/Balance-only union for consumers that require metric fields. */
export type MetricSnapshot = UsageSnapshot | BalanceSnapshot;

/**
 * Extensibility seam: snapshot shapes are keyed by family id; a future
 * action family adds one key here instead of rewriting shared contracts.
 */
export interface ActionFamilySnapshotShapes {
  readonly usage: UsageSnapshot;
  readonly balance: BalanceSnapshot;
  readonly status: StatusSnapshot;
}

export type NormalizedSnapshot = ActionFamilySnapshotShapes[ActionFamilyId];

/** Compile-time guard: the snapshot seam must cover every declared family id. */
type AssertCoversFamilies<T extends Readonly<Record<ActionFamilyId, NormalizedSnapshotBase>>> = T;
type _SnapshotShapesCoverFamilies = AssertCoversFamilies<ActionFamilySnapshotShapes>;
