import type { HttpClient as PlatformHttpClient } from "@effect/platform";
import { Clock, Effect, Option, Redacted, Schema } from "effect";

import type { NormalizedSnapshot } from "@ai-workbench/contracts";
import { MissingCredentials, UnauthorizedExpired } from "@ai-workbench/errors";
import { DEFAULT_HTTP_TIMEOUT_MS } from "@ai-workbench/http";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import type { GovernorBlocked, SchedulerFetchRequest } from "@ai-workbench/scheduler";

import { createUsageProviderAdapterBinding } from "../../../binding-helpers.js";
import { schedulerFailureFromTagged, type AdapterFetchFailure, type EffectUsageSchedulerFetch } from "../../../effect-fetch.js";
import { governedRequestJsonSchema, type ProviderAdapterAttemptContext } from "../../../governed-request.js";
import { abortSignalForScheduler } from "../../../live-http.js";
import { missingCredentialsFetchFailure, noSourceConfigured } from "../../../provider-failures.js";
import type {
  CreateUsageProviderSourceFetchInput,
  KimiCodeCredentialResult,
  UsageProviderAdapterBinding,
} from "../../../types.js";

const providerId = "kimi-code" as const;
const CREDENTIAL_BOUNDARY = "provider-adapters";

const KimiCodeUsageResponseSchema = Schema.Struct({
  usage: Schema.optional(Schema.Unknown),
  limits: Schema.optional(Schema.Unknown),
  boosterWallet: Schema.optional(Schema.Unknown),
});

export type KimiCodeUsageResponse = Schema.Schema.Type<typeof KimiCodeUsageResponseSchema>;

const KimiCodeUsageDetailSchema = Schema.Struct({
  used: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
  resetTime: Schema.optional(Schema.Unknown),
});

const KimiCodeLimitSchema = Schema.Struct({
  window: Schema.optional(
    Schema.Struct({
      duration: Schema.optional(Schema.Unknown),
      timeUnit: Schema.optional(Schema.Unknown),
    }),
  ),
  detail: Schema.optional(Schema.Unknown),
});

const KimiCodeMoneySchema = Schema.Struct({
  currency: Schema.optional(Schema.Unknown),
  priceInCents: Schema.optional(Schema.Unknown),
});

const KimiCodeBoosterWalletSchema = Schema.Struct({
  monthlyUsed: Schema.optional(Schema.Unknown),
});

const decodeUsageDetail = Schema.decodeUnknownOption(KimiCodeUsageDetailSchema);
const decodeLimit = Schema.decodeUnknownOption(KimiCodeLimitSchema);
const decodeMoney = Schema.decodeUnknownOption(KimiCodeMoneySchema);
const decodeBoosterWallet = Schema.decodeUnknownOption(KimiCodeBoosterWalletSchema);

type KimiCodeCredentialReasonCode = Extract<KimiCodeCredentialResult, { readonly ok: false }>['reasonCode'];

type KimiCodeCredentialRead =
  | {
      readonly ok: true;
      readonly token: Redacted.Redacted<string>;
      readonly expiresAtEpochSeconds?: number;
    }
  | {
      readonly ok: false;
      readonly reasonCode: KimiCodeCredentialReasonCode;
    };

type KimiCodeUsageWindow = "five-hour" | "seven-day" | "extra-usage";

interface PercentageValues {
  readonly value: number;
  readonly resetsAtEpochMs?: number;
}

interface MoneyValues {
  readonly amountMinor: number;
  readonly currency: string;
}

export function validateKimiCodeUsageRequest(
  request: SchedulerFetchRequest,
): Effect.Effect<KimiCodeUsageWindow, AdapterFetchFailure> {
  const window = request.keyParts.windowOrPeriod;
  return window === "five-hour" || window === "seven-day" || window === "extra-usage"
    ? Effect.succeed(window)
    : Effect.fail({ failure: noSourceConfigured("usage-kimi-window-not-returned").failure });
}

export function createKimiCodeUsageSourceOperation(
  input: CreateUsageProviderSourceFetchInput,
): (
  request: SchedulerFetchRequest,
) => Effect.Effect<
  KimiCodeUsageResponse,
  AdapterFetchFailure | GovernorBlocked,
  PlatformHttpClient.HttpClient | ProviderAdapterAttemptContext
> {
  const readCredential = input.localSources?.kimiCode?.readCredential;
  if (readCredential === undefined) {
    return () => Effect.fail({ failure: noSourceConfigured("usage-kimi-source-reader-missing").failure });
  }

  const usageUrl = new URL(`${input.baseUrl.replace(/\/+$/, "")}/usages`);
  const now = input.now;

  return (request) =>
    Effect.gen(function* () {
      const signal = abortSignalForScheduler(request.signal);
      const readOnce = Effect.tryPromise({
        try: () => readCredential(),
        catch: () => credentialReadRejected(),
      }).pipe(Effect.map(normalizeCredentialRead));
      const nowMs = now?.() ?? (yield* Clock.currentTimeMillis);

      let credential = yield* readOnce.pipe(Effect.mapError(schedulerFailureFromTagged));
      let reRead = false;
      if (credential.ok && credentialIsExpired(credential, nowMs)) {
        credential = yield* readOnce.pipe(Effect.mapError(schedulerFailureFromTagged));
        reRead = true;
      }
      if (!credential.ok) {
        return yield* Effect.fail<AdapterFetchFailure>({
          failure: missingCredentialsFetchFailure(credential.reasonCode).failure,
        });
      }
      if (credentialIsExpired(credential, nowMs)) {
        return yield* Effect.fail(credentialExpiredLocally()).pipe(Effect.mapError(schedulerFailureFromTagged));
      }

      const attempt = (token: Redacted.Redacted<string>) =>
        governedRequestJsonSchema(
          { url: usageUrl, headers: kimiCodeHeaders(token), signal },
          KimiCodeUsageResponseSchema,
          { defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS },
        );

      const decoded = reRead
        ? attempt(credential.token)
        : attempt(credential.token).pipe(
            Effect.catchTag("UnauthorizedExpired", () =>
              readOnce.pipe(
                Effect.flatMap((refreshed) => {
                  if (!refreshed.ok) {
                    return Effect.fail(missingCredentialsError(refreshed.reasonCode));
                  }
                  return credentialIsExpired(refreshed, nowMs)
                    ? Effect.fail(credentialExpiredLocally())
                    : attempt(refreshed.token);
                }),
              ),
            ),
          );

      return yield* decoded.pipe(Effect.mapError(schedulerFailureFromTagged));
    });
}

export function projectKimiCodeUsageResponse(
  body: KimiCodeUsageResponse,
  request: SchedulerFetchRequest,
  now?: () => number,
): Effect.Effect<NormalizedSnapshot, AdapterFetchFailure> {
  return Effect.gen(function* () {
    const window = yield* validateKimiCodeUsageRequest(request);
    const fetchedAtEpochMs = now?.() ?? request.startedAtEpochMs;

    if (window === "extra-usage") {
      if (body.boosterWallet === undefined) {
        return kimiCodeSpendOffSnapshot(fetchedAtEpochMs);
      }
      const spend = spendValuesForResponse(body.boosterWallet);
      if (spend === undefined) {
        return yield* Effect.fail<AdapterFetchFailure>({
          failure: noSourceConfigured("usage-kimi-extra-usage-not-returned").failure,
        });
      }
      return kimiCodeSpendActiveSnapshot(spend, fetchedAtEpochMs);
    }

    const values = window === "five-hour" ? fiveHourValuesForResponse(body) : percentageValues(body.usage);
    if (values === undefined) {
      return yield* Effect.fail<AdapterFetchFailure>({
        failure: noSourceConfigured(
          window === "five-hour" ? "usage-kimi-five-hour-not-returned" : "usage-kimi-seven-day-not-returned",
        ).failure,
      });
    }

    return {
      familyId: "usage",
      providerId,
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      unit: "percent",
      coverage: { kind: "rolling-window", window },
      value: values.value,
      fetchedAtEpochMs,
      ...(values.resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs: values.resetsAtEpochMs }),
    } satisfies NormalizedSnapshot;
  });
}

export const kimiCodeUsageProviderModule = {
  providerId,
  createBinding(capability: ProviderCapabilityMetadata): UsageProviderAdapterBinding {
    return createUsageProviderAdapterBinding(providerId, capability);
  },
  createSourceFetchEffect(input: CreateUsageProviderSourceFetchInput): EffectUsageSchedulerFetch {
    const source = createKimiCodeUsageSourceOperation(input);
    return (request) =>
      validateKimiCodeUsageRequest(request).pipe(
        Effect.zipRight(source(request)),
        Effect.flatMap((body) => projectKimiCodeUsageResponse(body, request, input.now)),
      );
  },
} as const;

function normalizeCredentialRead(result: KimiCodeCredentialResult): KimiCodeCredentialRead {
  if (!result.ok) {
    return { ok: false, reasonCode: result.reasonCode };
  }
  return {
    ok: true,
    token: Redacted.make(result.accessToken),
    ...(result.expiresAtEpochSeconds === undefined ? {} : { expiresAtEpochSeconds: result.expiresAtEpochSeconds }),
  };
}

function credentialIsExpired(
  credential: Extract<KimiCodeCredentialRead, { readonly ok: true }>,
  nowMs: number,
): boolean {
  return credential.expiresAtEpochSeconds !== undefined && credential.expiresAtEpochSeconds * 1000 <= nowMs;
}

function kimiCodeHeaders(token: Redacted.Redacted<string>): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${Redacted.value(token)}`,
  };
}

function missingCredentialsError(reasonCode: KimiCodeCredentialReasonCode): MissingCredentials {
  return new MissingCredentials({ reasonCode, boundary: CREDENTIAL_BOUNDARY, providerFailureClass: "credentials" });
}

function credentialExpiredLocally(): UnauthorizedExpired {
  return new UnauthorizedExpired({
    reasonCode: "kimi-code-credential-expired",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

function credentialReadRejected(): MissingCredentials {
  return new MissingCredentials({
    reasonCode: "kimi-code-credential-read-failed",
    boundary: CREDENTIAL_BOUNDARY,
    providerFailureClass: "credentials",
  });
}

function fiveHourValuesForResponse(response: KimiCodeUsageResponse): PercentageValues | undefined {
  if (!Array.isArray(response.limits)) {
    return undefined;
  }
  for (const rawLimit of response.limits) {
    const limit = Option.getOrUndefined(decodeLimit(rawLimit));
    const duration = numericValue(limit?.window?.duration);
    const timeUnit = limit?.window?.timeUnit;
    if (limit !== undefined && duration === 300 && typeof timeUnit === "string" && minuteTimeUnit(timeUnit)) {
      return percentageValues(limit.detail);
    }
  }
  return undefined;
}

function minuteTimeUnit(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === "MINUTE" || normalized === "TIME_UNIT_MINUTE";
}

function percentageValues(raw: unknown): PercentageValues | undefined {
  const detail = Option.getOrUndefined(decodeUsageDetail(raw));
  const used = numericValue(detail?.used);
  const limit = numericValue(detail?.limit);
  if (used === undefined || used < 0 || limit === undefined || limit <= 0) {
    return undefined;
  }
  const value = (used / limit) * 100;
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const resetTime = detail?.resetTime;
  const parsedReset = typeof resetTime === "string" ? Date.parse(resetTime) : Number.NaN;
  return {
    value,
    ...(Number.isFinite(parsedReset) && parsedReset > 0 ? { resetsAtEpochMs: parsedReset } : {}),
  };
}

function spendValuesForResponse(rawWallet: unknown): {
  readonly usedMinor: number;
  readonly currency: string;
} | undefined {
  const wallet = Option.getOrUndefined(decodeBoosterWallet(rawWallet));
  if (wallet === undefined) {
    return undefined;
  }
  const used = moneyValues(wallet.monthlyUsed);
  return used === undefined ? undefined : { usedMinor: used.amountMinor, currency: used.currency };
}

function moneyValues(raw: unknown): MoneyValues | undefined {
  const money = Option.getOrUndefined(decodeMoney(raw));
  const currency = money?.currency;
  const amountMinor = money === undefined ? undefined : money.priceInCents === undefined ? 0 : numericValue(money.priceInCents);
  return typeof currency === "string" &&
    currency.trim().length > 0 &&
    amountMinor !== undefined &&
    Number.isSafeInteger(amountMinor) &&
    amountMinor >= 0
    ? { amountMinor, currency: currency.trim().toUpperCase() }
    : undefined;
}

function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function kimiCodeSpendOffSnapshot(fetchedAtEpochMs: number): NormalizedSnapshot {
  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-spend",
    metricDirection: "upper-bound",
    unit: "money",
    coverage: { kind: "current-period" },
    value: 0,
    fetchedAtEpochMs,
    spendState: "off",
    autoReloadOn: false,
  };
}

function kimiCodeSpendActiveSnapshot(
  values: { readonly usedMinor: number; readonly currency: string },
  fetchedAtEpochMs: number,
): NormalizedSnapshot {
  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-spend",
    metricDirection: "upper-bound",
    unit: "money",
    coverage: { kind: "current-period" },
    value: values.usedMinor / 100,
    fetchedAtEpochMs,
    spendState: "active",
    spendDisplay: "money-used",
    autoReloadOn: false,
    usedMinor: values.usedMinor,
    currency: values.currency,
    exponent: 2,
  };
}
