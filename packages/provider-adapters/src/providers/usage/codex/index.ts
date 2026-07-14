import { Effect, Option, Redacted, Schema } from "effect";

import type { NormalizedSnapshot, UsageWindowId } from "@ai-workbench/contracts";
import { MissingCredentials } from "@ai-workbench/errors";
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
import { missingCredentialsFetchFailure, noSourceConfigured } from "../../../provider-failures.js";
import type {
  CodexCredentialResult,
  CodexSessionSnapshot,
  CreateUsageProviderSourceFetchInput,
  UsageProviderAdapterBinding,
} from "../../../types.js";

const providerId = "codex" as const;
const CREDENTIAL_BOUNDARY = "provider-adapters";
const CODEX_USAGE_WINDOW_DURATIONS = {
  "five-hour": { seconds: 18_000, minutes: 300 },
  "seven-day": { seconds: 604_800, minutes: 10_080 },
} as const satisfies Record<"five-hour" | "seven-day", { readonly seconds: number; readonly minutes: number }>;

const CodexRateLimitWindowSchema = Schema.Struct({
  limit_window_seconds: Schema.Number,
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.Number),
});

const CodexUsageResponseSchema = Schema.Struct({
  rate_limit: Schema.optional(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexRateLimitWindowSchema)),
      secondary_window: Schema.optional(Schema.NullOr(CodexRateLimitWindowSchema)),
    }),
  ),
  // Codex credit-pool balance from the SAME /backend-api/wham/usage response.
  // Deliberately TOLERANT on the shared decode: `credits` may be ANY
  // shape or absent WITHOUT ever failing the unchanged 5h/7d percentage decode. The STRICT
  // numeric decode of `credits.balance` is isolated in
  // `liveCreditsBalanceForResponse` via `CodexCreditsSchema`, so a malformed credits value
  // fails SOFT to the credits path's "not returned" no-data and never touches the percentage path.
  credits: Schema.optional(Schema.Unknown),
});

type CodexUsageResponse = Schema.Schema.Type<typeof CodexUsageResponseSchema>;

// Strict credits-balance schema decoded SEPARATELY from the shared response:
// `balance` parses a numeric string via `NumberFromString` or accepts a bare number; any other
// shape (absent, null, non-object, missing/null/non-numeric `balance`) decodes to `Option.none`.
const CodexCreditsSchema = Schema.Struct({
  balance: Schema.Union(Schema.NumberFromString, Schema.Number),
});
const decodeCreditsBalance = Schema.decodeUnknownOption(CodexCreditsSchema);

// Reset-credits endpoint response, from the DEDICATED
// `/backend-api/wham/rate-limit-reset-credits` endpoint, decoded at the source via the central one-read JSON decoder.
// TOLERANT on both consumed fields (same isolation ethos as the credits decode): `available_count`
// and each `credits[]` element are strict-decoded SEPARATELY below, so a malformed count fails SOFT to
// a clean "resets not returned" no-data (never a hard ValidationDrift, never a fake 0) and a single
// malformed credit is simply excluded from the earliest-expiry scan.
const CodexResetCreditsResponseSchema = Schema.Struct({
  available_count: Schema.optional(Schema.Unknown),
  credits: Schema.optional(Schema.Unknown),
});

type CodexResetCreditsResponse = Schema.Schema.Type<typeof CodexResetCreditsResponseSchema>;

// Strict, isolated decode of the available reset-credit count: a finite number (parsing a numeric
// string via `NumberFromString` if the vendor ever sends one, else a bare number). Guarded `>= 0` in
// the helper; any other shape decodes to `Option.none` -> fail-soft "resets not returned".
const decodeAvailableCount = Schema.decodeUnknownOption(Schema.Union(Schema.NumberFromString, Schema.Number));

// Strict, isolated decode of ONE reset credit: a `status` string and an `expires_at` string. A credit
// that omits or nulls either field decodes to `Option.none` and is EXCLUDED from the earliest-expiry scan.
const CodexResetCreditSchema = Schema.Struct({
  status: Schema.String,
  expires_at: Schema.String,
});
const decodeResetCredit = Schema.decodeUnknownOption(CodexResetCreditSchema);

type CodexCredentialReasonCode = Extract<CodexCredentialResult, { readonly ok: false }>["reasonCode"];

/**
 * The local `~/.codex/auth.json` credential read, normalized with BOTH sensitive fields wrapped
 * in `Redacted` at the instant of the read. Codex carries two secret-bearing header inputs — the
 * OAuth `accessToken` AND the `accountId` (an account identifier, rules section 6) — so both are
 * wrapped and neither plain string flows past `normalizeCredentialRead`.
 */
type CodexCredentialRead =
  | {
      readonly ok: true;
      readonly accessToken: Redacted.Redacted<string>;
      readonly accountId: Redacted.Redacted<string>;
    }
  | { readonly ok: false; readonly reasonCode: CodexCredentialReasonCode };

type CodexCredentialReadOk = Extract<CodexCredentialRead, { readonly ok: true }>;

export const codexUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  // Effect-native HYBRID source fetch: the codex
  // variant of the claude-code hybrid recipe — local `~/.codex/auth.json` credential +
  // HTTP + a non-HTTP session-JSONL fallback. It reads the local credential, wraps BOTH the
  // `accessToken` and the `accountId` in `Redacted` IMMEDIATELY on read (neither plain value flows
  // past the read->wrap point), builds the usage request with the raw values at the
  // `authorization: Bearer ...` and `chatgpt-account-id` headers (the adapter's ONLY two
  // `Redacted.value` unwrap sites, one per field), decodes at the source via `requestJsonSchema`
  // (central one-read JSON decoder, ONE attempt per HTTP call, NO scheduler backoff), and yields the plain
  // normalized usage snapshot. The one PROVIDER AUTH behavior preserved verbatim is an UNGATED
  // one-shot credential re-read + retry on a 401 (`Effect.catchTag("UnauthorizedExpired")`); codex
  // has NO proactive stale re-read (`auth.json` carries no `expiresAt`) and therefore NO shared
  // re-read budget, so this is not scheduler retry: each HTTP call is still ONE attempt.
  // For a NON-AUTH failure the intricate old-plugin session-JSONL fallback arbitration
  // (`codexSessionFallbackEffect`) is consulted; an AUTH failure surfaces directly and
  // the session file is never read ("never mask a dead login"). The scheduler remains the single
  // retry owner; the Effect-native scheduler consumes this adapter Effect directly (no Promise
  // bridge on the live path).
  createSourceFetchEffect(input: CreateUsageProviderSourceFetchInput): EffectUsageSchedulerFetch {
    const localSource = input.localSources?.codex;
    if (localSource === undefined) {
      return () =>
        Effect.fail<AdapterFetchFailure>({
          failure: noSourceConfigured("usage-codex-source-reader-missing").failure,
        });
    }

    const readCredential = localSource.readCredential;
    const readSessionSnapshot = localSource.readSessionSnapshot;
    const baseUrl = input.baseUrl;
    const now = input.now;

    return (request) =>
      Effect.gen(function* () {
        const window = request.keyParts.windowOrPeriod;
        if (window !== "five-hour" && window !== "seven-day" && window !== "credits" && window !== "resets") {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: noSourceConfigured("usage-codex-window-not-returned").failure,
          });
        }

        const signal = abortSignalForScheduler(request.signal);
        const usageUrl = new URL("/backend-api/wham/usage", baseUrl);

        // Reads the local credential once, wrapping BOTH secret fields in `Redacted` immediately. A
        // rejected read (defensive — the auth.json reader resolves ok/not-ok in practice) fails with
        // a sanitized tagged error carrying no cause. Re-running this Effect re-invokes the
        // reader, which is exactly what the 401 refresh below needs.
        const readOnce = Effect.tryPromise({
          try: () => readCredential(),
          catch: () => credentialReadRejected(),
        }).pipe(Effect.map(normalizeCredentialRead));

        // Initial credential read. A not-ok read is an AUTH failure that surfaces DIRECTLY — the
        // session file is NOT consulted (sessionReads===0; "never mask a dead login").
        const credential = yield* readOnce.pipe(Effect.mapError(schedulerFailureFromTagged));
        if (!credential.ok) {
          return yield* Effect.fail<AdapterFetchFailure>({
            failure: missingCredentialsFetchFailure(credential.reasonCode).failure,
          });
        }

        // Resets category (rate-limit reset-credits): a SEPARATE endpoint
        // (`/backend-api/wham/rate-limit-reset-credits`) with the reset-credits headers, HTTP-only. It
        // REUSES the shared credential read + the SAME ungated one-shot 401 auth refresh, decodes the
        // dedicated response at the source, and returns a `usage-resets` snapshot (available count +
        // earliest upcoming reset-credit expiry). There is NO session-JSONL fallback (the session file
        // carries no reset-credit data): an auth or transport failure surfaces directly through the
        // scheduler. Kept BEFORE the `/wham/usage` attempt so the resets path never fires the usage call.
        if (window === "resets") {
          const resetsUrl = new URL("/backend-api/wham/rate-limit-reset-credits", baseUrl);
          const attemptResets = (cred: CodexCredentialReadOk) =>
            governedRequestJsonSchema(
              { url: resetsUrl, headers: codexResetsHeaders(cred.accessToken, cred.accountId), signal },
              CodexResetCreditsResponseSchema,
              { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
            );
          const decodedResets = attemptResets(credential).pipe(
            Effect.catchTag("UnauthorizedExpired", () =>
              readOnce.pipe(
                Effect.flatMap((refreshed) =>
                  refreshed.ok ? attemptResets(refreshed) : Effect.fail(missingCredentialsError(refreshed.reasonCode)),
                ),
              ),
            ),
          );
          const fetchedAtEpochMs = now?.() ?? request.startedAtEpochMs;
          return yield* decodedResets.pipe(
            Effect.mapError(schedulerFailureFromTagged),
            Effect.flatMap((body) => {
              const resets = resetsSnapshotValuesForResponse(body, fetchedAtEpochMs);
              if (resets === undefined) {
                return Effect.fail<AdapterFetchFailure>({
                  failure: noSourceConfigured("usage-codex-resets-not-returned").failure,
                });
              }
              return Effect.succeed<NormalizedSnapshot>(
                codexResetsSnapshot(resets.count, fetchedAtEpochMs, resets.resetsAtEpochMs),
              );
            }),
          );
        }

        const attempt = (cred: CodexCredentialReadOk) =>
          governedRequestJsonSchema(
            { url: usageUrl, headers: codexHeaders(cred.accessToken, cred.accountId), signal },
            CodexUsageResponseSchema,
            { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
          );

        // First attempt + UNGATED one-shot auth refresh. The 401 refresh is PROVIDER AUTH logic,
        // not scheduler backoff: each HTTP call is still ONE `requestJsonSchema` attempt. Codex has
        // no proactive re-read/budget, so a 401 on the first call always re-reads + retries exactly
        // once. A persistent 401 (the retry's 401 is outside this `catchTag` scope) surfaces as
        // `unauthorized-expired`.
        const decoded = attempt(credential).pipe(
          Effect.catchTag("UnauthorizedExpired", () =>
            readOnce.pipe(
              Effect.flatMap((refreshed) =>
                refreshed.ok ? attempt(refreshed) : Effect.fail(missingCredentialsError(refreshed.reasonCode)),
              ),
            ),
          ),
        );

        // The credits category (evergreen credit pool) shares the credential read + the one-shot
        // 401 auth refresh above, but is HTTP-only: it maps the SAME decoded body to a
        // usage-credits snapshot and has NO session-JSONL fallback (the session file carries no
        // credit balance). An auth or transport failure surfaces directly through the scheduler.
        if (window === "credits") {
          return yield* decoded.pipe(
            Effect.mapError(schedulerFailureFromTagged),
            Effect.flatMap((body) => {
              const balance = liveCreditsBalanceForResponse(body);
              if (balance === undefined) {
                return Effect.fail<AdapterFetchFailure>({
                  failure: noSourceConfigured("usage-codex-credits-not-returned").failure,
                });
              }
              return Effect.succeed<NormalizedSnapshot>(
                codexCreditsSnapshot(balance, now?.() ?? request.startedAtEpochMs),
              );
            }),
          );
        }

        // 5h/7d percentage path (UNCHANGED): map the HTTP/decode tagged error to the plain adapter
        // failure, normalize the window on success, then arbitrate the session-JSONL fallback for
        // NON-AUTH failures only.
        return yield* decoded.pipe(
          Effect.mapError(schedulerFailureFromTagged),
          Effect.flatMap((body) => {
            const matched = liveUsageWindowForResponse(body, window);
            if (matched === undefined) {
              return Effect.fail<AdapterFetchFailure>({
                failure: noSourceConfigured("usage-codex-window-not-returned").failure,
              });
            }
            return Effect.succeed<NormalizedSnapshot>(
              codexSnapshot(window, matched.value, now?.() ?? request.startedAtEpochMs, matched.resetsAtEpochMs),
            );
          }),
          Effect.catchAll((failure) =>
            codexSessionFallbackEffect({
              readSessionSnapshot,
              previousSnapshot: request.previousSnapshot,
              window,
              failure,
            }),
          ),
        );
      });
  },
} as const;

function normalizeCredentialRead(result: CodexCredentialResult): CodexCredentialRead {
  if (!result.ok) {
    return { ok: false, reasonCode: result.reasonCode };
  }

  // Wrap BOTH the access token and the account id in `Redacted` at the instant of the read; neither
  // plain string flows beyond this point (`accountId` is an account identifier).
  return {
    ok: true,
    accessToken: Redacted.make(result.accessToken),
    accountId: Redacted.make(result.accountId),
  };
}

function codexHeaders(
  accessToken: Redacted.Redacted<string>,
  accountId: Redacted.Redacted<string>,
): Readonly<Record<string, string>> {
  return {
    // The adapter's ONLY two `Redacted.value` unwrap sites — the auth header and the account-id
    // header, one per secret-bearing field. Each is invoked once per actual HTTP call (the refresh
    // re-reads + re-wraps), never logged or copied elsewhere.
    authorization: `Bearer ${Redacted.value(accessToken)}`,
    "chatgpt-account-id": Redacted.value(accountId),
  };
}

/**
 * Reset-credits endpoint headers. REUSES `codexHeaders` — so the auth and
 * account-id secrets flow through the SAME two `Redacted.value` unwrap sites, adding NO new unwrap
 * site — and layers the endpoint's static headers on top. `OpenAI-Beta: codex-1` is what makes this
 * endpoint answer (mirrors CodexBar); `originator`/`User-Agent`/`Accept` identify the client. Header
 * names are case-insensitive on the wire; the values carry no secret or identifier.
 */
function codexResetsHeaders(
  accessToken: Redacted.Redacted<string>,
  accountId: Redacted.Redacted<string>,
): Readonly<Record<string, string>> {
  return {
    ...codexHeaders(accessToken, accountId),
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
}

/**
 * Old-plugin session-file fallback arbitration, preserved VERBATIM as an Effect:
 * consulted ONLY for non-auth failures, adopted ONLY when no retained snapshot exists or the
 * session file is STRICTLY NEWER, and marked `source: "local-fallback"` so renderers keep the old
 * staleness honesty. An AUTH failure surfaces as an auth failure — the fallback must never mask a
 * dead login, so the session file is NOT read. A rejected session read cannot adopt anything and
 * keeps the original failure, exactly like an absent/zero-timestamp snapshot.
 */
function codexSessionFallbackEffect(params: {
  readonly readSessionSnapshot: () => Promise<CodexSessionSnapshot | undefined>;
  readonly previousSnapshot: NormalizedSnapshot | undefined;
  readonly window: UsageWindowId;
  readonly failure: AdapterFetchFailure;
}): Effect.Effect<NormalizedSnapshot, AdapterFetchFailure> {
  const { readSessionSnapshot, previousSnapshot, window, failure } = params;
  if (isAuthFailure(failure)) {
    return Effect.fail<AdapterFetchFailure>(failure);
  }

  return Effect.tryPromise({
    try: () => readSessionSnapshot(),
    catch: () => failure,
  }).pipe(
    Effect.flatMap((sessionSnapshot) => {
      const adopted = adoptedSessionSnapshot(sessionSnapshot, previousSnapshot, window);
      return adopted === undefined ? Effect.fail<AdapterFetchFailure>(failure) : Effect.succeed(adopted);
    }),
  );
}

/**
 * The old strictly-newer arbitration, unchanged: adopt the session snapshot ONLY when its value is
 * defined, its `fetchedAtEpochMs > 0`, and it is STRICTLY NEWER than the retained snapshot (EQUAL
 * timestamps keep the failure so the central scheduler serves the cached value with its stale
 * marking). Returns the adopted `local-fallback` snapshot, or `undefined` to keep the failure.
 */
function adoptedSessionSnapshot(
  sessionSnapshot: CodexSessionSnapshot | undefined,
  previousSnapshot: NormalizedSnapshot | undefined,
  window: UsageWindowId,
): NormalizedSnapshot | undefined {
  const value = sessionUsagePercentForWindow(sessionSnapshot, window);
  if (value === undefined || sessionSnapshot === undefined || sessionSnapshot.fetchedAtEpochMs <= 0) {
    return undefined;
  }

  if (previousSnapshot !== undefined && sessionSnapshot.fetchedAtEpochMs <= previousSnapshot.fetchedAtEpochMs) {
    // The retained snapshot is at least as fresh; keep the failure so the central scheduler serves
    // the cached value with its stale marking.
    return undefined;
  }

  return codexSnapshot(
    window,
    value,
    sessionSnapshot.fetchedAtEpochMs,
    sessionResetsAtForWindow(sessionSnapshot, window),
    "local-fallback",
  );
}

function isAuthFailure(failure: AdapterFetchFailure): boolean {
  return (
    failure.failure.category === "unauthorized-expired" ||
    failure.failure.category === "invalid-credentials" ||
    failure.failure.category === "missing-credentials"
  );
}

function codexSnapshot(
  window: UsageWindowId,
  value: number,
  fetchedAtEpochMs: number,
  resetsAtEpochMs?: number,
  source?: "local-fallback",
): NormalizedSnapshot {
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
    value,
    fetchedAtEpochMs,
    ...(resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs }),
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * Codex evergreen credit-pool snapshot: a lower-bound
 * `usage-credits` remaining value with `evergreen` coverage (no window reset).
 * Distinct from `codexSnapshot`'s rolling-window percentage snapshot; the credits
 * path never carries a `resetsAtEpochMs` or a local-fallback source.
 */
function codexCreditsSnapshot(balance: number, fetchedAtEpochMs: number): NormalizedSnapshot {
  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-credits",
    metricDirection: "lower-bound",
    unit: "credits",
    coverage: { kind: "evergreen" },
    value: balance,
    fetchedAtEpochMs,
  };
}

/**
 * Codex evergreen reset-credit-count snapshot: a lower-bound `usage-resets`
 * value carrying the available count with `evergreen` coverage (no window reset), and — only when the
 * count is positive and a valid future expiry exists — the earliest upcoming reset-credit expiry as
 * `resetsAtEpochMs` (which drives the countdown line). Never carries a local-fallback source.
 */
function codexResetsSnapshot(count: number, fetchedAtEpochMs: number, resetsAtEpochMs?: number): NormalizedSnapshot {
  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-resets",
    metricDirection: "lower-bound",
    unit: "count",
    coverage: { kind: "evergreen" },
    value: count,
    fetchedAtEpochMs,
    ...(resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs }),
  };
}

/**
 * Resolves the reset-credits snapshot values from the tolerant response.
 * `available_count` is strict-decoded via `decodeAvailableCount` and guarded to a finite integer `>= 0`;
 * any other shape returns undefined so the path fails SOFT to "resets not returned" (never a fake 0).
 * A genuine `0` is a real 0 (count 0, no countdown). Only a positive count carries an earliest-expiry
 * countdown, computed from the available credits using the fetch instant as "now" (Clock seam).
 */
function resetsSnapshotValuesForResponse(
  response: CodexResetCreditsResponse,
  fetchedAtEpochMs: number,
): { readonly count: number; readonly resetsAtEpochMs?: number } | undefined {
  const decodedCount = Option.getOrUndefined(decodeAvailableCount(response.available_count));
  if (decodedCount === undefined || !Number.isInteger(decodedCount) || decodedCount < 0) {
    return undefined;
  }
  if (decodedCount === 0) {
    return { count: 0 };
  }
  const resetsAtEpochMs = earliestUpcomingResetExpiry(response.credits, fetchedAtEpochMs);
  return resetsAtEpochMs === undefined ? { count: decodedCount } : { count: decodedCount, resetsAtEpochMs };
}

/**
 * Earliest upcoming reset-credit expiry: the MIN `expires_at` (ISO -> epoch ms via `Date.parse`, the
 * same normalization the claude-code adapter applies to its window `resets_at`) across `credits[]`
 * entries whose `status` is `"available"` and whose parsed expiry is strictly greater than the fetch
 * instant. Entries with a null/absent/unparseable/past expiry, or a non-available status, are excluded;
 * `undefined` when none qualify (no countdown).
 */
function earliestUpcomingResetExpiry(credits: unknown, fetchedAtEpochMs: number): number | undefined {
  if (!Array.isArray(credits)) {
    return undefined;
  }
  let earliest: number | undefined;
  for (const raw of credits) {
    const credit = Option.getOrUndefined(decodeResetCredit(raw));
    if (credit === undefined || credit.status !== "available") {
      continue;
    }
    const expiresAtEpochMs = Date.parse(credit.expires_at);
    if (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= fetchedAtEpochMs) {
      continue;
    }
    if (earliest === undefined || expiresAtEpochMs < earliest) {
      earliest = expiresAtEpochMs;
    }
  }
  return earliest;
}

/**
 * A resolved-but-not-ok credential read, expressed as the shared `MissingCredentials` tagged error
 * so the HTTP-attempt + refresh sub-pipe stays in one error channel. The mapped plain
 * `SanitizedFailure` is identical to `missingCredentialsFetchFailure(reasonCode)`.
 */
function missingCredentialsError(reasonCode: CodexCredentialReasonCode): MissingCredentials {
  return new MissingCredentials({ reasonCode, boundary: CREDENTIAL_BOUNDARY, providerFailureClass: "credentials" });
}

/**
 * A rejected credential read (defensive — the `~/.codex/auth.json` reader resolves ok/not-ok in
 * practice). Classified as missing-credentials with no cause so nothing sensitive can leak.
 */
function credentialReadRejected(): MissingCredentials {
  return new MissingCredentials({
    reasonCode: "codex-credential-read-failed",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

function liveUsageWindowForResponse(
  response: CodexUsageResponse,
  window: UsageWindowId,
): { readonly value: number; readonly resetsAtEpochMs?: number } | undefined {
  const requestedSeconds = codexWindowDurationSeconds(window);
  if (requestedSeconds === undefined) {
    return undefined;
  }

  const matches = [response.rate_limit?.primary_window, response.rate_limit?.secondary_window].filter(
    (candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== undefined &&
      candidate !== null &&
      Number.isFinite(candidate.limit_window_seconds) &&
      candidate.limit_window_seconds === requestedSeconds,
  );
  if (matches.length !== 1) {
    return undefined;
  }

  const rawWindow = matches[0];
  if (!Number.isFinite(rawWindow.used_percent)) {
    return undefined;
  }

  // The endpoint reports reset_at in epoch SECONDS; zero means none scheduled.
  const resetAtSeconds = rawWindow.reset_at;
  return {
    value: rawWindow.used_percent,
    ...(typeof resetAtSeconds === "number" && Number.isFinite(resetAtSeconds) && resetAtSeconds > 0
      ? { resetsAtEpochMs: resetAtSeconds * 1000 }
      : {}),
  };
}

function codexWindowDurationSeconds(window: UsageWindowId): number | undefined {
  return window === "five-hour" || window === "seven-day" ? CODEX_USAGE_WINDOW_DURATIONS[window].seconds : undefined;
}

/**
 * Strict, isolated decode of the credits balance from the TOLERANT shared `credits` field:
 * accepts only a finite number (parsing a numeric string via `NumberFromString`
 * if present) through `CodexCreditsSchema`. ANY other shape — absent, null, non-object, or a
 * missing/null/non-numeric `balance` (e.g. `{ balance: "unlimited" }`) — decodes to `Option.none`
 * and returns undefined, so the credits path fails SOFT to a sanitized "credits not returned"
 * no-data (never ValidationDrift, never a fake zero) and the shared 5h/7d decode is untouched.
 */
function liveCreditsBalanceForResponse(response: CodexUsageResponse): number | undefined {
  const decoded = Option.getOrUndefined(decodeCreditsBalance(response.credits));
  return decoded !== undefined && Number.isFinite(decoded.balance) ? decoded.balance : undefined;
}

function sessionUsagePercentForWindow(
  sessionSnapshot: CodexSessionSnapshot | undefined,
  window: UsageWindowId,
): number | undefined {
  const value = window === "five-hour" ? sessionSnapshot?.fiveHourPercent : sessionSnapshot?.sevenDayPercent;
  return value === undefined || !Number.isFinite(value) ? undefined : value;
}

/** Per-window session-file reset moment (already normalized to epoch ms), when the session snapshot carries one. */
function sessionResetsAtForWindow(sessionSnapshot: CodexSessionSnapshot, window: UsageWindowId): number | undefined {
  const value = window === "five-hour" ? sessionSnapshot.fiveHourResetsAtEpochMs : sessionSnapshot.sevenDayResetsAtEpochMs;
  return value === undefined || !Number.isFinite(value) ? undefined : value;
}
