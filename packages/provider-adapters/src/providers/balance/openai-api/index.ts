import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS, requestJsonSchema } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import {
  NumberOrStringSchema,
  balanceSnapshotResult,
  hasNonEmptyPageToken,
  monthStartEpochMs,
  numberFromProviderValue,
  parseBalanceResponse,
  sum,
} from "../../../balance-normalization.js";
import { createBalanceSourceFetchEffect } from "../../../balance-source-fetch.js";
import { createBalanceProviderAdapterBinding } from "../../../binding-helpers.js";
import type { EffectBalanceSchedulerFetch } from "../../../effect-fetch.js";
import { semanticValidationFailure } from "../../../provider-failures.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../../types.js";

const providerId = "openai-api" as const;
const maxPages = 64;

const OpenAiCostsResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      start_time: Schema.optional(Schema.Number),
      end_time: Schema.optional(Schema.Number),
      results: Schema.Array(
        Schema.Struct({
          amount: Schema.Struct({
            currency: Schema.String,
            value: NumberOrStringSchema,
          }),
        }),
      ),
    }),
  ),
  has_more: Schema.Boolean,
  next_page: Schema.optional(Schema.NullOr(Schema.String)),
});

export const openAiApiBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: the paginating
  // twin of the anthropic adapter. An `Effect` program that consumes the `@effect/platform`
  // `HttpClient`, walks the cost-report pages, decodes each page at the source via
  // `requestJsonSchema` (schemaBodyJson, ONE attempt per page, NO retry), accumulates the
  // buckets, and yields the plain normalized snapshot (pagination completeness is enforced in
  // `normalize`). The Effect-native scheduler consumes this adapter Effect directly (no Promise
  // bridge on the live path); the scheduler remains the single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal, fetchedAtEpochMs }) =>
        Effect.gen(function* () {
          // The SINGLE `Redacted.value` unwrap for this adapter, REUSED across every page.
          const apiKey = Redacted.value(credential.value);
          const headers = { authorization: `Bearer ${apiKey}` };

          const data: unknown[] = [];
          let nextPage: string | undefined;
          let complete = false;
          for (let page = 0; page < maxPages; page += 1) {
            const url = new URL("/v1/organization/costs", baseUrl);
            url.searchParams.set("start_time", String(Math.floor(monthStartEpochMs(fetchedAtEpochMs) / 1000)));
            url.searchParams.set("limit", "31");
            if (nextPage !== undefined) {
              url.searchParams.set("page", nextPage);
            }

            const pageBody = yield* requestJsonSchema(
              { url, headers, signal },
              OpenAiCostsResponseSchema,
              { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
            );

            data.push(...pageBody.data);
            if (!pageBody.has_more && !hasNonEmptyPageToken(pageBody.next_page)) {
              complete = true;
              break;
            }
            nextPage = pageBody.next_page ?? undefined;
            if (nextPage === undefined) {
              break;
            }
          }

          return {
            data,
            has_more: !complete,
            next_page: null,
          };
        }),
      normalize: openAiApiBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(OpenAiCostsResponseSchema, input, "balance-openai-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value.has_more || hasNonEmptyPageToken(parsed.value.next_page)) {
      return semanticValidationFailure(input.providerId, "balance-openai-pagination-incomplete");
    }

    // Coverage end = the last bucket's end_time (epoch seconds, response-derived).
    const lastEndTimeMs = parsed.value.data.reduce<number | undefined>((latest, bucket) => {
      const endMs = typeof bucket.end_time === "number" && Number.isFinite(bucket.end_time) ? bucket.end_time * 1000 : Number.NaN;
      return Number.isFinite(endMs) && (latest === undefined || endMs > latest) ? endMs : latest;
    }, undefined);
    return balanceSnapshotResult(
      input,
      sum(parsed.value.data.flatMap((bucket) => bucket.results.map((result) => numberFromProviderValue(result.amount.value)))),
      parsed.value.data.flatMap((bucket) => bucket.results)[0]?.amount.currency,
      lastEndTimeMs === undefined ? undefined : { dataThroughEpochMs: lastEndTimeMs },
    );
  },
} as const;
