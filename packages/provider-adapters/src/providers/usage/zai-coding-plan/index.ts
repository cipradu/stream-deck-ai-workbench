import { Effect, Redacted, Schema } from "effect";

import type { NormalizedSnapshot, UsageWindowId } from "@ai-workbench/contracts";
import { createSanitizedFailure } from "@ai-workbench/errors";
import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import { createUsageProviderAdapterBinding } from "../../../binding-helpers.js";
import {
  schedulerFailureFromTagged,
  type AdapterFetchFailure,
  type EffectUsageSchedulerFetch,
} from "../../../effect-fetch.js";
import { governedRequestJsonSchema } from "../../../governed-request.js";
import { abortSignalForScheduler } from "../../../live-http.js";
import { noSourceConfigured, semanticValidationFetchFailure } from "../../../provider-failures.js";
import type { CreateUsageProviderSourceFetchInput, UsageProviderAdapterBinding } from "../../../types.js";

const providerId = "zai-coding-plan" as const;

// Entries are individually optional-field tolerant: the old working adapter
// skipped unrecognized (type, unit, number) triples and entries without a
// percentage instead of failing the whole response, and the vendor omits
// fields on idle windows.
const ZaiUsageLimitResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  data: Schema.Struct({
    limits: Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        unit: Schema.optional(Schema.Number),
        number: Schema.optional(Schema.Number),
        percentage: Schema.optional(Schema.Number),
        nextResetTime: Schema.optional(Schema.Number),
      }),
    ),
    level: Schema.optional(Schema.String),
  }),
});

type ZaiLimitEntry = Schema.Schema.Type<typeof ZaiUsageLimitResponseSchema>["data"]["limits"][number];

export const zaiCodingPlanUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: the pure-HTTP
  // Usage mirror of the Balance recipe — an `Effect` program that consumes the `@effect/platform`
  // `HttpClient`, resolves the `Redacted` credential from global settings, builds the single
  // quota request with the raw key at the `authorization` header (the SINGLE `Redacted.value`
  // unwrap), decodes at the source via `requestJsonSchema` (schemaBodyJson, ONE attempt, NO
  // retry), and yields the plain normalized usage snapshot. The window/success/window-absence
  // semantics are preserved verbatim from the old working adapter. The Effect-native scheduler
  // consumes this adapter Effect directly (no Promise bridge on the live path); the scheduler
  // remains the single retry owner.
  createSourceFetchEffect(input: CreateUsageProviderSourceFetchInput): EffectUsageSchedulerFetch {
    return (request) =>
      Effect.gen(function* () {
        const window = request.keyParts.windowOrPeriod;
        if (window !== "five-hour" && window !== "seven-day" && window !== "monthly-mcp") {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-zai-window-not-returned").failure,
          });
        }

        const resolution = yield* Effect.tryPromise({
          try: async () => input.resolveCredential(),
          catch: (): AdapterFetchFailure => ({ failure: credentialResolutionFailure() }),
        });
        if (!resolution.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({ failure: resolution.failure });
        }

        // The SINGLE `Redacted.value` unwrap for this adapter: the request-builder secret read.
        // Raw key by vendor contract — adding "Bearer" breaks auth (old working adapter, live-verified).
        const apiKey = Redacted.value(resolution.value.value);
        const signal = abortSignalForScheduler(request.signal);
        const fetchedAtEpochMs = input.now?.() ?? request.startedAtEpochMs;

        const body = yield* governedRequestJsonSchema(
          {
            url: new URL("/api/monitor/usage/quota/limit", input.baseUrl),
            headers: {
              authorization: apiKey,
              "accept-language": "en-US,en",
              "content-type": "application/json",
            },
            signal,
          },
          ZaiUsageLimitResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ).pipe(Effect.mapError(schedulerFailureFromTagged));

        if (body.success !== true) {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: semanticValidationFetchFailure("usage-zai-success-flag-false").failure,
          });
        }

        const matched = usageWindowEntry(body.data.limits, window);
        if (matched === undefined) {
          // A declared-but-absent window (e.g. an idle weekly entry) is "no data
          // yet", never an error or a defaulted 0% — old working behavior.
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-zai-window-not-returned").failure,
          });
        }

        const resetsAtEpochMs =
          typeof matched.nextResetTime === "number" && matched.nextResetTime > 0 ? matched.nextResetTime : undefined;
        const snapshot: NormalizedSnapshot = {
          familyId: "usage",
          providerId,
          metricKind: "usage-percent",
          metricDirection: "upper-bound",
          unit: "percent",
          coverage: {
            kind: "rolling-window",
            window,
          },
          value: matched.percentage,
          fetchedAtEpochMs,
          ...(resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs }),
        };
        return snapshot;
      });
  },
} as const;

function credentialResolutionFailure(): ReturnType<typeof createSanitizedFailure> {
  return createSanitizedFailure({
    category: "unknown-sanitized-failure",
    diagnostics: {
      boundary: "provider-adapters-usage-zai-coding-plan",
      issueCount: 1,
      reasonCode: "credential-resolution-failed",
    },
    provider: {
      failureClass: "unknown",
      reasonCode: "credential-resolution-failed",
    },
  });
}

function usageWindowEntry(
  limits: readonly ZaiLimitEntry[],
  window: UsageWindowId,
): (ZaiLimitEntry & { readonly percentage: number }) | undefined {
  for (const entry of limits) {
    if (matchesWindow(entry, window) && typeof entry.percentage === "number" && Number.isFinite(entry.percentage)) {
      return entry as ZaiLimitEntry & { readonly percentage: number };
    }
  }

  return undefined;
}

// Verified live triples from the old working adapter: unit 3=hours, 6=weeks,
// 5=months. Unknown triples are skipped, never guess-mapped.
function matchesWindow(entry: ZaiLimitEntry, window: UsageWindowId): boolean {
  if (window === "five-hour") {
    return entry.type === "TOKENS_LIMIT" && entry.unit === 3 && entry.number === 5;
  }
  if (window === "seven-day") {
    return entry.type === "TOKENS_LIMIT" && entry.unit === 6 && entry.number === 1;
  }
  if (window === "monthly-mcp") {
    return entry.type === "TIME_LIMIT" && entry.unit === 5 && entry.number === 1;
  }
  return false;
}
