import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import {
  NumberOrStringSchema,
  balanceSnapshotResult,
  hasNonEmptyPageToken,
  monthStartDateString,
  numberFromProviderValue,
  parseBalanceResponse,
  sum,
} from "../../../balance-normalization.js";
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

const providerId = "anthropic-api" as const;
const anthropicVersion = "2023-06-01";
const maxPages = 64;

const AnthropicCostReportResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      starting_at: Schema.String,
      ending_at: Schema.optional(Schema.String),
      results: Schema.Array(
        Schema.Struct({
          amount: NumberOrStringSchema,
          currency: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  has_more: Schema.Boolean,
  next_page: Schema.optional(Schema.NullOr(Schema.String)),
});

export const anthropicApiBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: an `Effect`
  // program that consumes the `@effect/platform` `HttpClient`, builds each paged request
  // with the credential, decodes at the source via `requestJsonSchema` (schemaBodyJson,
  // ONE attempt, NO retry), and yields the plain normalized snapshot. The Effect-native scheduler
  // consumes this adapter Effect directly (no Promise bridge on the live path); the scheduler
  // remains the single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal, fetchedAtEpochMs }) =>
        Effect.gen(function* () {
          // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
          const apiKey = Redacted.value(credential.value);

          const data: unknown[] = [];
          let nextPage: string | undefined;
          let complete = false;
          for (let page = 0; page < maxPages; page += 1) {
            const url = new URL("/v1/organizations/cost_report", baseUrl);
            url.searchParams.set("starting_at", `${monthStartDateString(fetchedAtEpochMs)}T00:00:00Z`);
            url.searchParams.set("bucket_width", "1d");
            if (nextPage !== undefined) {
              url.searchParams.set("page", nextPage);
            }

            const pageBody = yield* governedRequestJsonSchema(
              {
                url,
                headers: {
                  "anthropic-version": anthropicVersion,
                  "x-api-key": apiKey,
                },
                signal,
              },
              AnthropicCostReportResponseSchema,
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
      normalize: anthropicApiBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(AnthropicCostReportResponseSchema, input, "balance-anthropic-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value.has_more || hasNonEmptyPageToken(parsed.value.next_page)) {
      return semanticValidationFailure(input.providerId, "balance-anthropic-pagination-incomplete");
    }

    const lowestUnitValue = sum(
      parsed.value.data.flatMap((bucket) => bucket.results.map((result) => numberFromProviderValue(result.amount))),
    );
    const currencyCode = parsed.value.data.flatMap((bucket) => bucket.results).find((result) => result.currency !== undefined)?.currency;
    // Coverage end = the last bucket's ending_at (response-derived, never assumed).
    const lastEndingAt = parsed.value.data.reduce<number | undefined>((latest, bucket) => {
      const endMs = bucket.ending_at === undefined ? Number.NaN : Date.parse(bucket.ending_at);
      return Number.isFinite(endMs) && (latest === undefined || endMs > latest) ? endMs : latest;
    }, undefined);
    return balanceSnapshotResult(input, lowestUnitValue / 100, currencyCode, {
      ...(lastEndingAt === undefined ? {} : { dataThroughEpochMs: lastEndingAt }),
    });
  },
} as const;
