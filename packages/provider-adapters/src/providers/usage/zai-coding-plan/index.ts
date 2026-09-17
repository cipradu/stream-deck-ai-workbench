import { Effect, Redacted, Schema } from "effect";

import type { NormalizedSnapshot, UsageWindowId } from "@ai-workbench/contracts";
import { createSanitizedFailure, mapProviderFailure } from "@ai-workbench/errors";
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
const ZaiLimitEntrySchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.Number),
  number: Schema.optional(Schema.Number),
  percentage: Schema.optional(Schema.Number),
  nextResetTime: Schema.optional(Schema.Number),
});

// `data` and `success` are decode-optional so the vendor's own business-error
// envelope survives the source decode and can be classified from its `code`.
// The vendor answers those errors with HTTP 200 and NO `data` key at all
// (live-verified 2026-09-17: `{"code":500,"msg":"Internal service error","success":false}`).
// Requiring `data` here made every such envelope fail the decode and surface as
// `response-json-schema-mismatch`, i.e. a provider outage reported as our own
// schema drift. Shape enforcement moves into the exhaustive branch below: a body
// with neither `data` nor `code` is still rejected as unrecognized drift.
const ZaiUsageLimitResponseSchema = Schema.Struct({
  code: Schema.optional(Schema.Number),
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(
    Schema.Struct({
      limits: Schema.Array(ZaiLimitEntrySchema),
      level: Schema.optional(Schema.String),
    }),
  ),
});

type ZaiLimitEntry = Schema.Schema.Type<typeof ZaiLimitEntrySchema>;

/**
 * Every reason code this adapter can emit. Exported so the log-sanitizer guard in
 * `apps/streamdeck` asserts the REAL emitted values instead of a copy of them: a copy passes
 * happily after a rename while the deployed plugin logs `reasonCode: "redacted"` again.
 * `packages/provider-adapters` cannot import `packages/logging`, so the guard has to live
 * where both packages are available and reach back for these values.
 *
 * None of the static codes carries a digit, and that is load-bearing. The logging boundary
 * redacts any reason code matching BOTH a provider-metric label and a number
 * (`containsProviderMetricValue`, `packages/logging/src/index.ts`), and every Usage-family
 * code carries the metric label "usage" — so `usage-…-500` reaches the log as the bare string
 * "redacted", destroying the diagnosis and falsely implying a secret was present. For the
 * HTTP-status route the exact status instead rides in the structured
 * `httpStatus`/`httpStatusClass` diagnostics, which the logging allow-list emits intact.
 */
export const ZAI_USAGE_REASON_CODES = {
  vendorStatusError: "usage-zai-vendor-status-error",
  responseShapeUnrecognized: "usage-zai-response-shape-unrecognized",
  successFlagFalse: "usage-zai-success-flag-false",
  windowNotReturned: "usage-zai-window-not-returned",
} as const;

/**
 * The business-code reason. Unlike the static codes above this one MUST carry the vendor's
 * number: no structured channel can hold it (`httpStatus` admits only 100-599, `issueCount`
 * and `fieldPaths` never reach the log), so dropping it makes 1113 "insufficient balance"
 * indistinguishable from any other business fault while `transient-retry` polls forever.
 *
 * It therefore omits the Usage family's "usage-" prefix, because the redaction heuristic is an
 * AND of a metric label and a number — remove the label and the digits survive. That is a
 * deliberate, narrow choice: a vendor error code is not a provider metric value. In-repo
 * precedent is the `claude-code-*` family, whose codes carry no metric label for the same
 * reason. The guard pins this; do not re-add a metric label to this code.
 */
function zaiVendorBusinessErrorReason(code: number): string {
  return Number.isInteger(code) ? `zai-vendor-business-error-${code}` : "zai-vendor-business-error-non-integer";
}

/** @internal Exposed for the log-sanitizer guard so it can assert real emitted values. */
export const __zaiVendorBusinessErrorReasonForTests = zaiVendorBusinessErrorReason;

export const zaiCodingPlanUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  // Effect-native source fetch: the pure-HTTP
  // Usage mirror of the Balance recipe — an `Effect` program that consumes the `@effect/platform`
  // `HttpClient`, resolves the `Redacted` credential from global settings, builds the single
  // quota request with the raw key at the `authorization` header (the SINGLE `Redacted.value`
  // unwrap), decodes at the source via `requestJsonSchema` (central one-read JSON decoder, ONE attempt, NO
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
            failure: noSourceConfigured(ZAI_USAGE_REASON_CODES.windowNotReturned).failure,
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

        // An absent `data` key is the vendor's business-error envelope, not a quota
        // response. Classify it from its own `code`; a body carrying neither `data`
        // nor `code` is a shape this adapter does not recognize and stays validation drift.
        if (body.data === undefined) {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure:
              body.code === undefined
                ? semanticValidationFetchFailure(ZAI_USAGE_REASON_CODES.responseShapeUnrecognized).failure
                : vendorErrorFailure(body.code),
          });
        }

        if (body.success !== true) {
          // A `success:false` body that ALSO carries a fault code is the vendor reporting a
          // fault, even when it still sent a `data` envelope. Classify from the code so that
          // shape reaches the scheduler with the same honest category as the data-less one;
          // without a fault code this stays the pre-existing semantic validation failure.
          return yield* Effect.fail<AdapterFetchFailure>({
            failure:
              body.code !== undefined && isVendorErrorCode(body.code)
                ? vendorErrorFailure(body.code)
                : semanticValidationFetchFailure(ZAI_USAGE_REASON_CODES.successFlagFalse).failure,
          });
        }

        const matched = usageWindowEntry(body.data.limits, window);
        if (matched === undefined) {
          // A declared-but-absent window (e.g. an idle weekly entry) is "no data
          // yet", never an error or a defaulted 0% — old working behavior.
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured(ZAI_USAGE_REASON_CODES.windowNotReturned).failure,
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

/**
 * The vendor reports business errors inside a 200 response rather than on the HTTP status
 * line, so the shared `status >= 500` classification at the HTTP boundary never sees them.
 * Route the envelope's own `code` through that same shared classifier whenever it is an HTTP
 * status value: a 5xx then reaches the scheduler as `provider-unavailable` (transient-retry,
 * 30s->300s) instead of `validation-drift` (rate-limit-backoff, 60s->600s). That is both the
 * honest key state — the provider is down, our decoding is fine — and the faster recovery
 * cadence once the vendor restores service.
 *
 * Codes outside the HTTP range are the vendor's four-digit business codes. Those are
 * documented for its general API only, not for this undocumented monitor endpoint, so they
 * are reported as an unknown sanitized failure rather than guess-mapped onto a category.
 * The vendor's `msg` string never crosses this boundary.
 *
 * Only 4xx/5xx body codes take the HTTP-status route. The vendor's SUCCESS code on this
 * endpoint is `200`, so admitting 1xx/2xx/3xx here would classify a data-less success
 * envelope as `http-status-failure` and emit the self-contradictory diagnostic
 * `httpStatus: 200, httpStatusClass: "2xx"` — an HTTP-status failure for a request whose
 * status line really was 200. Those codes take the business route instead, which claims
 * nothing about the transport.
 */
function vendorErrorFailure(code: number): ReturnType<typeof mapProviderFailure> {
  if (Number.isInteger(code) && code >= 400 && code <= 599) {
    return mapProviderFailure({
      kind: "http-status",
      httpStatus: code,
      reasonCode: ZAI_USAGE_REASON_CODES.vendorStatusError,
    });
  }

  return mapProviderFailure({
    kind: "unknown",
    reasonCode: zaiVendorBusinessErrorReason(code),
  });
}

/**
 * True for a body `code` that reports a vendor fault. Covers HTTP-shaped 4xx/5xx and the
 * vendor's four-digit business codes; a non-integer code is unrecognized and treated as a
 * fault rather than silently ignored. `200` and other 1xx/2xx/3xx values are NOT faults —
 * `200` is this endpoint's success code.
 */
function isVendorErrorCode(code: number): boolean {
  if (!Number.isInteger(code)) {
    return true;
  }

  return (code >= 400 && code <= 599) || code >= 1000;
}

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

/**
 * Selection is deterministic even when a migrating account reports the same window under BOTH
 * labels. Returning the first array match would let vendor array order decide which percentage
 * the key renders — two different numbers for one window, silently, with no drift signal.
 * `CREDIT_LIMIT` wins because it is the post-migration plan model and therefore the account's
 * current truth; the legacy `TOKENS_LIMIT` entry is the fallback.
 */
function usageWindowEntry(
  limits: readonly ZaiLimitEntry[],
  window: UsageWindowId,
): (ZaiLimitEntry & { readonly percentage: number }) | undefined {
  let legacyMatch: (ZaiLimitEntry & { readonly percentage: number }) | undefined;

  for (const entry of limits) {
    if (!matchesWindow(entry, window) || typeof entry.percentage !== "number" || !Number.isFinite(entry.percentage)) {
      continue;
    }

    const match = entry as ZaiLimitEntry & { readonly percentage: number };
    if (entry.type === "CREDIT_LIMIT") {
      return match;
    }

    legacyMatch ??= match;
  }

  return legacyMatch;
}

// Verified live triples from the old working adapter: unit 3=hours, 6=weeks,
// 5=months. Unknown triples are skipped, never guess-mapped.
function matchesWindow(entry: ZaiLimitEntry, window: UsageWindowId): boolean {
  if (window === "five-hour") {
    return isTokenQuotaType(entry.type) && entry.unit === 3 && entry.number === 5;
  }
  if (window === "seven-day") {
    return isTokenQuotaType(entry.type) && entry.unit === 6 && entry.number === 1;
  }
  if (window === "monthly-mcp") {
    return entry.type === "TIME_LIMIT" && entry.unit === 5 && entry.number === 1;
  }
  return false;
}

/**
 * Legacy plans label token quotas `TOKENS_LIMIT`; the credits plan introduced by the
 * vendor's 2026-07-30 plan migration labels the SAME (unit, number) triples `CREDIT_LIMIT`.
 * Accounts move over at their own billing-cycle boundary, so both labels must resolve or the
 * key silently reports `usage-zai-window-not-returned` the day the account migrates. Only the
 * label differs — the unit/number triples above still identify the window, so this is not a
 * guess-mapped triple.
 */
function isTokenQuotaType(type: string | undefined): boolean {
  return type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
}
