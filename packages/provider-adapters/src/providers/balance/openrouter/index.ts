import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { NumberOrStringSchema, balanceSnapshotResult, numberFromProviderValue, parseBalanceResponse } from "../../../balance-normalization.js";
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

const providerId = "openrouter" as const;

const OpenRouterBalanceResponseSchema = Schema.Struct({
  data: Schema.Struct({
    total_credits: NumberOrStringSchema,
    total_usage: NumberOrStringSchema,
  }),
});

export const openrouterBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal }) =>
        governedRequestJsonSchema(
          {
            url: new URL("/api/v1/credits", baseUrl),
            headers: { authorization: `Bearer ${Redacted.value(credential.value)}` },
            signal,
          },
          OpenRouterBalanceResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: openrouterBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(OpenRouterBalanceResponseSchema, input, "balance-openrouter-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    return balanceSnapshotResult(
      input,
      numberFromProviderValue(parsed.value.data.total_credits) - numberFromProviderValue(parsed.value.data.total_usage),
    );
  },
} as const;
