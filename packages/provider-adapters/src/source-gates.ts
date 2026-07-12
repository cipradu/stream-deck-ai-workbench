import type { UsageWindowId } from "@ai-workbench/contracts";
import { IMPLEMENTATION_STATUS_BEHAVIOR, type ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import type { SchedulerFetch } from "@ai-workbench/scheduler";
import { Effect } from "effect";

import type { AdapterFetchFailure, EffectSchedulerFetch } from "./effect-fetch.js";
import { gatedFailure, noSourceConfigured, unsupportedFetchFailure } from "./provider-failures.js";
import type { CreateSourceGatedBalanceFetchInput, CreateSourceGatedUsageFetchInput } from "./types.js";

export interface CreateSourceGatedUsageFetchEffectInput extends Omit<CreateSourceGatedUsageFetchInput, "sourceFetch"> {
  readonly sourceFetch?: EffectSchedulerFetch;
}

export interface CreateSourceGatedBalanceFetchEffectInput extends Omit<CreateSourceGatedBalanceFetchInput, "sourceFetch"> {
  readonly sourceFetch?: EffectSchedulerFetch;
}

export function createSourceGatedUsageFetch(input: CreateSourceGatedUsageFetchInput): SchedulerFetch {
  return (request) => {
    if (
      request.keyParts.familyId !== "usage" ||
      request.keyParts.providerId !== input.providerId ||
      !isSupportedUsageWindow(input.capability, request.keyParts.windowOrPeriod)
    ) {
      return unsupportedFetchFailure("unsupported-usage-window");
    }

    if (!IMPLEMENTATION_STATUS_BEHAVIOR[input.capability.implementationStatus].fetchAllowed) {
      return {
        ok: false,
        failure: gatedFailure(input.capability),
      };
    }

    return input.sourceFetch?.(request) ?? noSourceConfigured("usage-source-not-configured");
  };
}

export function createSourceGatedBalanceFetch(input: CreateSourceGatedBalanceFetchInput): SchedulerFetch {
  return (request) => {
    if (
      request.keyParts.familyId !== "balance" ||
      request.keyParts.providerId !== input.providerId ||
      !isSupportedBalanceCoverage(input.capability, request.keyParts.windowOrPeriod)
    ) {
      return unsupportedFetchFailure("unsupported-balance-coverage");
    }

    if (!IMPLEMENTATION_STATUS_BEHAVIOR[input.capability.implementationStatus].fetchAllowed) {
      return {
        ok: false,
        failure: gatedFailure(input.capability),
      };
    }

    return input.sourceFetch?.(request) ?? noSourceConfigured("balance-source-not-configured");
  };
}

/**
 * Effect-native source gate: the same registry status/coverage gating as the Promise
 * variant, but returning an `Effect` the scheduler fibers consume DIRECTLY (no `runPromise` bridge).
 * Gated/unsupported/no-source states fail in the Effect error channel with the plain sanitized
 * failure; an allowed provider delegates to its Effect-native source fetch.
 */
export function createSourceGatedUsageFetchEffect(input: CreateSourceGatedUsageFetchEffectInput): EffectSchedulerFetch {
  return (request) => {
    if (
      request.keyParts.familyId !== "usage" ||
      request.keyParts.providerId !== input.providerId ||
      !isSupportedUsageWindow(input.capability, request.keyParts.windowOrPeriod)
    ) {
      return Effect.fail<AdapterFetchFailure>({ failure: unsupportedFetchFailure("unsupported-usage-window").failure });
    }

    if (!IMPLEMENTATION_STATUS_BEHAVIOR[input.capability.implementationStatus].fetchAllowed) {
      return Effect.fail<AdapterFetchFailure>({ failure: gatedFailure(input.capability) });
    }

    return input.sourceFetch?.(request) ?? Effect.fail<AdapterFetchFailure>({ failure: noSourceConfigured("usage-source-not-configured").failure });
  };
}

export function createSourceGatedBalanceFetchEffect(input: CreateSourceGatedBalanceFetchEffectInput): EffectSchedulerFetch {
  return (request) => {
    if (
      request.keyParts.familyId !== "balance" ||
      request.keyParts.providerId !== input.providerId ||
      !isSupportedBalanceCoverage(input.capability, request.keyParts.windowOrPeriod)
    ) {
      return Effect.fail<AdapterFetchFailure>({ failure: unsupportedFetchFailure("unsupported-balance-coverage").failure });
    }

    if (!IMPLEMENTATION_STATUS_BEHAVIOR[input.capability.implementationStatus].fetchAllowed) {
      return Effect.fail<AdapterFetchFailure>({ failure: gatedFailure(input.capability) });
    }

    return input.sourceFetch?.(request) ?? Effect.fail<AdapterFetchFailure>({ failure: noSourceConfigured("balance-source-not-configured").failure });
  };
}

function isSupportedUsageWindow(
  capability: ProviderCapabilityMetadata,
  windowOrPeriod: string | undefined,
): windowOrPeriod is UsageWindowId {
  return capability.supportedWindows?.includes(windowOrPeriod as UsageWindowId) ?? false;
}

function isSupportedBalanceCoverage(capability: ProviderCapabilityMetadata, windowOrPeriod: string | undefined): boolean {
  if (capability.actionFamilyId !== "balance") {
    return false;
  }

  return windowOrPeriod === undefined || windowOrPeriod === capability.coverageKind;
}
