import {
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  type BalanceMetricKind,
  type BalanceProviderId,
  type StatusProviderId,
  type UsageProviderId,
} from "@ai-workbench/contracts";
import {
  IMPLEMENTATION_STATUS_BEHAVIOR,
  type ProviderCapabilityMetadata,
  type StatusProviderCapabilityMetadata,
} from "@ai-workbench/provider-registry";

import {
  createSourceGatedBalanceFetch,
  createSourceGatedStatusFetch,
  createSourceGatedUsageFetch,
} from "./source-gates.js";
import type {
  BalanceProviderAdapterBinding,
  StatusProviderAdapterBinding,
  UsageProviderAdapterBinding,
} from "./types.js";

export function createUsageProviderAdapterBinding(
  providerId: UsageProviderId,
  capability: ProviderCapabilityMetadata,
): UsageProviderAdapterBinding {
  const fetchAllowed = IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus].fetchAllowed;

  return {
    adapterBindingId: capability.adapterBindingId,
    providerId,
    actionFamilyId: "usage",
    implementationStatus: capability.implementationStatus,
    sourceProofStatus: capability.sourceProofStatus,
    supportedWindows: capability.supportedWindows ?? [],
    fetchAllowed,
    sourceAccess: fetchAllowed ? "source-fetch" : "source-gated",
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    retryOwner: "scheduler",
    errorOwner: "shared-errors",
    displayOwner: "display-boundary",
    fetch: createSourceGatedUsageFetch({ providerId, capability }),
  };
}

export function createBalanceProviderAdapterBinding(
  providerId: BalanceProviderId,
  capability: ProviderCapabilityMetadata,
): BalanceProviderAdapterBinding {
  const fetchAllowed = IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus].fetchAllowed;

  return {
    adapterBindingId: capability.adapterBindingId,
    providerId,
    actionFamilyId: "balance",
    implementationStatus: capability.implementationStatus,
    sourceProofStatus: capability.sourceProofStatus,
    coverageKind: capability.coverageKind,
    metricKind: capability.metricKind as BalanceMetricKind,
    fetchAllowed,
    sourceAccess: fetchAllowed ? "source-fetch" : "source-gated",
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    retryOwner: "scheduler",
    errorOwner: "shared-errors",
    displayOwner: "display-boundary",
    fetch: createSourceGatedBalanceFetch({ providerId, capability }),
  };
}

export function createStatusProviderAdapterBinding(
  providerId: StatusProviderId,
  capability: StatusProviderCapabilityMetadata,
): StatusProviderAdapterBinding {
  const fetchAllowed = IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus].fetchAllowed;

  return {
    adapterBindingId: capability.adapterBindingId,
    providerId,
    actionFamilyId: "status",
    implementationStatus: capability.implementationStatus,
    sourceProofStatus: capability.sourceProofStatus,
    credentialClass: capability.credentialClass,
    fetchAllowed,
    sourceAccess: fetchAllowed ? "source-fetch" : "source-gated",
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    retryOwner: "scheduler",
    errorOwner: "shared-errors",
    displayOwner: "display-boundary",
    fetch: createSourceGatedStatusFetch({ providerId, capability }),
  };
}
