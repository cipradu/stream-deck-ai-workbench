import { Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { balanceSnapshotResult, monthStartDateString, parseBalanceResponse, sum } from "../../../balance-normalization.js";
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

const providerId = "speechmatics" as const;

const SpeechmaticsUsageResponseSchema = Schema.Struct({
  since: Schema.String,
  until: Schema.String,
  summary: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        mode: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
        language: Schema.optional(Schema.String),
        operating_point: Schema.optional(Schema.String),
        count: Schema.Number,
        duration_hrs: Schema.Number,
      }),
    ),
  ),
  details: Schema.NullOr(Schema.Array(Schema.Unknown)),
});

export const speechmaticsBalanceProviderModule = {
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
      fetchBody: (credential, { baseUrl, signal, fetchedAtEpochMs }) => {
        const url = new URL("/v2/usage", baseUrl);
        url.searchParams.set("since", monthStartDateString(fetchedAtEpochMs));
        return governedRequestJsonSchema(
          {
            url,
            // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
            headers: { authorization: `Bearer ${Redacted.value(credential.value)}` },
            signal,
          },
          SpeechmaticsUsageResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        );
      },
      normalize: speechmaticsBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(SpeechmaticsUsageResponseSchema, input, "balance-speechmatics-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    // Coverage end = end of the echoed `until` day; the API always excludes
    // the current day, so the marker is honest (old working behavior).
    const dataThroughEpochMs = endOfUtcDay(parsed.value.until);
    return balanceSnapshotResult(input, parsed.value.summary === null ? 0 : sum(parsed.value.summary.map((item) => item.duration_hrs)), undefined, {
      ...(dataThroughEpochMs === undefined ? {} : { dataThroughEpochMs }),
    });
  },
} as const;

function endOfUtcDay(until: string): number | undefined {
  const parts = until.split("-").map(Number);
  if (parts.length !== 3 || !parts.every((part) => Number.isFinite(part))) {
    return undefined;
  }
  return Date.UTC(parts[0] as number, (parts[1] as number) - 1, parts[2] as number, 23, 59, 59, 999);
}
