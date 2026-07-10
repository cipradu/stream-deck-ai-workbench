/**
 * Stable machine identifiers for the first provider catalog. These are
 * storage/lookup keys only; product-visible labels belong to the provider
 * registry, never to these ids.
 */

export const USAGE_PROVIDER_IDS = ["claude-code", "codex", "zai-coding-plan", "minimax"] as const;
export type UsageProviderId = (typeof USAGE_PROVIDER_IDS)[number];

// Declared in the old working plugin's Balance picker order; the registry and
// Property Inspector mirror this ordering.
export const BALANCE_PROVIDER_IDS = [
  "anthropic-api",
  "openai-api",
  "moonshot",
  "deepseek",
  "tavily",
  "exa",
  "deepgram",
  "jina",
  "fal",
  "elevenlabs",
  "runpod",
  "speechmatics",
] as const;
export type BalanceProviderId = (typeof BALANCE_PROVIDER_IDS)[number];

export const PROVIDER_IDS = [...USAGE_PROVIDER_IDS, ...BALANCE_PROVIDER_IDS] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
