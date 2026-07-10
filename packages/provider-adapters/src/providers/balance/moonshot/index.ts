import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS, requestJsonSchema } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { NumberOrStringSchema, balanceSnapshotResult, numberFromProviderValue, parseBalanceResponse } from "../../../balance-normalization.js";
import { createBalanceSourceFetchEffect } from "../../../balance-source-fetch.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import type { EffectBalanceSchedulerFetch } from "../../../effect-fetch.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "moonshot" as const;

const MoonshotBalanceResponseSchema = Schema.Struct({
  data: Schema.Struct({
    available_balance: NumberOrStringSchema,
    voucher_balance: Schema.optional(NumberOrStringSchema),
    cash_balance: Schema.optional(NumberOrStringSchema),
  }),
});

export const moonshotBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: an `Effect`
  // program that consumes the `@effect/platform` `HttpClient`, builds the request with the
  // credential, decodes at the source via `requestJsonSchema` (schemaBodyJson, ONE attempt,
  // NO retry), and yields the plain normalized snapshot. The Effect-native scheduler consumes
  // this adapter Effect directly (no Promise bridge on the live path); the scheduler remains the
  // single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal }) =>
        requestJsonSchema(
          {
            url: new URL("/v1/users/me/balance", baseUrl),
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { authorization: `Bearer ${Redacted.value(credential.value)}` },
            signal,
          },
          MoonshotBalanceResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: moonshotBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(MoonshotBalanceResponseSchema, input, "balance-moonshot-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    return balanceSnapshotResult(input, numberFromProviderValue(parsed.value.data.available_balance));
  },
} as const;
