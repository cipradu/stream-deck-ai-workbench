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

const providerId = "minimax" as const;

// The confirmed model_name of the global coding-plan tier this adapter reads; the
// vendor also returns a "video" tier that the product intentionally ignores.
const GENERAL_MODEL_NAME = "general" as const;

// Tolerant edge decode (mirrors the z.ai adapter): unconsumed vendor fields are
// discarded by the default Struct decode, and per-model fields are individually
// optional so an idle/partial model entry never fails the whole response. The two
// strict points are enforced AFTER decode: `base_resp.status_code` must be a
// number (declared required here) and the SELECTED window's remaining-percent must
// be a finite number (validated in `remainingPercentForWindow`).
const MinimaxRemainsResponseSchema = Schema.Struct({
  base_resp: Schema.Struct({
    status_code: Schema.Number,
  }),
  model_remains: Schema.Array(
    Schema.Struct({
      model_name: Schema.optional(Schema.String),
      current_interval_remaining_percent: Schema.optional(Schema.Number),
      current_weekly_remaining_percent: Schema.optional(Schema.Number),
      end_time: Schema.optional(Schema.Number),
      weekly_end_time: Schema.optional(Schema.Number),
    }),
  ),
});

type MinimaxModelEntry = Schema.Schema.Type<typeof MinimaxRemainsResponseSchema>["model_remains"][number];

export const minimaxUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: the pure-HTTP Usage recipe shared
  // with z.ai — an `Effect` program that consumes the `@effect/platform` `HttpClient`, resolves the
  // `Redacted` credential from global settings, builds the single `GET /v1/coding_plan/remains`
  // request with the raw key at the `authorization: Bearer <key>` header (the SINGLE `Redacted.value`
  // unwrap), decodes at the source via `requestJsonSchema` (schemaBodyJson, ONE attempt, NO retry),
  // and yields the plain normalized usage snapshot. The Effect-native scheduler consumes this adapter
  // Effect directly (no Promise bridge on the live path) and remains the single retry owner.
  createSourceFetchEffect(input: CreateUsageProviderSourceFetchInput): EffectUsageSchedulerFetch {
    return (request) =>
      Effect.gen(function* () {
        const window = request.keyParts.windowOrPeriod;
        if (window !== "five-hour" && window !== "seven-day") {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-minimax-window-unsupported").failure,
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
        // MiniMax uses the `Bearer ` prefix (owner live-probe-confirmed), unlike z.ai's raw key.
        const apiKey = Redacted.value(resolution.value.value);
        const signal = abortSignalForScheduler(request.signal);
        const fetchedAtEpochMs = input.now?.() ?? request.startedAtEpochMs;

        const body = yield* governedRequestJsonSchema(
          {
            url: new URL("/v1/coding_plan/remains", input.baseUrl),
            headers: {
              authorization: `Bearer ${apiKey}`,
              accept: "application/json",
            },
            signal,
          },
          MinimaxRemainsResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        ).pipe(Effect.mapError(schedulerFailureFromTagged));

        // Standard MiniMax status wrapper: a non-zero status_code is a semantic failure (the
        // Usage analog of z.ai's `success !== true`), never a defaulted or empty display value.
        if (body.base_resp.status_code !== 0) {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: semanticValidationFetchFailure("usage-minimax-status-code-nonzero").failure,
          });
        }

        const model = body.model_remains.find((entry) => entry.model_name === GENERAL_MODEL_NAME);
        if (model === undefined) {
          // The `general` tier is absent (never the ignored `video` tier): "no data yet",
          // not an error or a defaulted 0% — the z.ai window-absent behavior.
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-minimax-model-absent").failure,
          });
        }

        const remainingPercent = remainingPercentForWindow(model, window);
        if (remainingPercent === undefined) {
          // A missing or non-finite remaining-percent is "no data yet", never a defaulted 0%.
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-minimax-remaining-percent-missing").failure,
          });
        }

        const resetSource = window === "five-hour" ? model.end_time : model.weekly_end_time;
        const resetsAtEpochMs = typeof resetSource === "number" && resetSource > 0 ? resetSource : undefined;
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
          // Used% is the complement of the vendor's remaining-percent, clamped into [0,100].
          value: Math.min(100, Math.max(0, 100 - remainingPercent)),
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
      boundary: "provider-adapters-usage-minimax",
      issueCount: 1,
      reasonCode: "credential-resolution-failed",
    },
    provider: {
      failureClass: "unknown",
      reasonCode: "credential-resolution-failed",
    },
  });
}

// The selected window's remaining-percent, strictly validated: a finite number in
// [0,100] is required, so a missing, non-finite, or out-of-range value returns
// undefined (the caller maps that to "no data yet" rather than rendering a used%
// derived from a corrupt percent). This keeps the caller's clamp a pure safety net.
function remainingPercentForWindow(entry: MinimaxModelEntry, window: UsageWindowId): number | undefined {
  const raw = window === "five-hour" ? entry.current_interval_remaining_percent : entry.current_weekly_remaining_percent;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : undefined;
}
