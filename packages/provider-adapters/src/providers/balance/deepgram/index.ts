import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, parseBalanceResponse } from "../../../balance-normalization.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import {
  schedulerFailureFromTagged,
  isGovernorBlocked,
  type AdapterFetchFailure,
  type EffectBalanceSchedulerFetch,
} from "../../../effect-fetch.js";
import { governedRequestJsonSchema } from "../../../governed-request.js";
import { abortSignalForScheduler } from "../../../live-http.js";
import { credentialResolutionFailure, isClientErrorFailure, semanticValidationFailure } from "../../../provider-failures.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "deepgram" as const;

const DeepgramBalancesResponseSchema = Schema.Struct({
  balances: Schema.Array(
    Schema.Struct({
      balance_id: Schema.optional(Schema.String),
      amount: Schema.Number,
      units: Schema.String,
      purchase_order_id: Schema.optional(Schema.String),
    }),
  ),
});

export const deepgramBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: a two-step
  // `Effect` program (project discovery -> balances) that consumes the `@effect/platform`
  // `HttpClient` and decodes at the source via `requestJsonSchema` (central one-read JSON decoder, ONE attempt
  // per call, NO retry). The discovered project id is cached in this adapter closure exactly as
  // the Promise path did, so repeat calls skip discovery; a 4xx on the balances call invalidates
  // that cache so the next call re-discovers. The Effect-native scheduler consumes this adapter
  // Effect directly (no Promise bridge on the live path); the scheduler remains the single retry
  // owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    let cachedProjectId: string | undefined;

    return (request) =>
      Effect.gen(function* () {
        const resolution = yield* Effect.tryPromise({
          try: async () => input.resolveCredential(),
          catch: (): AdapterFetchFailure => ({ failure: credentialResolutionFailure(providerId) }),
        });
        if (!resolution.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({ failure: resolution.failure });
        }

        // The SINGLE `Redacted.value` unwrap for this adapter, REUSED across the project
        // discovery and balances calls (never unwrapped per call).
        const apiKey = Redacted.value(resolution.value.value);
        const headers = { authorization: `Token ${apiKey}` };
        const signal = abortSignalForScheduler(request.signal);
        const fetchedAtEpochMs = input.now?.() ?? request.startedAtEpochMs;

        // Local narrowable copy: `cachedProjectId` is reassigned inside the balances-call
        // error tap (a nested function), which would defeat TS narrowing on it directly.
        let projectId = cachedProjectId;
        if (projectId === undefined) {
          const projectsBody = yield* governedRequestJsonSchema(
            { url: new URL("/v1/projects", input.baseUrl), headers, signal },
            // The discovery response has no vendor schema in the original adapter; it applies
            // the `firstProjectId` heuristic to the raw decoded JSON, preserved verbatim here.
            Schema.Unknown,
            { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
          ).pipe(Effect.mapError(schedulerFailureFromTagged));

          projectId = firstProjectId(projectsBody);
          if (projectId === undefined) {
            const discovery = semanticValidationFailure(providerId, "balance-deepgram-project-discovery-schema");
            if (discovery.ok) {
              return discovery.snapshot;
            }
            return yield* Effect.fail<AdapterFetchFailure>({ failure: discovery.failure });
          }
          cachedProjectId = projectId;
        }

        const balancesBody = yield* governedRequestJsonSchema(
          { url: new URL(`/v1/projects/${encodeURIComponent(projectId)}/balances`, input.baseUrl), headers, signal },
          DeepgramBalancesResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ).pipe(
          // A 4xx on the balances call means the cached project id is stale/unusable (the
          // Promise path reset `cachedProjectId` on any 400-499); invalidate it so the next
          // call re-discovers. See `isClientErrorFailure` for the taxonomy-to-4xx mapping.
          Effect.tapError((taggedError) =>
            Effect.sync(() => {
              if (!isGovernorBlocked(taggedError) && isClientErrorFailure(taggedError)) {
                cachedProjectId = undefined;
              }
            }),
          ),
          Effect.mapError(schedulerFailureFromTagged),
        );

        const normalized = deepgramBalanceProviderModule.normalize({
          providerId,
          response: balancesBody,
          fetchedAtEpochMs,
        });
        if (!normalized.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({ failure: normalized.failure });
        }

        return normalized.snapshot;
      });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(DeepgramBalancesResponseSchema, input, "balance-deepgram-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    // The FIRST balance row is prominent; additional rows become the "+N"
    // marker instead of a summed total (old working behavior).
    const primaryBalance = parsed.value.balances[0];
    if (primaryBalance === undefined) {
      return semanticValidationFailure(input.providerId, "balance-deepgram-empty-balances");
    }

    return balanceSnapshotResult(input, primaryBalance.amount, primaryBalance.units, {
      extraCurrencies: parsed.value.balances.length - 1,
    });
  },
} as const;

function firstProjectId(response: unknown): string | undefined {
  const projects = Array.isArray(response) ? response : isRecord(response) && Array.isArray(response.projects) ? response.projects : undefined;
  const firstProject = projects?.[0];
  if (!isRecord(firstProject)) {
    return undefined;
  }

  const projectId = firstProject.project_id ?? firstProject.id;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
