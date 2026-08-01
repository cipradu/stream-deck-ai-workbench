import type { HttpClient as PlatformHttpClient } from "@effect/platform";
import { Clock, Effect, Option, Redacted, Schema } from "effect";

import type { NormalizedSnapshot, UsageWindowId } from "@ai-workbench/contracts";
import { MissingCredentials, UnauthorizedExpired } from "@ai-workbench/errors";
import { DEFAULT_HTTP_TIMEOUT_MS, type JsonResponseClassifier } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import type { GovernorBlocked, SchedulerFetchRequest } from "@ai-workbench/scheduler";

import { createUsageProviderAdapterBinding } from "../../../binding-helpers.js";
import {
  schedulerFailureFromTagged,
  type AdapterFetchFailure,
  type EffectUsageSchedulerFetch,
} from "../../../effect-fetch.js";
import { governedRequestJsonSchema, type ProviderAdapterAttemptContext } from "../../../governed-request.js";
import { abortSignalForScheduler } from "../../../live-http.js";
import { missingCredentialsFetchFailure, noSourceConfigured } from "../../../provider-failures.js";
import type {
  ClaudeCodeCredentialResult,
  CreateUsageProviderSourceFetchInput,
  UsageProviderAdapterBinding,
} from "../../../types.js";

const providerId = "claude-code" as const;
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CREDENTIAL_BOUNDARY = "provider-adapters";

// The Fable usage category is the `limits[]` entry whose `kind` is
// `weekly_scoped` and whose scoped model display name is exactly this. `scope.model.id` is null on
// the wire, so the entry is selected by display name, not id.
const FABLE_WEEKLY_SCOPED_KIND = "weekly_scoped";
const FABLE_MODEL_DISPLAY_NAME = "Fable";

const ClaudeCodeUsageResponseSchema = Schema.Struct({
  // `utilization` is TOLERANT (optional + nullable): a transient malformed window (a missing or null
  // utilization) degrades THAT window to per-window no-data in `usageWindowForResponse` instead of
  // failing the WHOLE decode (which briefly blanked the key during credit-toggling). The 5h/7d happy
  // path — a finite numeric utilization — is unchanged.
  five_hour: Schema.optional(
    Schema.Struct({
      utilization: Schema.optional(Schema.NullOr(Schema.Number)),
      resets_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  seven_day: Schema.optional(
    Schema.Struct({
      utilization: Schema.optional(Schema.NullOr(Schema.Number)),
      resets_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  // Fable source: the OAuth usage response's `limits[]`. Deliberately
  // TOLERANT on the shared decode — `Schema.Unknown` so ANY `limits` shape (or its absence) can NEVER
  // fail the unchanged 5h/7d percentage decode (mirrors the Codex `credits` isolation; before
  // this field existed `limits` was silently excess-ignored, so consuming it MUST stay unable to
  // reject the response). The STRICT per-entry decode is isolated in `fableUsageForResponse` via
  // `ClaudeCodeLimitSchema`, so a malformed entry fails SOFT to the Fable path's "not returned"
  // no-data and never touches the 5h/7d path. Every other response field stays excess-ignored.
  limits: Schema.optional(Schema.Unknown),
  // Extra-usage SPEND source: the OAuth usage response's `spend`
  // object. Same isolation ethos as `limits`/`credits`: TOLERANT `Schema.Unknown` on the shared
  // decode so ANY `spend` shape (or its absence, or a bad sub-field) can NEVER fail the unchanged
  // 5h/7d/fable decode (before this field existed `spend` was silently excess-ignored, so consuming
  // it MUST stay unable to reject the response). The STRICT decode is isolated in
  // `spendSnapshotValuesForResponse` via `ClaudeCodeSpendSchema`, so a malformed `spend` fails SOFT
  // to the credit-spend path's "not returned" no-data and never touches the 5h/7d/fable path.
  spend: Schema.optional(Schema.Unknown),
});

const classifyClaudeCodeUsageResponse: JsonResponseClassifier = (response) => {
  if (!isJsonObject(response)) {
    return "claude-code-usage-root-not-object";
  }

  const fiveHour = response.five_hour;
  if (hasOwn(response, "five_hour") && !isJsonObject(fiveHour)) {
    return "claude-code-usage-five-hour-not-object";
  }
  if (isJsonObject(fiveHour)) {
    if (hasOwn(fiveHour, "utilization") && fiveHour.utilization !== null && typeof fiveHour.utilization !== "number") {
      return "claude-code-usage-five-hour-utilization-invalid";
    }
    if (hasOwn(fiveHour, "resets_at") && fiveHour.resets_at !== null && typeof fiveHour.resets_at !== "string") {
      return "claude-code-usage-five-hour-resets-at-invalid";
    }
  }

  const sevenDay = response.seven_day;
  if (hasOwn(response, "seven_day") && !isJsonObject(sevenDay)) {
    return "claude-code-usage-seven-day-not-object";
  }
  if (isJsonObject(sevenDay)) {
    if (hasOwn(sevenDay, "utilization") && sevenDay.utilization !== null && typeof sevenDay.utilization !== "number") {
      return "claude-code-usage-seven-day-utilization-invalid";
    }
    if (hasOwn(sevenDay, "resets_at") && sevenDay.resets_at !== null && typeof sevenDay.resets_at !== "string") {
      return "claude-code-usage-seven-day-resets-at-invalid";
    }
  }

  return undefined;
};

export type ClaudeCodeUsageResponse = Schema.Schema.Type<typeof ClaudeCodeUsageResponseSchema>;

// Strict, isolated decode of ONE `limits[]` entry, decoded SEPARATELY from
// the tolerant shared `limits` field (same isolation ethos as the Codex credits/resets decodes): the
// consumed fields are individually optional/nullable, and every other entry field (group, severity,
// is_active, scope.surface, scope.model.id, ...) is excess-ignored. An entry that does not decode is
// simply skipped by the scan, never a hard ValidationDrift.
const ClaudeCodeLimitSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              display_name: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeClaudeCodeLimit = Schema.decodeUnknownOption(ClaudeCodeLimitSchema);

// One money amount inside `spend` (used / limit / cap.money): minor units + exponent + ISO 4217
// currency, every field individually optional/nullable so a partial money object degrades to
// per-field no-data in `spendMoneyForSpend` rather than failing the whole spend decode.
const ClaudeCodeSpendMoneySchema = Schema.Struct({
  amount_minor: Schema.optional(Schema.NullOr(Schema.Number)),
  currency: Schema.optional(Schema.NullOr(Schema.String)),
  exponent: Schema.optional(Schema.NullOr(Schema.Number)),
});

// Strict, isolated decode of the `spend` object, decoded SEPARATELY
// from the tolerant shared `spend` field (same isolation ethos as the Fable/credits decodes). Every
// consumed field is individually optional/nullable so a present-but-partial spend still decodes; a
// non-object spend (string/number/array) decodes to `Option.none` -> fail-soft "not returned"
// no-data. `auto_reload` stays `Schema.Unknown` because its ON-shape is UNCONFIRMED (owner probes
// only ever return `null`): decoding it strictly could reject a real spend, so it is interpreted
// tolerantly in `autoReloadIsOn` instead. Every other `spend` field (balance, cap.credits, ...) is
// excess-ignored.
const ClaudeCodeSpendSchema = Schema.Struct({
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  disabled_reason: Schema.optional(Schema.NullOr(Schema.String)),
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  used: Schema.optional(Schema.NullOr(ClaudeCodeSpendMoneySchema)),
  limit: Schema.optional(Schema.NullOr(ClaudeCodeSpendMoneySchema)),
  cap: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        money: Schema.optional(Schema.NullOr(ClaudeCodeSpendMoneySchema)),
      }),
    ),
  ),
  auto_reload: Schema.optional(Schema.Unknown),
});
const decodeClaudeCodeSpend = Schema.decodeUnknownOption(ClaudeCodeSpendSchema);

type ClaudeCodeSpend = Schema.Schema.Type<typeof ClaudeCodeSpendSchema>;

const OUT_OF_CREDITS_REASON = "out_of_credits";

type SpendState = "active" | "off" | "out-of-credits";

/**
 * Resolved credit-spend snapshot values. The active state carries
 * the money detail (percent displayed, `usedMinor`/`capMinor` in a shared `exponent`, `currency`);
 * the off / out-of-credits states carry only the state + the auto-reload flag. `autoReloadOn` is
 * carried for every state but only the out-of-credits render consumes it.
 */
type SpendSnapshotValues =
  | {
      readonly spendState: "active";
      readonly autoReloadOn: boolean;
      readonly percent: number;
      readonly usedMinor: number;
      readonly capMinor: number;
      readonly currency: string;
      readonly exponent: number;
    }
  | {
      readonly spendState: "off" | "out-of-credits";
      readonly autoReloadOn: boolean;
    };

type ClaudeCodeCredentialReasonCode = Extract<ClaudeCodeCredentialResult, { readonly ok: false }>["reasonCode"];

/**
 * The local Keychain credential read, normalized and with the plain access token wrapped in
 * `Redacted` at the instant of the read. The plain string never flows past `normalizeCredentialRead`.
 */
type ClaudeCodeCredentialRead =
  | { readonly ok: true; readonly token: Redacted.Redacted<string>; readonly expiresAt?: number }
  | { readonly ok: false; readonly reasonCode: ClaudeCodeCredentialReasonCode };

type ClaudeCodeUsageWindow = "five-hour" | "seven-day" | "fable" | "credit-spend";

/** Validates a category before it can subscribe to the shared OAuth response. */
export function validateClaudeCodeUsageRequest(
  request: SchedulerFetchRequest,
): Effect.Effect<ClaudeCodeUsageWindow, AdapterFetchFailure> {
  const window = request.keyParts.windowOrPeriod;
  return window === "five-hour" || window === "seven-day" || window === "fable" || window === "credit-spend"
    ? Effect.succeed(window)
    : Effect.fail({ failure: noSourceConfigured("usage-claude-window-not-returned").failure });
}

/**
 * Adapter-owned typed OAuth source operation. It owns the local credential lifecycle,
 * tolerant shared response decode, and the one-shot 401 refresh, but never chooses a
 * category projection. One source flight can therefore serve compatible category closures.
 */
export function createClaudeCodeUsageSourceOperation(
  input: CreateUsageProviderSourceFetchInput,
): (
  request: SchedulerFetchRequest,
) => Effect.Effect<
  ClaudeCodeUsageResponse,
  AdapterFetchFailure | GovernorBlocked,
  PlatformHttpClient.HttpClient | ProviderAdapterAttemptContext
> {
  const readCredential = input.localSources?.claudeCode?.readCredential;
  const refreshCredential = input.localSources?.claudeCode?.refreshCredential;
  if (readCredential === undefined) {
    return () =>
      Effect.fail<AdapterFetchFailure>({
        failure: noSourceConfigured("usage-claude-source-reader-missing").failure,
      });
  }

  const baseUrl = input.baseUrl;
  const now = input.now;

  return (request) =>
    Effect.gen(function* () {
      const signal = abortSignalForScheduler(request.signal);
      const usageUrl = new URL("/api/oauth/usage", baseUrl);

      // Reads the local credential once, wrapping the plain token in `Redacted` immediately. A
      // rejected read (defensive — the Keychain reader resolves ok/not-ok in practice) fails
      // with a sanitized tagged error carrying no cause. Re-running this Effect re-invokes the
      // reader, which is exactly what the proactive/refresh re-reads need.
      const readOnce = Effect.tryPromise({
        try: () => readCredential(),
        catch: () => credentialReadRejected(),
      }).pipe(Effect.map(normalizeCredentialRead));

      // ONE `now` snapshot governs BOTH expiry checks below, so the re-read decision and the
      // fail-fast decision cannot straddle a clock tick (and stay deterministic under TestClock).
      const nowMs = now?.() ?? (yield* Clock.currentTimeMillis);
      let recoveryAttempted = false;

      const recoverAndRead = Effect.gen(function* () {
        recoveryAttempted = true;
        let refreshCompleted = refreshCredential === undefined;
        if (refreshCredential !== undefined) {
          refreshCompleted = yield* Effect.tryPromise({
            try: () => refreshCredential(),
            catch: () => credentialRefreshRejected(),
          }).pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true,
            }),
          );
        }
        const recoveredCredential = yield* readOnce;
        return { credential: recoveredCredential, refreshCompleted } as const;
      });

      // Proactive stale-`expiresAt` recovery BEFORE the first call. The shell callback lets the
      // Claude CLI refresh its own Keychain item; the adapter then performs one readback.
      let credential = yield* readOnce.pipe(Effect.mapError(schedulerFailureFromTagged));
      let reRead = false;
      if (credential.ok && credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
        credential = (yield* recoverAndRead.pipe(Effect.mapError(schedulerFailureFromTagged))).credential;
        reRead = true;
      }
      if (!credential.ok) {
        return yield* Effect.fail<AdapterFetchFailure>({
          failure: missingCredentialsFetchFailure(credential.reasonCode).failure,
        });
      }

      // FAIL FAST on a known-dead token. The one recovery attempt above did not produce a live
      // credential. Sending it would be a GUARANTEED 401 that
      // still spends provider rate-limit budget; enough of those trip a real 429 whose governor
      // cooldown then blocks the very re-read/retry that would have recovered, which is how a
      // ~4h credential gap once became a 27h dead key. So this resolves WITHOUT an HTTP call:
      // the key reads AUTH REQUIRED, no rate-limit budget burns, and because `unauthorized-expired`
      // is the `credential-settings-refresh` retry class (NO back-off armed) the normal poll
      // cadence keeps running and may try one fresh recovery on the next source flight.
      if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
        return yield* Effect.fail(credentialExpiredLocally()).pipe(Effect.mapError(schedulerFailureFromTagged));
      }

      const attempt = (token: Redacted.Redacted<string>) =>
        governedRequestJsonSchema(
          { url: usageUrl, headers: claudeCodeHeaders(token), signal },
          ClaudeCodeUsageResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS, responseClassifier: classifyClaudeCodeUsageResponse },
        );

      // The 401 refresh is provider-auth logic, not scheduler backoff. Each HTTP call still
      // takes one fresh governor attempt permit through `governedRequestJsonSchema`.
      const decoded = reRead
        ? attempt(credential.token)
        : attempt(credential.token).pipe(
            Effect.catchTag("UnauthorizedExpired", () =>
              (recoveryAttempted
                ? readOnce.pipe(Effect.map((credential) => ({ credential, refreshCompleted: false }) as const))
                : recoverAndRead
              ).pipe(
                Effect.flatMap(({ credential: refreshed, refreshCompleted }) => {
                  if (!refreshCompleted) {
                    return Effect.fail(credentialExpiredLocally());
                  }
                  if (!refreshed.ok) {
                    return Effect.fail(missingCredentialsError(refreshed.reasonCode));
                  }
                  return refreshed.expiresAt !== undefined && refreshed.expiresAt <= nowMs
                    ? Effect.fail(credentialExpiredLocally())
                    : attempt(refreshed.token);
                }),
              ),
            ),
          );

      return yield* decoded.pipe(Effect.mapError(schedulerFailureFromTagged));
    });
}

/** Projects one category from a decoded shared OAuth response without mutating it or caching it. */
export function projectClaudeCodeUsageResponse(
  body: ClaudeCodeUsageResponse,
  request: SchedulerFetchRequest,
  now?: () => number,
): Effect.Effect<NormalizedSnapshot, AdapterFetchFailure> {
  return Effect.gen(function* () {
    const window = yield* validateClaudeCodeUsageRequest(request);

    // Credit-spend uses the same response's `spend` object but has a distinct snapshot shape.
    // Malformed or absent spend remains a category-local sanitized no-data result.
    if (window === "credit-spend") {
      const spend = spendSnapshotValuesForResponse(body);
      if (spend === undefined) {
        return yield* Effect.fail<AdapterFetchFailure>({
          failure: noSourceConfigured("usage-claude-credit-spend-not-returned").failure,
        });
      }
      return claudeCodeSpendSnapshot(spend, now?.() ?? request.startedAtEpochMs);
    }

    // Fable has its own tolerant `limits[]` projection; the named window projections stay
    // independent, so malformed optional categories cannot poison each other.
    const matched = window === "fable" ? fableUsageForResponse(body) : usageWindowForResponse(body, window);
    if (matched === undefined) {
      return yield* Effect.fail<AdapterFetchFailure>({
        failure: noSourceConfigured(
          window === "fable" ? "usage-claude-fable-not-returned" : "usage-claude-window-not-returned",
        ).failure,
      });
    }

    return {
      familyId: "usage",
      providerId,
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      unit: "percent",
      coverage: {
        kind: "rolling-window",
        window,
      },
      value: matched.value,
      fetchedAtEpochMs: now?.() ?? request.startedAtEpochMs,
      ...(matched.resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs: matched.resetsAtEpochMs }),
    } satisfies NormalizedSnapshot;
  });
}

export const claudeCodeUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  createSourceFetchEffect(input: CreateUsageProviderSourceFetchInput): EffectUsageSchedulerFetch {
    const source = createClaudeCodeUsageSourceOperation(input);
    return (request) =>
      validateClaudeCodeUsageRequest(request).pipe(
        Effect.zipRight(source(request)),
        Effect.flatMap((body) => projectClaudeCodeUsageResponse(body, request, input.now)),
      );
  },
} as const;

function normalizeCredentialRead(result: ClaudeCodeCredentialResult): ClaudeCodeCredentialRead {
  if (!result.ok) {
    return { ok: false, reasonCode: result.reasonCode };
  }

  // Wrap the plain access token in `Redacted` at the instant of the read; the plain string does
  // not flow beyond this point.
  return {
    ok: true,
    token: Redacted.make(result.accessToken),
    ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
  };
}

function claudeCodeHeaders(token: Redacted.Redacted<string>): Readonly<Record<string, string>> {
  return {
    // The SINGLE `Redacted.value` unwrap site for this adapter — the auth header. Invoked once
    // per actual HTTP call (the refresh re-reads + re-wraps), never logged or copied elsewhere.
    authorization: `Bearer ${Redacted.value(token)}`,
    "anthropic-beta": ANTHROPIC_BETA_HEADER,
  };
}

/**
 * A resolved-but-not-ok credential read, expressed as the shared `MissingCredentials` tagged
 * error so the HTTP-attempt + refresh sub-pipe stays in one error channel. The mapped plain
 * `SanitizedFailure` is identical to `missingCredentialsFetchFailure(reasonCode)`.
 */
function missingCredentialsError(reasonCode: ClaudeCodeCredentialReasonCode): MissingCredentials {
  return new MissingCredentials({ reasonCode, boundary: CREDENTIAL_BOUNDARY, providerFailureClass: "credentials" });
}

/**
 * A locally-detected expired access token, expressed as the same `UnauthorizedExpired` tagged error
 * the HTTP 401 path produces — so the key renders the identical `AUTH REQUIRED` state whether the
 * expiry is caught locally or reported by the provider. Emitted only after the single re-read failed
 * to yield a live token, and deliberately WITHOUT an HTTP call. No cause and no token cross.
 */
function credentialExpiredLocally(): UnauthorizedExpired {
  return new UnauthorizedExpired({
    reasonCode: "claude-code-credential-expired",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

/**
 * A rejected credential read (defensive — the Keychain reader resolves ok/not-ok in practice).
 * Classified as missing-credentials with no cause so nothing sensitive can leak.
 */
function credentialReadRejected(): MissingCredentials {
  return new MissingCredentials({
    reasonCode: "claude-code-credential-read-failed",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

function credentialRefreshRejected(): UnauthorizedExpired {
  return new UnauthorizedExpired({
    reasonCode: "claude-code-credential-refresh-failed",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

function isJsonObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function usageWindowForResponse(
  response: ClaudeCodeUsageResponse,
  window: UsageWindowId,
): { readonly value: number; readonly resetsAtEpochMs?: number } | undefined {
  const rawWindow = window === "five-hour" ? response.five_hour : response.seven_day;
  // A missing window, or a missing/null/non-finite `utilization` (now tolerated by the schema), is
  // per-window no-data — never a defaulted 0, and never a whole-response failure. The typeof guard
  // both rejects null/undefined and narrows `utilization` to a finite number for the value below.
  const utilization = rawWindow?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return undefined;
  }

  const resetsAt = rawWindow?.resets_at;
  const parsedResetsAt = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  return {
    value: utilization,
    ...(Number.isFinite(parsedResetsAt) && parsedResetsAt > 0 ? { resetsAtEpochMs: parsedResetsAt } : {}),
  };
}

/**
 * Fable usage from the tolerant `limits[]`: the entry whose `kind` is
 * `weekly_scoped` and whose `scope.model.display_name` is exactly "Fable" (selected by display name
 * because `scope.model.id` is null on the wire). Its `percent` is the weekly Fable usage % (a finite
 * number; any other shape — including a present entry with a null/non-finite percent — is no-data,
 * never a defaulted 0). `resets_at` is null while inactive (no countdown) and an ISO string while
 * active, normalized to epoch ms via `Date.parse` exactly like the 5h/7d window `resets_at`. An
 * absent Fable entry returns undefined; the caller maps that to the sanitized "fable not returned"
 * no-data.
 */
function fableUsageForResponse(
  response: ClaudeCodeUsageResponse,
): { readonly value: number; readonly resetsAtEpochMs?: number } | undefined {
  if (!Array.isArray(response.limits)) {
    return undefined;
  }

  for (const raw of response.limits) {
    const limit = Option.getOrUndefined(decodeClaudeCodeLimit(raw));
    if (
      limit === undefined ||
      limit.kind !== FABLE_WEEKLY_SCOPED_KIND ||
      limit.scope?.model?.display_name !== FABLE_MODEL_DISPLAY_NAME
    ) {
      continue;
    }

    // The Fable entry is present: a finite `percent` is the value, else per-category no-data.
    if (typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) {
      return undefined;
    }

    const parsedResetsAt = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : Number.NaN;
    return {
      value: limit.percent,
      ...(Number.isFinite(parsedResetsAt) && parsedResetsAt > 0 ? { resetsAtEpochMs: parsedResetsAt } : {}),
    };
  }

  return undefined;
}

/**
 * Resolves the credit-spend snapshot values from the tolerant
 * `spend` field via the isolated strict `ClaudeCodeSpendSchema`. A non-object/absent `spend` decodes
 * to `Option.none` -> undefined -> fail-soft "not returned" no-data. The state machine reads
 * `enabled`/`disabled_reason`; only the ACTIVE state extracts money, and an active state whose
 * used/cap money is missing or non-finite ALSO returns undefined (fail soft — never a broken gauge).
 */
function spendSnapshotValuesForResponse(response: ClaudeCodeUsageResponse): SpendSnapshotValues | undefined {
  const spend = Option.getOrUndefined(decodeClaudeCodeSpend(response.spend));
  if (spend === undefined) {
    return undefined;
  }

  const autoReloadOn = autoReloadIsOn(spend.auto_reload);
  const state = spendStateFor(spend);
  if (state !== "active") {
    return { spendState: state, autoReloadOn };
  }

  const money = spendMoneyForSpend(spend);
  if (money === undefined) {
    return undefined;
  }

  return {
    spendState: "active",
    autoReloadOn,
    percent: money.percent,
    usedMinor: money.usedMinor,
    capMinor: money.capMinor,
    currency: money.currency,
    exponent: money.exponent,
  };
}

/**
 * The spend state machine (owner-confirmed): `active` when the extra-usage toggle is on
 * (`enabled === true`); `out-of-credits` when depleted (`disabled_reason === "out_of_credits"`,
 * which also wins if `enabled` is missing); otherwise `off`. Active always wins so a momentarily
 * depleted-but-enabled account still reads as actively spending.
 */
function spendStateFor(spend: ClaudeCodeSpend): SpendState {
  if (spend.enabled === true) {
    return "active";
  }
  if (spend.disabled_reason === OUT_OF_CREDITS_REASON) {
    return "out-of-credits";
  }
  return "off";
}

/**
 * Active-state money: `used` must carry a finite minor amount, a
 * finite exponent, and a non-empty currency; the cap is `limit ?? cap.money` (first with a finite
 * minor amount). A single `exponent` (from `used`) is applied to both amounts — the confirmed data
 * shares it — and a cap reporting its OWN finite, DISAGREEING exponent fails soft rather than
 * misrender the cap. `percent` is `spend.percent` when finite, else derived from used/cap so the
 * gauge still reflects the real ratio. Any missing/non-finite piece returns undefined -> no-data.
 */
function spendMoneyForSpend(spend: ClaudeCodeSpend): {
  readonly percent: number;
  readonly usedMinor: number;
  readonly capMinor: number;
  readonly currency: string;
  readonly exponent: number;
} | undefined {
  const used = spend.used;
  if (used === null || used === undefined) {
    return undefined;
  }
  const usedMinor = used.amount_minor;
  const exponent = used.exponent;
  const currency = used.currency;
  if (
    typeof usedMinor !== "number" ||
    !Number.isFinite(usedMinor) ||
    typeof exponent !== "number" ||
    !Number.isFinite(exponent) ||
    typeof currency !== "string" ||
    currency.length === 0
  ) {
    return undefined;
  }

  const cap = capMinorForSpend(spend);
  if (cap === undefined) {
    return undefined;
  }
  if (typeof cap.exponent === "number" && Number.isFinite(cap.exponent) && cap.exponent !== exponent) {
    return undefined;
  }

  const percent =
    typeof spend.percent === "number" && Number.isFinite(spend.percent)
      ? spend.percent
      : cap.amountMinor > 0
        ? (usedMinor / cap.amountMinor) * 100
        : 0;

  return { percent, usedMinor, capMinor: cap.amountMinor, currency, exponent };
}

/**
 * Resolves the spend cap minor amount (and its own exponent, if present) from `limit ?? cap.money`
 * (owner order), taking the first source with a finite `amount_minor`. Returns undefined when
 * neither source carries a finite cap amount.
 */
function capMinorForSpend(spend: ClaudeCodeSpend): { readonly amountMinor: number; readonly exponent: number | null | undefined } | undefined {
  for (const source of [spend.limit, spend.cap?.money]) {
    if (source !== null && source !== undefined && typeof source.amount_minor === "number" && Number.isFinite(source.amount_minor)) {
      return { amountMinor: source.amount_minor, exponent: source.exponent };
    }
  }
  return undefined;
}

/**
 * Auto-reload heuristic (UNVERIFIED — review: unverified-pending-observation). The ON-shape is
 * unconfirmed: owner probes only ever return `null` (off). So `spend.auto_reload` is decoded
 * tolerantly (`Schema.Unknown`) and interpreted here: a bare `true`, or a non-null object that does
 * not explicitly carry `enabled: false`, is treated as ON (the out-of-credits render turns red — the
 * imminent-auto-charge burn condition); `null` / absent / `false` / any other primitive / an
 * unrecognized shape is OFF (fail safe, never crash).
 */
function autoReloadIsOn(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return (value as { readonly enabled?: unknown }).enabled !== false;
  }
  return false;
}

/**
 * Builds the credit-spend snapshot. The active snapshot carries the
 * money detail (base `value` is the money spent, matching the `money` unit); the off/out-of-credits
 * status snapshot carries only the state + auto-reload flag with an inert `value` of 0 (never
 * displayed — the renderer shows a neutral status word, and severity is not evaluated).
 */
function claudeCodeSpendSnapshot(values: SpendSnapshotValues, fetchedAtEpochMs: number): NormalizedSnapshot {
  if (values.spendState === "active") {
    return {
      familyId: "usage",
      providerId,
      metricKind: "usage-spend",
      metricDirection: "upper-bound",
      unit: "money",
      coverage: { kind: "current-period" },
      value: values.usedMinor / 10 ** values.exponent,
      fetchedAtEpochMs,
      spendState: "active",
      autoReloadOn: values.autoReloadOn,
      percent: values.percent,
      usedMinor: values.usedMinor,
      capMinor: values.capMinor,
      currency: values.currency,
      exponent: values.exponent,
    };
  }

  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-spend",
    metricDirection: "upper-bound",
    unit: "money",
    coverage: { kind: "current-period" },
    value: 0,
    fetchedAtEpochMs,
    spendState: values.spendState,
    autoReloadOn: values.autoReloadOn,
  };
}
