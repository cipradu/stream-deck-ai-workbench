import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS, requestJsonSchema } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, parseBalanceResponse } from "../../../balance-normalization.js";
import { createBalanceSourceFetchEffect } from "../../../balance-source-fetch.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import type { EffectBalanceSchedulerFetch } from "../../../effect-fetch.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "fal" as const;

const FalBalanceResponseSchema = Schema.Struct({
  credits: Schema.Struct({
    current_balance: Schema.Number,
    currency: Schema.optional(Schema.String),
  }),
});

export const falBalanceProviderModule = {
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
            url: new URL("/v1/account/billing?expand=credits", baseUrl),
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { authorization: `Key ${Redacted.value(credential.value)}` },
            signal,
          },
          FalBalanceResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: falBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(FalBalanceResponseSchema, input, "balance-fal-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    return balanceSnapshotResult(input, parsed.value.credits.current_balance, parsed.value.credits.currency);
  },
} as const;
