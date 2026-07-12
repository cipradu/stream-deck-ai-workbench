import { Context, Effect } from "effect";

import type { NormalizedSnapshot } from "@ai-workbench/contracts";
import type { SanitizedTaggedError } from "@ai-workbench/errors";
import {
  executeRequest,
  requestJsonSchema,
  requestTextBody,
  type HttpExecuteOptions,
  type HttpJsonRequest,
  type RequestJsonSchemaOptions,
} from "@ai-workbench/http";
import type { SchedulerFetchRequest } from "@ai-workbench/scheduler";
import type { GovernorBlocked, GovernorRateLimitNotice, GovernorSourceLease } from "@ai-workbench/scheduler";

import type { AdapterFetchFailure } from "./effect-fetch.js";

/**
 * Adapter-private source/projection declaration for a future admitted source
 * operation. `SourceResult` is deliberately generic only within this package:
 * the governor receives it as opaque work and public scheduler/contracts remain
 * normalized-snapshot-only.
 */
export interface AdapterSourceOperation<SourceResult> {
  readonly sourceIdentity: string;
  readonly normalizedRequestVariant: string;
  readonly source: (
    request: SchedulerFetchRequest,
  ) => Effect.Effect<SourceResult, AdapterFetchFailure, import("@effect/platform").HttpClient.HttpClient>;
  readonly project: (
    sourceResult: SourceResult,
    request: SchedulerFetchRequest,
  ) => Effect.Effect<NormalizedSnapshot, AdapterFetchFailure>;
}

/** Retains adapter-owned source-result typing without exporting it as a product contract. */
export function defineAdapterSourceOperation<SourceResult>(
  operation: AdapterSourceOperation<SourceResult>,
): AdapterSourceOperation<SourceResult> {
  return operation;
}

/**
 * Adapter-internal capability installed only while a source operation is admitted
 * by the request governor. It preserves each helper's original error type and
 * environment, adding only the governor's already-sanitized blocked result.
 * Production source dispatch always installs it before protected I/O starts.
 */
export interface ProviderAdapterAttemptContext {
  readonly attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E | GovernorBlocked, R>;
  readonly reportRateLimit: (notice: GovernorRateLimitNotice) => Effect.Effect<void>;
}

export const ProviderAdapterAttemptContext = Context.GenericTag<ProviderAdapterAttemptContext>(
  "@ai-workbench/provider-adapters/ProviderAdapterAttemptContext",
);

/**
 * Obtains a fresh active-operation permit immediately before a shared one-attempt
 * HTTP helper starts. It neither retries nor classifies failures; those behaviors
 * stay with the existing HTTP helper and provider adapter respectively.
 */
export function governedAttempt<A, E, R>(
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GovernorBlocked, R | ProviderAdapterAttemptContext> {
  return Effect.flatMap(ProviderAdapterAttemptContext, (context) => context.attempt(operation));
}

/**
 * Adapter-owned capability for a source flight that already holds a governor
 * source lease. Unlike the current optional context above, this additive seam
 * exposes the governor's typed admission result so no failure is erased or
 * converted before the future runtime composition chooses its boundary.
 */
export interface GovernorBackedAttemptContext {
  readonly attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E | GovernorBlocked, R>;
  readonly reportRateLimit: (notice: GovernorRateLimitNotice) => Effect.Effect<void>;
}

/**
 * Brackets exactly one adapter attempt with a fresh governor permit. The
 * original success, error, and environment channels are retained; governor
 * admission can add only its existing typed blocked result.
 */
export function makeGovernorBackedAttemptContext(lease: GovernorSourceLease): GovernorBackedAttemptContext {
  return {
    attempt: <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | GovernorBlocked, R> =>
      Effect.scoped(
        Effect.gen(function* () {
          const permit = yield* lease.acquireAttempt();
          return yield* operation.pipe(Effect.ensuring(permit.release()));
        }),
      ),
    reportRateLimit: (notice) => lease.reportRateLimit(notice),
  };
}

/**
 * Reports only the already-sanitized rate-limit notice before preserving the
 * adapter's original failure. Non-rate failures never reach the governor's
 * cooldown channel.
 */
export function governedAdapterFetchAttempt<A, R>(
  context: GovernorBackedAttemptContext,
  operation: Effect.Effect<A, AdapterFetchFailure, R>,
): Effect.Effect<A, AdapterFetchFailure | GovernorBlocked, R> {
  return context.attempt(
    operation.pipe(
      Effect.tapError((failure) => {
        if (failure.failure.category !== "rate-limited") {
          return Effect.void;
        }
        const retryAfterSeconds = failure.retry?.retryAfterSeconds;
        return context.reportRateLimit(retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
      }),
    ),
  );
}

function governedTaggedAttempt<A, R>(
  operation: Effect.Effect<A, SanitizedTaggedError, R>,
): Effect.Effect<A, SanitizedTaggedError | GovernorBlocked, R | ProviderAdapterAttemptContext> {
  return Effect.flatMap(ProviderAdapterAttemptContext, (context) =>
    context.attempt(
      operation.pipe(
        Effect.tapError((failure) =>
          failure._tag === "RateLimited"
            ? context.reportRateLimit(
                failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds },
              )
            : Effect.void,
        ),
      ),
    ),
  );
}

export function governedRequestJsonSchema<A, I, R>(
  request: HttpJsonRequest,
  schema: import("effect").Schema.Schema<A, I, R>,
  options: RequestJsonSchemaOptions = {},
) {
  return governedTaggedAttempt(requestJsonSchema(request, schema, options));
}

export function governedRequestTextBody(request: HttpJsonRequest, options: RequestJsonSchemaOptions = {}) {
  return governedTaggedAttempt(requestTextBody(request, options));
}

export function governedExecuteRequest(
  request: import("@effect/platform").HttpClientRequest.HttpClientRequest,
  options: HttpExecuteOptions = {},
) {
  return governedAttempt(executeRequest(request, options));
}
