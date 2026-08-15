import {
  BALANCE_PROVIDER_IDS,
  STATUS_PROVIDER_IDS,
  USAGE_PROVIDER_IDS,
  type BalanceProviderId,
  type StatusProviderId,
  type UsageProviderId,
} from "@ai-workbench/contracts";
import { listProviderEntriesForFamily } from "@ai-workbench/provider-registry";

import { balanceProviderModules } from "./providers/balance/index.js";
import { statusProviderModules } from "./providers/status/index.js";
import { usageProviderModules } from "./providers/usage/index.js";
import type {
  BalanceProviderAdapterBinding,
  ProviderAdapterBinding,
  StatusProviderAdapterBinding,
  UsageProviderAdapterBinding,
} from "./types.js";

export function listUsageProviderAdapterBindings(): readonly UsageProviderAdapterBinding[] {
  return listProviderEntriesForFamily("usage").flatMap((entry) => {
    const providerId = entry.providerId;

    if (!isUsageProviderId(providerId)) {
      return [];
    }

    const providerModule = usageProviderModules.find((candidate) => candidate.providerId === providerId);
    if (providerModule === undefined) {
      return [];
    }

    return entry.capabilities
      .filter((capability) => capability.actionFamilyId === "usage")
      .map((capability) => providerModule.createBinding(capability));
  });
}

export function listBalanceProviderAdapterBindings(): readonly BalanceProviderAdapterBinding[] {
  return listProviderEntriesForFamily("balance").flatMap((entry) => {
    const providerId = entry.providerId;

    if (!isBalanceProviderId(providerId)) {
      return [];
    }

    const providerModule = balanceProviderModules.find((candidate) => candidate.providerId === providerId);
    if (providerModule === undefined) {
      return [];
    }

    return entry.capabilities
      .filter((capability) => capability.actionFamilyId === "balance")
      .map((capability) => providerModule.createBinding(capability));
  });
}

export function listStatusProviderAdapterBindings(): readonly StatusProviderAdapterBinding[] {
  return listProviderEntriesForFamily("status").flatMap((entry) => {
    const providerId = entry.providerId;

    if (!isStatusProviderId(providerId)) {
      return [];
    }

    const providerModule = statusProviderModules.find((candidate) => candidate.providerId === providerId);
    if (providerModule === undefined) {
      return [];
    }

    return entry.capabilities
      .filter((capability) => capability.actionFamilyId === "status")
      .map((capability) => providerModule.createBinding(capability));
  });
}

export function findProviderAdapterBinding(adapterBindingId: string): ProviderAdapterBinding | undefined {
  return [...listUsageProviderAdapterBindings(), ...listBalanceProviderAdapterBindings(), ...listStatusProviderAdapterBindings()].find(
    (binding) => binding.adapterBindingId === adapterBindingId,
  );
}

function isStatusProviderId(providerId: string): providerId is StatusProviderId {
  return (STATUS_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isUsageProviderId(providerId: string): providerId is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isBalanceProviderId(providerId: string): providerId is BalanceProviderId {
  return (BALANCE_PROVIDER_IDS as readonly string[]).includes(providerId);
}
