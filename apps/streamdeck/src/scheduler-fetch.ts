import { resolveBalanceProviderOption } from "@ai-workbench/action-balance";
import { resolveUsageProviderOption } from "@ai-workbench/action-usage";
import {
  BALANCE_PROVIDER_IDS,
  COVERAGE_KINDS,
  USAGE_PROVIDER_IDS,
  USAGE_WINDOW_IDS,
  type BalanceProviderId,
  type CoverageKind,
  type UsageProviderId,
  type UsageWindowId,
} from "@ai-workbench/contracts";
import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";
import { fetchHttpClientLayer } from "@ai-workbench/http";
import type { StreamDeckLogSink } from "@ai-workbench/logging";
import {
  createBalanceProviderSourceFetchEffect,
  createSourceGatedBalanceFetchEffect,
  createSourceGatedUsageFetchEffect,
  createUsageProviderSourceFetchEffect,
  type UsageProviderLocalSourceReaders,
} from "@ai-workbench/provider-adapters";
import type { SchedulerEffectFetch } from "@ai-workbench/scheduler";
import type { NormalizedActionSettingsView } from "@ai-workbench/settings";
import { Clock, Effect, Either } from "effect";

import { resolveCredentialMaterialFromGlobalSettings } from "./credentials.js";
import { createLocalUsageSourceReaders } from "./local-usage-sources.js";
import { writeShellLog } from "./logging.js";

export interface CreateSchedulerFetchOptions {
  readonly readGlobalSettings: () => Promise<unknown>;
  readonly httpClientLayer?: typeof fetchHttpClientLayer;
  readonly localSources?: UsageProviderLocalSourceReaders;
  readonly logSink?: StreamDeckLogSink;
  readonly now?: () => number;
}

const defaultLocalSources = createLocalUsageSourceReaders();

const BALANCE_PROVIDER_BASE_URLS = {
  fal: "https://api.fal.ai",
  "anthropic-api": "https://api.anthropic.com",
  "openai-api": "https://api.openai.com",
  deepgram: "https://api.deepgram.com",
  elevenlabs: "https://api.elevenlabs.io",
  runpod: "https://rest.runpod.io",
  speechmatics: "https://asr.api.speechmatics.com",
  tavily: "https://api.tavily.com",
  exa: "https://admin-api.exa.ai",
  jina: "https://r.jina.ai",
  moonshot: "https://api.moonshot.ai",
  deepseek: "https://api.deepseek.com",
} as const satisfies Readonly<Record<BalanceProviderId, string>>;

const USAGE_PROVIDER_BASE_URLS = {
  "claude-code": "https://api.anthropic.com",
  codex: "https://chatgpt.com",
  "zai-coding-plan": "https://api.z.ai",
  // MiniMax global host (owner live-probe-confirmed 2026-07-10). The adapter appends the
  // `/v1/coding_plan/remains` path. Mainland region-switching is a future option, not modeled now.
  minimax: "https://api.minimax.io",
} as const satisfies Readonly<Record<UsageProviderId, string>>;

/**
 * Builds the Effect-native per-key fetch the scheduler fibers run DIRECTLY: the
 * source-gated adapter `Effect` with the `HttpClient` layer provided here at the shell boundary,
 * wrapped with sanitized fetch-path logging. This removes the temporary `runPromiseExit` bridge —
 * the adapter Effect flows straight into the scheduler fiber (scheduler fiber -> adapter Effect ->
 * HttpClient -> schemaBodyJson).
 */
export function createSchedulerFetchForActionSettings(
  settings: NormalizedActionSettingsView,
  options: CreateSchedulerFetchOptions,
): SchedulerEffectFetch {
  return withFetchPathLogging(settings, options, createSchedulerFetchWithoutLogging(settings, options));
}

/** Sanitized provider-fetch path logs: started, succeeded, failed (never payloads or secrets). */
function withFetchPathLogging(
  settings: NormalizedActionSettingsView,
  options: CreateSchedulerFetchOptions,
  runFetch: SchedulerEffectFetch,
): SchedulerEffectFetch {
  const logSink = options.logSink;
  if (logSink === undefined) {
    return runFetch;
  }

  return (request) =>
    Effect.gen(function* () {
      const startedAt = yield* readNowMillis(options.now);
      yield* logEvent(logSink, {
        context: {
          actionFamilyId: settings.familyId,
          providerId: settings.providerId,
          reasonCode: request.trigger,
        },
        eventName: "streamdeck-provider-fetch-started",
        level: "info",
        message: "Provider fetch started.",
      });

      const outcome = yield* Effect.either(runFetch(request));
      const elapsedMs = Math.max(0, (yield* readNowMillis(options.now)) - startedAt);
      if (Either.isRight(outcome)) {
        yield* logEvent(logSink, {
          context: {
            actionFamilyId: settings.familyId,
            providerId: settings.providerId,
            reasonCode: "fetch-succeeded",
            elapsedMs,
          },
          eventName: "streamdeck-provider-fetch-succeeded",
          level: "info",
          message: "Provider fetch succeeded.",
        });
        return outcome.right;
      }

      const failure = outcome.left.failure;
      yield* logEvent(logSink, {
        context: {
          actionFamilyId: settings.familyId,
          providerId: settings.providerId,
          reasonCode: failure.diagnostics.reasonCode,
          retryClass: failure.retryClass,
          ...(failure.diagnostics.httpStatusClass === undefined ? {} : { httpStatusClass: failure.diagnostics.httpStatusClass }),
          elapsedMs,
        },
        eventName: "streamdeck-provider-fetch-failed",
        level: "warn",
        message: failure.safePublicMessage,
      });
      return yield* Effect.fail(outcome.left);
    });
}

/** Fire the best-effort shell log without letting a logging rejection defect the poll fiber. */
function logEvent(logSink: StreamDeckLogSink, event: Parameters<typeof writeShellLog>[1]): Effect.Effect<void, never, never> {
  return Effect.promise(() => writeShellLog(logSink, event).catch(() => undefined));
}

/**
 * Reads wall-clock millis for fetch-path timing from the injected `now` seam when present,
 * else Effect `Clock` (no `Date.now` in Effect code). `Clock.currentTimeMillis`
 * is a default service, so this adds nothing to the fetch effect's requirements channel.
 */
function readNowMillis(now: (() => number) | undefined): Effect.Effect<number> {
  return now === undefined ? Clock.currentTimeMillis : Effect.succeed(now());
}

function createSchedulerFetchWithoutLogging(
  settings: NormalizedActionSettingsView,
  options: CreateSchedulerFetchOptions,
): SchedulerEffectFetch {
  const httpClientLayer = options.httpClientLayer ?? fetchHttpClientLayer;

  if (settings.familyId === "usage") {
    if (!isUsageProviderId(settings.providerId) || !isUsageWindowId(settings.windowOrPeriod)) {
      return failureFetch("usage-action-settings-invalid");
    }
    const resolved = resolveUsageProviderOption({
      providerId: settings.providerId,
      windowOrPeriod: settings.windowOrPeriod,
    });
    if (!resolved.ok) {
      return sanitizedFailureFetch(resolved.failure);
    }
    const sourceFetch = createUsageProviderSourceFetchEffect({
      providerId: resolved.value.providerId,
      baseUrl: USAGE_PROVIDER_BASE_URLS[resolved.value.providerId],
      localSources: options.localSources ?? defaultLocalSources,
      resolveCredential: async () =>
        resolveCredentialMaterialFromGlobalSettings({
          actionSettings: settings,
          globalSettings: await options.readGlobalSettings(),
        }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const gated = createSourceGatedUsageFetchEffect({
      providerId: resolved.value.providerId,
      capability: resolved.value.capability,
      ...(sourceFetch === undefined ? {} : { sourceFetch }),
    });
    return (request) => gated(request).pipe(Effect.provide(httpClientLayer));
  }

  if (!isBalanceProviderId(settings.providerId)) {
    return failureFetch("balance-action-settings-invalid");
  }
  const windowOrPeriod = isCoverageKind(settings.windowOrPeriod) ? settings.windowOrPeriod : undefined;
  const resolved = resolveBalanceProviderOption({
    providerId: settings.providerId,
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
  });
  if (!resolved.ok) {
    return sanitizedFailureFetch(resolved.failure);
  }
  const sourceFetch = createBalanceProviderSourceFetchEffect({
    providerId: resolved.value.providerId,
    baseUrl: BALANCE_PROVIDER_BASE_URLS[resolved.value.providerId],
    resolveCredential: async () =>
      resolveCredentialMaterialFromGlobalSettings({
        actionSettings: settings,
        globalSettings: await options.readGlobalSettings(),
      }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const gated = createSourceGatedBalanceFetchEffect({
    providerId: resolved.value.providerId,
    capability: resolved.value.capability,
    ...(sourceFetch === undefined ? {} : { sourceFetch }),
  });
  return (request) => gated(request).pipe(Effect.provide(httpClientLayer));
}

function failureFetch(reasonCode: string): SchedulerEffectFetch {
  return sanitizedFailureFetch(
    createSanitizedFailure({
      category: "settings-validation-failure",
      diagnostics: {
        boundary: "streamdeck-shell",
        issueCount: 1,
        reasonCode,
      },
    }),
  );
}

function sanitizedFailureFetch(failure: SanitizedFailure): SchedulerEffectFetch {
  return () => Effect.fail({ failure });
}

function isUsageProviderId(providerId: string): providerId is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isBalanceProviderId(providerId: string): providerId is BalanceProviderId {
  return (BALANCE_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function isUsageWindowId(windowOrPeriod: string | undefined): windowOrPeriod is UsageWindowId {
  return windowOrPeriod !== undefined && (USAGE_WINDOW_IDS as readonly string[]).includes(windowOrPeriod);
}

function isCoverageKind(windowOrPeriod: string | undefined): windowOrPeriod is CoverageKind {
  return windowOrPeriod !== undefined && (COVERAGE_KINDS as readonly string[]).includes(windowOrPeriod);
}
