import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS, requestJsonSchema } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, monthStartDateString, parseBalanceResponse } from "../../../balance-normalization.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import {
  schedulerFailureFromTagged,
  type AdapterFetchFailure,
  type EffectBalanceSchedulerFetch,
} from "../../../effect-fetch.js";
import { abortSignalForScheduler } from "../../../live-http.js";
import { credentialResolutionFailure, isClientErrorFailure, semanticValidationFailure } from "../../../provider-failures.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "exa" as const;

const ExaUsageResponseSchema = Schema.Struct({
  period: Schema.Struct({
    start: Schema.String,
    end: Schema.String,
  }),
  total_cost_usd: Schema.Number,
  cost_breakdown: Schema.Array(
    Schema.Struct({
      price_id: Schema.optional(Schema.String),
      price_name: Schema.optional(Schema.String),
      quantity: Schema.Number,
      amount_usd: Schema.Number,
    }),
  ),
  metadata: Schema.Struct({
    generated_at: Schema.String,
  }),
});

export const exaBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: a two-step
  // `Effect` program (api-key discovery -> usage) that consumes the `@effect/platform`
  // `HttpClient` and decodes at the source via `requestJsonSchema` (schemaBodyJson, ONE attempt
  // per call, NO retry). The discovered api-key id is cached in this adapter closure exactly as
  // the Promise path did, so repeat calls skip discovery; a 4xx on the usage call invalidates
  // that cache so the next call re-discovers. The Effect-native scheduler consumes this adapter
  // Effect directly (no Promise bridge on the live path); the scheduler remains the single retry
  // owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    let cachedApiKeyId: string | undefined;

    return (request) =>
      Effect.gen(function* () {
        const resolution = yield* Effect.tryPromise({
          try: async () => input.resolveCredential(),
          catch: (): AdapterFetchFailure => ({ failure: credentialResolutionFailure(providerId) }),
        });
        if (!resolution.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({ failure: resolution.failure });
        }

        // The SINGLE `Redacted.value` unwrap for this adapter, REUSED across the api-key
        // discovery and usage calls (never unwrapped per call).
        const apiKey = Redacted.value(resolution.value.value);
        const headers = { "x-api-key": apiKey };
        const signal = abortSignalForScheduler(request.signal);
        const fetchedAtEpochMs = input.now?.() ?? request.startedAtEpochMs;

        // Local narrowable copy: `cachedApiKeyId` is reassigned inside the usage-call error
        // tap (a nested function), which would defeat TS narrowing on it directly.
        let apiKeyId = cachedApiKeyId;
        if (apiKeyId === undefined) {
          const apiKeysBody = yield* requestJsonSchema(
            { url: new URL("/team-management/api-keys", input.baseUrl), headers, signal },
            // The discovery response has no vendor schema in the original adapter; it applies
            // the `firstApiKeyId` heuristic to the raw decoded JSON, preserved verbatim here.
            Schema.Unknown,
            { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
          ).pipe(Effect.mapError(schedulerFailureFromTagged));

          apiKeyId = firstApiKeyId(apiKeysBody);
          if (apiKeyId === undefined) {
            const discovery = semanticValidationFailure(providerId, "balance-exa-api-key-discovery-schema");
            if (discovery.ok) {
              return discovery.snapshot;
            }
            return yield* Effect.fail<AdapterFetchFailure>({ failure: discovery.failure });
          }
          cachedApiKeyId = apiKeyId;
        }

        const usageUrl = new URL(`/team-management/api-keys/${encodeURIComponent(apiKeyId)}/usage`, input.baseUrl);
        usageUrl.searchParams.set("start_date", monthStartDateString(fetchedAtEpochMs));
        const usageBody = yield* requestJsonSchema(
          { url: usageUrl, headers, signal },
          ExaUsageResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ).pipe(
          // A 4xx on the usage call means the cached api-key id is stale/unusable (the Promise
          // path reset `cachedApiKeyId` on any 400-499); invalidate it so the next call
          // re-discovers. See `isClientErrorFailure` for the taxonomy-to-4xx mapping.
          Effect.tapError((taggedError) =>
            Effect.sync(() => {
              if (isClientErrorFailure(taggedError)) {
                cachedApiKeyId = undefined;
              }
            }),
          ),
          Effect.mapError(schedulerFailureFromTagged),
        );

        const normalized = exaBalanceProviderModule.normalize({
          providerId,
          response: usageBody,
          fetchedAtEpochMs,
        });
        if (!normalized.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({ failure: normalized.failure });
        }

        return normalized.snapshot;
      });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(ExaUsageResponseSchema, input, "balance-exa-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    // Coverage end = the echoed period end (response-derived, never assumed).
    const periodEndMs = Date.parse(parsed.value.period.end);
    return balanceSnapshotResult(input, parsed.value.total_cost_usd, "USD", {
      ...(Number.isFinite(periodEndMs) ? { dataThroughEpochMs: periodEndMs } : {}),
    });
  },
} as const;

function firstApiKeyId(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.apiKeys)) {
    return undefined;
  }

  const firstKey = response.apiKeys[0];
  if (!isRecord(firstKey)) {
    return undefined;
  }

  return typeof firstKey.id === "string" && firstKey.id.length > 0 ? firstKey.id : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
