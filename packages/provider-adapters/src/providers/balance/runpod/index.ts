import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, monthStartEpochMs, parseBalanceResponse, sum } from "../../../balance-normalization.js";
import { createBalanceSourceFetchEffect } from "../../../balance-source-fetch.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import type { EffectBalanceSchedulerFetch } from "../../../effect-fetch.js";
import { governedRequestJsonSchema } from "../../../governed-request.js";
import { semanticValidationFailure } from "../../../provider-failures.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "runpod" as const;

const RunpodBillingResponseSchema = Schema.Struct({
  pods: Schema.optional(Schema.Array(Schema.Struct({ amount: Schema.Number }))),
  endpoints: Schema.optional(Schema.Array(Schema.Struct({ amount: Schema.Number }))),
});

export const runpodBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: a two-call
  // `Effect` program (billing pods + endpoints) that consumes the `@effect/platform`
  // `HttpClient` and decodes each call at the source via `requestJsonSchema` (central one-read JSON decoder,
  // ONE attempt per call, NO retry). Each call's raw JSON is combined and the shared shape is
  // validated by `RunpodBillingResponseSchema` inside `normalize` (as the Promise path did — the
  // individual calls carry no vendor schema). A failed pods call short-circuits before endpoints.
  // The Effect-native scheduler consumes this adapter Effect directly (no Promise bridge on the
  // live path); the scheduler remains the single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal, fetchedAtEpochMs }) =>
        Effect.gen(function* () {
          // The SINGLE `Redacted.value` unwrap for this adapter, REUSED across both billing calls.
          const apiKey = Redacted.value(credential.value);
          const headers = { authorization: `Bearer ${apiKey}` };

          // Runpod's billing-history endpoints define no documented default period when called
          // with no date params, so the no-params spend is not reliably the current period. The
          // owner chose an EXPLICIT current UTC calendar-month range (start of this UTC month
          // through now) so the key deterministically shows this month's spend. "Now" is the
          // scheduler-owned `fetchedAtEpochMs` fetch seam (one canonical instant per fetch cycle,
          // Clock-derived at the scheduler boundary), NOT a second direct Clock read — matching the
          // sibling anthropic-api adapter. Tests pin this instant deterministically via the `now`
          // input override (as anthropic-api's tests do), not a TestClock read here. The UTC month
          // start comes from the shared `monthStartEpochMs` helper; both bounds are sent as RFC3339
          // strings with milliseconds (e.g. 2026-07-01T00:00:00.000Z), the form Runpod accepts.
          const nowMs = fetchedAtEpochMs;
          const startTime = new Date(monthStartEpochMs(nowMs)).toISOString();
          const endTime = new Date(nowMs).toISOString();

          const podsUrl = new URL("/v1/billing/pods", baseUrl);
          podsUrl.searchParams.set("startTime", startTime);
          podsUrl.searchParams.set("endTime", endTime);

          const podsBody = yield* governedRequestJsonSchema(
            { url: podsUrl, headers, signal },
            Schema.Unknown,
            { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
          );

          const endpointsUrl = new URL("/v1/billing/endpoints", baseUrl);
          endpointsUrl.searchParams.set("startTime", startTime);
          endpointsUrl.searchParams.set("endTime", endTime);

          const endpointsBody = yield* governedRequestJsonSchema(
            { url: endpointsUrl, headers, signal },
            Schema.Unknown,
            { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
          );

          return {
            pods: podsBody,
            endpoints: endpointsBody,
          };
        }),
      normalize: runpodBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(RunpodBillingResponseSchema, input, "balance-runpod-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value.pods === undefined || parsed.value.endpoints === undefined) {
      return semanticValidationFailure(input.providerId, "balance-runpod-billing-collections-missing");
    }

    return balanceSnapshotResult(input, sum([...parsed.value.pods, ...parsed.value.endpoints].map((row) => row.amount)), "USD");
  },
} as const;
