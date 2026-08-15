import type { BalanceProviderId } from "@ai-workbench/contracts";
import {
  createSanitizedFailure,
  mapProviderFailure,
  type SanitizedFailure,
  type SanitizedTaggedError,
} from "@ai-workbench/errors";
import type {
  ProviderCapabilityMetadata,
  StatusProviderCapabilityMetadata,
} from "@ai-workbench/provider-registry";
import type { SchedulerFetchResult } from "@ai-workbench/scheduler";

import type { BalanceProviderNormalizationResult } from "./types.js";

export function gatedFailure(
  capability: ProviderCapabilityMetadata | StatusProviderCapabilityMetadata,
): SanitizedFailure {
  return mapProviderFailure(providerFailureForCapability(capability));
}

type SchedulerFetchFailureResult = Extract<SchedulerFetchResult, { readonly ok: false }>;

export function unsupportedFetchFailure(reasonCode: string): SchedulerFetchFailureResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "unsupported",
      providerFailureClass: "unsupported",
      reasonCode,
    }),
  };
}

export function noSourceConfigured(reasonCode: string): SchedulerFetchFailureResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "no-data",
      providerFailureClass: "no-data",
      reasonCode,
    }),
  };
}

export function missingCredentialsFetchFailure(reasonCode: string): SchedulerFetchFailureResult {
  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "missing-credentials",
      diagnostics: {
        boundary: "provider-adapters",
        reasonCode,
      },
      provider: {
        failureClass: "credentials",
        reasonCode,
      },
    }),
  };
}

export function semanticValidationFetchFailure(reasonCode: string): SchedulerFetchFailureResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "validation",
      providerFailureClass: "validation",
      reasonCode,
    }),
  };
}

export function unsupportedNormalizationFailure(reasonCode: string): BalanceProviderNormalizationResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "unsupported",
      providerFailureClass: "unsupported",
      reasonCode,
    }),
  };
}

export function probeRequiredNormalizationFailure(
  providerId: BalanceProviderId,
  reasonCode: string,
): BalanceProviderNormalizationResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "probe-required",
      providerFailureClass: "probe-required",
      reasonCode: `balance-${providerId}-${reasonCode}`,
    }),
  };
}

export function semanticValidationFailure(
  providerId: BalanceProviderId,
  reasonCode: string,
): BalanceProviderNormalizationResult {
  return {
    ok: false,
    failure: mapProviderFailure({
      kind: "validation",
      providerFailureClass: "validation",
      reasonCode,
    }),
  };
}

function providerFailureForCapability(
  capability: ProviderCapabilityMetadata | StatusProviderCapabilityMetadata,
): Parameters<typeof mapProviderFailure>[0] {
  if (capability.implementationStatus === "unsupported" || capability.sourceProofStatus === "unsupported") {
    return {
      kind: "unsupported",
      providerFailureClass: "unsupported",
      reasonCode: "unsupported-capability",
    };
  }

  if (capability.sourceProofStatus === "decisionGated") {
    return {
      kind: "probe-required",
      providerFailureClass: "probe-required",
      reasonCode: "decision-gated",
    };
  }

  if (capability.implementationStatus === "probeRequired" || capability.sourceProofStatus === "probeRequired") {
    return {
      kind: "probe-required",
      providerFailureClass: "probe-required",
      reasonCode: "probe-required",
    };
  }

  if (capability.sourceProofStatus === "sourceProofRequired") {
    return {
      kind: "not-implemented",
      providerFailureClass: "not-implemented",
      reasonCode: "source-proof-required",
    };
  }

  return {
    kind: "not-implemented",
    providerFailureClass: "not-implemented",
    reasonCode: "not-implemented",
  };
}

/**
 * The sanitized failure for a rejected credential resolver, shared across every Balance
 * adapter (consolidation). The boundary is derived from the provider id,
 * byte-identical to each adapter's former local copy (`provider-adapters-${providerId}`).
 * No cause crosses.
 */
export function credentialResolutionFailure(providerId: BalanceProviderId): SanitizedFailure {
  return createSanitizedFailure({
    category: "unknown-sanitized-failure",
    diagnostics: {
      boundary: `provider-adapters-${providerId}`,
      issueCount: 1,
      reasonCode: "credential-resolution-failed",
    },
    provider: {
      failureClass: "unknown",
      reasonCode: "credential-resolution-failed",
    },
  });
}

/**
 * True for the tagged errors that correspond to an HTTP 4xx client error, mirroring the
 * Promise path's `status >= 400 && status < 500` cache-reset guard through the shared
 * `Data.TaggedError` taxonomy. 401/403/429 are inherently 4xx; a generic `HttpStatusFailure`
 * carries its `statusClass`. (408 collapses into `Timeout`, indistinguishable from 504/deadline,
 * so it is intentionally excluded — a transient timeout is not a stale-id signal.)
 *
 * Shared by the discovery Balance adapters (exa, deepgram) whose cached discovery id is
 * invalidated on a 4xx of the follow-up call (consolidation).
 */
export function isClientErrorFailure(error: SanitizedTaggedError): boolean {
  switch (error._tag) {
    case "UnauthorizedExpired":
    case "InsufficientCredentialScope":
    case "RateLimited":
      return true;
    case "HttpStatusFailure":
      return error.statusClass === "4xx";
    default:
      return false;
  }
}
