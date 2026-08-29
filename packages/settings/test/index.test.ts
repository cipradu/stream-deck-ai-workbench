import { readFileSync } from "node:fs";

import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyActionSettingsChange,
  classifyGlobalSettingsChange,
  CredentialMaterialSchema,
  HeaderSafeCredentialValueSchema,
  isHeaderSafeCredentialValue,
  packageName,
  parseActionSettings,
  parseGlobalSettings,
  parsePeakHoursWindows,
  parsePropertyInspectorPayload,
  resolveProviderSettingsRequirements,
  type AppSettingsAdapterPort,
} from "../src/index.js";

const RAW_NEEDLES = {
  actionValue: "fixture-action-rejected-value",
  credentialValueA: "fixture-credential-material-a",
  credentialValueB: "fixture-credential-material-b",
  selectorValue: "fixture-selector-material",
  thresholdValue: 37,
} as const;

const falCredentialRef = {
  kind: "credential-profile",
  credentialClass: "plugin-api-key",
  profileId: "profile-fal-primary",
} as const;

const falActionPayload = {
  familyId: "balance",
  providerId: "fal",
  credentialProfileRef: falCredentialRef,
} as const;

const openAiCredentialRef = {
  kind: "credential-profile",
  credentialClass: "admin-api-credential",
  profileId: "profile-openai-admin",
} as const;

const globalSettingsPayload = {
  credentialProfiles: [
    {
      profileId: "profile-fal-primary",
      displayName: "Fal primary",
      actionFamilyId: "balance",
      providerId: "fal",
      credentialClass: "plugin-api-key",
      credentialMaterial: {
        kind: "inline-secret",
        value: RAW_NEEDLES.credentialValueA,
      },
    },
    {
      profileId: "profile-openai-admin",
      displayName: "OpenAI admin",
      actionFamilyId: "balance",
      providerId: "openai-api",
      credentialClass: "admin-api-credential",
      credentialMaterial: {
        kind: "inline-secret",
        value: RAW_NEEDLES.credentialValueB,
      },
    },
  ],
  severityProfiles: [
    {
      profileId: "severity-money-floor",
      displayName: "Money floor",
      thresholds: {
        direction: "lower-bound",
        basis: "absolute",
        warningAt: 10,
        criticalAt: 5,
      },
    },
  ],
} as const;

function expectSettingsValidationFailure(result: ReturnType<typeof parseActionSettings>, forbiddenNeedles: readonly string[]) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.failure).toMatchObject({
    category: "settings-validation-failure",
    displayState: "settings-invalid",
    retryClass: "credential-settings-refresh",
    safePublicMessage: "Settings validation failed.",
    sanitized: true,
  });

  const serialized = JSON.stringify(result);
  for (const needle of forbiddenNeedles) {
    expect(serialized).not.toContain(needle);
  }
  expect(serialized).not.toContain("ParseError");
  expect(serialized).not.toContain("Expected");
}

function unwrapActionSettings(payload: unknown) {
  const result = parseActionSettings(payload);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected valid action settings fixture");
  }
  return result.value;
}

describe("@ai-workbench/settings public surface", () => {
  it("keeps the package identity export", () => {
    expect(packageName).toBe("@ai-workbench/settings");
  });

  it("defines an SDK-free app settings adapter port that moves unknown payloads through the boundary", async () => {
    const adapter: AppSettingsAdapterPort = {
      readActionSettings: async () => ({ familyId: "balance", providerId: "fal" }),
      readGlobalSettings: async () => ({ credentialProfiles: [] }),
      writeActionSettings: async (_actionContextId: string, _payload: unknown) => undefined,
      writeGlobalSettings: async (_payload: unknown) => undefined,
    };

    await expect(adapter.readGlobalSettings()).resolves.toEqual({ credentialProfiles: [] });
    await expect(adapter.readActionSettings("fixture-action-context")).resolves.toMatchObject({
      familyId: "balance",
      providerId: "fal",
    });
  });
});

describe("action settings normalization and privacy", () => {
  it("normalizes Status through its own non-metric settings path", () => {
    const result = parseActionSettings({ familyId: "status" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        familyId: "status",
        providerId: "anthropic-api",
        refreshIntervalSeconds: 600,
        displayPreferences: {},
        schedulerKeyParts: {
          familyId: "status",
          providerId: "anthropic-api",
          credentialProfileId: "none",
        },
        schedulerKey: "status|anthropic-api||none|",
      },
    });
  });

  it.each(["anthropic-api", "openai-api", "moonshot", "minimax"] as const)(
    "normalizes approved Status provider %s with one fixed no-credential scheduler identity",
    (providerId) => {
      const result = parseActionSettings({ familyId: "status", providerId });

      expect(result).toMatchObject({
        ok: true,
        value: {
          familyId: "status",
          providerId,
          refreshIntervalSeconds: 600,
          displayPreferences: {},
          schedulerKeyParts: {
            familyId: "status",
            providerId,
            credentialProfileId: "none",
          },
        },
      });
      if (result.ok) {
        expect(Object.keys(result.value).sort()).toEqual([
          "displayPreferences",
          "familyId",
          "peakPricingEnabled",
          "providerId",
          "refreshIntervalSeconds",
          "schedulerKey",
          "schedulerKeyParts",
        ]);
        expect(result.value.peakPricingEnabled).toBe(false);
        expect(result.value.schedulerKeyParts).not.toHaveProperty("windowOrPeriod");
        expect(result.value.schedulerKeyParts).not.toHaveProperty("metricVariant");
      }
    },
  );

  it.each(["deepseek", "zai-coding-plan", "unknown-provider"])(
    "rejects provider %s outside the exact Status catalog",
    (providerId) => {
      expect(parseActionSettings({ familyId: "status", providerId })).toMatchObject({ ok: false });
    },
  );

  it("accepts a configurable Status refresh interval without changing scheduler identity", () => {
    const result = parseActionSettings({
      familyId: "status",
      providerId: "openai-api",
      refreshIntervalSeconds: 900,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        familyId: "status",
        providerId: "openai-api",
        refreshIntervalSeconds: 900,
        displayPreferences: {},
        schedulerKey: "status|openai-api||none|",
      },
    });
  });

  it.each([59, 3601, 600.5, Number.NaN])("rejects Status refresh interval %s as out of range", (refreshIntervalSeconds) => {
    const result = parseActionSettings({
      familyId: "status",
      providerId: "anthropic-api",
      refreshIntervalSeconds,
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        diagnostics: { reasonCode: "action-settings-refresh-interval-out-of-range" },
      },
    });
  });

  it("classifies a Status refresh interval change as refresh-policy-only", () => {
    const baseline = unwrapActionSettings({
      familyId: "status",
      providerId: "anthropic-api",
      refreshIntervalSeconds: 600,
    });
    const refreshChanged = unwrapActionSettings({
      familyId: "status",
      providerId: "anthropic-api",
      refreshIntervalSeconds: 900,
    });

    expect(classifyActionSettingsChange(baseline, refreshChanged)).toMatchObject({
      kind: "refresh-policy-affecting",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      refreshPolicyChanged: true,
      displayOnly: false,
      reasons: ["refresh-interval-changed"],
    });
  });

  it("rejects Status payloads carrying the peak-pricing fields", () => {
    for (const extra of [{ peakPricingEnabled: true }, { peakHours: "01:00-04:00" }]) {
      expect(parseActionSettings({ familyId: "status", providerId: "openai-api", ...extra })).toMatchObject({
        ok: false,
        failure: { diagnostics: { reasonCode: "status-action-settings-forbidden-field" } },
      });
    }
  });

  it("parses a valid peak-hours window list into typed UTC windows", () => {
    expect(parsePeakHoursWindows("01:00-04:00, 06:00-10:00")).toEqual({
      kind: "windows",
      windows: [
        { startMinutesUtc: 60, endMinutesUtc: 240 },
        { startMinutesUtc: 360, endMinutesUtc: 600 },
      ],
    });
    expect(parsePeakHoursWindows("22:00-02:00")).toEqual({
      kind: "windows",
      windows: [{ startMinutesUtc: 1320, endMinutesUtc: 120 }],
    });
  });

  it.each([" 01:00-04:00 ", "01:00 - 04:00", "01:00-04:00 , 06:00-10:00"])(
    "accepts peak-hours whitespace variant %j",
    (input) => {
      expect(parsePeakHoursWindows(input)).toMatchObject({ kind: "windows" });
    },
  );

  it.each(["25:00-04:00", "1:00-04:00", "01:60-04:00", "01:00", "abc", "01:00-01:00", "01:00-04:00,"])(
    "rejects malformed peak-hours input %j",
    (input) => {
      expect(parsePeakHoursWindows(input)).toEqual({ kind: "invalid" });
    },
  );

  it("treats empty or whitespace-only peak-hours input as the provider default", () => {
    expect(parsePeakHoursWindows("")).toEqual({ kind: "default" });
    expect(parsePeakHoursWindows("   ")).toEqual({ kind: "default" });
  });

  it("normalizes a Balance payload with peak-pricing fields and defaults the toggle", () => {
    const enabled = unwrapActionSettings({
      familyId: "balance",
      providerId: "deepseek",
      peakPricingEnabled: true,
      peakHours: "01:00-04:00, 06:00-10:00",
    });
    expect(enabled.peakPricingEnabled).toBe(true);
    expect(enabled.peakHours).toBe("01:00-04:00, 06:00-10:00");
    expect(enabled.schedulerKey).toBe("balance|deepseek||none|");

    const defaults = unwrapActionSettings({ familyId: "balance", providerId: "deepseek" });
    expect(defaults.peakPricingEnabled).toBe(false);
    expect(defaults).not.toHaveProperty("peakHours");

    const emptyWindows = unwrapActionSettings({ familyId: "balance", providerId: "deepseek", peakHours: "   " });
    expect(emptyWindows).not.toHaveProperty("peakHours");
  });

  it("fails closed on a malformed Balance peak-hours string", () => {
    expect(
      parseActionSettings({ familyId: "balance", providerId: "deepseek", peakPricingEnabled: true, peakHours: "25:00-04:00" }),
    ).toMatchObject({
      ok: false,
      failure: { diagnostics: { reasonCode: "action-settings-peak-hours-invalid" } },
    });
  });

  it("classifies peak-pricing changes as display-only", () => {
    const baseline = unwrapActionSettings({ familyId: "balance", providerId: "deepseek" });
    const toggleChanged = unwrapActionSettings({ familyId: "balance", providerId: "deepseek", peakPricingEnabled: true });
    expect(classifyActionSettingsChange(baseline, toggleChanged)).toMatchObject({
      kind: "display-only",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      refreshPolicyChanged: false,
      displayOnly: true,
      reasons: ["peak-pricing-changed"],
    });

    const windowsChanged = unwrapActionSettings({
      familyId: "balance",
      providerId: "deepseek",
      peakPricingEnabled: true,
      peakHours: "02:00-05:00",
    });
    expect(classifyActionSettingsChange(toggleChanged, windowsChanged)).toMatchObject({
      kind: "display-only",
      reasons: ["peak-pricing-changed"],
    });
  });

  it.each([
    "refreshInterval",
    "pollIntervalSeconds",
    "credentialProfileRef",
    "credentialProfileId",
    "credentialClass",
    "credential",
    "credentials",
    "apiKey",
    "apiKeyId",
    "secret",
    "token",
    "authorizationHeader",
    "authHeader",
    "credentialMaterial",
    "credentialValue",
    "rawCredentialPayload",
    "sensitiveSelectors",
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
    "severityProfileRef",
    "severityProfileId",
    "thresholds",
    "warningAt",
    "criticalAt",
    "warnFloor",
    "criticalFloor",
    "windowOrPeriod",
    "window",
    "category",
    "categoryId",
    "period",
    "coverageKind",
    "metricVariant",
    "metricKind",
    "displayPreferences",
    "displayMode",
    "label",
    "color",
    "components",
    "component",
    "componentId",
    "include",
    "exclude",
    "page",
    "pageStatus",
    "maintenance",
    "scheduledMaintenances",
    "endpoint",
    "endpointUrl",
    "url",
    "statusUrl",
    "provider",
    "vendor",
    "nested",
    "unknownField",
  ])("rejects forbidden Status raw field %s before stripping or defaulting", (field) => {
    const result = parseActionSettings({
      familyId: "status",
      providerId: "anthropic-api",
      [field]: { hidden: RAW_NEEDLES.actionValue },
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        diagnostics: { reasonCode: "status-action-settings-forbidden-field" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(RAW_NEEDLES.actionValue);
  });

  it("normalizes a missing refresh interval to 600 seconds and derives secret-free scheduler key parts", () => {
    const result = parseActionSettings(falActionPayload);

    expect(result).toMatchObject({
      ok: true,
      value: {
        familyId: "balance",
        providerId: "fal",
        refreshIntervalSeconds: 600,
        credentialProfileRef: falCredentialRef,
        schedulerKeyParts: {
          familyId: "balance",
          providerId: "fal",
          credentialProfileId: "profile-fal-primary",
        },
      },
    });
    expect(result.ok && result.value.schedulerKey).toBeTypeOf("string");
    expect(JSON.stringify(result)).not.toContain("fixture-credential");
  });

  it.each([59, 3601])("rejects refresh interval %i as sanitized settings validation without clamping", (refreshIntervalSeconds) => {
    const result = parseActionSettings({
      ...falActionPayload,
      refreshIntervalSeconds,
    });

    expectSettingsValidationFailure(result, [String(refreshIntervalSeconds)]);
  });

  it.each([
    "apiKey",
    "secret",
    "token",
    "authorizationHeader",
    "accountId",
    "organizationId",
    "projectId",
    "teamId",
    "routingId",
    "rawCredentialPayload",
    "sensitiveSelectors",
  ] as const)("rejects action settings containing forbidden raw field %s without echoing it", (forbiddenKey) => {
    const result = parseActionSettings({
      ...falActionPayload,
      [forbiddenKey]: RAW_NEEDLES.actionValue,
    });

    expectSettingsValidationFailure(result, [forbiddenKey, RAW_NEEDLES.actionValue]);
  });

  it.each(["account", "organization", "project", "team", "workspace"] as const)(
    "rejects action settings containing sensitive selector class key %s without echoing it",
    (selectorClass) => {
      const result = parseActionSettings({
        ...falActionPayload,
        [selectorClass]: RAW_NEEDLES.actionValue,
      });

      expectSettingsValidationFailure(result, [selectorClass, RAW_NEEDLES.actionValue]);
    },
  );

  it.each(["warningAt", "criticalAt"] as const)("rejects inline severity scalar %s without echoing it", (scalarKey) => {
    const result = parseActionSettings({
      ...falActionPayload,
      [scalarKey]: RAW_NEEDLES.thresholdValue,
    });

    expectSettingsValidationFailure(result, [scalarKey, String(RAW_NEEDLES.thresholdValue)]);
  });

  it("rejects nested secret-like action settings fields without echoing them", () => {
    const result = parseActionSettings({
      ...falActionPayload,
      displayPreferences: {
        label: "Visible label",
        token: RAW_NEEDLES.actionValue,
      },
    });

    expectSettingsValidationFailure(result, ["token", RAW_NEEDLES.actionValue]);
  });

  it("rejects nested inline severity scalar fields without echoing them", () => {
    const result = parseActionSettings({
      ...falActionPayload,
      displayPreferences: {
        label: "Visible label",
        warningAt: RAW_NEEDLES.thresholdValue,
      },
    });

    expectSettingsValidationFailure(result, ["warningAt", String(RAW_NEEDLES.thresholdValue)]);
  });

  it("rejects credential profile references whose class does not match registry metadata", () => {
    const result = parseActionSettings({
      ...falActionPayload,
      credentialProfileRef: {
        kind: "credential-profile",
        credentialClass: "admin-api-credential",
        profileId: "profile-admin-wrong-provider",
      },
    });

    expectSettingsValidationFailure(result, ["profile-admin-wrong-provider"]);
  });

  it("requires Usage actions to include a supported window before scheduler key normalization", () => {
    const missingWindow = parseActionSettings({
      familyId: "usage",
      providerId: "claude-code",
      credentialProfileRef: {
        kind: "credential-profile",
        credentialClass: "local-read-only-source",
        profileId: "profile-claude-local",
      },
    });
    expectSettingsValidationFailure(missingWindow, ["claude-code"]);

    const unsupportedWindow = parseActionSettings({
      familyId: "usage",
      providerId: "claude-code",
      credentialProfileRef: {
        kind: "credential-profile",
        credentialClass: "local-read-only-source",
        profileId: "profile-claude-local",
      },
      windowOrPeriod: "monthly-mcp",
    });
    expectSettingsValidationFailure(unsupportedWindow, ["monthly-mcp"]);

    const validWindow = parseActionSettings({
      familyId: "usage",
      providerId: "claude-code",
      credentialProfileRef: {
        kind: "credential-profile",
        credentialClass: "local-read-only-source",
        profileId: "profile-claude-local",
      },
      windowOrPeriod: "five-hour",
    });

    expect(validWindow).toMatchObject({
      ok: true,
      value: {
        schedulerKeyParts: {
          familyId: "usage",
          providerId: "claude-code",
          credentialProfileId: "profile-claude-local",
          windowOrPeriod: "five-hour",
        },
      },
    });
  });

  it("keeps severity profile references action-local while rejecting inline threshold definitions", () => {
    const result = parseActionSettings({
      ...falActionPayload,
      severityProfileRef: {
        kind: "severity-profile",
        profileId: "severity-money-floor",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        severityProfileRef: {
          kind: "severity-profile",
          profileId: "severity-money-floor",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("warningAt");

    const inlineThresholdResult = parseActionSettings({
      ...falActionPayload,
      thresholds: {
        direction: "lower-bound",
        basis: "absolute",
        warningAt: RAW_NEEDLES.thresholdValue,
        criticalAt: 5,
      },
    });
    expectSettingsValidationFailure(inlineThresholdResult, ["thresholds", String(RAW_NEEDLES.thresholdValue)]);
  });
});

describe("global settings safe views and registry-derived requirements", () => {
  it("accepts global credential profiles with distinct credential classes without exposing raw values", () => {
    const result = parseGlobalSettings(globalSettingsPayload);

    expect(result).toMatchObject({
      ok: true,
      value: {
        credentialProfiles: [
          {
            profileId: "profile-fal-primary",
            displayName: "Fal primary",
            providerId: "fal",
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            credentialPresent: true,
            sensitiveSelectors: [],
          },
          {
            profileId: "profile-openai-admin",
            displayName: "OpenAI admin",
            providerId: "openai-api",
            actionFamilyId: "balance",
            credentialClass: "admin-api-credential",
            credentialPresent: true,
            sensitiveSelectors: [],
          },
        ],
        severityProfiles: [
          {
            profileId: "severity-money-floor",
            displayName: "Money floor",
            thresholds: {
              direction: "lower-bound",
              basis: "absolute",
              warningAt: 10,
              criticalAt: 5,
            },
          },
        ],
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.credentialValueA);
    expect(serialized).not.toContain(RAW_NEEDLES.credentialValueB);
    expect(serialized).not.toContain(RAW_NEEDLES.selectorValue);
    expect(serialized).not.toContain("credentialMaterial");
  });

  it("resolves provider setting requirements from registry metadata for simple and admin credential providers", () => {
    const falRequirements = resolveProviderSettingsRequirements({
      providerId: "fal",
      actionFamilyId: "balance",
    });
    const openAiRequirements = resolveProviderSettingsRequirements({
      providerId: "openai-api",
      actionFamilyId: "balance",
    });

    expect(falRequirements).toMatchObject({
      ok: true,
      value: {
        providerId: "fal",
        actionFamilyId: "balance",
        credentialClasses: ["plugin-api-key"],
        sensitiveSelectorRequirements: [],
        requiredSettings: ["credential-profile", "severity-profile-optional", "display-preferences-optional"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        severityStrategy: {
          kind: "registry-default",
          reference: "lower-bound-remaining-money-default",
        },
      },
    });

    expect(openAiRequirements).toMatchObject({
      ok: true,
      value: {
        providerId: "openai-api",
        actionFamilyId: "balance",
        credentialClasses: ["admin-api-credential"],
        sensitiveSelectorRequirements: [],
        requiredSettings: ["credential-profile", "severity-profile-optional", "display-preferences-optional"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        severityStrategy: {
          kind: "registry-default",
          reference: "upper-bound-spend-money-default",
        },
      },
    });
  });

  it("accepts independently optional severity floors and rejects severity profiles with no threshold at all", () => {
    const warnOnly = parseGlobalSettings({
      credentialProfiles: [],
      severityProfiles: [
        {
          profileId: "floors:warn-only",
          thresholds: {
            direction: "lower-bound",
            basis: "absolute",
            warningAt: 25,
          },
        },
      ],
    });
    expect(warnOnly).toMatchObject({
      ok: true,
      value: {
        severityProfiles: [
          {
            profileId: "floors:warn-only",
            thresholds: {
              direction: "lower-bound",
              basis: "absolute",
              warningAt: 25,
            },
          },
        ],
      },
    });
    if (warnOnly.ok) {
      expect(warnOnly.value.severityProfiles[0]?.thresholds.criticalAt).toBeUndefined();
    }

    const criticalOnly = parseGlobalSettings({
      credentialProfiles: [],
      severityProfiles: [
        {
          profileId: "floors:critical-only",
          thresholds: {
            direction: "lower-bound",
            basis: "absolute",
            criticalAt: 5,
          },
        },
      ],
    });
    expect(criticalOnly).toMatchObject({ ok: true });

    const emptyThresholds = parseGlobalSettings({
      credentialProfiles: [],
      severityProfiles: [
        {
          profileId: "floors:empty",
          thresholds: {
            direction: "lower-bound",
            basis: "absolute",
          },
        },
      ],
    });
    expect(emptyThresholds).toMatchObject({ ok: false });
  });

  it("rejects global credential profiles whose class is not allowed by registry metadata", () => {
    const result = parseGlobalSettings({
      credentialProfiles: [
        {
          ...globalSettingsPayload.credentialProfiles[0],
          credentialClass: "admin-api-credential",
          credentialMaterial: {
            kind: "inline-secret",
            value: RAW_NEEDLES.credentialValueA,
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.credentialValueA);
    if (!result.ok) {
      expect(result.failure.category).toBe("settings-validation-failure");
    }
  });

  it("accepts OpenRouter Management-key profiles and rejects the wrong credential class", () => {
    const correctProfile = {
      profileId: "profile:balance:openrouter:admin-api-credential",
      actionFamilyId: "balance",
      providerId: "openrouter",
      credentialClass: "admin-api-credential",
      credentialMaterial: {
        kind: "inline-secret",
        value: RAW_NEEDLES.credentialValueA,
      },
    } as const;
    const accepted = parseGlobalSettings({ credentialProfiles: [correctProfile] });
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        credentialProfiles: [
          {
            profileId: "profile:balance:openrouter:admin-api-credential",
            providerId: "openrouter",
            actionFamilyId: "balance",
            credentialClass: "admin-api-credential",
            credentialPresent: true,
          },
        ],
      },
    });
    expect(JSON.stringify(accepted)).not.toContain(RAW_NEEDLES.credentialValueA);

    const rejected = parseGlobalSettings({
      credentialProfiles: [
        {
          ...correctProfile,
          profileId: "profile:balance:openrouter:plugin-api-key",
          credentialClass: "plugin-api-key",
          credentialMaterial: {
            kind: "inline-secret",
            value: RAW_NEEDLES.credentialValueB,
          },
        },
      ],
    });
    expect(rejected).toMatchObject({
      ok: false,
      failure: {
        category: "settings-validation-failure",
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(RAW_NEEDLES.credentialValueB);
  });
});

describe("Property Inspector payload parsing", () => {
  it("accepts a Status action update through the central action boundary", () => {
    expect(
      parsePropertyInspectorPayload({
        kind: "action-settings-update",
        payload: {
          familyId: "status",
          providerId: "openai-api",
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "action-settings-update",
        actionSettings: {
          familyId: "status",
          providerId: "openai-api",
          refreshIntervalSeconds: 600,
          schedulerKeyParts: { credentialProfileId: "none" },
        },
      },
    });
  });

  it("rejects a Status Property Inspector attempt to write global settings", () => {
    expect(
      parsePropertyInspectorPayload({
        kind: "global-settings-update",
        payload: {
          familyId: "status",
        },
      }),
    ).toMatchObject({
      ok: false,
      failure: {
        diagnostics: { reasonCode: "status-property-inspector-global-settings-forbidden" },
      },
    });
  });

  it("uses the same action settings rules and rejects secret-bearing action updates", () => {
    const result = parsePropertyInspectorPayload({
      kind: "action-settings-update",
      payload: {
        ...falActionPayload,
        apiKey: RAW_NEEDLES.actionValue,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.category).toBe("settings-validation-failure");
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain(RAW_NEEDLES.actionValue);
  });

  it("uses the same action settings rules and rejects stripped PI action update extras", () => {
    const result = parsePropertyInspectorPayload({
      kind: "action-settings-update",
      payload: {
        ...falActionPayload,
        organization: RAW_NEEDLES.actionValue,
      },
    });

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("organization");
    expect(serialized).not.toContain(RAW_NEEDLES.actionValue);
  });

  it("normalizes global settings updates through the same global settings boundary", () => {
    const result = parsePropertyInspectorPayload({
      kind: "global-settings-update",
      payload: globalSettingsPayload,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "global-settings-update",
        globalSettings: {
          credentialProfiles: expect.any(Array),
          severityProfiles: expect.any(Array),
        },
      },
    });
  });
});

describe("settings change classification", () => {
  it("distinguishes provider-source-affecting changes from display-only changes", () => {
    const baseline = unwrapActionSettings({
      ...falActionPayload,
      displayPreferences: {
        label: "Primary",
        color: "green",
      },
      metricVariant: "primary",
      windowOrPeriod: "evergreen",
    });
    const credentialChanged = unwrapActionSettings({
      ...falActionPayload,
      credentialProfileRef: {
        ...falCredentialRef,
        profileId: "profile-fal-secondary",
      },
      displayPreferences: {
        label: "Primary",
        color: "green",
      },
      metricVariant: "primary",
      windowOrPeriod: "evergreen",
    });
    const displayChanged = unwrapActionSettings({
      ...falActionPayload,
      displayPreferences: {
        label: "Renamed",
        color: "amber",
      },
      metricVariant: "primary",
      severityProfileRef: {
        kind: "severity-profile",
        profileId: "severity-money-floor",
      },
      windowOrPeriod: "evergreen",
    });

    expect(classifyActionSettingsChange(baseline, credentialChanged)).toMatchObject({
      kind: "provider-source-affecting",
      schedulerKeyChanged: true,
      providerRefetchRequired: true,
      bypassBackoffAllowed: true,
      refreshPolicyChanged: false,
      displayOnly: false,
      reasons: expect.arrayContaining(["credential-profile-changed"]),
    });

    expect(classifyActionSettingsChange(baseline, displayChanged)).toMatchObject({
      kind: "display-only",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      refreshPolicyChanged: false,
      displayOnly: true,
      reasons: expect.arrayContaining(["display-preferences-changed", "severity-profile-reference-changed"]),
    });
  });

  it("classifies every provider-source action field change with its reason", () => {
    const baseline = unwrapActionSettings({
      ...falActionPayload,
      displayPreferences: {
        label: "Primary",
      },
      metricVariant: "primary",
      windowOrPeriod: "evergreen",
    });
    const providerSourceCases = [
      {
        label: "action family",
        reason: "action-family-changed",
        after: { ...baseline, familyId: "usage" },
      },
      {
        label: "provider",
        reason: "provider-changed",
        after: { ...baseline, providerId: "openai-api" },
      },
      {
        label: "credential profile",
        reason: "credential-profile-changed",
        after: {
          ...baseline,
          credentialProfileRef: {
            ...falCredentialRef,
            profileId: "profile-fal-secondary",
          },
        },
      },
      {
        label: "credential class",
        reason: "credential-class-changed",
        after: {
          ...baseline,
          credentialProfileRef: {
            ...falCredentialRef,
            credentialClass: "admin-api-credential",
          },
        },
      },
      {
        label: "window or period",
        reason: "window-or-period-changed",
        after: { ...baseline, windowOrPeriod: "current-period" },
      },
      {
        label: "metric variant",
        reason: "metric-variant-changed",
        after: { ...baseline, metricVariant: "secondary" },
      },
    ] as const;

    for (const { label, reason, after } of providerSourceCases) {
      expect(classifyActionSettingsChange(baseline, after), label).toMatchObject({
        kind: "provider-source-affecting",
        schedulerKeyChanged: false,
        providerRefetchRequired: true,
        bypassBackoffAllowed: true,
        refreshPolicyChanged: false,
        displayOnly: false,
        reasons: [reason],
      });
    }
  });

  it("classifies refresh interval changes distinctly from provider-source changes", () => {
    const baseline = unwrapActionSettings(falActionPayload);
    const refreshChanged = unwrapActionSettings({
      ...falActionPayload,
      refreshIntervalSeconds: 900,
    });

    expect(classifyActionSettingsChange(baseline, refreshChanged)).toMatchObject({
      kind: "refresh-policy-affecting",
      schedulerKeyChanged: false,
      providerRefetchRequired: false,
      bypassBackoffAllowed: false,
      refreshPolicyChanged: true,
      displayOnly: false,
      reasons: ["refresh-interval-changed"],
    });
  });

  it("classifies raw credential value changes without exposing the changed values", () => {
    const result = classifyGlobalSettingsChange(globalSettingsPayload, {
      ...globalSettingsPayload,
      credentialProfiles: [
        {
          ...globalSettingsPayload.credentialProfiles[0],
          credentialMaterial: {
            kind: "inline-secret",
            value: "fixture-credential-material-c",
          },
        },
        globalSettingsPayload.credentialProfiles[1],
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "provider-source-affecting",
        providerRefetchRequired: true,
        bypassBackoffAllowed: true,
        reasons: expect.arrayContaining(["credential-value-changed"]),
        affectedCredentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.credentialValueA);
    expect(serialized).not.toContain("fixture-credential-material-c");
  });

  it("classifies sensitive selector changes without exposing selector material", () => {
    const result = classifyGlobalSettingsChange(globalSettingsPayload, {
      ...globalSettingsPayload,
      credentialProfiles: [
        globalSettingsPayload.credentialProfiles[0],
        {
          ...globalSettingsPayload.credentialProfiles[1],
          sensitiveSelectors: [
            {
              selectorClass: "organization",
              value: "fixture-selector-material-changed",
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "provider-source-affecting",
        providerRefetchRequired: true,
        bypassBackoffAllowed: true,
        affectedCredentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "admin-api-credential",
            profileId: "profile-openai-admin",
            providerId: "openai-api",
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.selectorValue);
    expect(serialized).not.toContain("fixture-selector-material-changed");
  });
});

describe("Redacted credential decode boundary", () => {
  const BEARER_SECRET = "sk-live-REDACTED-PROBE-abcXYZ-do-not-leak";

  const credentialProfile = (value: string) => ({
    profileId: "profile-fal-primary",
    displayName: "Fal primary",
    actionFamilyId: "balance",
    providerId: "fal",
    credentialClass: "plugin-api-key",
    credentialMaterial: { kind: "inline-secret", value },
  });

  it("decodes credential material as a Redacted value that renders <redacted> and never exposes the raw secret", () => {
    const decoded = Schema.decodeUnknownSync(CredentialMaterialSchema)({
      kind: "inline-secret",
      value: BEARER_SECRET,
    });

    // Effect@3.21.4 renders Redacted as "<redacted>" (angle brackets) under
    // toString/toJSON/inspect — the raw secret must be absent from both.
    expect(Redacted.isRedacted(decoded.value)).toBe(true);

    const asJson = JSON.stringify(decoded);
    expect(asJson).not.toContain(BEARER_SECRET);
    expect(asJson).toContain("<redacted>");

    expect(String(decoded.value)).toBe("<redacted>");
    expect(String(decoded.value)).not.toContain(BEARER_SECRET);
    expect(`${decoded.value}`).not.toContain(BEARER_SECRET);
  });

  it("classifies an identical credential value as unchanged and a rotated value as provider-source-affecting via Redacted Hash", () => {
    // Distinct payload objects with the SAME secret decode to distinct Redacted
    // instances; a value-based Hash must still classify them as unchanged (an
    // identity-based fingerprint would wrongly report a change here).
    const unchanged = classifyGlobalSettingsChange(
      { credentialProfiles: [credentialProfile(BEARER_SECRET)] },
      { credentialProfiles: [credentialProfile(BEARER_SECRET)] },
    );
    expect(unchanged).toMatchObject({ ok: true, value: { kind: "unchanged" } });

    const changed = classifyGlobalSettingsChange(
      { credentialProfiles: [credentialProfile(BEARER_SECRET)] },
      { credentialProfiles: [credentialProfile(`${BEARER_SECRET}-rotated`)] },
    );
    expect(changed).toMatchObject({
      ok: true,
      value: {
        kind: "provider-source-affecting",
        providerRefetchRequired: true,
        bypassBackoffAllowed: true,
        reasons: expect.arrayContaining(["credential-value-changed"]),
        affectedCredentialProfiles: [
          {
            actionFamilyId: "balance",
            credentialClass: "plugin-api-key",
            profileId: "profile-fal-primary",
            providerId: "fal",
          },
        ],
      },
    });

    const serialized = JSON.stringify([unchanged, changed]);
    expect(serialized).not.toContain(BEARER_SECRET);
  });

  it("preserves the empty-vs-present distinction through value-based Equal without unwrapping", () => {
    const present = parseGlobalSettings({ credentialProfiles: [credentialProfile(BEARER_SECRET)] });
    const empty = parseGlobalSettings({ credentialProfiles: [credentialProfile("")] });

    expect(present.ok && present.value.credentialProfiles[0]?.credentialPresent).toBe(true);
    expect(empty.ok && empty.value.credentialProfiles[0]?.credentialPresent).toBe(false);

    expect(JSON.stringify([present, empty])).not.toContain(BEARER_SECRET);
  });

  it("never unwraps the redacted secret anywhere in the settings source", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Redacted.value");
  });
});

describe("header-safe credential value edge validation", () => {
  // FAKE keys only. `\n` is an internal line break; the astral emoji and the BOM are the
  // non-Latin-1 / edge code points a corrupted paste introduces. None may leak into a message.
  const INTERNAL_NEWLINE_KEY = "sk-fixture-header-abc" + "\n" + "def";
  const ASTRAL_KEY = "sk-fixture-header-abc" + String.fromCodePoint(0x1f600) + "def";
  const LEADING_BOM_KEY = String.fromCharCode(0xfeff) + "sk-fixture-header-key";

  it("accepts credential values whose header-forwarded form is valid", () => {
    const acceptedValues = [
      "sk-fixture-Abc123._+/=", // base64 + / = plus JWT dots
      "sk.fixture.jwt.aaa-bbb_ccc",
      "sk-fixture-trailing-space  ", // trailing HTTP whitespace is trimmed by Node
      "sk-fixture-trailing-newline" + "\n",
      "sk-fixture-high-latin1-é", // high Latin-1 (0xE9) is a valid header byte
    ];

    for (const value of acceptedValues) {
      expect(isHeaderSafeCredentialValue(value)).toBe(true);
      expect(Schema.is(HeaderSafeCredentialValueSchema)(value)).toBe(true);
    }
  });

  it("rejects empty, whitespace-only, internal-control-char, and non-Latin-1 credential values", () => {
    const rejectedValues = ["", "   ", INTERNAL_NEWLINE_KEY, ASTRAL_KEY, LEADING_BOM_KEY];

    for (const value of rejectedValues) {
      expect(isHeaderSafeCredentialValue(value)).toBe(false);
      expect(Schema.is(HeaderSafeCredentialValueSchema)(value)).toBe(false);
    }
  });

  it("never embeds the credential value in the schema's validation message", () => {
    // Production uses `Schema.is` (a boolean guard, no ParseError). Even on the decode path
    // the filter's message is static and must not echo the value.
    let message = "";
    try {
      Schema.decodeUnknownSync(HeaderSafeCredentialValueSchema)(INTERNAL_NEWLINE_KEY);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("valid in an HTTP header value");
    expect(message).not.toContain("sk-fixture-header-abc");
  });
});
