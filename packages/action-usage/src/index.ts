import {
  USAGE_PROVIDER_IDS,
  USAGE_WINDOW_IDS,
  type DisplayState,
  type CredentialClass,
  type ImplementationStatus,
  type SeverityThresholdSet,
  type UsageProviderId,
  type UsageWindowId,
} from "@ai-workbench/contracts";
import { buildRendererInput, headerLabelForActionSettings, type DisplayRendererInput } from "@ai-workbench/display";
import { mapProviderFailure, type SanitizedFailure } from "@ai-workbench/errors";
import { createSourceGatedUsageFetch, listUsageProviderAdapterBindings } from "@ai-workbench/provider-adapters";
import {
  IMPLEMENTATION_STATUS_BEHAVIOR,
  findProviderEntry,
  listProviderEntriesForFamily,
  resolveCapabilityMetricForWindow,
  type ProviderCapabilityMetadata,
  type ProviderPresentationMetadata,
  type RegistryOpenDecision,
  type ResolvedCapabilityMetric,
  type SourceProofStatus,
} from "@ai-workbench/provider-registry";
import type { SchedulerFetch, SchedulerOutput } from "@ai-workbench/scheduler";
import type { NormalizedActionSettingsView } from "@ai-workbench/settings";

export const packageName = "@ai-workbench/action-usage" as const;

export type UsageActionResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };

export interface UsageProviderOption {
  readonly providerId: UsageProviderId;
  readonly productLabel: string;
  readonly actionFamilyId: "usage";
  readonly adapterBindingId: string;
  readonly supportedWindows: readonly UsageWindowId[];
  readonly credentialClasses: readonly CredentialClass[];
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly fetchAllowed: boolean;
  readonly selectionEligible: boolean;
  readonly presentation?: ProviderPresentationMetadata;
  readonly unavailableDisplayState?: DisplayState;
  readonly unavailableReason?: string;
  readonly openDecision?: RegistryOpenDecision;
}

export interface ResolvedUsageProviderOption extends UsageProviderOption {
  readonly windowOrPeriod: UsageWindowId;
  readonly capability: ProviderCapabilityMetadata;
}

export interface ResolveUsageProviderOptionInput {
  readonly providerId: UsageProviderId;
  readonly windowOrPeriod: UsageWindowId;
}

export interface BuildSourceGatedUsageSchedulerOutputInput {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly sourceFetch?: SchedulerFetch;
  readonly activeRefCount?: number;
  readonly startedAtEpochMs?: number;
}

export interface BuildUsageRendererInputOptions {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly schedulerOutput: SchedulerOutput;
  readonly thresholds?: SeverityThresholdSet;
}

export function listUsageProviderOptions(): readonly UsageProviderOption[] {
  const adapterBindingIds = new Set(listUsageProviderAdapterBindings().map((binding) => binding.adapterBindingId));

  return listProviderEntriesForFamily("usage").flatMap((entry) => {
    const providerId = entry.providerId;

    if (!isUsageProviderId(providerId)) {
      return [];
    }

    return entry.capabilities
      .filter((capability) => capability.actionFamilyId === "usage")
      .map((capability) => usageProviderOption(providerId, entry.productLabel, capability, adapterBindingIds));
  });
}

export function resolveUsageProviderOption(
  input: ResolveUsageProviderOptionInput,
): UsageActionResult<ResolvedUsageProviderOption> {
  const entry = findProviderEntry(input.providerId);
  const capability = entry?.capabilities.find((candidate) => candidate.actionFamilyId === "usage");
  if (entry === undefined || capability === undefined || !isUsageProviderId(entry.providerId)) {
    return usageFailure("unsupported", "usage-provider-not-found");
  }

  const option = usageProviderOption(
    entry.providerId,
    entry.productLabel,
    capability,
    new Set(listUsageProviderAdapterBindings().map((binding) => binding.adapterBindingId)),
  );

  if (!option.supportedWindows.includes(input.windowOrPeriod)) {
    return usageFailure("unsupported", "unsupported-usage-window");
  }

  return {
    ok: true,
    value: {
      ...option,
      windowOrPeriod: input.windowOrPeriod,
      capability,
    },
  };
}

export async function buildSourceGatedUsageSchedulerOutput(
  input: BuildSourceGatedUsageSchedulerOutputInput,
): Promise<SchedulerOutput> {
  if (input.actionSettings.familyId !== "usage" || !isUsageProviderId(input.actionSettings.providerId)) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: usageProviderFailure("unsupported", "usage-action-settings-not-usage"),
    });
  }

  const windowOrPeriod = input.actionSettings.windowOrPeriod;
  if (!isUsageWindowId(windowOrPeriod)) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: usageProviderFailure("unsupported", "usage-window-missing"),
    });
  }

  const resolved = resolveUsageProviderOption({
    providerId: input.actionSettings.providerId,
    windowOrPeriod,
  });
  if (!resolved.ok) {
    return schedulerOutputForFailure({
      actionSettings: input.actionSettings,
      activeRefCount: input.activeRefCount,
      failure: resolved.failure,
    });
  }

  const schedulerFetch = createSourceGatedUsageFetch({
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

export function buildUsageRendererInput(input: BuildUsageRendererInputOptions): DisplayRendererInput {
  const capability = capabilityForActionSettings(input.actionSettings);
  const authExpiredHint = capability?.presentation?.authExpiredHint;
  const windowOrPeriod = isUsageWindowId(input.actionSettings.windowOrPeriod)
    ? input.actionSettings.windowOrPeriod
    : undefined;
  // Resolve the per-category severity strategy (e.g. the Codex credits category's no-default
  // requires-user-profile strategy) so the display evaluates each category with its OWN severity
  // behavior instead of the capability's default usage-percent registry strategy.
  const severityStrategy =
    capability === undefined ? undefined : resolveCapabilityMetricForWindow(capability, windowOrPeriod).severityStrategy;

  return buildRendererInput({
    schedulerOutput: input.schedulerOutput,
    displayPreferences: input.actionSettings.displayPreferences,
    providerId: input.actionSettings.providerId,
    actionFamilyId: "usage",
    headerLabel: headerLabelForActionSettings({
      providerId: input.actionSettings.providerId,
      familyId: "usage",
      ...(input.actionSettings.windowOrPeriod === undefined ? {} : { windowOrPeriod: input.actionSettings.windowOrPeriod }),
      ...(input.actionSettings.displayPreferences.label === undefined ? {} : { label: input.actionSettings.displayPreferences.label }),
    }),
    ...(authExpiredHint === undefined ? {} : { authExpiredHint }),
    ...(capability === undefined ? {} : { capability }),
    ...(severityStrategy === undefined ? {} : { severityStrategy }),
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  });
}

/**
 * Resolves the effective metric metadata for a Usage provider's category
 * (window) from the registry. The settings boundary uses this to derive the
 * credits category's lower-bound direction for the floors→severity-profile
 * migration, keeping the registry the single owner of metric direction. Returns
 * undefined for an unknown provider or a provider with no usage capability.
 */
export function resolveUsageCategoryMetric(
  providerId: string,
  windowOrPeriod: UsageWindowId | undefined,
): ResolvedCapabilityMetric | undefined {
  const capability = findProviderEntry(providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "usage");
  return capability === undefined ? undefined : resolveCapabilityMetricForWindow(capability, windowOrPeriod);
}

function usageProviderOption(
  providerId: UsageProviderId,
  productLabel: string,
  capability: ProviderCapabilityMetadata,
  adapterBindingIds: ReadonlySet<string>,
): UsageProviderOption {
  const status = IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus];
  const supportedWindows = capability.supportedWindows ?? [];
  const adapterBindingAvailable = adapterBindingIds.has(capability.adapterBindingId);

  return {
    providerId,
    productLabel,
    actionFamilyId: "usage",
    adapterBindingId: capability.adapterBindingId,
    supportedWindows,
    credentialClasses: capability.credentialClasses,
    implementationStatus: capability.implementationStatus,
    sourceProofStatus: capability.sourceProofStatus,
    fetchAllowed: status.fetchAllowed && adapterBindingAvailable,
    selectionEligible: status.selectionEligible && adapterBindingAvailable,
    ...(capability.presentation === undefined ? {} : { presentation: capability.presentation }),
    ...(status.unavailableDisplayState === undefined ? {} : { unavailableDisplayState: status.unavailableDisplayState }),
    ...(capability.unavailableReason === undefined ? {} : { unavailableReason: capability.unavailableReason }),
    ...(capability.openDecision === undefined ? {} : { openDecision: capability.openDecision }),
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
  return findProviderEntry(actionSettings.providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "usage");
}

function usageFailure(
  kind: "unsupported" | "not-implemented" | "probe-required",
  reasonCode: string,
): UsageActionResult<never> {
  return {
    ok: false,
    failure: usageProviderFailure(kind, reasonCode),
  };
}

function usageProviderFailure(
  kind: "unsupported" | "not-implemented" | "probe-required",
  reasonCode: string,
): SanitizedFailure {
  return mapProviderFailure({
    kind,
    providerFailureClass: kind === "not-implemented" ? "not-implemented" : kind,
    reasonCode,
  });
}

function isUsageProviderId(providerId: string): providerId is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isUsageWindowId(windowOrPeriod: string | undefined): windowOrPeriod is UsageWindowId {
  return typeof windowOrPeriod === "string" && (USAGE_WINDOW_IDS as readonly string[]).includes(windowOrPeriod);
}

const noopSignal = {
  aborted: false,
  addEventListener: () => undefined,
};
