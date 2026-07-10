import {
  BALANCE_PROVIDER_IDS,
  COVERAGE_KINDS,
  type BalanceMetricKind,
  type BalanceProviderId,
  type CoverageKind,
  type CredentialClass,
  type DisplayState,
  type DisplayUnit,
  type ImplementationStatus,
  type MetricDirection,
  type SeverityThresholdSet,
} from "@ai-workbench/contracts";
import { buildRendererInput, headerLabelForActionSettings, type DisplayRendererInput } from "@ai-workbench/display";
import { mapProviderFailure, type SanitizedFailure } from "@ai-workbench/errors";
import { createSourceGatedBalanceFetch, listBalanceProviderAdapterBindings } from "@ai-workbench/provider-adapters";
import {
  IMPLEMENTATION_STATUS_BEHAVIOR,
  findProviderEntry,
  listProviderEntriesForFamily,
  type DisplayBasis,
  type ProviderCapabilityMetadata,
  type ProviderPresentationMetadata,
  type SourceProofStatus,
} from "@ai-workbench/provider-registry";
import type { SchedulerFetch, SchedulerOutput } from "@ai-workbench/scheduler";
import type { NormalizedActionSettingsView } from "@ai-workbench/settings";

export const packageName = "@ai-workbench/action-balance" as const;

export type BalanceActionResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };

export interface BalanceProviderOption {
  readonly providerId: BalanceProviderId;
  readonly productLabel: string;
  readonly actionFamilyId: "balance";
  readonly adapterBindingId: string;
  readonly metricKind: BalanceMetricKind;
  readonly metricDirection: MetricDirection;
  readonly unit: DisplayUnit;
  readonly displayBasis: DisplayBasis;
  readonly coverageKind: CoverageKind;
  readonly credentialClasses: readonly CredentialClass[];
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly fetchAllowed: boolean;
  readonly selectionEligible: boolean;
  readonly presentation?: ProviderPresentationMetadata;
  readonly unavailableDisplayState?: DisplayState;
  readonly unavailableReason?: string;
}

export interface ResolvedBalanceProviderOption extends BalanceProviderOption {
  readonly capability: ProviderCapabilityMetadata;
}

export interface ResolveBalanceProviderOptionInput {
  readonly providerId: BalanceProviderId;
  readonly windowOrPeriod?: CoverageKind;
}

export interface BuildSourceGatedBalanceSchedulerOutputInput {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly sourceFetch?: SchedulerFetch;
  readonly activeRefCount?: number;
  readonly startedAtEpochMs?: number;
}

export interface BuildBalanceRendererInputOptions {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly schedulerOutput: SchedulerOutput;
  readonly thresholds?: SeverityThresholdSet;
  readonly currencyCode?: string;
}

export function listBalanceProviderOptions(): readonly BalanceProviderOption[] {
  const adapterBindingIds = new Set(listBalanceProviderAdapterBindings().map((binding) => binding.adapterBindingId));

  return listProviderEntriesForFamily("balance").flatMap((entry) => {
    const providerId = entry.providerId;

    if (!isBalanceProviderId(providerId)) {
      return [];
    }

    return entry.capabilities
      .filter((capability) => capability.actionFamilyId === "balance")
      .map((capability) => balanceProviderOption(providerId, entry.productLabel, capability, adapterBindingIds));
  });
}

export function resolveBalanceProviderOption(
  input: ResolveBalanceProviderOptionInput,
): BalanceActionResult<ResolvedBalanceProviderOption> {
  const entry = findProviderEntry(input.providerId);
  const capability = entry?.capabilities.find((candidate) => candidate.actionFamilyId === "balance");
  if (entry === undefined || capability === undefined || !isBalanceProviderId(entry.providerId)) {
    return balanceFailure("unsupported", "balance-provider-not-found");
  }

  if (input.windowOrPeriod !== undefined && input.windowOrPeriod !== capability.coverageKind) {
    return balanceFailure("unsupported", "unsupported-balance-coverage");
  }

  return {
    ok: true,
    value: {
      ...balanceProviderOption(
        entry.providerId,
        entry.productLabel,
        capability,
        new Set(listBalanceProviderAdapterBindings().map((binding) => binding.adapterBindingId)),
      ),
      capability,
    },
  };
}

export async function buildSourceGatedBalanceSchedulerOutput(
  input: BuildSourceGatedBalanceSchedulerOutputInput,
): Promise<SchedulerOutput> {
  if (input.actionSettings.familyId !== "balance" || !isBalanceProviderId(input.actionSettings.providerId)) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: balanceProviderFailure("unsupported", "balance-action-settings-not-balance"),
    });
  }

  const windowOrPeriod = input.actionSettings.windowOrPeriod;
  if (windowOrPeriod !== undefined && !isCoverageKind(windowOrPeriod)) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: balanceProviderFailure("unsupported", "unsupported-balance-coverage"),
    });
  }

  const resolved = resolveBalanceProviderOption({
    providerId: input.actionSettings.providerId,
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
  });
  if (!resolved.ok) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: resolved.failure,
    });
  }

  const schedulerFetch = createSourceGatedBalanceFetch({
    providerId: resolved.value.providerId,
    capability: resolved.value.capability,
    ...(input.sourceFetch === undefined ? {} : { sourceFetch: input.sourceFetch }),
  });
  const result = await schedulerFetch({
    schedulerKey: input.actionSettings.schedulerKey,
    key: input.actionSettings.schedulerKey,
    keyParts: input.actionSettings.schedulerKeyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: input.startedAtEpochMs ?? 0,
    signal: noopSignal,
  });

  if (result.ok) {
    return {
      schedulerKey: input.actionSettings.schedulerKey,
      displayState: "fresh",
      refreshIntervalSeconds: input.actionSettings.refreshIntervalSeconds,
      activeRefCount: input.activeRefCount ?? 1,
      inFlight: false,
      snapshot: result.snapshot,
    };
  }

  return schedulerOutputForFailure({
    actionSettings: input.actionSettings,
    activeRefCount: input.activeRefCount,
    failure: result.failure,
  });
}

export function buildBalanceRendererInput(input: BuildBalanceRendererInputOptions): DisplayRendererInput {
  const capability = capabilityForActionSettings(input.actionSettings);
  const authExpiredHint = capability?.presentation?.authExpiredHint;

  return buildRendererInput({
    schedulerOutput: input.schedulerOutput,
    displayPreferences: input.actionSettings.displayPreferences,
    providerId: input.actionSettings.providerId,
    actionFamilyId: "balance",
    headerLabel: headerLabelForActionSettings({
      providerId: input.actionSettings.providerId,
      familyId: "balance",
      ...(input.actionSettings.displayPreferences.label === undefined ? {} : { label: input.actionSettings.displayPreferences.label }),
    }),
    ...(authExpiredHint === undefined ? {} : { authExpiredHint }),
    ...(capability === undefined ? {} : { capability }),
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
    ...(input.currencyCode === undefined ? {} : { currencyCode: input.currencyCode }),
  });
}

function balanceProviderOption(
  providerId: BalanceProviderId,
  productLabel: string,
  capability: ProviderCapabilityMetadata,
  adapterBindingIds: ReadonlySet<string>,
): BalanceProviderOption {
  const status = IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus];
  const adapterBindingAvailable = adapterBindingIds.has(capability.adapterBindingId);

  return {
    providerId,
    productLabel,
    actionFamilyId: "balance",
    adapterBindingId: capability.adapterBindingId,
    metricKind: capability.metricKind as BalanceMetricKind,
    metricDirection: capability.metricDirection,
    unit: capability.displayUnit,
    displayBasis: capability.displayBasis,
    coverageKind: capability.coverageKind,
    credentialClasses: capability.credentialClasses,
    implementationStatus: capability.implementationStatus,
    sourceProofStatus: capability.sourceProofStatus,
    fetchAllowed: status.fetchAllowed && adapterBindingAvailable,
    selectionEligible: status.selectionEligible && adapterBindingAvailable,
    ...(capability.presentation === undefined ? {} : { presentation: capability.presentation }),
    ...(status.unavailableDisplayState === undefined ? {} : { unavailableDisplayState: status.unavailableDisplayState }),
    ...(capability.unavailableReason === undefined ? {} : { unavailableReason: capability.unavailableReason }),
  };
}

function schedulerOutputForFailure(input: {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly failure: SanitizedFailure;
  readonly activeRefCount?: number | undefined;
}): SchedulerOutput {
  return {
    schedulerKey: input.actionSettings.schedulerKey,
    displayState: input.failure.displayState,
    refreshIntervalSeconds: input.actionSettings.refreshIntervalSeconds,
    activeRefCount: input.activeRefCount ?? 1,
    inFlight: false,
    failure: input.failure,
  };
}

function capabilityForActionSettings(actionSettings: NormalizedActionSettingsView): ProviderCapabilityMetadata | undefined {
  return findProviderEntry(actionSettings.providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "balance");
}

function balanceFailure(
  kind: "unsupported" | "not-implemented" | "probe-required",
  reasonCode: string,
): BalanceActionResult<never> {
  return {
    ok: false,
    failure: balanceProviderFailure(kind, reasonCode),
  };
}

function balanceProviderFailure(
  kind: "unsupported" | "not-implemented" | "probe-required",
  reasonCode: string,
): SanitizedFailure {
  return mapProviderFailure({
    kind,
    providerFailureClass: kind === "not-implemented" ? "not-implemented" : kind,
    reasonCode,
  });
}

function isBalanceProviderId(providerId: string): providerId is BalanceProviderId {
  return (BALANCE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isCoverageKind(windowOrPeriod: string): windowOrPeriod is CoverageKind {
  return (COVERAGE_KINDS as readonly string[]).includes(windowOrPeriod);
}

const noopSignal = {
  aborted: false,
  addEventListener: () => undefined,
};
