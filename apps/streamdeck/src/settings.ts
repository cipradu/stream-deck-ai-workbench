import { listBalanceProviderOptions } from "@ai-workbench/action-balance";
import { listUsageProviderOptions, resolveUsageCategoryMetric } from "@ai-workbench/action-usage";
import {
  BALANCE_PROVIDER_IDS,
  USAGE_PROVIDER_IDS,
  USAGE_WINDOW_IDS,
  type ActionFamilyId,
  type CredentialClass,
  type MetricDirection,
  type ProviderId,
  type SchedulerWindowOrPeriod,
  type SeverityThresholdBasis,
  type UsageWindowId,
} from "@ai-workbench/contracts";
import { createSanitizedFailure } from "@ai-workbench/errors";
import {
  parseActionSettings,
  type DisplayPreferencesSettings,
  type NormalizedActionSettingsView,
  type SettingsResult,
} from "@ai-workbench/settings";

const DEFAULT_ACTION_SETTINGS_BY_FAMILY = {
  usage: {
    familyId: "usage",
    providerId: "claude-code",
    displayPreferences: {
      usageDisplayMode: "used",
    },
    windowOrPeriod: "five-hour",
  },
  balance: {
    familyId: "balance",
    providerId: "anthropic-api",
    displayPreferences: {},
  },
  status: {
    familyId: "status",
    providerId: "anthropic-api",
  },
} as const;

const LEGACY_USAGE_PROVIDER_IDS = {
  claude: "claude-code",
  codex: "codex",
  kimi: "kimi-code",
  zai: "zai-coding-plan",
  // MiniMax has no old-plugin rename; the Property Inspector saves its own id under the
  // `provider` key, so it must resolve to itself (same self-mapping pattern as `codex`).
  minimax: "minimax",
} as const satisfies Readonly<Record<string, ProviderId>>;
const LEGACY_USAGE_PROVIDER_LOOKUP: Readonly<Record<string, ProviderId>> = LEGACY_USAGE_PROVIDER_IDS;

const LEGACY_BALANCE_PROVIDER_IDS = {
  anthropic: "anthropic-api",
  openai: "openai-api",
  fal: "fal",
  deepgram: "deepgram",
  elevenlabs: "elevenlabs",
  runpod: "runpod",
  speechmatics: "speechmatics",
  tavily: "tavily",
  exa: "exa",
  jina: "jina",
  moonshot: "moonshot",
  deepseek: "deepseek",
} as const satisfies Readonly<Record<string, ProviderId>>;
const LEGACY_BALANCE_PROVIDER_LOOKUP: Readonly<Record<string, ProviderId>> = LEGACY_BALANCE_PROVIDER_IDS;

const LEGACY_USAGE_WINDOWS = {
  five_hour: "five-hour",
  weekly: "seven-day",
  mcp_monthly: "monthly-mcp",
  // The Codex "credits"/"resets" and claude-code "fable"/"credit-spend" categories are new current
  // vocabulary (no old-plugin rename); the PI window dropdown saves them under the legacy `window`
  // key as "credits"/"resets"/"fable"/"credit-spend", so each must resolve to itself.
  credits: "credits",
  resets: "resets",
  fable: "fable",
  "credit-spend": "credit-spend",
  "extra-usage": "extra-usage",
} as const satisfies Readonly<Record<string, SchedulerWindowOrPeriod>>;
const LEGACY_USAGE_WINDOW_LOOKUP: Readonly<Record<string, SchedulerWindowOrPeriod>> = LEGACY_USAGE_WINDOWS;

const FORBIDDEN_COMPATIBILITY_KEYS = new Set([
  "apiKey",
  "secret",
  "token",
  "authorizationHeader",
  "authHeader",
  "credentialMaterial",
  "credentialValue",
  "sensitiveSelectors",
]);

// Old plugin global-settings key names -> current provider/credential-class
// identity. The old plugin stored `zaiApiKey` (and other usage keys) at the
// top level and balance keys nested under `balanceApiKeys.<vendor>`; both map
// into canonical credential profiles so previously saved keys keep working.
const LEGACY_USAGE_GLOBAL_KEYS = {
  zaiApiKey: "zai-coding-plan",
  // The MiniMax Property Inspector key field saves to the top-level `minimaxApiKey`
  // global-settings field (like z.ai's `zaiApiKey`); it maps into the canonical
  // minimax credential profile so a pasted key is resolvable and refetch-classified.
  minimaxApiKey: "minimax",
} as const satisfies Readonly<Record<string, ProviderId>>;

const ADMIN_CREDENTIAL_PROVIDER_IDS: ReadonlySet<string> = new Set(["anthropic-api", "openai-api"]);

function canonicalCredentialClassFor(familyId: ActionFamilyId, providerId: ProviderId): CredentialClass {
  void familyId;
  return ADMIN_CREDENTIAL_PROVIDER_IDS.has(providerId) ? "admin-api-credential" : "plugin-api-key";
}

/** Canonical profile id scheme shared with the Property Inspector. */
export function canonicalCredentialProfileId(familyId: ActionFamilyId, providerId: ProviderId, credentialClass: CredentialClass): string {
  return ["profile", familyId, providerId, credentialClass].join(":");
}

function legacyCredentialProfiles(input: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const profiles: Record<string, unknown>[] = [];

  for (const [legacyKey, providerId] of Object.entries(LEGACY_USAGE_GLOBAL_KEYS)) {
    const value = input[legacyKey];
    if (typeof value === "string" && value.length > 0) {
      profiles.push(legacyCredentialProfile("usage", providerId, value));
    }
  }

  const balanceKeys = input.balanceApiKeys;
  if (isRecord(balanceKeys)) {
    for (const [legacyVendor, value] of Object.entries(balanceKeys)) {
      const providerId = LEGACY_BALANCE_PROVIDER_LOOKUP[legacyVendor];
      if (providerId !== undefined && typeof value === "string" && value.length > 0) {
        profiles.push(legacyCredentialProfile("balance", providerId, value));
      }
    }
  }

  return profiles;
}

function legacyCredentialProfile(familyId: ActionFamilyId, providerId: ProviderId, value: string): Record<string, unknown> {
  const credentialClass = canonicalCredentialClassFor(familyId, providerId);
  return {
    profileId: canonicalCredentialProfileId(familyId, providerId, credentialClass),
    actionFamilyId: familyId,
    providerId,
    credentialClass,
    credentialMaterial: {
      kind: "inline-secret",
      value,
    },
  };
}

/**
 * Read-side compatibility: merges credential profiles derived from old-plugin
 * global-settings keys (`zaiApiKey`, `balanceApiKeys.<vendor>`) into the
 * payload when no canonical profile with the same identity exists yet. Writes
 * always emit the canonical profile model.
 */
export function withLegacyCredentialProfiles(globalSettings: unknown): unknown {
  if (!isRecord(globalSettings)) {
    return globalSettings;
  }

  const legacyProfiles = legacyCredentialProfiles(globalSettings);
  if (legacyProfiles.length === 0) {
    return globalSettings;
  }

  const existingProfiles = getArrayProperty(globalSettings, "credentialProfiles");
  const existingIds = new Set(
    existingProfiles.flatMap((profile) => (isRecord(profile) && typeof profile.profileId === "string" ? [profile.profileId] : [])),
  );
  const additions = legacyProfiles.filter((profile) => !existingIds.has(profile.profileId as string));
  if (additions.length === 0) {
    return globalSettings;
  }

  return {
    ...(cloneJsonLike(globalSettings) as Record<string, unknown>),
    credentialProfiles: [...cloneJsonLikeArray(existingProfiles), ...additions],
  };
}

export interface WritableActionSettings {
  readonly familyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly refreshIntervalSeconds: number;
  readonly displayPreferences: DisplayPreferencesSettings;
  readonly credentialProfileRef?: NormalizedActionSettingsView["credentialProfileRef"];
  readonly severityProfileRef?: NormalizedActionSettingsView["severityProfileRef"];
  readonly windowOrPeriod?: SchedulerWindowOrPeriod;
  readonly metricVariant?: string;
}

export interface WritableSeverityProfile {
  readonly profileId: string;
  readonly displayName?: string;
  readonly thresholds: {
    readonly direction: MetricDirection;
    readonly basis: SeverityThresholdBasis;
    readonly warningAt?: number;
    readonly criticalAt?: number;
  };
}

export function toWritableActionSettings(settings: NormalizedActionSettingsView): WritableActionSettings {
  return {
    familyId: settings.familyId,
    providerId: settings.providerId,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    displayPreferences: settings.displayPreferences,
    ...(settings.credentialProfileRef === undefined ? {} : { credentialProfileRef: settings.credentialProfileRef }),
    ...(settings.severityProfileRef === undefined ? {} : { severityProfileRef: settings.severityProfileRef }),
    ...(settings.windowOrPeriod === undefined ? {} : { windowOrPeriod: settings.windowOrPeriod }),
    ...(settings.metricVariant === undefined ? {} : { metricVariant: settings.metricVariant }),
  };
}

export function parseActionSettingsForFamily(
  familyId: ActionFamilyId,
  input: unknown,
): SettingsResult<NormalizedActionSettingsView> {
  const parsed = parseActionSettings(normalizeActionSettingsInputForFamily(familyId, input));
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.familyId !== familyId) {
    return shellSettingsFailure("action-settings-family-mismatch");
  }
  return parsed;
}

export function defaultActionSettingsForFamily(familyId: ActionFamilyId): WritableActionSettings {
  const parsed = parseActionSettings(DEFAULT_ACTION_SETTINGS_BY_FAMILY[familyId]);
  if (!parsed.ok) {
    throw new Error(`Default ${familyId} action settings are invalid.`);
  }
  return toWritableActionSettings(parsed.value);
}

function normalizeActionSettingsInputForFamily(familyId: ActionFamilyId, input: unknown): unknown {
  if (!isRecord(input)) {
    return familyId === "status" ? input : DEFAULT_ACTION_SETTINGS_BY_FAMILY[familyId];
  }
  if (containsForbiddenCompatibilityKey(input)) {
    return input;
  }

  if (familyId === "status") {
    const refreshIntervalSeconds =
      numericSetting(input.refreshIntervalSeconds) ??
      clampLegacyRefreshInterval(numericSetting(input.intervalSeconds) ?? numericFromString(input.intervalSeconds));

    const normalized: Record<string, unknown> = {
      ...input,
      familyId: Object.prototype.hasOwnProperty.call(input, "familyId") ? input.familyId : "status",
      providerId: Object.prototype.hasOwnProperty.call(input, "providerId")
        ? input.providerId
        : DEFAULT_ACTION_SETTINGS_BY_FAMILY.status.providerId,
      ...(refreshIntervalSeconds === undefined ? {} : { refreshIntervalSeconds }),
    };
    delete normalized.intervalSeconds;
    return normalized;
  }

  const existingFamilyId = typeof input.familyId === "string" ? input.familyId : familyId;
  if (existingFamilyId !== familyId) {
    return input;
  }

  if (familyId === "usage") {
    return normalizeUsageActionSettingsInput(input);
  }

  return normalizeBalanceActionSettingsInput(input);
}

// Old-plugin normalization semantics: EVERY missing or invalid field defaults
// (provider -> Claude Code, window -> the provider's first supported window,
// display -> used, refresh -> the central default). The Property Inspector
// saves partial objects — only the fields the user touched — so partial input
// is the NORMAL case, never a validation failure. Secret-shaped payloads are
// rejected before this defaulting runs.
function normalizeUsageActionSettingsInput(input: Readonly<Record<string, unknown>>): unknown {
  const currentProviderId =
    typeof input.providerId === "string" && isKnownUsageProviderId(input.providerId) ? input.providerId : undefined;
  const legacyProviderId = typeof input.provider === "string" ? LEGACY_USAGE_PROVIDER_LOOKUP[input.provider] : undefined;
  const providerId = currentProviderId ?? legacyProviderId ?? DEFAULT_ACTION_SETTINGS_BY_FAMILY.usage.providerId;

  const supportedWindows = supportedUsageWindowsFor(providerId);
  const currentWindow = typeof input.windowOrPeriod === "string" ? input.windowOrPeriod : undefined;
  const legacyWindow = typeof input.window === "string" ? LEGACY_USAGE_WINDOW_LOOKUP[input.window] : undefined;
  // A persisted window the provider does not declare normalizes to the
  // provider's FIRST supported window (old toKeyConfig behavior).
  const windowOrPeriod =
    [currentWindow, legacyWindow].find((candidate) => candidate !== undefined && supportedWindows.includes(candidate)) ??
    supportedWindows[0] ??
    DEFAULT_ACTION_SETTINGS_BY_FAMILY.usage.windowOrPeriod;
  const refreshIntervalSeconds =
    numericSetting(input.refreshIntervalSeconds) ??
    clampLegacyRefreshInterval(numericSetting(input.intervalSeconds) ?? numericFromString(input.intervalSeconds));
  const usageDisplayMode =
    (displayModeSetting(input.displayPreferences, "usageDisplayMode") ?? displayModeSetting(input, "displayMode")) === "remaining"
      ? "remaining"
      : "used";
  const label = displayModeSetting(input.displayPreferences, "label");
  const credentialProfileRef = isRecord(input.credentialProfileRef)
    ? cloneJsonLike(input.credentialProfileRef)
    : canonicalCredentialProfileRef("usage", providerId);
  // Old-plugin-style per-action warn/critical floors on a lower-bound Usage category (Codex
  // "credits"/"resets") resolve to a category-scoped severity profile reference; the shell upserts
  // the matching profile into global settings (keeps user thresholds out of action
  // settings), exactly like the balance floors. The percentage windows carry no floors.
  const legacyProfile = legacySeverityProfileForUsageInput(input);
  const severityProfileRef = isRecord(input.severityProfileRef)
    ? cloneJsonLike(input.severityProfileRef)
    : legacyProfile === undefined
      ? undefined
      : { kind: "severity-profile", profileId: legacyProfile.profileId };

  return {
    familyId: "usage",
    providerId,
    ...(refreshIntervalSeconds === undefined ? {} : { refreshIntervalSeconds }),
    displayPreferences: {
      usageDisplayMode,
      ...(label === undefined ? {} : { label }),
    },
    ...(credentialProfileRef === undefined ? {} : { credentialProfileRef }),
    ...(severityProfileRef === undefined ? {} : { severityProfileRef }),
    windowOrPeriod,
    ...(typeof input.metricVariant === "string" ? { metricVariant: input.metricVariant } : {}),
  };
}

function normalizeBalanceActionSettingsInput(input: Readonly<Record<string, unknown>>): unknown {
  const currentProviderId =
    typeof input.providerId === "string" && isKnownBalanceProviderId(input.providerId) ? input.providerId : undefined;
  const legacyProviderId = typeof input.vendor === "string" ? LEGACY_BALANCE_PROVIDER_LOOKUP[input.vendor] : undefined;
  // Invalid/absent vendor falls back to the first catalog vendor (old behavior).
  const providerId = currentProviderId ?? legacyProviderId ?? DEFAULT_ACTION_SETTINGS_BY_FAMILY.balance.providerId;

  const refreshIntervalSeconds =
    numericSetting(input.refreshIntervalSeconds) ??
    clampLegacyRefreshInterval(numericSetting(input.intervalSeconds) ?? numericFromString(input.intervalSeconds));
  const label = displayModeSetting(input.displayPreferences, "label");
  const windowOrPeriod = typeof input.windowOrPeriod === "string" ? input.windowOrPeriod : undefined;
  const credentialProfileRef = isRecord(input.credentialProfileRef)
    ? cloneJsonLike(input.credentialProfileRef)
    : canonicalCredentialProfileRef("balance", providerId);
  // Old plugin per-action warn/critical floors resolve to a provider-scoped
  // severity profile reference; the shell upserts the matching profile into
  // global settings (keeps user thresholds out of action settings).
  const legacyProfile = legacySeverityProfileForBalanceInput(input);
  const severityProfileRef = isRecord(input.severityProfileRef)
    ? cloneJsonLike(input.severityProfileRef)
    : legacyProfile === undefined
      ? undefined
      : { kind: "severity-profile", profileId: legacyProfile.profileId };

  return {
    familyId: "balance",
    providerId,
    ...(refreshIntervalSeconds === undefined ? {} : { refreshIntervalSeconds }),
    displayPreferences: {
      ...(label === undefined ? {} : { label }),
    },
    ...(credentialProfileRef === undefined ? {} : { credentialProfileRef }),
    ...(severityProfileRef === undefined ? {} : { severityProfileRef }),
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
    ...(typeof input.metricVariant === "string" ? { metricVariant: input.metricVariant } : {}),
  };
}

/**
 * Old plugin balance keys stored warn/critical floors directly in action
 * settings. They translate into a provider-scoped absolute severity profile
 * that the shell persists into global settings. The threshold DIRECTION is the
 * provider's registry metric direction (the registry — not the
 * adapter or the settings layer — owns metric direction), so a remaining vendor
 * fires the same floors at-or-below and a spend/used vendor fires them
 * at-or-above. The single warn/critical numbers stay direction-agnostic; only
 * the direction the central engine applies them in changes.
 */
export function legacySeverityProfileForBalanceInput(input: unknown): WritableSeverityProfile | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const providerId =
    typeof input.providerId === "string"
      ? input.providerId
      : typeof input.vendor === "string"
        ? LEGACY_BALANCE_PROVIDER_LOOKUP[input.vendor]
        : undefined;
  if (providerId === undefined) {
    return undefined;
  }

  const direction = balanceMetricDirectionLookup().get(providerId);
  if (direction === undefined) {
    return undefined;
  }

  const warningAt = numericSetting(input.warnFloor) ?? numericFromString(input.warnFloor);
  const criticalAt = numericSetting(input.criticalFloor) ?? numericFromString(input.criticalFloor);
  if (warningAt === undefined && criticalAt === undefined) {
    return undefined;
  }

  return {
    profileId: `floors:balance:${providerId}`,
    thresholds: {
      direction,
      basis: "absolute",
      ...(warningAt === undefined ? {} : { warningAt }),
      ...(criticalAt === undefined ? {} : { criticalAt }),
    },
  };
}

/**
 * Old-plugin-style per-action warn/critical floors on a lower-bound Usage
 * category (Codex "credits" and "resets") migrate into a category-scoped
 * absolute severity profile, exactly like the balance floors. Only lower-bound
 * categories carry user floors: "credits" has no registry default so the floors
 * are its only severity source, while "resets" floors OVERRIDE its 7/3-day
 * registry default. The upper-bound percentage windows keep the registry default
 * and are skipped. The threshold DIRECTION is the registry category metric
 * direction (the registry owns metric direction), so a lower-bound
 * pool/runway fires the floors at-or-below. For "resets" the floor numbers are
 * DAYS of reset-credit runway (matching the days-based severity basis); the
 * persisted profile shape is still `basis: "absolute"`.
 */
export function legacySeverityProfileForUsageInput(input: unknown): WritableSeverityProfile | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const providerId =
    typeof input.providerId === "string" && isKnownUsageProviderId(input.providerId)
      ? input.providerId
      : typeof input.provider === "string"
        ? LEGACY_USAGE_PROVIDER_LOOKUP[input.provider]
        : undefined;
  if (providerId === undefined) {
    return undefined;
  }

  // Resolve the category from the current-vocabulary `windowOrPeriod` OR the legacy PI `window`
  // key (the usage PI window dropdown saves under `window`), mirroring normalizeUsageActionSettingsInput.
  const legacyWindow = typeof input.window === "string" ? LEGACY_USAGE_WINDOW_LOOKUP[input.window] : undefined;
  const windowOrPeriod = asUsageWindowId(input.windowOrPeriod) ?? asUsageWindowId(legacyWindow);
  const categoryMetric = resolveUsageCategoryMetric(providerId, windowOrPeriod);
  // A Usage category carries user floors when its severity is USER-DRIVEN rather than a fixed
  // registry default: a no-default requires-user-profile category (Codex "credits" — a lower-bound
  // remaining pool; claude-code "credit-spend" — an upper-bound money spend guard) whose floors are
  // its ONLY severity source, OR the "resets" registry-default whose floors OVERRIDE its 7/3-day
  // default. The fixed upper-bound percentage windows (upper-bound-usage-percent-default) keep the
  // registry default and never migrate floors. The threshold DIRECTION is always the registry
  // category metric direction (the registry owns metric direction), so a lower-bound
  // pool/runway fires the floors at-or-below and the upper-bound spend guard fires them at-or-above;
  // the single warn/critical numbers stay direction-agnostic (for "resets" they are DAYS of runway;
  // for "credit-spend" they are absolute money in the account currency), and the persisted profile is
  // still `basis: "absolute"`.
  const strategy = categoryMetric?.severityStrategy;
  const carriesFloors =
    strategy !== undefined &&
    (strategy.kind === "requires-user-profile" ||
      (strategy.kind === "registry-default" && strategy.reference === "lower-bound-resets-days-default"));
  if (windowOrPeriod === undefined || categoryMetric === undefined || !carriesFloors) {
    return undefined;
  }

  const warningAt = numericSetting(input.warnFloor) ?? numericFromString(input.warnFloor);
  const criticalAt = numericSetting(input.criticalFloor) ?? numericFromString(input.criticalFloor);
  if (warningAt === undefined && criticalAt === undefined) {
    return undefined;
  }

  return {
    profileId: `floors:usage:${providerId}:${windowOrPeriod}`,
    thresholds: {
      direction: categoryMetric.metricDirection,
      basis: "absolute",
      ...(warningAt === undefined ? {} : { warningAt }),
      ...(criticalAt === undefined ? {} : { criticalAt }),
    },
  };
}

function asUsageWindowId(value: unknown): UsageWindowId | undefined {
  return typeof value === "string" && (USAGE_WINDOW_IDS as readonly string[]).includes(value)
    ? (value as UsageWindowId)
    : undefined;
}

function numericFromString(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Upserts one severity profile into a raw global-settings payload (read-modify-write compat path). */
export function upsertSeverityProfilePayload(previous: unknown, profile: WritableSeverityProfile): unknown {
  const previousRecord = isRecord(previous) ? (cloneJsonLike(previous) as Record<string, unknown>) : {};
  const existing = getArrayProperty(previousRecord, "severityProfiles").filter(
    (candidate) => !(isRecord(candidate) && candidate.profileId === profile.profileId),
  );
  return {
    ...previousRecord,
    severityProfiles: [...existing, profile],
  };
}

// Old plugin settings had no credential-profile references; a plugin-key
// provider without one resolves to the canonical profile the Property
// Inspector writes, so legacy keys and legacy action settings keep working.
let credentialClassByFamilyProvider: ReadonlyMap<string, CredentialClass> | undefined;

function credentialClassLookup(): ReadonlyMap<string, CredentialClass> {
  if (credentialClassByFamilyProvider !== undefined) {
    return credentialClassByFamilyProvider;
  }

  const lookup = new Map<string, CredentialClass>();
  for (const option of [...listUsageProviderOptions(), ...listBalanceProviderOptions()]) {
    const credentialClass = option.credentialClasses.find(
      (candidate) => candidate === "plugin-api-key" || candidate === "admin-api-credential",
    );
    if (credentialClass !== undefined) {
      lookup.set(`${option.actionFamilyId}:${option.providerId}`, credentialClass);
    }
  }
  credentialClassByFamilyProvider = lookup;
  return lookup;
}

function canonicalCredentialProfileRef(
  familyId: ActionFamilyId,
  providerId: string,
): { readonly kind: "credential-profile"; readonly credentialClass: CredentialClass; readonly profileId: string } | undefined {
  const credentialClass = credentialClassLookup().get(`${familyId}:${providerId}`);
  if (credentialClass === undefined) {
    return undefined;
  }

  return {
    kind: "credential-profile",
    credentialClass,
    profileId: canonicalCredentialProfileId(familyId, providerId as ProviderId, credentialClass),
  };
}

/**
 * Legacy-value tolerance for OLD persisted `intervalSeconds` only: the old
 * plugin accepted any interval down to a 30-second floor, while the current
 * policy validates 60..3600 and treats out-of-range as a validation failure.
 * Old persisted values clamp into range instead of bricking previously
 * working keys; current `refreshIntervalSeconds` inputs stay unclamped so
 * central validation rejects out-of-range values per the approved spec.
 */
function clampLegacyRefreshInterval(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(3600, Math.max(60, Math.floor(value)));
}

function numericSetting(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isKnownUsageProviderId(candidate: string): boolean {
  return credentialClassLookupKnownProvider(`usage:${candidate}`) || USAGE_PROVIDER_ID_SET.has(candidate);
}

function isKnownBalanceProviderId(candidate: string): boolean {
  return BALANCE_PROVIDER_ID_SET.has(candidate);
}

function credentialClassLookupKnownProvider(key: string): boolean {
  return credentialClassLookup().has(key);
}

const USAGE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(USAGE_PROVIDER_IDS);
const BALANCE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BALANCE_PROVIDER_IDS);

// Registry-declared windows per usage provider; single catalog source, cached.
let usageWindowsByProvider: ReadonlyMap<string, readonly string[]> | undefined;

function supportedUsageWindowsFor(providerId: string): readonly string[] {
  if (usageWindowsByProvider === undefined) {
    usageWindowsByProvider = new Map(listUsageProviderOptions().map((option) => [option.providerId, option.supportedWindows]));
  }
  return usageWindowsByProvider.get(providerId) ?? [];
}

// Registry-declared metric direction per balance provider; single catalog
// source (the registry owns metric direction), cached. Drives
// the direction the legacy warn/critical floors resolve to so spend/used
// (upper-bound) and remaining (lower-bound) vendors both apply.
let balanceMetricDirectionByProvider: ReadonlyMap<string, MetricDirection> | undefined;

function balanceMetricDirectionLookup(): ReadonlyMap<string, MetricDirection> {
  if (balanceMetricDirectionByProvider === undefined) {
    balanceMetricDirectionByProvider = new Map(
      listBalanceProviderOptions().map((option) => [option.providerId, option.metricDirection]),
    );
  }
  return balanceMetricDirectionByProvider;
}

function displayModeSetting(input: unknown, key: string): string | undefined {
  return isRecord(input) && typeof input[key] === "string" ? input[key] : undefined;
}

function containsForbiddenCompatibilityKey(input: unknown): boolean {
  if (!isRecord(input)) {
    return false;
  }
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_COMPATIBILITY_KEYS.has(key) || containsForbiddenCompatibilityKey(value)) {
      return true;
    }
  }
  return false;
}

function shellSettingsFailure(reasonCode: string): SettingsResult<never> {
  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "settings-validation-failure",
      diagnostics: {
        boundary: "streamdeck-shell",
        issueCount: 1,
        reasonCode,
      },
    }),
  };
}

function getArrayProperty(input: unknown, key: string): readonly unknown[] {
  if (!isRecord(input) || !Array.isArray(input[key])) {
    return [];
  }
  return input[key];
}

function cloneJsonLikeArray(input: readonly unknown[]): readonly unknown[] {
  return input.map((item) => cloneJsonLike(item));
}

function cloneJsonLike(input: unknown): unknown {
  if (input === null) {
    return null;
  }

  if (typeof input === "string" || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }

  if (Array.isArray(input)) {
    return input.map((item) => cloneJsonLike(item));
  }

  if (isRecord(input)) {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      copy[key] = cloneJsonLike(value);
    }
    return copy;
  }

  return undefined;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
