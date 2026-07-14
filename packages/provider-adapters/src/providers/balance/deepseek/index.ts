import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { NumberOrStringSchema, balanceSnapshotResult, numberFromProviderValue, parseBalanceResponse } from "../../../balance-normalization.js";
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

const providerId = "deepseek" as const;

const DeepSeekBalanceResponseSchema = Schema.Struct({
  is_available: Schema.Boolean,
  balance_infos: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      total_balance: NumberOrStringSchema,
      granted_balance: Schema.optional(NumberOrStringSchema),
      topped_up_balance: Schema.optional(NumberOrStringSchema),
    }),
  ),
});

export const deepseekBalanceProviderModule = {
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
            url: new URL("/user/balance", baseUrl),
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { authorization: `Bearer ${Redacted.value(credential.value)}` },
            signal,
          },
          DeepSeekBalanceResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: deepseekBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(DeepSeekBalanceResponseSchema, input, "balance-deepseek-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    const primaryBalance = parsed.value.balance_infos[0];
    if (primaryBalance === undefined) {
      return semanticValidationFailure(input.providerId, "balance-deepseek-empty-balance-infos");
    }

    // The FIRST vendor-reported entry is prominent; further entries surface as
    // the renderer's dim "+N" marker (old working behavior).
    return balanceSnapshotResult(input, numberFromProviderValue(primaryBalance.total_balance), primaryBalance.currency, {
      extraCurrencies: parsed.value.balance_infos.length - 1,
    });
  },
} as const;
