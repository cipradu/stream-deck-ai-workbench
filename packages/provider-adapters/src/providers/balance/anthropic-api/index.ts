import { Effect, Redacted, Schema } from "effect";

import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import {
  NumberOrStringSchema,
  balanceSnapshotResult,
  hasNonEmptyPageToken,
  monthStartDateString,
  monthStartEpochMs,
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
// The Usage and Cost Analytics API is a beta; every request must carry this header.
const anthropicAnalyticsBeta = "analytics-usage-cost-2026-08-24";
const maxPages = 64;

function isFirstUtcDayOfMonth(epochMs: number): boolean {
  return new Date(epochMs).getUTCDate() === 1;
}

// `GET /v1/organizations/analytics/cost` without `group_by` or `time_bucket_width`: one row aggregates
// the whole requested range. `cost.amount` is a decimal string in cents, after discounts and BEFORE any
// credits, so prepaid or promotional credit never reduces it. `data_refreshed_at` is the end of the data
// the vendor has processed (null with empty `data` when no export covers the range yet). Only the
// fields this adapter consumes are declared; everything else (group, list_amount, requests) is ignored.
const AnthropicCostResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      ending_at: Schema.optional(Schema.String),
      cost: Schema.Struct({
        amount: NumberOrStringSchema,
        currency: Schema.optional(Schema.String),
      }),
    }),
  ),
  has_more: Schema.Boolean,
  next_page: Schema.optional(Schema.NullOr(Schema.String)),
  data_refreshed_at: Schema.optional(Schema.NullOr(Schema.String)),
});

export const anthropicApiBalanceProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): BalanceProviderAdapterBinding {
    return createBalanceProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: an `Effect`
  // program that consumes the `@effect/platform` `HttpClient`, builds each paged request
  // with the credential, decodes at the source via `requestJsonSchema` (central one-read JSON decoder,
  // ONE attempt, NO retry), and yields the plain normalized snapshot. The Effect-native scheduler
  // consumes this adapter Effect directly (no Promise bridge on the live path); the scheduler
  // remains the single retry owner.
  createSourceFetchEffect(input: CreateBalanceProviderSourceFetchInput): EffectBalanceSchedulerFetch {
    return createBalanceSourceFetchEffect(input, {
      fetchBody: (credential, { baseUrl, signal, fetchedAtEpochMs }) =>
        Effect.gen(function* () {
          if (isFirstUtcDayOfMonth(fetchedAtEpochMs)) {
            return {
              data: [],
              has_more: false,
              next_page: null,
            };
          }

          // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
          const apiKey = Redacted.value(credential.value);

          const data: unknown[] = [];
          let dataRefreshedAt: string | null | undefined;
          let nextPage: string | undefined;
          let complete = false;
          for (let page = 0; page < maxPages; page += 1) {
            // Month-to-date: only `starting_at` is sent. With no `ending_at` the vendor ends the range at
            // the current hour, and with no `group_by` or `time_bucket_width` it returns one summed row.
            // The range stays within the endpoint's 31-day limit because a calendar month never exceeds it.
            const url = new URL("/v1/organizations/analytics/cost", baseUrl);
            url.searchParams.set("starting_at", `${monthStartDateString(fetchedAtEpochMs)}T00:00:00Z`);
            if (nextPage !== undefined) {
              url.searchParams.set("page", nextPage);
            }

            const pageBody = yield* governedRequestJsonSchema(
              {
                url,
                headers: {
                  "anthropic-beta": anthropicAnalyticsBeta,
                  "anthropic-version": anthropicVersion,
                  "x-api-key": apiKey,
                },
                signal,
              },
              AnthropicCostResponseSchema,
              { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
            );

            data.push(...pageBody.data);
            // Every page reads the same vendor snapshot, so the times should be identical. Should they ever
            // differ, coverage must not claim more than the earliest page processed.
            dataRefreshedAt = earlierTimestamp(dataRefreshedAt, pageBody.data_refreshed_at);
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
            data_refreshed_at: dataRefreshedAt ?? null,
          };
        }),
      normalize: anthropicApiBalanceProviderModule.normalize,
    });
  },
  normalize(input: NormalizeBalanceProviderResponseInput): BalanceProviderNormalizationResult {
    const parsed = parseBalanceResponse(AnthropicCostResponseSchema, input, "balance-anthropic-response-schema");
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value.has_more || hasNonEmptyPageToken(parsed.value.next_page)) {
      return semanticValidationFailure(input.providerId, "balance-anthropic-pagination-incomplete");
    }

    const rows = parsed.value.data;
    const refreshedAtEpochMs = epochMsFromTimestamp(parsed.value.data_refreshed_at);

    if (rows.length === 0) {
      // No cost rows: month-to-date spend is zero, covered through the vendor's processed-through time or,
      // when it has none yet (null or absent, and always on the first UTC day when no request is made), the
      // month start. This must be a successful zero and never a "no data yet" failure: the scheduler would
      // keep the previous month's snapshot and show it as stale across the month boundary (see
      // docs/specs/2026-07-31_23-29_anthropic-first-day-cost-report_spec.md, RISK-002). The renderer's
      // "thru <date>" marker shows how far the data really extends.
      return balanceSnapshotResult(input, 0, undefined, {
        dataThroughEpochMs: refreshedAtEpochMs ?? monthStartEpochMs(input.fetchedAtEpochMs),
      });
    }

    const lowestUnitValue = sum(rows.map((row) => numberFromProviderValue(row.cost.amount)));
    const currencyCode = rows.find((row) => row.cost.currency !== undefined)?.cost.currency;
    // Coverage end = the earlier of the vendor's processed-through time and the last row's exclusive end
    // (both response-derived, never assumed). Data after `data_refreshed_at` is missing or partial.
    const rowEndEpochMs = rows.reduce<number | undefined>((latest, row) => {
      const endMs = epochMsFromTimestamp(row.ending_at);
      return endMs !== undefined && (latest === undefined || endMs > latest) ? endMs : latest;
    }, undefined);
    const coverageEnds = [refreshedAtEpochMs, rowEndEpochMs].filter((value): value is number => value !== undefined);
    const dataThroughEpochMs = coverageEnds.length === 0 ? undefined : Math.min(...coverageEnds);
    return balanceSnapshotResult(input, lowestUnitValue / 100, currencyCode, {
      ...(dataThroughEpochMs === undefined ? {} : { dataThroughEpochMs }),
    });
  },
} as const;

function earlierTimestamp(
  current: string | null | undefined,
  candidate: string | null | undefined,
): string | null | undefined {
  const currentMs = epochMsFromTimestamp(current);
  const candidateMs = epochMsFromTimestamp(candidate);
  if (candidateMs === undefined) {
    return current ?? candidate;
  }
  return currentMs === undefined || candidateMs < currentMs ? candidate : current;
}

function epochMsFromTimestamp(timestamp: string | null | undefined): number | undefined {
  if (timestamp === null || timestamp === undefined) {
    return undefined;
  }
  const epochMs = Date.parse(timestamp);
  return Number.isFinite(epochMs) ? epochMs : undefined;
}
