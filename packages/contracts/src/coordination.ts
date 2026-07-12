import type { ProviderId } from "./providers.js";

/** The conservative scope shared by every source for one provider profile. */
export const DEFAULT_RATE_LIMIT_DOMAIN = "provider-profile" as const;
export type DefaultRateLimitDomain = typeof DEFAULT_RATE_LIMIT_DOMAIN;

/**
 * Static accepted-evidence classifications. They record no source payload,
 * account reference, endpoint, or credential material.
 */
export const COORDINATION_EVIDENCE_SOURCES = [
  "primary-source",
  "local-source",
  "owner-approved-sanitized-probe",
] as const;
export type CoordinationEvidenceSource = (typeof COORDINATION_EVIDENCE_SOURCES)[number];

export interface NoCoordinationEvidence {
  readonly status: "not-required";
}

export interface AcceptedCoordinationEvidence {
  readonly status: "accepted";
  readonly source: CoordinationEvidenceSource;
}

export type CoordinationEvidence = NoCoordinationEvidence | AcceptedCoordinationEvidence;

/** Registry input for the one safe default or a later evidence-backed override. */
export type DeclaredRateLimitDomain =
  | {
      readonly kind: "provider-profile";
      readonly domain: DefaultRateLimitDomain;
      readonly evidence: NoCoordinationEvidence;
    }
  | {
      readonly kind: "evidence-backed";
      readonly domain: string;
      readonly evidence: AcceptedCoordinationEvidence;
    };

/** Registry input for adapter-declared source sharing. */
export type DeclaredSourceSharing =
  | {
      readonly kind: "not-declared";
      readonly evidence: NoCoordinationEvidence;
    }
  | {
      readonly kind: "fan-out";
      readonly evidence: AcceptedCoordinationEvidence;
    };

/** Static provider capability coordination policy before registry validation. */
export interface ProviderCoordinationPolicyDeclaration {
  readonly rateLimitDomain: DeclaredRateLimitDomain;
  readonly sourceSharing: DeclaredSourceSharing;
}

/**
 * Static policy resolved by the provider registry. Source identity remains an
 * adapter declaration so catalog metadata cannot carry executable source data.
 */
export interface ResolvedProviderCoordinationPolicy {
  readonly rateLimitDomain: string;
  readonly sourceIdentity: "adapter-declared";
  readonly sourceSharing: DeclaredSourceSharing["kind"];
  readonly rateLimitDomainEvidence: CoordinationEvidence;
  readonly sourceSharingEvidence: CoordinationEvidence;
}

/** Plain, opaque inputs for a runtime rate-limit scope. */
export interface RateLimitScopeInput {
  readonly providerId: ProviderId;
  readonly credentialProfileId: string;
  readonly credentialGeneration: number;
  readonly rateLimitDomain: string;
}

/** Plain, adapter-declared source identity inputs for later coalescing. */
export interface SourceRequestIdentityInput {
  readonly rateLimitScope: RateLimitScopeInput;
  readonly sourceIdentity: string;
  readonly normalizedRequestVariant: string;
}

/** Canonical opaque key for scope-local pacing and cooldown state. */
export type RateLimitScopeKey = string;

/** Canonical opaque key for exact source-operation coalescing. */
export type SourceRequestIdentityKey = string;

function serializeSegments(segments: readonly (string | number)[]): string {
  return segments.map((segment) => encodeURIComponent(String(segment))).join("|");
}

function isSafeSourceIdentityToken(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

/**
 * Serializes only scope fields. Source identity and request variant are
 * intentionally excluded so distinct sources cannot create distinct scopes.
 */
export function serializeRateLimitScope(parts: RateLimitScopeInput): RateLimitScopeKey {
  return serializeSegments([
    parts.providerId,
    parts.credentialProfileId,
    parts.credentialGeneration,
    parts.rateLimitDomain,
  ]);
}

/** Serializes exact source-operation identity beneath its already-scoped key. */
export function serializeSourceRequestIdentity(parts: SourceRequestIdentityInput): SourceRequestIdentityKey {
  if (!isSafeSourceIdentityToken(parts.sourceIdentity) || !isSafeSourceIdentityToken(parts.normalizedRequestVariant)) {
    throw new Error("Invalid source request identity");
  }

  return serializeSegments([
    serializeRateLimitScope(parts.rateLimitScope),
    parts.sourceIdentity,
    parts.normalizedRequestVariant,
  ]);
}

/** Safe identifiers reserved for central governor policy events. */
export const GOVERNOR_REASON_CODES = ["governor-queue-full"] as const;
export type GovernorReasonCode = (typeof GOVERNOR_REASON_CODES)[number];

export const GOVERNOR_EVENT_IDS = ["admitted", "joined", "queued", "queue-full", "cooldown-applied", "cancelled"] as const;
export type GovernorEventId = (typeof GOVERNOR_EVENT_IDS)[number];
