import type { ActionFamilyId } from "./action-family.js";
import type { CoverageKind, UsageWindowId } from "./metrics.js";
import type { ProviderId } from "./providers.js";

/** Window or period discriminator for scheduler keys, when applicable. */
export type SchedulerWindowOrPeriod = UsageWindowId | CoverageKind;

/**
 * Scheduler key parts: the scheduler key is the provider capability, not an
 * individual Stream Deck key. Instances sharing one key share one in-flight
 * fetch and one cached output.
 */
export interface SchedulerKeyParts {
  readonly familyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly windowOrPeriod?: SchedulerWindowOrPeriod;
  /** Opaque non-secret credential/profile reference id (see CredentialProfileReference). */
  readonly credentialProfileId: string;
  /** Metric/source variant discriminator when one capability has multiple sources. */
  readonly metricVariant?: string;
}

/** Canonical serialized scheduler key. */
export type SchedulerKey = string;

/**
 * Canonical, deterministic, collision-free serialization: each segment is
 * URI-component-encoded (so the `|` delimiter cannot be injected through
 * opaque ids) and absent optional parts serialize as empty segments.
 */
export function serializeSchedulerKey(parts: SchedulerKeyParts): SchedulerKey {
  const segments: readonly string[] = [
    parts.familyId,
    parts.providerId,
    parts.windowOrPeriod ?? "",
    parts.credentialProfileId,
    parts.metricVariant ?? "",
  ];
  return segments.map((segment) => encodeURIComponent(segment)).join("|");
}
