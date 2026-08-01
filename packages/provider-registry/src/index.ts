import {
  METRIC_KIND_DIRECTION,
  METRIC_KIND_UNIT,
  DEFAULT_RATE_LIMIT_DOMAIN,
  type ActionFamilyId,
  type AcceptedCoordinationEvidence,
  type CoverageKind,
  type CoordinationEvidence,
  type CredentialClass,
  type DisplayState,
  type DisplayUnit,
  type ImplementationStatus,
  type MetricDirection,
  type MetricKind,
  type NoCoordinationEvidence,
  type ProviderId,
  type ResolvedProviderCoordinationPolicy,
  type UsageWindowId,
} from "@ai-workbench/contracts";

export const packageName = "@ai-workbench/provider-registry" as const;

export const SOURCE_PROOF_STATUSES = [
  "docsBacked",
  "probeAccepted",
  "sourceProofRequired",
  "probeRequired",
  "decisionGated",
  "unsupported",
  "notApplicable",
] as const;
export type SourceProofStatus = (typeof SOURCE_PROOF_STATUSES)[number];

export const PROVIDER_SETTING_REQUIREMENTS = [
  "credential-profile",
  "local-source-access",
  "mcp-source-selection",
  "sensitive-routing-selector",
  "severity-profile-optional",
  "display-preferences-optional",
] as const;
export type ProviderSettingRequirement = (typeof PROVIDER_SETTING_REQUIREMENTS)[number];

export const DISPLAY_BASES = [
  "bounded-percentage",
  "current-period-value",
  "remaining-value",
  "used-value",
] as const;
export type DisplayBasis = (typeof DISPLAY_BASES)[number];

export const SENSITIVE_SELECTOR_CLASSES = ["account", "organization", "project", "team", "workspace"] as const;
export type SensitiveSelectorClass = (typeof SENSITIVE_SELECTOR_CLASSES)[number];

export interface SensitiveSelectorRequirement {
  readonly selectorClass: SensitiveSelectorClass;
  readonly required: true;
}

export const SEVERITY_STRATEGY_REFERENCES = [
  "upper-bound-usage-percent-default",
  "lower-bound-remaining-percent-default",
  "upper-bound-spend-money-default",
  "lower-bound-remaining-money-default",
  // Codex "resets" default: lower-bound on the DAYS of reset-credit runway (days until the earliest
  // upcoming reset-credit expiry), not on the credit count. Fewer days left is worse (warn 7 / crit 3).
  "lower-bound-resets-days-default",
] as const;
export type SeverityStrategyReference = (typeof SEVERITY_STRATEGY_REFERENCES)[number];

export type SeverityStrategy =
  | {
      readonly kind: "registry-default";
      readonly reference: SeverityStrategyReference;
    }
  | {
      readonly kind: "requires-user-profile";
      readonly reason: "absolute-threshold-requires-owner-profile";
    };

export interface RegistryOpenDecision {
  readonly decisionId: "zai-monthly-mcp-display-truth";
  readonly options: readonly ["usage-consumed", "remaining-quota", "both"];
}

/**
 * User-facing presentation copy for one provider capability. This is the
 * single catalog home for Property Inspector credential labels/placeholders,
 * the per-provider "About" guidance, the short display-unit word used in
 * threshold labels, and the on-key auth-expired hint. Copy is carried over
 * verbatim from the old working plugin's Property Inspector and renderers.
 */
export interface ProviderPresentationMetadata {
  readonly credentialLabel?: string;
  readonly credentialPlaceholder?: string;
  readonly guidance?: string;
  readonly unitShortLabel?: string;
  readonly authExpiredHint?: string;
  /** Short key-header label when it differs from the product label (e.g. "Claude" on the key vs "Claude Code" in the picker). */
  readonly headerLabel?: string;
}

/**
 * Per-category metric override for a multi-category capability. A usage
 * capability whose default metric is `usage-percent` (the rolling windows) can
 * declare a category — keyed by its `UsageWindowId` — that carries a DIFFERENT
 * metric kind, display basis, coverage, and severity strategy (e.g. Codex
 * `credits`: a lower-bound evergreen credit pool with a no-default,
 * user-profile severity strategy). Metric direction and display unit are always
 * derived from `metricKind`, never overridden independently.
 */
export interface CapabilityCategoryMetric {
  readonly metricKind: MetricKind;
  readonly displayBasis: DisplayBasis;
  readonly coverageKind: CoverageKind;
  readonly severityStrategy: SeverityStrategy;
}

export interface ProviderCapabilityMetadata {
  readonly actionFamilyId: ActionFamilyId;
  readonly adapterBindingId: string;
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly credentialClasses: readonly CredentialClass[];
  readonly sensitiveSelectorRequirements: readonly SensitiveSelectorRequirement[];
  readonly requiredSettings: readonly ProviderSettingRequirement[];
  readonly metricKind: MetricKind;
  readonly metricDirection: MetricDirection;
  readonly displayUnit: DisplayUnit;
  readonly displayBasis: DisplayBasis;
  readonly coverageKind: CoverageKind;
  readonly supportedWindows?: readonly UsageWindowId[];
  readonly severityStrategy: SeverityStrategy;
  /**
   * Per-category metric metadata overrides keyed by category id. A category not
   * listed here uses the capability's top-level metric metadata. Only categories
   * present in `supportedWindows` are meaningful.
   */
  readonly categoryMetrics?: Readonly<Partial<Record<UsageWindowId, CapabilityCategoryMetric>>>;
  readonly presentation?: ProviderPresentationMetadata;
  readonly unavailableReason?: string;
  readonly openDecision?: RegistryOpenDecision;
}

/**
 * Authoritative catalog metadata with the internal policy resolved at the
 * registry boundary. Read-only consumers can continue to depend on the
 * narrower `ProviderCapabilityMetadata` shape when they do not need policy.
 */
export interface ResolvedProviderCapabilityMetadata extends ProviderCapabilityMetadata {
  readonly coordinationPolicy: ResolvedProviderCoordinationPolicy;
}

/** Effective metric metadata for one capability category, with direction/unit derived from `metricKind`. */
export interface ResolvedCapabilityMetric {
  readonly metricKind: MetricKind;
  readonly metricDirection: MetricDirection;
  readonly displayUnit: DisplayUnit;
  readonly displayBasis: DisplayBasis;
  readonly coverageKind: CoverageKind;
  readonly severityStrategy: SeverityStrategy;
}

/**
 * Resolves the effective metric metadata for a capability in a given category
 * (usage window). Returns the capability's top-level metric metadata unless a
 * `categoryMetrics` override applies to `windowOrPeriod`. Metric direction and
 * display unit are always derived from the resolved `metricKind`, keeping the
 * registry the single owner of direction/unit truth.
 */
export function resolveCapabilityMetricForWindow(
  capability: ProviderCapabilityMetadata,
  windowOrPeriod: UsageWindowId | undefined,
): ResolvedCapabilityMetric {
  const override = windowOrPeriod === undefined ? undefined : capability.categoryMetrics?.[windowOrPeriod];
  const metricKind = override?.metricKind ?? capability.metricKind;
  return {
    metricKind,
    metricDirection: METRIC_KIND_DIRECTION[metricKind],
    displayUnit: METRIC_KIND_UNIT[metricKind],
    displayBasis: override?.displayBasis ?? capability.displayBasis,
    coverageKind: override?.coverageKind ?? capability.coverageKind,
    severityStrategy: override?.severityStrategy ?? capability.severityStrategy,
  };
}

export interface ProviderRegistryEntry<Id extends string = ProviderId> {
  readonly providerId: Id;
  readonly productLabel: string;
  readonly capabilities: readonly ResolvedProviderCapabilityMetadata[];
}

export interface ImplementationStatusBehavior {
  readonly selectionEligible: boolean;
  readonly fetchAllowed: boolean;
  readonly unavailableDisplayState?: DisplayState;
}

export const IMPLEMENTATION_STATUS_BEHAVIOR: Readonly<Record<ImplementationStatus, ImplementationStatusBehavior>> = {
  implemented: {
    selectionEligible: true,
    fetchAllowed: true,
  },
  probeRequired: {
    selectionEligible: false,
    fetchAllowed: false,
    unavailableDisplayState: "not-implemented",
  },
  docsOnly: {
    selectionEligible: false,
    fetchAllowed: false,
    unavailableDisplayState: "not-implemented",
  },
  unsupported: {
    selectionEligible: false,
    fetchAllowed: false,
    unavailableDisplayState: "unsupported-capability",
  },
  notImplemented: {
    selectionEligible: false,
    fetchAllowed: false,
    unavailableDisplayState: "not-implemented",
  },
} as const;

type CapabilityInput = Omit<ResolvedProviderCapabilityMetadata, "displayUnit" | "metricDirection" | "coordinationPolicy"> & {
  readonly coordinationPolicy?: unknown;
};

export const DEFAULT_PROVIDER_COORDINATION_POLICY = {
  rateLimitDomain: DEFAULT_RATE_LIMIT_DOMAIN,
  sourceIdentity: "adapter-declared",
  sourceSharing: "not-declared",
  rateLimitDomainEvidence: { status: "not-required" },
  sourceSharingEvidence: { status: "not-required" },
} as const satisfies ResolvedProviderCoordinationPolicy;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isNoCoordinationEvidence(value: unknown): value is NoCoordinationEvidence {
  return isRecord(value) && hasOnlyKeys(value, ["status"]) && value.status === "not-required";
}

function isAcceptedCoordinationEvidence(value: unknown): value is AcceptedCoordinationEvidence {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["status", "source"]) &&
    value.status === "accepted" &&
    (value.source === "primary-source" || value.source === "local-source" || value.source === "owner-approved-sanitized-probe")
  );
}

function isSafeCoordinationLabel(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function invalidProviderCoordinationPolicy(): never {
  throw new Error("Invalid provider coordination policy");
}

function resolveRateLimitDomain(value: unknown): {
  readonly domain: string;
  readonly evidence: CoordinationEvidence;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "domain", "evidence"])) {
    return invalidProviderCoordinationPolicy();
  }

  const declaration = value as unknown as { readonly kind?: unknown; readonly domain?: unknown; readonly evidence?: unknown };
  if (
    declaration.kind === "provider-profile" &&
    declaration.domain === DEFAULT_RATE_LIMIT_DOMAIN &&
    isNoCoordinationEvidence(declaration.evidence)
  ) {
    return { domain: DEFAULT_RATE_LIMIT_DOMAIN, evidence: declaration.evidence };
  }

  if (
    declaration.kind === "evidence-backed" &&
    isSafeCoordinationLabel(declaration.domain) &&
    declaration.domain !== DEFAULT_RATE_LIMIT_DOMAIN &&
    isAcceptedCoordinationEvidence(declaration.evidence)
  ) {
    return { domain: declaration.domain, evidence: declaration.evidence };
  }

  return invalidProviderCoordinationPolicy();
}

function resolveSourceSharing(value: unknown): {
  readonly kind: ResolvedProviderCoordinationPolicy["sourceSharing"];
  readonly evidence: CoordinationEvidence;
} {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "evidence"])) {
    return invalidProviderCoordinationPolicy();
  }

  const declaration = value as unknown as { readonly kind?: unknown; readonly evidence?: unknown };
  if (declaration.kind === "not-declared" && isNoCoordinationEvidence(declaration.evidence)) {
    return { kind: declaration.kind, evidence: declaration.evidence };
  }

  if (declaration.kind === "fan-out" && isAcceptedCoordinationEvidence(declaration.evidence)) {
    return { kind: declaration.kind, evidence: declaration.evidence };
  }

  return invalidProviderCoordinationPolicy();
}

/**
 * Validates static coordination metadata at the catalog boundary. The error
 * intentionally contains no rejected declaration values.
 */
export function resolveProviderCoordinationPolicy(
  declaration: unknown | undefined,
): ResolvedProviderCoordinationPolicy {
  if (declaration === undefined) {
    return DEFAULT_PROVIDER_COORDINATION_POLICY;
  }

  if (!isRecord(declaration) || !hasOnlyKeys(declaration, ["rateLimitDomain", "sourceSharing"])) {
    return invalidProviderCoordinationPolicy();
  }

  const rateLimitDomain = resolveRateLimitDomain(declaration.rateLimitDomain);
  const sourceSharing = resolveSourceSharing(declaration.sourceSharing);
  return {
    rateLimitDomain: rateLimitDomain.domain,
    sourceIdentity: "adapter-declared",
    sourceSharing: sourceSharing.kind,
    rateLimitDomainEvidence: rateLimitDomain.evidence,
    sourceSharingEvidence: sourceSharing.evidence,
  };
}

function capability(input: CapabilityInput): ResolvedProviderCapabilityMetadata {
  const { coordinationPolicy, ...metadata } = input;
  return {
    ...metadata,
    coordinationPolicy: resolveProviderCoordinationPolicy(coordinationPolicy),
    metricDirection: METRIC_KIND_DIRECTION[metadata.metricKind],
    displayUnit: METRIC_KIND_UNIT[metadata.metricKind],
  };
}

const localSourceCredential = ["local-read-only-source"] as const;
const pluginApiKeyCredential = ["plugin-api-key"] as const;
const adminApiCredential = ["admin-api-credential"] as const;

const localSourceSettings = ["local-source-access", "display-preferences-optional"] as const;
const credentialSettings = ["credential-profile", "severity-profile-optional", "display-preferences-optional"] as const;
const usageSeverity: SeverityStrategy = {
  kind: "registry-default",
  reference: "upper-bound-usage-percent-default",
};

const spendSeverity: SeverityStrategy = {
  kind: "registry-default",
  reference: "upper-bound-spend-money-default",
};

const remainingMoneySeverity: SeverityStrategy = {
  kind: "registry-default",
  reference: "lower-bound-remaining-money-default",
};

// Codex "resets" default: severity is judged on the reset-credit RUNWAY (days until the earliest
// upcoming reset-credit expiry), a lower-bound derived quantity — fewer days left is worse. Unlike
// the no-default "credits" pool, resets ships a registry default (warn 7 / crit 3 days); a user
// PI floor (in days) still overrides it in the central engine.
const resetsDaysSeverity: SeverityStrategy = {
  kind: "registry-default",
  reference: "lower-bound-resets-days-default",
};

const requiresUserProfileSeverity: SeverityStrategy = {
  kind: "requires-user-profile",
  reason: "absolute-threshold-requires-owner-profile",
};

function usageCapability(input: {
  readonly adapterBindingId: string;
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly supportedWindows: readonly UsageWindowId[];
  readonly coordinationPolicy?: unknown;
  readonly credentialClasses: readonly CredentialClass[];
  readonly requiredSettings: readonly ProviderSettingRequirement[];
  readonly categoryMetrics?: Readonly<Partial<Record<UsageWindowId, CapabilityCategoryMetric>>>;
  readonly presentation?: ProviderPresentationMetadata;
  readonly unavailableReason?: string;
  readonly openDecision?: RegistryOpenDecision;
}): ResolvedProviderCapabilityMetadata {
  return capability({
    actionFamilyId: "usage",
    adapterBindingId: input.adapterBindingId,
    implementationStatus: input.implementationStatus,
    sourceProofStatus: input.sourceProofStatus,
    credentialClasses: input.credentialClasses,
    sensitiveSelectorRequirements: [],
    requiredSettings: input.requiredSettings,
    metricKind: "usage-percent",
    displayBasis: "bounded-percentage",
    coverageKind: "rolling-window",
    supportedWindows: input.supportedWindows,
    severityStrategy: usageSeverity,
    ...(input.coordinationPolicy === undefined ? {} : { coordinationPolicy: input.coordinationPolicy }),
    ...(input.categoryMetrics === undefined ? {} : { categoryMetrics: input.categoryMetrics }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    ...(input.unavailableReason === undefined ? {} : { unavailableReason: input.unavailableReason }),
    ...(input.openDecision === undefined ? {} : { openDecision: input.openDecision }),
  });
}

function balanceCapability(input: {
  readonly adapterBindingId: string;
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly credentialClasses: readonly CredentialClass[];
  readonly sensitiveSelectorRequirements?: readonly SensitiveSelectorRequirement[];
  readonly requiredSettings: readonly ProviderSettingRequirement[];
  readonly metricKind: MetricKind;
  readonly displayBasis: DisplayBasis;
  readonly coverageKind: CoverageKind;
  readonly severityStrategy: SeverityStrategy;
  readonly presentation?: ProviderPresentationMetadata;
  readonly unavailableReason?: string;
}): ResolvedProviderCapabilityMetadata {
  return capability({
    actionFamilyId: "balance",
    adapterBindingId: input.adapterBindingId,
    implementationStatus: input.implementationStatus,
    sourceProofStatus: input.sourceProofStatus,
    credentialClasses: input.credentialClasses,
    sensitiveSelectorRequirements: input.sensitiveSelectorRequirements ?? [],
    requiredSettings: input.requiredSettings,
    metricKind: input.metricKind,
    displayBasis: input.displayBasis,
    coverageKind: input.coverageKind,
    severityStrategy: input.severityStrategy,
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    ...(input.unavailableReason === undefined ? {} : { unavailableReason: input.unavailableReason }),
  });
}

// Product labels, Balance ordering, per-provider credential labels/placeholders,
// "About" guidance, threshold unit words, and auth-expired hints replicate the
// old working plugin's Property Inspector and key renderers verbatim
// (stream-deck_before_effect ui/usage-display.html, ui/balance-display.html,
// src/render/key-svg.ts, src/render/balance-key-svg.ts). Mistral from the old
// plugin remains excluded. Kimi Code was owner-approved on 2026-08-01 as a
// read-only local-source Usage provider. MiniMax was added 2026-07-10 as a later addition above
// the first-family catalog, with a live-probe-confirmed coding-plan usage API.
export const PROVIDER_REGISTRY = [
  {
    providerId: "claude-code",
    productLabel: "Claude Code",
    capabilities: [
      usageCapability({
        adapterBindingId: "usage.claude-code",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        // "fable" is a claude-code-only weekly scoped usage window (the Fable model's rolling weekly
        // percentage from the OAuth usage response `limits[]`), offered ALONGSIDE the 5h/7d rolling
        // percentage windows. It is a plain upper-bound usage-percent rolling window like seven-day —
        // NO categoryMetrics override — so it inherits the capability default metric/severity.
        // "credit-spend" is a claude-code-only extra-usage SPEND category (the OAuth usage response's
        // `spend` object): an upper-bound usage-spend money metric with current-period coverage and a
        // no-default (requires-user-profile) severity strategy — green until the owner sets absolute
        // dollar warn/critical thresholds (same no-default path as the balance remaining-money floors,
        // but upper-bound: more spent is worse). The internal id is `credit-spend`, NOT `credits`
        // (Codex owns the `credits` count pool) so the two never clash. Only claude-code declares it.
        supportedWindows: ["five-hour", "seven-day", "fable", "credit-spend"],
        coordinationPolicy: {
          rateLimitDomain: {
            kind: "provider-profile",
            domain: "provider-profile",
            evidence: { status: "not-required" },
          },
          sourceSharing: {
            kind: "fan-out",
            evidence: { status: "accepted", source: "local-source" },
          },
        },
        credentialClasses: localSourceCredential,
        requiredSettings: localSourceSettings,
        categoryMetrics: {
          "credit-spend": {
            metricKind: "usage-spend",
            displayBasis: "current-period-value",
            coverageKind: "current-period",
            // No registry default: green until the owner sets an absolute dollar warn/critical
            // threshold in the Property Inspector (upper-bound — the key turns amber/red when the
            // money spent RISES past the threshold).
            severityStrategy: requiresUserProfileSeverity,
          },
        },
        presentation: {
          authExpiredHint: "open Claude Code",
          headerLabel: "Claude",
        },
      }),
    ],
  },
  {
    providerId: "codex",
    productLabel: "Codex",
    capabilities: [
      usageCapability({
        adapterBindingId: "usage.codex",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        // "credits" (evergreen credit pool) and "resets" (evergreen count of available rate-limit
        // reset credits) are Codex-only lower-bound categories, offered ALONGSIDE the 5h/7d rolling
        // percentage windows. Only Codex declares them.
        supportedWindows: ["five-hour", "seven-day", "credits", "resets"],
        credentialClasses: localSourceCredential,
        requiredSettings: localSourceSettings,
        categoryMetrics: {
          credits: {
            metricKind: "usage-credits",
            displayBasis: "remaining-value",
            coverageKind: "evergreen",
            // No registry default: green until the user sets a warn/critical FLOOR
            // (same no-default path as the balance remaining-credits vendors).
            severityStrategy: requiresUserProfileSeverity,
          },
          resets: {
            metricKind: "usage-resets",
            displayBasis: "remaining-value",
            coverageKind: "evergreen",
            // Severity is judged on the reset-credit RUNWAY (days to the earliest upcoming expiry),
            // NOT the count: fewer days left is worse. Ships a registry default (warn 7 / crit 3 days);
            // a user PI FLOOR (in days) overrides it. The displayed number stays the available count.
            severityStrategy: resetsDaysSeverity,
          },
        },
        presentation: {
          authExpiredHint: "run codex",
        },
      }),
    ],
  },
  {
    providerId: "kimi-code",
    productLabel: "Kimi Code",
    capabilities: [
      usageCapability({
        adapterBindingId: "usage.kimi-code",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        supportedWindows: ["five-hour", "seven-day", "extra-usage"],
        coordinationPolicy: {
          rateLimitDomain: {
            kind: "provider-profile",
            domain: "provider-profile",
            evidence: { status: "not-required" },
          },
          sourceSharing: {
            kind: "fan-out",
            evidence: { status: "accepted", source: "local-source" },
          },
        },
        credentialClasses: localSourceCredential,
        requiredSettings: localSourceSettings,
        categoryMetrics: {
          "extra-usage": {
            metricKind: "usage-spend",
            displayBasis: "current-period-value",
            coverageKind: "current-period",
            severityStrategy: requiresUserProfileSeverity,
          },
        },
        presentation: {
          authExpiredHint: "open Kimi Code",
          headerLabel: "Kimi",
        },
      }),
    ],
  },
  {
    providerId: "zai-coding-plan",
    productLabel: "Z.AI",
    capabilities: [
      usageCapability({
        adapterBindingId: "usage.zai-coding-plan",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        // Weekly ("seven-day") HIDDEN 2026-07-09: the z.ai coding-plan quota response
        // carries no weekly entry, so it is not offered in settings (mirrored in the PI
        // usage-display.html WINDOW_OPTIONS.zai row). The adapter's seven-day mapping is
        // RETAINED — re-add "seven-day" here + in that PI row to re-enable if z.ai adds it.
        supportedWindows: ["five-hour", "monthly-mcp"],
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        presentation: {
          credentialLabel: "Z.AI API Key",
          credentialPlaceholder: "paste your z.ai API key",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "minimax",
    productLabel: "MiniMax",
    capabilities: [
      usageCapability({
        adapterBindingId: "usage.minimax",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        // Owner live-probe-confirmed coding-plan usage API (2026-07-10): the global
        // `general` model exposes a rolling 5-hour interval (current_interval_remaining_percent)
        // and a rolling 7-day weekly window (current_weekly_remaining_percent). Both are
        // upper-bound usage-percent windows sharing the standard registry default severity,
        // exactly like z.ai/Codex. Mainland region-switching is a future option, not modeled now.
        supportedWindows: ["five-hour", "seven-day"],
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        presentation: {
          credentialLabel: "MiniMax API Key",
          credentialPlaceholder: "paste your MiniMax API key",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "anthropic-api",
    productLabel: "Anthropic",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.anthropic-api",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: adminApiCredential,
        requiredSettings: credentialSettings,
        metricKind: "current-month-spend",
        displayBasis: "current-period-value",
        coverageKind: "month-to-date",
        severityStrategy: spendSeverity,
        presentation: {
          credentialLabel: "Anthropic Admin API Key",
          credentialPlaceholder: "sk-ant-admin-…",
          guidance:
            "Admin API key (sk-ant-admin…) from Console → Settings → Admin API keys. NOTE: this key carries FULL organization-admin privileges — no narrower Anthropic credential can read spend.",
          unitShortLabel: "USD",
          authExpiredHint: "needs admin key",
        },
      }),
    ],
  },
  {
    providerId: "openai-api",
    productLabel: "OpenAI",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.openai-api",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: adminApiCredential,
        requiredSettings: credentialSettings,
        metricKind: "current-month-spend",
        displayBasis: "current-period-value",
        coverageKind: "month-to-date",
        severityStrategy: spendSeverity,
        presentation: {
          credentialLabel: "OpenAI Admin Key",
          credentialPlaceholder: "sk-admin-…",
          guidance:
            "OpenAI ADMIN key (platform.openai.com → Organization settings → Admin keys) — spend comes from the org Costs API; a regular sk- key is rejected.",
          unitShortLabel: "USD",
          authExpiredHint: "needs admin key",
        },
      }),
    ],
  },
  {
    providerId: "moonshot",
    productLabel: "Moonshot",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.moonshot",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-balance",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: remainingMoneySeverity,
        presentation: {
          credentialLabel: "Moonshot Platform Key",
          credentialPlaceholder: "open-platform key (NOT a Kimi Code key)",
          guidance: "Moonshot OPEN-PLATFORM key (platform.moonshot.ai) — NOT the Kimi Code coding key, which is rejected here.",
          unitShortLabel: "USD",
          authExpiredHint: "needs platform key",
        },
      }),
    ],
  },
  {
    providerId: "deepseek",
    productLabel: "DeepSeek",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.deepseek",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-balance",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: remainingMoneySeverity,
        presentation: {
          credentialLabel: "DeepSeek API Key",
          credentialPlaceholder: "sk-…",
          guidance: "DeepSeek API key (platform.deepseek.com → API keys).",
          unitShortLabel: "USD",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "tavily",
    productLabel: "Tavily",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.tavily",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-credits",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: requiresUserProfileSeverity,
        presentation: {
          credentialLabel: "Tavily API Key",
          credentialPlaceholder: "tvly-…",
          guidance: "Tavily API key (app.tavily.com → API keys).",
          unitShortLabel: "credits",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "exa",
    productLabel: "Exa",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.exa",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "current-month-spend",
        displayBasis: "current-period-value",
        coverageKind: "month-to-date",
        severityStrategy: spendSeverity,
        presentation: {
          credentialLabel: "Exa Service API Key",
          credentialPlaceholder: "team-management service key",
          guidance: "Exa SERVICE API key (team-management credential; Exa dashboard). Distinct from a search key.",
          unitShortLabel: "USD",
          authExpiredHint: "needs service key",
        },
      }),
    ],
  },
  {
    providerId: "deepgram",
    productLabel: "Deepgram",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.deepgram",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-balance",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: remainingMoneySeverity,
        presentation: {
          credentialLabel: "Deepgram Project Key",
          credentialPlaceholder: "project-scoped key",
          guidance: "Deepgram PROJECT-scoped key with billing:read permission (Console → the project).",
          unitShortLabel: "USD",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "jina",
    productLabel: "Jina",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.jina",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-tokens",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: requiresUserProfileSeverity,
        presentation: {
          credentialLabel: "Jina API Key",
          credentialPlaceholder: "jina_…",
          guidance: "Jina API key (jina.ai).",
          unitShortLabel: "tokens",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "fal",
    productLabel: "Fal.AI",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.fal",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-balance",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: remainingMoneySeverity,
        presentation: {
          credentialLabel: "fal.ai Admin API Key",
          credentialPlaceholder: "fal admin/scope key",
          guidance:
            "fal.ai Admin/API-scope key (fal.ai dashboard → Keys). The billing endpoint requires the key class that can read account billing credits.",
          unitShortLabel: "USD",
          authExpiredHint: "needs admin key",
        },
      }),
    ],
  },
  {
    providerId: "elevenlabs",
    productLabel: "ElevenLabs",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.elevenlabs",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "remaining-characters",
        displayBasis: "remaining-value",
        coverageKind: "evergreen",
        severityStrategy: requiresUserProfileSeverity,
        presentation: {
          credentialLabel: "ElevenLabs API Key",
          credentialPlaceholder: "xi-…",
          guidance: "ElevenLabs API key (elevenlabs.io → Profile → API key).",
          unitShortLabel: "chars",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "runpod",
    productLabel: "RunPod",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.runpod",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "current-period-spend",
        displayBasis: "current-period-value",
        coverageKind: "current-period",
        severityStrategy: spendSeverity,
        presentation: {
          credentialLabel: "RunPod API Key",
          credentialPlaceholder: "RunPod API key",
          guidance: "RunPod API key. Billing endpoints report usage/spend history, not remaining balance.",
          unitShortLabel: "USD",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
  {
    providerId: "speechmatics",
    productLabel: "Speechmatics",
    capabilities: [
      balanceCapability({
        adapterBindingId: "balance.speechmatics",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        credentialClasses: pluginApiKeyCredential,
        requiredSettings: credentialSettings,
        metricKind: "used-time",
        displayBasis: "used-value",
        coverageKind: "current-period",
        severityStrategy: requiresUserProfileSeverity,
        presentation: {
          credentialLabel: "Speechmatics API Key",
          credentialPlaceholder: "Speechmatics key",
          guidance:
            "Speechmatics API key (portal). This vendor reports audio HOURS, not money — and only through yesterday (their API excludes the current day).",
          unitShortLabel: "hrs",
          authExpiredHint: "check API key",
        },
      }),
    ],
  },
] as const satisfies readonly ProviderRegistryEntry[];

export interface ProviderAdapterBinding {
  readonly adapterBindingId: string;
}

export interface ProviderSelectionRequest {
  readonly actionFamilyId: ActionFamilyId;
  readonly adapterBindings: readonly ProviderAdapterBinding[];
}

export interface ProviderSelectionOption {
  readonly providerId: string;
  readonly productLabel: string;
  readonly actionFamilyId: ActionFamilyId;
  readonly adapterBindingId: string;
  readonly implementationStatus: ImplementationStatus;
  readonly metricKind: MetricKind;
  readonly metricDirection: MetricDirection;
  readonly displayUnit: DisplayUnit;
}

export function listProviderEntriesForFamily(actionFamilyId: ActionFamilyId): readonly ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY.filter((entry) =>
    entry.capabilities.some((capabilityMetadata) => capabilityMetadata.actionFamilyId === actionFamilyId),
  );
}

export function findProviderEntry(providerId: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((entry) => entry.providerId === providerId);
}

export function deriveProviderSelectionOptions(
  registry: readonly ProviderRegistryEntry<string>[],
  request: ProviderSelectionRequest,
): readonly ProviderSelectionOption[] {
  const implementedAdapterBindingIds = new Set(request.adapterBindings.map((binding) => binding.adapterBindingId));

  return registry.flatMap((entry) =>
    entry.capabilities
      .filter((capabilityMetadata) => capabilityMetadata.actionFamilyId === request.actionFamilyId)
      .filter((capabilityMetadata) => IMPLEMENTATION_STATUS_BEHAVIOR[capabilityMetadata.implementationStatus].selectionEligible)
      .filter((capabilityMetadata) => implementedAdapterBindingIds.has(capabilityMetadata.adapterBindingId))
      .map((capabilityMetadata) => ({
        providerId: entry.providerId,
        productLabel: entry.productLabel,
        actionFamilyId: capabilityMetadata.actionFamilyId,
        adapterBindingId: capabilityMetadata.adapterBindingId,
        implementationStatus: capabilityMetadata.implementationStatus,
        metricKind: capabilityMetadata.metricKind,
        metricDirection: capabilityMetadata.metricDirection,
        displayUnit: capabilityMetadata.displayUnit,
      })),
  );
}
