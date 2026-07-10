import type { Redacted } from "effect";

import type {
  BalanceMetricKind,
  BalanceProviderId,
  CoverageKind,
  NormalizedSnapshot,
  ProviderId,
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  UsageProviderId,
  UsageWindowId,
} from "@ai-workbench/contracts";
import type { SanitizedFailure } from "@ai-workbench/errors";
import type { ProviderCapabilityMetadata, SourceProofStatus } from "@ai-workbench/provider-registry";
import type { SchedulerFetch } from "@ai-workbench/scheduler";

export type ProviderAdapterSourceAccess = "source-gated" | "source-fetch";

export interface UsageProviderAdapterBinding {
  readonly adapterBindingId: string;
  readonly providerId: UsageProviderId;
  readonly actionFamilyId: "usage";
  readonly implementationStatus: ProviderCapabilityMetadata["implementationStatus"];
  readonly sourceProofStatus: SourceProofStatus;
  readonly supportedWindows: readonly UsageWindowId[];
  readonly fetchAllowed: boolean;
  readonly sourceAccess: ProviderAdapterSourceAccess;
  readonly refreshIntervalSeconds: typeof REFRESH_INTERVAL_DEFAULT_SECONDS;
  readonly retryOwner: "scheduler";
  readonly errorOwner: "shared-errors";
  readonly displayOwner: "display-boundary";
  readonly fetch: SchedulerFetch;
}

export interface BalanceProviderAdapterBinding {
  readonly adapterBindingId: string;
  readonly providerId: BalanceProviderId;
  readonly actionFamilyId: "balance";
  readonly implementationStatus: ProviderCapabilityMetadata["implementationStatus"];
  readonly sourceProofStatus: SourceProofStatus;
  readonly coverageKind: CoverageKind;
  readonly metricKind: BalanceMetricKind;
  readonly fetchAllowed: boolean;
  readonly sourceAccess: ProviderAdapterSourceAccess;
  readonly refreshIntervalSeconds: typeof REFRESH_INTERVAL_DEFAULT_SECONDS;
  readonly retryOwner: "scheduler";
  readonly errorOwner: "shared-errors";
  readonly displayOwner: "display-boundary";
  readonly fetch: SchedulerFetch;
}

export type ProviderAdapterBinding = UsageProviderAdapterBinding | BalanceProviderAdapterBinding;

export interface CreateSourceGatedUsageFetchInput {
  readonly providerId: UsageProviderId;
  readonly capability: ProviderCapabilityMetadata;
  readonly sourceFetch?: SchedulerFetch;
}

export interface CreateSourceGatedBalanceFetchInput {
  readonly providerId: ProviderId;
  readonly capability: ProviderCapabilityMetadata;
  readonly sourceFetch?: SchedulerFetch;
}

export interface ProviderCredentialMaterial {
  /**
   * The provider secret, type-wrapped as `Redacted<string>`: it renders `<redacted>` under
   * `JSON.stringify`/`String` and is
   * unwrapped with `Redacted.value` at only two sites — the shell credential
   * boundary (apps/streamdeck/src/credentials.ts) transiently unwraps it to reject
   * an all-whitespace value and immediately discards that read, and the
   * Effect-native adapter's HTTP request-builder unwraps it to forward the secret
   * in the request header. The request-builder is the only unwrap that forwards
   * the secret.
   */
  readonly value: Redacted.Redacted<string>;
}

export type ProviderCredentialResolution =
  | {
      readonly ok: true;
      readonly value: ProviderCredentialMaterial;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };

export type ResolveProviderCredentialMaterial = () =>
  | ProviderCredentialResolution
  | Promise<ProviderCredentialResolution>;

export type ClaudeCodeCredentialResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly expiresAt?: number;
    }
  | {
      readonly ok: false;
      readonly reasonCode: "claude-code-keychain-denied" | "claude-code-keychain-malformed";
    };

export type CodexCredentialResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly accountId: string;
    }
  | {
      readonly ok: false;
      readonly reasonCode: "codex-auth-missing" | "codex-auth-malformed" | "codex-auth-wrong-mode";
    };

export interface CodexSessionSnapshot {
  readonly fiveHourPercent?: number;
  readonly sevenDayPercent?: number;
  readonly fiveHourResetsAtEpochMs?: number;
  readonly sevenDayResetsAtEpochMs?: number;
  readonly fetchedAtEpochMs: number;
}

export interface UsageProviderLocalSourceReaders {
  readonly claudeCode?: {
    readonly readCredential: () => Promise<ClaudeCodeCredentialResult>;
  };
  readonly codex?: {
    readonly readCredential: () => Promise<CodexCredentialResult>;
    readonly readSessionSnapshot: () => Promise<CodexSessionSnapshot | undefined>;
  };
}

export interface ProviderSourceFetchInputBase {
  readonly baseUrl: string;
  readonly resolveCredential: ResolveProviderCredentialMaterial;
  readonly now?: () => number;
}

export interface CreateBalanceProviderSourceFetchInput extends ProviderSourceFetchInputBase {
  readonly providerId: BalanceProviderId;
}

export interface CreateUsageProviderSourceFetchInput extends ProviderSourceFetchInputBase {
  readonly providerId: UsageProviderId;
  readonly localSources?: UsageProviderLocalSourceReaders;
}

export interface NormalizeBalanceProviderResponseInput {
  readonly providerId: BalanceProviderId;
  readonly response: unknown;
  readonly fetchedAtEpochMs: number;
}

export type BalanceProviderNormalizationResult =
  | {
      readonly ok: true;
      readonly snapshot: NormalizedSnapshot;
      readonly currencyCode?: string;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };
