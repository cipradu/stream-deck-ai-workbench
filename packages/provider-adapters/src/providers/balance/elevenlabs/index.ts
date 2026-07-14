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

const providerId = "elevenlabs" as const;

const ElevenLabsSubscriptionResponseSchema = Schema.Struct({
  character_count: Schema.Number,
  character_limit: Schema.Number,
  next_character_count_reset_unix: Schema.optional(Schema.Number),
});

export const elevenlabsBalanceProviderModule = {
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
            url: new URL("/v1/user/subscription", baseUrl),
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { "xi-api-key": Redacted.value(credential.value) },
            signal,
          },
          ElevenLabsSubscriptionResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ),
      normalize: elevenlabsBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(ElevenLabsSubscriptionResponseSchema, input, "balance-elevenlabs-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    const resetUnixSeconds = parsed.value.next_character_count_reset_unix;
    return balanceSnapshotResult(input, parsed.value.character_limit - parsed.value.character_count, undefined, {
      ...(typeof resetUnixSeconds === "number" && Number.isFinite(resetUnixSeconds) && resetUnixSeconds > 0
        ? { resetsAtEpochMs: resetUnixSeconds * 1000 }
        : {}),
    });
  },
} as const;
