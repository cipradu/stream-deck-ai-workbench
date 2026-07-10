import { Effect } from "effect";
import { HttpClient as PlatformHttpClient } from "@effect/platform";

import type { NormalizedSnapshot } from "@ai-workbench/contracts";
import { taggedFailureToSanitizedFailure, type SanitizedTaggedError } from "@ai-workbench/errors";
import type { SchedulerFetchRequest, SchedulerFetchResult } from "@ai-workbench/scheduler";

// ---------------------------------------------------------------------------
// Effect-native adapter source-fetch shape + tagged->plain failure mapping.
//
// A migrated adapter is an `Effect` program that consumes the `@effect/platform`
// `HttpClient` and decodes at the source via `packages/http`'s `requestJsonSchema`
// (schemaBodyJson, ONE attempt, NO retry). This module defines the shared shape of that
// program (`Effect*SchedulerFetch`, leaving `HttpClient` in the context channel for its
// consumer to satisfy) and the tagged->plain failure mapping (`schedulerFailureFromTagged`).
// The Effect-native scheduler consumes these adapter Effects DIRECTLY — it provides
// the `HttpClient` layer and runs them as fibers — so there is NO Promise bridge on the live
// path. The scheduler remains the single retry owner.
// ---------------------------------------------------------------------------

type SchedulerFetchFailureResult = Extract<SchedulerFetchResult, { readonly ok: false }>;

/**
 * The failure the adapter Effect fails with: the plain `SanitizedFailure` plus the
 * optional rate-limit retry hint, i.e. the `SchedulerFetchResult` failure minus its
 * `ok` discriminant. Keeping the plain failure here (rather than a raw tagged error)
 * preserves the exact category of credential and normalization failures and the
 * `Retry-After` seconds of an HTTP rate-limit, with no lossy plain<->tagged round-trip.
 */
export type AdapterFetchFailure = Omit<SchedulerFetchFailureResult, "ok">;

/**
 * A provider Effect-native source fetch, family-neutral: builds and runs one HTTP attempt via
 * the `@effect/platform` `HttpClient`, decodes at the source, and yields the plain normalized
 * snapshot or an `AdapterFetchFailure`. The `NormalizedSnapshot` union is shared across action
 * families, so Balance and Usage adapters share this exact shape.
 * `HttpClient` is left in the context channel for the Effect-native scheduler to satisfy. The
 * per-family aliases name the seam each family's adapters and dispatch reference.
 */
export type EffectSchedulerFetch = (
  request: SchedulerFetchRequest,
) => Effect.Effect<NormalizedSnapshot, AdapterFetchFailure, PlatformHttpClient.HttpClient>;

/** Balance adapters' Effect-native source fetch. */
export type EffectBalanceSchedulerFetch = EffectSchedulerFetch;

/** Usage adapters' Effect-native source fetch; the pure-HTTP z.ai adapter today. */
export type EffectUsageSchedulerFetch = EffectSchedulerFetch;

/**
 * Maps the shared HTTP `Data.TaggedError` taxonomy to the plain adapter failure the
 * scheduler consumes, preserving a rate-limit `Retry-After` (the only tagged field the
 * plain `SanitizedFailure` cannot carry). Mirrors the Promise helper's exit mapping in
 * `packages/http` so both surfaces classify identically. No raw `Cause` crosses.
 */
export function schedulerFailureFromTagged(error: SanitizedTaggedError): AdapterFetchFailure {
  const failure = taggedFailureToSanitizedFailure(error);
  return error._tag === "RateLimited" && error.retryAfterSeconds !== undefined
    ? { failure, retry: { retryAfterSeconds: error.retryAfterSeconds } }
    : { failure };
}
