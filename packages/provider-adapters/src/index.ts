export const packageName = "@ai-workbench/provider-adapters" as const;

export {
  findProviderAdapterBinding,
  listBalanceProviderAdapterBindings,
  listStatusProviderAdapterBindings,
  listUsageProviderAdapterBindings,
} from "./bindings.js";
export { createBalanceProviderSourceFetchEffect } from "./providers/balance/index.js";
export { createStatusProviderSourceFetchEffect } from "./providers/status/index.js";
export { createUsageProviderSourceFetchEffect } from "./providers/usage/index.js";
// Exported so the log-sanitizer guard in `apps/streamdeck` asserts the REAL emitted reason
// codes. `provider-adapters` cannot import `logging`, so the guard cannot live here.
export {
  ZAI_USAGE_REASON_CODES,
  __zaiVendorBusinessErrorReasonForTests,
} from "./providers/usage/zai-coding-plan/index.js";
export {
  createSourceGatedBalanceFetch,
  createSourceGatedBalanceFetchEffect,
  createSourceGatedStatusFetch,
  createSourceGatedStatusFetchEffect,
  createSourceGatedUsageFetch,
  createSourceGatedUsageFetchEffect,
} from "./source-gates.js";
export { normalizeBalanceProviderResponse } from "./providers/balance/index.js";
export {
  AdapterSourceFlightRuntimeCapability,
  AdapterSourceFlightRuntimeLive,
  advanceAdapterSourceCredentialGeneration,
  makeAdapterSourceFlightRuntimeLive,
  shutdownAdapterSourceFlightRuntime,
} from "./source-flight-runtime.js";
export type { AdapterSourceFlightRuntimeTestObserver, AdapterSourceRequestIdentity } from "./source-flight-runtime.js";
export type {
  BalanceProviderAdapterBinding,
  BalanceProviderNormalizationResult,
  ClaudeCodeCredentialResult,
  CodexCredentialResult,
  CodexSessionSnapshot,
  KimiCodeCredentialResult,
  CreateBalanceProviderSourceFetchInput,
  CreateStatusProviderSourceFetchInput,
  CreateUsageProviderSourceFetchInput,
  CreateSourceGatedBalanceFetchInput,
  CreateSourceGatedStatusFetchInput,
  CreateSourceGatedUsageFetchInput,
  NormalizeBalanceProviderResponseInput,
  ProviderAdapterBinding,
  ProviderAdapterSourceAccess,
  ProviderCredentialMaterial,
  ProviderCredentialResolution,
  ResolveProviderCredentialMaterial,
  UsageProviderLocalSourceReaders,
  StatusProviderAdapterBinding,
  UsageProviderAdapterBinding,
} from "./types.js";
