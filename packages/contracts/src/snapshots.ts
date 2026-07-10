import type { ActionFamilyId } from "./action-family.js";
import type { CurrentPeriodCoverage, DisplayUnit, EvergreenCoverage, MetricDirection, MetricKind, SnapshotCoverage } from "./metrics.js";
import type { BalanceProviderId, ProviderId, UsageProviderId } from "./providers.js";

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
  readonly metricKind: MetricKind;
  readonly metricDirection: MetricDirection;
  readonly unit: DisplayUnit;
  readonly coverage: SnapshotCoverage;
  /** Normalized numeric value in `unit` semantics; for usage-percent this is percent used (0..100). */
  readonly value: number;
  readonly fetchedAtEpochMs: EpochMilliseconds;
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
export interface UsagePercentSnapshot extends NormalizedSnapshotBase {
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
export interface UsageCreditsSnapshot extends NormalizedSnapshotBase {
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
export interface UsageResetsSnapshot extends NormalizedSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-resets";
  readonly metricDirection: "lower-bound";
  readonly unit: "count";
  readonly coverage: EvergreenCoverage;
}

/**
 * Extra-usage SPEND snapshot in the ACTIVE state (Claude Code "Credits" category). Upper-bound
 * `usage-spend` money metric with `current-period` coverage. The DISPLAYED number is `percent`
 * (% of the spend cap consumed), but severity is judged on the absolute money spent
 * (`usedMinor / 10^exponent`) — a display-value-vs-severity-basis split. `usedMinor`/`capMinor`
 * are minor units (e.g. cents) sharing a single `exponent`; `currency` is the ISO 4217 account
 * currency (e.g. "CAD"). `autoReloadOn` is the tolerantly-decoded auto-reload signal (only the
 * out-of-credits state renders it, but it is carried for every state). The base `value` is the
 * money spent, matching the `money` unit.
 */
export interface UsageSpendActiveSnapshot extends NormalizedSnapshotBase {
  readonly familyId: "usage";
  readonly providerId: UsageProviderId;
  readonly metricKind: "usage-spend";
  readonly metricDirection: "upper-bound";
  readonly unit: "money";
  readonly coverage: CurrentPeriodCoverage;
  readonly spendState: "active";
  readonly autoReloadOn: boolean;
  readonly percent: number;
  readonly usedMinor: number;
  readonly capMinor: number;
  readonly currency: string;
  readonly exponent: number;
}

/**
 * Extra-usage SPEND snapshot in a non-gauge STATUS state (Claude Code "Credits" category): `off`
 * (the extra-usage toggle is off) or `out-of-credits` (depleted). Carries no money — the renderer
 * shows a neutral status word ("Off" / "Out"), and the out-of-credits state renders critical only
 * when `autoReloadOn`. The base `value` is `0` (never displayed; severity is not evaluated).
 */
export interface UsageSpendStatusSnapshot extends NormalizedSnapshotBase {
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

export interface BalanceSnapshot extends NormalizedSnapshotBase {
  readonly familyId: "balance";
  readonly providerId: BalanceProviderId;
}

/**
 * Extensibility seam: snapshot shapes are keyed by family id; a future
 * action family adds one key here instead of rewriting shared contracts.
 */
export interface ActionFamilySnapshotShapes {
  readonly usage: UsageSnapshot;
  readonly balance: BalanceSnapshot;
}

export type NormalizedSnapshot = ActionFamilySnapshotShapes[ActionFamilyId];

/** Compile-time guard: the snapshot seam must cover every declared family id. */
type AssertCoversFamilies<T extends Readonly<Record<ActionFamilyId, NormalizedSnapshotBase>>> = T;
type _SnapshotShapesCoverFamilies = AssertCoversFamilies<ActionFamilySnapshotShapes>;
