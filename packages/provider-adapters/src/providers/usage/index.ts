import type { UsageProviderId } from "@ai-workbench/contracts";
import type { ProviderCapabilityMetadata } from "@ai-workbench/provider-registry";

import type { EffectUsageSchedulerFetch } from "../../effect-fetch.js";
import type { CreateUsageProviderSourceFetchInput, UsageProviderAdapterBinding } from "../../types.js";
import { claudeCodeUsageProviderModule } from "./claude-code/index.js";
import { codexUsageProviderModule } from "./codex/index.js";
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
): EffectUsageSchedulerFetch | undefined {
  return usageProviderModules
    .find((providerModule) => providerModule.providerId === input.providerId)
    ?.createSourceFetchEffect?.(input);
}
