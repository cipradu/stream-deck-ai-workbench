import type { Redacted } from "effect";

import type {
  BalanceMetricKind,
  BalanceProviderId,
  CoverageKind,
  NormalizedSnapshot,
  ProviderId,
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  StatusProviderId,
  UsageProviderId,
  UsageWindowId,
} from "@ai-workbench/contracts";
import type { ResponseDiagnosticInput, SanitizedFailure } from "@ai-workbench/errors";
import type {
  ProviderCapabilityMetadata,
  SourceProofStatus,
  StatusProviderCapabilityMetadata,
} from "@ai-workbench/provider-registry";
import type { SchedulerFetch } from "@ai-workbench/scheduler";

import type { AdapterSourceFlightRuntimeCapability } from "./source-flight-runtime.js";

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

export interface StatusProviderAdapterBinding {
  readonly adapterBindingId: string;
  readonly providerId: StatusProviderId;
  readonly actionFamilyId: "status";
  readonly implementationStatus: StatusProviderCapabilityMetadata["implementationStatus"];
  readonly sourceProofStatus: SourceProofStatus;
  readonly credentialClass: "none";
  readonly fetchAllowed: boolean;
  readonly sourceAccess: ProviderAdapterSourceAccess;
  readonly refreshIntervalSeconds: typeof REFRESH_INTERVAL_DEFAULT_SECONDS;
  readonly retryOwner: "scheduler";
  readonly errorOwner: "shared-errors";
  readonly displayOwner: "display-boundary";
  readonly fetch: SchedulerFetch;
}

export type ProviderAdapterBinding = UsageProviderAdapterBinding | BalanceProviderAdapterBinding | StatusProviderAdapterBinding;

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

export interface CreateSourceGatedStatusFetchInput {
  readonly providerId: StatusProviderId;
  readonly capability: StatusProviderCapabilityMetadata;
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
      /**
       * One code per distinguishable failure shape, so the emitted log line identifies the cause
       * instead of collapsing four causes into one.
       *
       * `claude-code-keychain-malformed` is now UNREACHABLE — every branch of
       * `parseClaudeCodeKeychainPayload` returns a specific code. It is retained in the union
       * only so a stored or in-flight value from a previous build still type-checks; it is not a
       * fallback and nothing produces it. Remove it once no older build can be running.
       */
      readonly reasonCode:
        | "claude-code-keychain-denied"
        | "claude-code-keychain-malformed"
        | "claude-code-keychain-empty"
        | "claude-code-keychain-not-json"
        | "claude-code-keychain-root-not-object"
        | "claude-code-keychain-record-missing"
        | "claude-code-keychain-record-not-object"
        | "claude-code-keychain-credential-missing"
        | "claude-code-keychain-credential-blank"
        | "claude-code-keychain-credential-invalid"
        | "claude-code-file-unreadable"
        | "claude-code-file-not-json"
        | "claude-code-file-root-not-object"
        | "claude-code-file-record-missing"
        | "claude-code-file-record-not-object"
        | "claude-code-file-credential-missing"
        | "claude-code-file-credential-blank"
        | "claude-code-file-credential-invalid";
      /**
       * Catalog-derived structural diagnostic (ADR-0027). Carries no value-bearing field; the
       * central sanitizer promotes its `code` to the emitted `reasonCode`.
       */
      readonly responseDiagnostic?: ResponseDiagnosticInput;
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

export type KimiCodeCredentialResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly expiresAtEpochSeconds?: number;
    }
  | {
      readonly ok: false;
      readonly reasonCode: "kimi-code-auth-missing" | "kimi-code-auth-malformed";
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
    readonly refreshCredential?: () => Promise<void>;
  };
  readonly codex?: {
    readonly readCredential: () => Promise<CodexCredentialResult>;
    readonly readSessionSnapshot: () => Promise<CodexSessionSnapshot | undefined>;
  };
  readonly kimiCode?: {
    readonly readCredential: () => Promise<KimiCodeCredentialResult>;
    readonly refreshCredential?: () => Promise<void>;
  };
}

export interface ProviderSourceFetchInputBase {
  readonly baseUrl: string;
  readonly resolveCredential: ResolveProviderCredentialMaterial;
  readonly now?: () => number;
  /**
   * Safe, plugin-scoped coordination capability supplied only by the real app
   * composition. Dispatch fails closed when it is absent; it never substitutes
   * an ungoverned source path.
   */
  readonly sourceFlightRuntime?: AdapterSourceFlightRuntimeCapability;
  readonly credentialProfileId?: string;
  readonly rateLimitDomain?: string;
}

export interface CreateBalanceProviderSourceFetchInput extends ProviderSourceFetchInputBase {
  readonly providerId: BalanceProviderId;
}

export interface CreateUsageProviderSourceFetchInput extends ProviderSourceFetchInputBase {
  readonly providerId: UsageProviderId;
  readonly localSources?: UsageProviderLocalSourceReaders;
}

export interface CreateStatusProviderSourceFetchInput {
  readonly providerId: StatusProviderId;
  readonly sourceFlightRuntime?: AdapterSourceFlightRuntimeCapability;
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
