import type { BalanceProviderId } from "@ai-workbench/contracts";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";
import { Effect } from "effect";

import {
  isGovernorBlocked,
  schedulerFailureFromGovernorBlocked,
  type EffectBalanceSchedulerFetch,
  type EffectSchedulerFetch,
} from "../../effect-fetch.js";
import { ProviderAdapterAttemptContext } from "../../governed-request.js";
import { unsupportedNormalizationFailure } from "../../provider-failures.js";
import { executeAdapterSource } from "../../source-flight-runtime.js";
import type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
} from "../../types.js";
import { anthropicApiBalanceProviderModule } from "./anthropic-api/index.js";
import { deepgramBalanceProviderModule } from "./deepgram/index.js";
import { deepseekBalanceProviderModule } from "./deepseek/index.js";
import { elevenlabsBalanceProviderModule } from "./elevenlabs/index.js";
import { exaBalanceProviderModule } from "./exa/index.js";
import { falBalanceProviderModule } from "./fal/index.js";
import { jinaBalanceProviderModule } from "./jina/index.js";
import { moonshotBalanceProviderModule } from "./moonshot/index.js";
import { openAiApiBalanceProviderModule } from "./openai-api/index.js";
import { openrouterBalanceProviderModule } from "./openrouter/index.js";
import { runpodBalanceProviderModule } from "./runpod/index.js";
import { speechmaticsBalanceProviderModule } from "./speechmatics/index.js";
import { tavilyBalanceProviderModule } from "./tavily/index.js";

export interface BalanceProviderModule {
  readonly providerId: BalanceProviderId;
  readonly createBinding: (capability: ProviderCapabilityMetadata) => BalanceProviderAdapterBinding;
  // Effect-native source fetch: every balance module exposes this; it is provided the
  // `HttpClient` layer and consumed directly by the scheduler fibers via
  // `createBalanceProviderSourceFetchEffect` below.
  readonly createSourceFetchEffect?: (input: CreateBalanceProviderSourceFetchInput) => EffectBalanceSchedulerFetch;
  readonly normalize: (input: NormalizeBalanceProviderResponseInput) => BalanceProviderNormalizationResult;
}

// Typed as the interface (not `as const`) so the dispatch below reads the optional
// `createSourceFetchEffect` member off the shared module interface.
export const balanceProviderModules: readonly BalanceProviderModule[] = [
  falBalanceProviderModule,
  anthropicApiBalanceProviderModule,
  openAiApiBalanceProviderModule,
  deepgramBalanceProviderModule,
  elevenlabsBalanceProviderModule,
  runpodBalanceProviderModule,
  speechmaticsBalanceProviderModule,
  tavilyBalanceProviderModule,
  exaBalanceProviderModule,
  jinaBalanceProviderModule,
  moonshotBalanceProviderModule,
  deepseekBalanceProviderModule,
  openrouterBalanceProviderModule,
];

export function normalizeBalanceProviderResponse(
  input: NormalizeBalanceProviderResponseInput,
): BalanceProviderNormalizationResult {
  return (
    balanceProviderModules.find((providerModule) => providerModule.providerId === input.providerId)?.normalize(input) ??
    unsupportedNormalizationFailure("balance-provider-not-found")
  );
}

/**
 * Effect-native dispatch: returns the migrated provider's RAW `Effect` source fetch
 * (`HttpClient` still in the context channel) so the Effect scheduler fibers consume it DIRECTLY —
 * the temporary `runPromiseExit` bridge is removed from the scheduler's consumption path. Returns
 * `undefined` when the provider is not Effect-migrated. The `HttpClient` layer is provided by the
 * caller (the shell's scheduler-fetch dispatch) before the effect reaches the scheduler.
 */
export function createBalanceProviderSourceFetchEffect(
  input: CreateBalanceProviderSourceFetchInput,
): EffectSchedulerFetch | undefined {
  const providerModule = balanceProviderModules.find((candidate) => candidate.providerId === input.providerId);
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
