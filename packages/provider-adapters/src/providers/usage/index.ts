import type { UsageProviderId } from "@ai-workbench/contracts";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import { Effect } from "effect";

import {
  isGovernorBlocked,
  schedulerFailureFromGovernorBlocked,
  type EffectSchedulerFetch,
  type EffectUsageSchedulerFetch,
} from "../../effect-fetch.js";
import { ProviderAdapterAttemptContext } from "../../governed-request.js";
import { executeAdapterSource, runClaudeCodeUsageSource, runKimiCodeUsageSource } from "../../source-flight-runtime.js";
import type { CreateUsageProviderSourceFetchInput, UsageProviderAdapterBinding } from "../../types.js";
import {
  claudeCodeUsageProviderModule,
  createClaudeCodeUsageSourceOperation,
  projectClaudeCodeUsageResponse,
  validateClaudeCodeUsageRequest,
} from "./claude-code/index.js";
import { codexUsageProviderModule } from "./codex/index.js";
import {
  createKimiCodeUsageSourceOperation,
  kimiCodeUsageProviderModule,
  projectKimiCodeUsageResponse,
  validateKimiCodeUsageRequest,
} from "./kimi-code/index.js";
import { minimaxUsageProviderModule } from "./minimax/index.js";
import { zaiCodingPlanUsageProviderModule } from "./zai-coding-plan/index.js";

export interface UsageProviderModule {
  readonly providerId: UsageProviderId;
  readonly createBinding: (capability: ProviderCapabilityMetadata) => UsageProviderAdapterBinding;
  // Effect-native source fetch: every usage module exposes this (zai-coding-plan,
  // claude-code, codex); it is provided the `HttpClient` layer and consumed directly by the
  // scheduler fibers via `createUsageProviderSourceFetchEffect` below.
  readonly createSourceFetchEffect?: (input: CreateUsageProviderSourceFetchInput) => EffectUsageSchedulerFetch;
}

// Typed as the interface (not `as const`) so the dispatch below reads the optional
// `createSourceFetchEffect` member off the shared module interface; all usage providers are
// Effect-native.
export const usageProviderModules: readonly UsageProviderModule[] = [
  claudeCodeUsageProviderModule,
  codexUsageProviderModule,
  kimiCodeUsageProviderModule,
  zaiCodingPlanUsageProviderModule,
  minimaxUsageProviderModule,
];

/**
 * Effect-native dispatch: returns the migrated provider's RAW `Effect` source fetch
 * (`HttpClient` still in the context channel) so the Effect scheduler fibers consume it DIRECTLY —
 * the temporary `runPromiseExit` bridge is removed from the scheduler's consumption path. Every
 * usage provider is Effect-native (zai-coding-plan, claude-code, codex); the `HttpClient` layer is
 * provided by the caller (the shell's scheduler-fetch dispatch) before the effect reaches the scheduler.
 */
export function createUsageProviderSourceFetchEffect(
  input: CreateUsageProviderSourceFetchInput,
): EffectSchedulerFetch | undefined {
  if (
    input.providerId === "claude-code" &&
    input.sourceFlightRuntime !== undefined &&
    input.credentialProfileId !== undefined &&
    input.rateLimitDomain !== undefined
  ) {
    const source = createClaudeCodeUsageSourceOperation(input);
    const sourceFlightRuntime = input.sourceFlightRuntime;
    const credentialProfileId = input.credentialProfileId;
    const rateLimitDomain = input.rateLimitDomain;

    return (request) =>
      validateClaudeCodeUsageRequest(request).pipe(
        Effect.zipRight(
          runClaudeCodeUsageSource(
            sourceFlightRuntime,
            {
              providerId: "claude-code",
              credentialProfileId,
              rateLimitDomain,
              sourceIdentity: "oauth-usage",
              normalizedRequestVariant: "default",
            },
            (attempts) => source(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attempts)),
          ),
        ),
        Effect.flatMap((body) => projectClaudeCodeUsageResponse(body, request, input.now)),
        Effect.mapError((failure) => (isGovernorBlocked(failure) ? schedulerFailureFromGovernorBlocked(failure) : failure)),
      );
  }

  if (
    input.providerId === "kimi-code" &&
    input.sourceFlightRuntime !== undefined &&
    input.credentialProfileId !== undefined &&
    input.rateLimitDomain !== undefined
  ) {
    const source = createKimiCodeUsageSourceOperation(input);
    const sourceFlightRuntime = input.sourceFlightRuntime;
    const credentialProfileId = input.credentialProfileId;
    const rateLimitDomain = input.rateLimitDomain;

    return (request) =>
      validateKimiCodeUsageRequest(request).pipe(
        Effect.zipRight(
          runKimiCodeUsageSource(
            sourceFlightRuntime,
            {
              providerId: "kimi-code",
              credentialProfileId,
              rateLimitDomain,
              sourceIdentity: "managed-usage",
              normalizedRequestVariant: "default",
            },
            (attempts) => source(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attempts)),
          ),
        ),
        Effect.flatMap((body) => projectKimiCodeUsageResponse(body, request, input.now)),
        Effect.mapError((failure) => (isGovernorBlocked(failure) ? schedulerFailureFromGovernorBlocked(failure) : failure)),
      );
  }

  const providerModule = usageProviderModules.find((candidate) => candidate.providerId === input.providerId);
  const sourceFetch = providerModule?.createSourceFetchEffect?.(input);
  if (
    sourceFetch === undefined ||
    providerModule === undefined ||
    input.sourceFlightRuntime === undefined ||
    input.credentialProfileId === undefined ||
    input.rateLimitDomain === undefined
  ) {
    return undefined;
  }
  const sourceFlightRuntime = input.sourceFlightRuntime;
  const credentialProfileId = input.credentialProfileId;
  const rateLimitDomain = input.rateLimitDomain;

  return (request) =>
    executeAdapterSource(
      sourceFlightRuntime,
      {
        providerId: providerModule.providerId,
        credentialProfileId,
        rateLimitDomain,
        sourceIdentity: providerModule.providerId,
        normalizedRequestVariant: request.keyParts.windowOrPeriod ?? "current",
      },
      (attempts) => sourceFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attempts)),
    )
      .pipe(
        Effect.mapError((failure) => (isGovernorBlocked(failure) ? schedulerFailureFromGovernorBlocked(failure) : failure)),
      );
}
