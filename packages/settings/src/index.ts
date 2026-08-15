import { Equal, Hash, Redacted, Schema } from "effect";

import {
  ACTION_FAMILY_IDS,
  COVERAGE_KINDS,
  CREDENTIAL_CLASSES,
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  REFRESH_INTERVAL_MAX_SECONDS,
  REFRESH_INTERVAL_MIN_SECONDS,
  USAGE_DISPLAY_MODES,
  USAGE_WINDOW_IDS,
  PROVIDER_IDS,
  serializeSchedulerKey,
  type ActionFamilyId,
  type CredentialClass,
  type CredentialProfileReference,
  type MetricDirection,
  type ProviderId,
  type SchedulerKey,
  type SchedulerKeyParts,
  type SchedulerWindowOrPeriod,
  type SeverityProfileReference,
  type SeverityThresholdBasis,
  type SeverityThresholdSet,
} from "@ai-workbench/contracts";
import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";
import {
  findProviderEntry,
  resolveProviderCapability,
  type ProviderCapabilityMetadata,
  type ProviderSettingRequirement,
  type SensitiveSelectorRequirement,
  type SeverityStrategy,
  type SourceProofStatus,
} from "@ai-workbench/provider-registry";
import { parseUnknown } from "@ai-workbench/validation";

export const packageName = "@ai-workbench/settings" as const;

export type SettingsResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
    };

export interface AppSettingsAdapterPort {
  readonly readGlobalSettings: () => Promise<unknown>;
  readonly writeGlobalSettings: (payload: unknown) => Promise<void>;
  readonly readActionSettings: (actionContextId: string) => Promise<unknown>;
  readonly writeActionSettings: (actionContextId: string, payload: unknown) => Promise<void>;
}

export interface DisplayPreferencesSettings {
  readonly usageDisplayMode?: (typeof USAGE_DISPLAY_MODES)[number];
  readonly label?: string;
  readonly color?: string;
}

export interface NormalizedActionSettingsView {
  readonly familyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly refreshIntervalSeconds: number;
  readonly displayPreferences: DisplayPreferencesSettings;
  readonly credentialProfileRef?: CredentialProfileReference;
  readonly severityProfileRef?: SeverityProfileReference;
  readonly windowOrPeriod?: SchedulerWindowOrPeriod;
  readonly metricVariant?: string;
  readonly schedulerKeyParts: SchedulerKeyParts;
  readonly schedulerKey: SchedulerKey;
}

export interface NormalizedSensitiveSelectorState {
  readonly selectorClass: SensitiveSelectorRequirement["selectorClass"];
  readonly required: true;
  readonly present: boolean;
}

export interface NormalizedCredentialProfile {
  readonly profileId: string;
  readonly displayName?: string;
  readonly actionFamilyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly credentialClass: CredentialClass;
  readonly credentialPresent: boolean;
  readonly sensitiveSelectors: readonly NormalizedSensitiveSelectorState[];
}

export interface NormalizedSeverityProfile {
  readonly profileId: string;
  readonly displayName?: string;
  readonly thresholds: SeverityThresholdSet;
}

export interface NormalizedGlobalSettingsView {
  readonly credentialProfiles: readonly NormalizedCredentialProfile[];
  readonly severityProfiles: readonly NormalizedSeverityProfile[];
}

export interface GlobalSettingsAffectedCredentialProfile {
  readonly profileId: string;
  readonly actionFamilyId: ActionFamilyId;
  readonly providerId: ProviderId;
  readonly credentialClass: CredentialClass;
}

export interface ProviderSettingsRequirements {
  readonly providerId: ProviderId;
  readonly actionFamilyId: ActionFamilyId;
  readonly credentialClasses: readonly CredentialClass[];
  readonly sensitiveSelectorRequirements: readonly SensitiveSelectorRequirement[];
  readonly requiredSettings: readonly ProviderSettingRequirement[];
  readonly implementationStatus: ProviderCapabilityMetadata["implementationStatus"];
  readonly sourceProofStatus: SourceProofStatus;
  readonly severityStrategy: SeverityStrategy;
}

export type PropertyInspectorPayload =
  | {
      readonly kind: "action-settings-update";
      readonly actionSettings: NormalizedActionSettingsView;
    }
  | {
      readonly kind: "global-settings-update";
      readonly globalSettings: NormalizedGlobalSettingsView;
    };

export type ActionSettingsChangeKind = "unchanged" | "provider-source-affecting" | "refresh-policy-affecting" | "display-only";

export interface ActionSettingsChangeClassification {
  readonly kind: ActionSettingsChangeKind;
  readonly schedulerKeyChanged: boolean;
  readonly providerRefetchRequired: boolean;
  readonly bypassBackoffAllowed: boolean;
  readonly refreshPolicyChanged: boolean;
  readonly displayOnly: boolean;
  readonly reasons: readonly string[];
}

export type GlobalSettingsChangeKind = "unchanged" | "provider-source-affecting" | "display-only";

export interface GlobalSettingsChangeClassification {
  readonly kind: GlobalSettingsChangeKind;
  readonly providerRefetchRequired: boolean;
  readonly bypassBackoffAllowed: boolean;
  readonly displayOnly: boolean;
  readonly reasons: readonly string[];
  readonly affectedCredentialProfiles: readonly GlobalSettingsAffectedCredentialProfile[];
}

const PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASONS = [
  {
    reason: "action-family-changed",
    hasChanged: (before, after) => before.familyId !== after.familyId,
  },
  {
    reason: "provider-changed",
    hasChanged: (before, after) => before.providerId !== after.providerId,
  },
  {
    reason: "credential-profile-changed",
    hasChanged: (before, after) => before.credentialProfileRef?.profileId !== after.credentialProfileRef?.profileId,
  },
  {
    reason: "credential-class-changed",
    hasChanged: (before, after) => before.credentialProfileRef?.credentialClass !== after.credentialProfileRef?.credentialClass,
  },
  {
    reason: "window-or-period-changed",
    hasChanged: (before, after) => before.windowOrPeriod !== after.windowOrPeriod,
  },
  {
    reason: "metric-variant-changed",
    hasChanged: (before, after) => before.metricVariant !== after.metricVariant,
  },
] as const satisfies readonly {
  readonly reason: string;
  readonly hasChanged: (before: NormalizedActionSettingsView, after: NormalizedActionSettingsView) => boolean;
}[];

type ProviderSourceActionSettingsChangeReason = (typeof PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASONS)[number]["reason"];

const PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASON_SET: ReadonlySet<string> = new Set<ProviderSourceActionSettingsChangeReason>(
  PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASONS.map((definition) => definition.reason),
);

const ActionFamilyIdSchema = Schema.Literal(...ACTION_FAMILY_IDS);
const ProviderIdSchema = Schema.Literal(...PROVIDER_IDS);
const CredentialClassSchema = Schema.Literal(...CREDENTIAL_CLASSES);
const UsageDisplayModeSchema = Schema.Literal(...USAGE_DISPLAY_MODES);
const SeverityThresholdBasisSchema = Schema.Literal("percent", "absolute");
const MetricDirectionSchema = Schema.Literal("upper-bound", "lower-bound", "none");
const WindowOrPeriodSchema = Schema.Literal(...USAGE_WINDOW_IDS, ...COVERAGE_KINDS);

const CredentialProfileReferenceSchema = Schema.Struct({
  kind: Schema.Literal("credential-profile"),
  credentialClass: CredentialClassSchema,
  profileId: Schema.String,
});

const SeverityProfileReferenceSchema = Schema.Struct({
  kind: Schema.Literal("severity-profile"),
  profileId: Schema.String,
});

const DisplayPreferencesSchema = Schema.Struct({
  usageDisplayMode: Schema.optional(UsageDisplayModeSchema),
  label: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
});

const ActionSettingsPayloadSchema = Schema.Struct({
  familyId: ActionFamilyIdSchema,
  providerId: ProviderIdSchema,
  refreshIntervalSeconds: Schema.optional(Schema.Number),
  displayPreferences: Schema.optional(DisplayPreferencesSchema),
  credentialProfileRef: Schema.optional(CredentialProfileReferenceSchema),
  severityProfileRef: Schema.optional(SeverityProfileReferenceSchema),
  windowOrPeriod: Schema.optional(WindowOrPeriodSchema),
  metricVariant: Schema.optional(Schema.String),
});

const StatusActionSettingsPayloadSchema = Schema.Struct({
  familyId: Schema.Literal("status"),
  providerId: Schema.optional(ProviderIdSchema),
  refreshIntervalSeconds: Schema.optional(Schema.Number),
});

const SensitiveSelectorClassSchema = Schema.Literal("account", "organization", "project", "team", "workspace");

// Settings-internal credential material: the secret decodes
// as Schema.Redacted so it is type-wrapped the moment it leaves the decode boundary
// and renders "<redacted>" under JSON.stringify/String. It is never unwrapped in
// this package. Downstream the redacted secret is unwrapped at only two sites: the
// Stream Deck shell credential boundary (apps/streamdeck/src/credentials.ts)
// transiently unwraps it to reject an all-whitespace value and immediately discards
// that read (nothing is forwarded, logged, or stored), and the Effect-native
// adapter's HTTP request-builder unwraps it to forward the secret in the request
// header — the request header is the only unwrap that forwards it.
// Exported as the shared decode contract: that same shell credential boundary
// decodes raw global-settings credential material through this schema in
// production.
export const CredentialMaterialSchema = Schema.Struct({
  kind: Schema.Literal("inline-secret"),
  value: Schema.Redacted(Schema.String),
});

// Header-safety edge validation. A resolved credential
// value is forwarded verbatim into a provider auth header, where it is always the
// SUFFIX of the header string (`Bearer <key>`, `Token <key>`, `Key <key>`, or a bare
// `x-api-key: <key>`). Node/undici trims a header value's leading/trailing HTTP
// whitespace — tab, space, LF, CR (RFC 7230 OWS + CRLF) — then throws synchronously if
// any surviving character is a bare LF/CR/NUL or a code point above U+00FF (the
// signature of a corrupted copy/paste). That synchronous throw surfaces downstream as a
// misleading network failure. Because the key sits at the END of the header value, its
// trailing run of that whitespace is always trimmed by Node and is safe; but its LEADING
// whitespace is an edge only for a bare header and becomes INTERNAL behind a `Bearer `
// prefix, so it is NOT stripped before validation. We therefore strip only the trailing
// HTTP-whitespace run and require every remaining code unit to be printable ASCII or
// high Latin-1. This mirrors exactly what Node accepts and never lets a throwing value
// through (plain `String.prototype.trim` would also strip a leading BOM / Unicode line
// separator that Node keeps and then rejects). The filter message is static and never
// embeds the value; callers use `isHeaderSafeCredentialValue`, a `Schema.is`
// boolean guard, so no ParseError carrying the value is ever constructed.
const TRAILING_HTTP_WHITESPACE_PATTERN = /[\t\n\r ]+$/;
const HEADER_SAFE_CREDENTIAL_VALUE_PATTERN = /^[\x20-\x7E\x80-\xFF]+$/;

export const HeaderSafeCredentialValueSchema: Schema.Schema<string> = Schema.String.pipe(
  Schema.filter(
    (value) => {
      const withoutTrailingWhitespace = value.replace(TRAILING_HTTP_WHITESPACE_PATTERN, "");
      return withoutTrailingWhitespace.length > 0 && HEADER_SAFE_CREDENTIAL_VALUE_PATTERN.test(withoutTrailingWhitespace);
    },
    {
      message: () => "credential value must be non-empty and contain only characters valid in an HTTP header value",
    },
  ),
);

const isHeaderSafeCredentialValueGuard = Schema.is(HeaderSafeCredentialValueSchema);

/**
 * Boolean header-safety check for a credential value. Backed by
 * `HeaderSafeCredentialValueSchema` through `Schema.is`, which returns a plain type
 * guard, so no ParseError is constructed and the credential value can never leak through
 * parse diagnostics. The Stream Deck credential boundary calls this to reject a pasted
 * key that would throw synchronously when forwarded into a provider auth header.
 */
export function isHeaderSafeCredentialValue(value: string): boolean {
  return isHeaderSafeCredentialValueGuard(value);
}

const SensitiveSelectorPayloadSchema = Schema.Struct({
  selectorClass: SensitiveSelectorClassSchema,
  value: Schema.String,
});

const RawCredentialProfileSchema = Schema.Struct({
  profileId: Schema.String,
  displayName: Schema.optional(Schema.String),
  actionFamilyId: ActionFamilyIdSchema,
  providerId: ProviderIdSchema,
  credentialClass: CredentialClassSchema,
  credentialMaterial: Schema.optional(CredentialMaterialSchema),
  sensitiveSelectors: Schema.optional(Schema.Array(SensitiveSelectorPayloadSchema)),
});

// Each bound is independently optional (a lone warn floor colors amber only,
// a lone critical floor red only — old working plugin UX), but a profile with
// neither bound evaluates nothing and is rejected.
const SeverityThresholdSetSchema = Schema.Struct({
  direction: MetricDirectionSchema,
  basis: SeverityThresholdBasisSchema,
  warningAt: Schema.optional(Schema.Number),
  criticalAt: Schema.optional(Schema.Number),
}).pipe(
  Schema.filter((thresholds) => thresholds.warningAt !== undefined || thresholds.criticalAt !== undefined, {
    message: () => "severity thresholds require warningAt or criticalAt",
  }),
);

const RawSeverityProfileSchema = Schema.Struct({
  profileId: Schema.String,
  displayName: Schema.optional(Schema.String),
  thresholds: SeverityThresholdSetSchema,
});

const GlobalSettingsPayloadSchema = Schema.Struct({
  credentialProfiles: Schema.optional(Schema.Array(RawCredentialProfileSchema)),
  severityProfiles: Schema.optional(Schema.Array(RawSeverityProfileSchema)),
});

const PropertyInspectorEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("action-settings-update", "global-settings-update"),
  payload: Schema.Unknown,
});

const FORBIDDEN_ACTION_SETTING_KEYS = new Set([
  "apiKey",
  "secret",
  "token",
  "authorizationHeader",
  "authHeader",
  "account",
  "organization",
  "project",
  "team",
  "workspace",
  "accountId",
  "organizationId",
  "projectId",
  "teamId",
  "workspaceId",
  "routingId",
  "apiKeyId",
  "rawCredentialPayload",
  "credentialMaterial",
  "credentialValue",
  "sensitiveSelectors",
  "thresholds",
  "warningAt",
  "criticalAt",
]);

const ALLOWED_ACTION_SETTING_KEYS = new Set([
  "familyId",
  "providerId",
  "refreshIntervalSeconds",
  "displayPreferences",
  "credentialProfileRef",
  "severityProfileRef",
  "windowOrPeriod",
  "metricVariant",
]);

const ALLOWED_STATUS_ACTION_SETTING_KEYS = new Set(["familyId", "providerId", "refreshIntervalSeconds"]);

const ALLOWED_DISPLAY_PREFERENCE_KEYS = new Set(["usageDisplayMode", "label", "color"]);

const ALLOWED_CREDENTIAL_PROFILE_REFERENCE_KEYS = new Set(["kind", "credentialClass", "profileId"]);

const ALLOWED_SEVERITY_PROFILE_REFERENCE_KEYS = new Set(["kind", "profileId"]);

export function parseActionSettings(input: unknown): SettingsResult<NormalizedActionSettingsView> {
  if (isRecord(input) && input.familyId === "status") {
    return parseStatusActionSettings(input);
  }

  const forbiddenField = findForbiddenActionSettingsKey(input);
  if (forbiddenField !== undefined) {
    return settingsValidationFailure("action-settings-forbidden-sensitive-field");
  }

  const parsed = parseSettingsUnknown(ActionSettingsPayloadSchema, input, {
    reasonCode: "action-settings-schema",
  });
  if (!parsed.ok) {
    return parsed;
  }
  const capability = findProviderCapability({
    actionFamilyId: parsed.value.familyId,
    providerId: parsed.value.providerId,
  });
  if (capability === undefined) {
    return settingsValidationFailure("provider-settings-requirements-not-found");
  }
  if (
    parsed.value.credentialProfileRef !== undefined &&
    !capability.credentialClasses.includes(parsed.value.credentialProfileRef.credentialClass)
  ) {
    return settingsValidationFailure("action-settings-credential-class-mismatch", ["credentialProfileRef"]);
  }
  if (capability.actionFamilyId === "usage" && parsed.value.windowOrPeriod === undefined) {
    return settingsValidationFailure("action-settings-window-or-period-required", ["windowOrPeriod"]);
  }
  if (parsed.value.windowOrPeriod !== undefined && !isWindowOrPeriodAllowed(capability, parsed.value.windowOrPeriod)) {
    return settingsValidationFailure("action-settings-window-or-period-unsupported", ["windowOrPeriod"]);
  }

  const refreshIntervalSeconds = parsed.value.refreshIntervalSeconds ?? REFRESH_INTERVAL_DEFAULT_SECONDS;
  if (
    !Number.isInteger(refreshIntervalSeconds) ||
    refreshIntervalSeconds < REFRESH_INTERVAL_MIN_SECONDS ||
    refreshIntervalSeconds > REFRESH_INTERVAL_MAX_SECONDS
  ) {
    return settingsValidationFailure("action-settings-refresh-interval-out-of-range", ["refreshIntervalSeconds"]);
  }

  const credentialProfileId = parsed.value.credentialProfileRef?.profileId ?? "none";
  const schedulerKeyParts: SchedulerKeyParts = {
    familyId: parsed.value.familyId,
    providerId: parsed.value.providerId,
    credentialProfileId,
    ...(parsed.value.windowOrPeriod === undefined ? {} : { windowOrPeriod: parsed.value.windowOrPeriod }),
    ...(parsed.value.metricVariant === undefined ? {} : { metricVariant: parsed.value.metricVariant }),
  };

  return {
    ok: true,
    value: {
      familyId: parsed.value.familyId,
      providerId: parsed.value.providerId,
      refreshIntervalSeconds,
      displayPreferences: normalizeDisplayPreferences(parsed.value.displayPreferences),
      ...(parsed.value.credentialProfileRef === undefined ? {} : { credentialProfileRef: parsed.value.credentialProfileRef }),
      ...(parsed.value.severityProfileRef === undefined ? {} : { severityProfileRef: parsed.value.severityProfileRef }),
      ...(parsed.value.windowOrPeriod === undefined ? {} : { windowOrPeriod: parsed.value.windowOrPeriod }),
      ...(parsed.value.metricVariant === undefined ? {} : { metricVariant: parsed.value.metricVariant }),
      schedulerKeyParts,
      schedulerKey: serializeSchedulerKey(schedulerKeyParts),
    },
  };
}

function parseStatusActionSettings(input: Readonly<Record<string, unknown>>): SettingsResult<NormalizedActionSettingsView> {
  if (Object.keys(input).some((key) => !ALLOWED_STATUS_ACTION_SETTING_KEYS.has(key))) {
    return settingsValidationFailure("status-action-settings-forbidden-field");
  }

  const parsed = parseSettingsUnknown(StatusActionSettingsPayloadSchema, input, {
    reasonCode: "status-action-settings-schema",
  });
  if (!parsed.ok) {
    return parsed;
  }

  const providerId = parsed.value.providerId ?? "anthropic-api";
  if (resolveProviderCapability(providerId, "status") === undefined) {
    return settingsValidationFailure("status-provider-not-supported");
  }

  const refreshIntervalSeconds = parsed.value.refreshIntervalSeconds ?? REFRESH_INTERVAL_DEFAULT_SECONDS;
  if (
    !Number.isInteger(refreshIntervalSeconds) ||
    refreshIntervalSeconds < REFRESH_INTERVAL_MIN_SECONDS ||
    refreshIntervalSeconds > REFRESH_INTERVAL_MAX_SECONDS
  ) {
    return settingsValidationFailure("action-settings-refresh-interval-out-of-range", ["refreshIntervalSeconds"]);
  }

  const schedulerKeyParts: SchedulerKeyParts = {
    familyId: "status",
    providerId,
    credentialProfileId: "none",
  };
  return {
    ok: true,
    value: {
      familyId: "status",
      providerId,
      refreshIntervalSeconds,
      displayPreferences: {},
      schedulerKeyParts,
      schedulerKey: serializeSchedulerKey(schedulerKeyParts),
    },
  };
}

export function parseGlobalSettings(input: unknown): SettingsResult<NormalizedGlobalSettingsView> {
  const parsed = parseSettingsUnknown(GlobalSettingsPayloadSchema, input, {
    reasonCode: "global-settings-schema",
  });
  if (!parsed.ok) {
    return parsed;
  }

  const credentialProfiles = parsed.value.credentialProfiles ?? [];
  const severityProfiles = parsed.value.severityProfiles ?? [];
  for (const profile of credentialProfiles) {
    const failure = validateGlobalCredentialProfile(profile);
    if (failure !== undefined) {
      return failure;
    }
  }

  return {
    ok: true,
    value: {
      credentialProfiles: credentialProfiles.map((profile) => normalizeCredentialProfile(profile)),
      severityProfiles: severityProfiles.map((profile) => normalizeSeverityProfile(profile)),
    },
  };
}

export function parsePropertyInspectorPayload(input: unknown): SettingsResult<PropertyInspectorPayload> {
  const envelope = parseSettingsUnknown(PropertyInspectorEnvelopeSchema, input, {
    reasonCode: "property-inspector-payload-schema",
  });
  if (!envelope.ok) {
    return envelope;
  }

  if (envelope.value.kind === "action-settings-update") {
    const actionSettings = parseActionSettings(envelope.value.payload);
    if (!actionSettings.ok) {
      return actionSettings;
    }
    return {
      ok: true,
      value: {
        kind: "action-settings-update",
        actionSettings: actionSettings.value,
      },
    };
  }

  if (isRecord(envelope.value.payload) && envelope.value.payload.familyId === "status") {
    return settingsValidationFailure("status-property-inspector-global-settings-forbidden");
  }

  const globalSettings = parseGlobalSettings(envelope.value.payload);
  if (!globalSettings.ok) {
    return globalSettings;
  }
  return {
    ok: true,
    value: {
      kind: "global-settings-update",
      globalSettings: globalSettings.value,
    },
  };
}

export function resolveProviderSettingsRequirements(input: {
  readonly providerId: ProviderId;
  readonly actionFamilyId: ActionFamilyId;
}): SettingsResult<ProviderSettingsRequirements> {
  const capability = findProviderEntry(input.providerId)?.capabilities.find(
    (candidate) => candidate.actionFamilyId === input.actionFamilyId,
  );

  if (capability === undefined) {
    return settingsValidationFailure("provider-settings-requirements-not-found");
  }

  return {
    ok: true,
    value: {
      providerId: input.providerId,
      actionFamilyId: input.actionFamilyId,
      credentialClasses: capability.credentialClasses,
      sensitiveSelectorRequirements: capability.sensitiveSelectorRequirements,
      requiredSettings: capability.requiredSettings,
      implementationStatus: capability.implementationStatus,
      sourceProofStatus: capability.sourceProofStatus,
      severityStrategy: capability.severityStrategy,
    },
  };
}

export function classifyActionSettingsChange(
  before: NormalizedActionSettingsView,
  after: NormalizedActionSettingsView,
): ActionSettingsChangeClassification {
  const reasons: ProviderSourceActionSettingsChangeReason[] = [];

  for (const definition of PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASONS) {
    if (definition.hasChanged(before, after)) {
      reasons.push(definition.reason);
    }
  }

  const schedulerKeyChanged = before.schedulerKey !== after.schedulerKey;
  if (schedulerKeyChanged || hasProviderSourceReason(reasons)) {
    return {
      kind: "provider-source-affecting",
      schedulerKeyChanged,
      providerRefetchRequired: true,
      bypassBackoffAllowed: true,
      refreshPolicyChanged: false,
      displayOnly: false,
      reasons,
    };
  }

  if (before.refreshIntervalSeconds !== after.refreshIntervalSeconds) {
    return {
      kind: "refresh-policy-affecting",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      refreshPolicyChanged: true,
      displayOnly: false,
      reasons: ["refresh-interval-changed"],
    };
  }

  const displayReasons = displayChangeReasons(before, after);
  if (displayReasons.length > 0) {
    return {
      kind: "display-only",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      refreshPolicyChanged: false,
      displayOnly: true,
      reasons: displayReasons,
    };
  }

  return {
    kind: "unchanged",
    schedulerKeyChanged: false,
    providerRefetchRequired: false,
    bypassBackoffAllowed: false,
    refreshPolicyChanged: false,
    displayOnly: false,
    reasons: [],
  };
}

export function classifyGlobalSettingsChange(
  before: unknown,
  after: unknown,
): SettingsResult<GlobalSettingsChangeClassification> {
  const beforeRaw = parseSettingsUnknown(GlobalSettingsPayloadSchema, before, {
    reasonCode: "global-settings-before-schema",
  });
  if (!beforeRaw.ok) {
    return beforeRaw;
  }

  const afterRaw = parseSettingsUnknown(GlobalSettingsPayloadSchema, after, {
    reasonCode: "global-settings-after-schema",
  });
  if (!afterRaw.ok) {
    return afterRaw;
  }

  const beforeCredentialSignatures = credentialProfileSignatures(beforeRaw.value.credentialProfiles ?? []);
  const afterCredentialSignatures = credentialProfileSignatures(afterRaw.value.credentialProfiles ?? []);
  if (!arraysEqual(beforeCredentialSignatures, afterCredentialSignatures)) {
    const affectedCredentialProfiles = changedCredentialProfiles(
      beforeRaw.value.credentialProfiles ?? [],
      afterRaw.value.credentialProfiles ?? [],
    );
    return {
      ok: true,
      value: {
        kind: "provider-source-affecting",
        providerRefetchRequired: true,
        bypassBackoffAllowed: true,
        displayOnly: false,
        reasons: ["credential-value-changed"],
        affectedCredentialProfiles,
      },
    };
  }

  const beforeSafe = normalizeGlobalPayload(beforeRaw.value);
  const afterSafe = normalizeGlobalPayload(afterRaw.value);
  if (JSON.stringify(beforeSafe) !== JSON.stringify(afterSafe)) {
    return {
      ok: true,
      value: {
        kind: "display-only",
        providerRefetchRequired: false,
        bypassBackoffAllowed: false,
        displayOnly: true,
        reasons: ["global-display-settings-changed"],
        affectedCredentialProfiles: [],
      },
    };
  }

  return {
    ok: true,
    value: {
      kind: "unchanged",
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      displayOnly: false,
      reasons: [],
      affectedCredentialProfiles: [],
    },
  };
}

function parseSettingsUnknown<Value, Encoded>(
  schema: Schema.Schema<Value, Encoded, never>,
  input: unknown,
  options: { readonly reasonCode: string; readonly fieldPaths?: readonly string[] },
): SettingsResult<Value> {
  const parsed = parseUnknown(schema, input, {
    boundary: "settings",
    reasonCode: options.reasonCode,
    ...(options.fieldPaths === undefined ? {} : { fieldPaths: options.fieldPaths }),
  });

  if (parsed.ok) {
    return parsed;
  }

  return settingsValidationFailure(options.reasonCode, parsed.failure.diagnostics.fieldPaths);
}

function settingsValidationFailure(reasonCode: string, fieldPaths: readonly string[] = ["<redacted-field>"]): SettingsResult<never> {
  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "settings-validation-failure",
      diagnostics: {
        boundary: "settings",
        fieldPaths,
        issueCount: 1,
        reasonCode,
      },
    }),
  };
}

function findForbiddenActionSettingsKey(input: unknown): string | undefined {
  return findForbiddenOrUnknownActionSettingsKey(input, "action");
}

function findForbiddenOrUnknownActionSettingsKey(
  input: unknown,
  context: "action" | "display" | "credentialRef" | "severityRef",
): string | undefined {
  if (Array.isArray(input)) {
    for (const value of input) {
      const nested = findForbiddenOrUnknownActionSettingsKey(value, context);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (!isRecord(input)) {
    return undefined;
  }

  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_ACTION_SETTING_KEYS.has(key)) {
      return key;
    }
    if (!allowedActionSettingsKeysForContext(context).has(key)) {
      return key;
    }
    if (isRecord(value) || Array.isArray(value)) {
      const nested = findForbiddenOrUnknownActionSettingsKey(value, childContextForActionSettingsKey(key));
      if (nested !== undefined) {
        return nested;
      }
    }
  }

  return undefined;
}

function allowedActionSettingsKeysForContext(
  context: "action" | "display" | "credentialRef" | "severityRef",
): ReadonlySet<string> {
  switch (context) {
    case "action":
      return ALLOWED_ACTION_SETTING_KEYS;
    case "display":
      return ALLOWED_DISPLAY_PREFERENCE_KEYS;
    case "credentialRef":
      return ALLOWED_CREDENTIAL_PROFILE_REFERENCE_KEYS;
    case "severityRef":
      return ALLOWED_SEVERITY_PROFILE_REFERENCE_KEYS;
  }
}

function childContextForActionSettingsKey(key: string): "action" | "display" | "credentialRef" | "severityRef" {
  if (key === "displayPreferences") {
    return "display";
  }
  if (key === "credentialProfileRef") {
    return "credentialRef";
  }
  if (key === "severityProfileRef") {
    return "severityRef";
  }
  return "action";
}

function normalizeCredentialProfile(
  profile: Schema.Schema.Type<typeof RawCredentialProfileSchema>,
): NormalizedCredentialProfile {
  const requirements =
    findProviderEntry(profile.providerId)?.capabilities.find(
      (capability) => capability.actionFamilyId === profile.actionFamilyId,
    )?.sensitiveSelectorRequirements ?? [];

  const suppliedSelectors = new Set((profile.sensitiveSelectors ?? []).map((selector) => selector.selectorClass));
  return {
    profileId: profile.profileId,
    ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
    actionFamilyId: profile.actionFamilyId,
    providerId: profile.providerId,
    credentialClass: profile.credentialClass,
    credentialPresent: credentialMaterialPresent(profile.credentialMaterial),
    sensitiveSelectors: requirements.map((requirement) => ({
      selectorClass: requirement.selectorClass,
      required: true,
      present: suppliedSelectors.has(requirement.selectorClass),
    })),
  };
}

function validateGlobalCredentialProfile(
  profile: Schema.Schema.Type<typeof RawCredentialProfileSchema>,
): SettingsResult<never> | undefined {
  const capability = findProviderCapability({
    actionFamilyId: profile.actionFamilyId,
    providerId: profile.providerId,
  });
  if (capability === undefined) {
    return settingsValidationFailure("global-settings-provider-capability-not-found");
  }

  if (!capability.credentialClasses.includes(profile.credentialClass)) {
    return settingsValidationFailure("global-settings-credential-class-mismatch");
  }

  const classMayCarryCredentialMaterial =
    profile.credentialClass === "plugin-api-key" || profile.credentialClass === "admin-api-credential";
  if (!classMayCarryCredentialMaterial && profile.credentialMaterial?.value !== undefined) {
    return settingsValidationFailure("global-settings-credential-material-class-mismatch");
  }

  const allowedSelectorClasses = new Set(
    capability.sensitiveSelectorRequirements.map((requirement) => requirement.selectorClass),
  );
  const unexpectedSelector = (profile.sensitiveSelectors ?? []).some(
    (selector) => !allowedSelectorClasses.has(selector.selectorClass),
  );
  if (unexpectedSelector) {
    return settingsValidationFailure("global-settings-sensitive-selector-mismatch");
  }

  return undefined;
}

function findProviderCapability(input: {
  readonly providerId: ProviderId;
  readonly actionFamilyId: ActionFamilyId;
}): ProviderCapabilityMetadata | undefined {
  return findProviderEntry(input.providerId)?.capabilities.find(
    (candidate) => candidate.actionFamilyId === input.actionFamilyId,
  );
}

function isWindowOrPeriodAllowed(
  capability: ProviderCapabilityMetadata,
  windowOrPeriod: SchedulerWindowOrPeriod,
): boolean {
  if (capability.actionFamilyId === "usage") {
    return capability.supportedWindows?.includes(windowOrPeriod as (typeof USAGE_WINDOW_IDS)[number]) ?? false;
  }

  return windowOrPeriod === capability.coverageKind;
}

function normalizeDisplayPreferences(
  preferences: Schema.Schema.Type<typeof DisplayPreferencesSchema> | undefined,
): DisplayPreferencesSettings {
  if (preferences === undefined) {
    return {};
  }

  return {
    ...(preferences.usageDisplayMode === undefined ? {} : { usageDisplayMode: preferences.usageDisplayMode }),
    ...(preferences.label === undefined ? {} : { label: preferences.label }),
    ...(preferences.color === undefined ? {} : { color: preferences.color }),
  };
}

function normalizeSeverityProfile(profile: Schema.Schema.Type<typeof RawSeverityProfileSchema>): NormalizedSeverityProfile {
  return {
    profileId: profile.profileId,
    ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
    thresholds: {
      direction: profile.thresholds.direction as MetricDirection,
      basis: profile.thresholds.basis as SeverityThresholdBasis,
      ...(profile.thresholds.warningAt === undefined ? {} : { warningAt: profile.thresholds.warningAt }),
      ...(profile.thresholds.criticalAt === undefined ? {} : { criticalAt: profile.thresholds.criticalAt }),
    },
  };
}

function normalizeGlobalPayload(payload: Schema.Schema.Type<typeof GlobalSettingsPayloadSchema>): NormalizedGlobalSettingsView {
  return {
    credentialProfiles: (payload.credentialProfiles ?? []).map((profile) => normalizeCredentialProfile(profile)),
    severityProfiles: (payload.severityProfiles ?? []).map((profile) => normalizeSeverityProfile(profile)),
  };
}

function credentialProfileSignatures(profiles: readonly Schema.Schema.Type<typeof RawCredentialProfileSchema>[]): readonly string[] {
  return profiles.map((profile) => credentialProfileSignature(profile)).sort();
}

function changedCredentialProfiles(
  before: readonly Schema.Schema.Type<typeof RawCredentialProfileSchema>[],
  after: readonly Schema.Schema.Type<typeof RawCredentialProfileSchema>[],
): readonly GlobalSettingsAffectedCredentialProfile[] {
  const beforeByIdentity = credentialProfileSignaturesByIdentity(before);
  const afterByIdentity = credentialProfileSignaturesByIdentity(after);
  const identities = new Map<string, GlobalSettingsAffectedCredentialProfile>();
  for (const profile of [...before, ...after]) {
    identities.set(credentialProfileIdentityKey(profile), credentialProfileIdentity(profile));
  }

  return [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])]
    .filter((key) => beforeByIdentity.get(key) !== afterByIdentity.get(key))
    .flatMap((key) => {
      const identity = identities.get(key);
      return identity === undefined ? [] : [identity];
    })
    .sort(compareCredentialProfileIdentities);
}

function credentialProfileSignaturesByIdentity(
  profiles: readonly Schema.Schema.Type<typeof RawCredentialProfileSchema>[],
): ReadonlyMap<string, string> {
  return new Map(profiles.map((profile) => [credentialProfileIdentityKey(profile), credentialProfileSignature(profile)]));
}

function credentialProfileSignature(profile: Schema.Schema.Type<typeof RawCredentialProfileSchema>): string {
  return JSON.stringify({
    profileId: profile.profileId,
    actionFamilyId: profile.actionFamilyId,
    providerId: profile.providerId,
    credentialClass: profile.credentialClass,
    credentialPresent: credentialMaterialPresent(profile.credentialMaterial),
    credentialFingerprint: fingerprintRedactedCredential(profile.credentialMaterial?.value),
    selectorClasses: (profile.sensitiveSelectors ?? []).map((selector) => selector.selectorClass).sort(),
    selectorFingerprints: (profile.sensitiveSelectors ?? [])
      .map((selector) => `${selector.selectorClass}:${fingerprintSensitiveValue(selector.value)}`)
      .sort(),
  });
}

function credentialProfileIdentity(
  profile: Schema.Schema.Type<typeof RawCredentialProfileSchema>,
): GlobalSettingsAffectedCredentialProfile {
  return {
    actionFamilyId: profile.actionFamilyId,
    credentialClass: profile.credentialClass,
    profileId: profile.profileId,
    providerId: profile.providerId,
  };
}

function credentialProfileIdentityKey(
  profile: Pick<GlobalSettingsAffectedCredentialProfile, "actionFamilyId" | "credentialClass" | "profileId" | "providerId">,
): string {
  return JSON.stringify([profile.actionFamilyId, profile.providerId, profile.credentialClass, profile.profileId]);
}

function compareCredentialProfileIdentities(
  left: GlobalSettingsAffectedCredentialProfile,
  right: GlobalSettingsAffectedCredentialProfile,
): number {
  return credentialProfileIdentityKey(left).localeCompare(credentialProfileIdentityKey(right));
}

// Settings-internal presence + change-fingerprint over the Redacted credential.
// Both rely on Redacted's value-based Equal/Hash (verified against effect@3.21.4)
// so the underlying secret is never unwrapped in this package.
const EMPTY_CREDENTIAL_VALUE = Redacted.make("");

function credentialMaterialPresent(
  material: Schema.Schema.Type<typeof CredentialMaterialSchema> | undefined,
): boolean {
  return material !== undefined && !Equal.equals(material.value, EMPTY_CREDENTIAL_VALUE);
}

function fingerprintRedactedCredential(value: Redacted.Redacted<string> | undefined): string {
  if (value === undefined) {
    return "absent";
  }

  return `redacted:${Hash.hash(value)}`;
}

function fingerprintSensitiveValue(value: string | undefined): string {
  if (value === undefined) {
    return "absent";
  }

  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function hasProviderSourceReason(reasons: readonly string[]): boolean {
  return reasons.some((reason) => PROVIDER_SOURCE_ACTION_SETTINGS_CHANGE_REASON_SET.has(reason));
}

function displayChangeReasons(
  before: NormalizedActionSettingsView,
  after: NormalizedActionSettingsView,
): readonly string[] {
  const reasons: string[] = [];

  if (JSON.stringify(before.displayPreferences) !== JSON.stringify(after.displayPreferences)) {
    reasons.push("display-preferences-changed");
  }
  if (before.severityProfileRef?.profileId !== after.severityProfileRef?.profileId) {
    reasons.push("severity-profile-reference-changed");
  }

  return reasons;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
