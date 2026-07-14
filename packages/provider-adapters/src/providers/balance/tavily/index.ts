import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, parseBalanceResponse } from "../../../balance-normalization.js";
import { createBalanceSourceFetchEffect } from "../../../balance-source-fetch.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import type { EffectBalanceSchedulerFetch } from "../../../effect-fetch.js";
import { governedRequestJsonSchema } from "../../../governed-request.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "tavily" as const;

const NullableNumberSchema = Schema.NullOr(Schema.Number);

const TavilyUsageResponseSchema = Schema.Struct({
  account: Schema.Struct({
    plan_usage: Schema.optional(NullableNumberSchema),
    plan_limit: Schema.optional(NullableNumberSchema),
    paygo_usage: Schema.optional(NullableNumberSchema),
    paygo_limit: Schema.optional(NullableNumberSchema),
  }),
  key: Schema.optional(Schema.Unknown),
});

export const tavilyBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: an `Effect`
  // program that consumes the `@effect/platform` `HttpClient`, builds the request with the
  // credential, decodes at the source via `requestJsonSchema` (central one-read JSON decoder, ONE attempt,
  // NO retry), and yields the plain normalized snapshot. The Effect-native scheduler consumes
  // this adapter Effect directly (no Promise bridge on the live path); the scheduler remains the
  // single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal }) =>
        governedRequestJsonSchema(
          {
            url: new URL("/usage", baseUrl),
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { authorization: `Bearer ${Redacted.value(credential.value)}` },
            signal,
          },
          TavilyUsageResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: tavilyBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(TavilyUsageResponseSchema, input, "balance-tavily-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    const account = parsed.value.account;
    // Tavily bills the monthly plan first, then pay-as-you-go once the plan is
    // exhausted, so `paygo_usage` already accounts for the plan overflow. The plan
    // term stays zero-capped: a spent plan is normal (that is what paygo is for),
    // and adding its deficit would double-count the same spend paygo already reports.
    const planRemaining = Math.max(0, numberOrZero(account.plan_limit) - numberOrZero(account.plan_usage));
    // The paygo term is deliberately NOT zero-capped: the paygo limit is the account's
    // real ceiling, so when `paygo_usage` exceeds it the remaining goes negative to
    // surface the genuine overage instead of hiding it at zero. But "over" requires a
    // real ceiling — when `paygo_limit` is absent/null the paygo pool is unpriced, so the
    // term contributes 0 rather than reading a bare `-paygo_usage` as a spurious overage.
    const paygoLimit = account.paygo_limit;
    const paygoRemaining =
      typeof paygoLimit === "number" && Number.isFinite(paygoLimit)
        ? paygoLimit - numberOrZero(account.paygo_usage)
        : 0;

    return balanceSnapshotResult(input, planRemaining + paygoRemaining);
  },
} as const;

function numberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
