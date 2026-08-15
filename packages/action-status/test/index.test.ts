import { describe, expect, it } from "vitest";

import {
  buildStatusDisplayInput,
  buildStatusRendererInput,
  listStatusProviderOptions,
  normalizeStatusIncidents,
  packageName,
  resolveStatusProviderOption,
} from "../src/index.js";

describe("@ai-workbench/action-status public surface", () => {
  it("derives the exact approved Status provider options from registry family APIs", () => {
    expect(packageName).toBe("@ai-workbench/action-status");
    expect(listStatusProviderOptions()).toEqual([
      {
        providerId: "anthropic-api",
        productLabel: "Anthropic",
        pickerLabel: "Anthropic",
        actionFamilyId: "status",
        adapterBindingId: "status.anthropic-api",
        credentialClass: "none",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
      },
      {
        providerId: "openai-api",
        productLabel: "OpenAI",
        pickerLabel: "OpenAI",
        actionFamilyId: "status",
        adapterBindingId: "status.openai-api",
        credentialClass: "none",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
      },
      {
        providerId: "moonshot",
        productLabel: "Moonshot",
        pickerLabel: "Moonshot AI",
        actionFamilyId: "status",
        adapterBindingId: "status.moonshot",
        credentialClass: "none",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
      },
      {
        providerId: "minimax",
        productLabel: "MiniMax",
        pickerLabel: "MiniMax",
        actionFamilyId: "status",
        adapterBindingId: "status.minimax",
        credentialClass: "none",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
      },
    ]);
    expect(resolveStatusProviderOption("moonshot")).toMatchObject({
      providerId: "moonshot",
      productLabel: "Moonshot",
      pickerLabel: "Moonshot AI",
    });
    expect(resolveStatusProviderOption("deepseek")).toBeUndefined();
    expect(resolveStatusProviderOption("zai-coding-plan")).toBeUndefined();
    expect(resolveStatusProviderOption("unknown-provider")).toBeUndefined();
  });
});

describe("Status incident policy", () => {
  it("returns zero with no highest impact and operational tone for an empty incident list", () => {
    const snapshot = normalizeStatusIncidents({
      providerId: "anthropic-api",
      incidents: [],
      fetchedAtEpochMs: 1_000,
    });

    expect(snapshot).toEqual({
      familyId: "status",
      providerId: "anthropic-api",
      activeIncidentCount: 0,
      fetchedAtEpochMs: 1_000,
    });
    expect(snapshot).not.toHaveProperty("highestImpact");
    expect(buildStatusDisplayInput(snapshot)).toEqual({
      ok: true,
      value: {
        actionFamilyId: "status",
        providerId: "anthropic-api",
        activeIncidentCount: 0,
        tone: "operational",
        valueText: "0",
        fetchedAtEpochMs: 1_000,
      },
    });
  });

  it("returns informational tone for a positive active count with impact none", () => {
    const snapshot = normalizeStatusIncidents({
      providerId: "openai-api",
      incidents: [{ status: "investigating", impact: "none" }],
      providerStatusIndicator: "none",
      fetchedAtEpochMs: 2_000,
    });

    expect(snapshot).toEqual({
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 1,
      highestImpact: "none",
      providerStatusIndicator: "none",
      fetchedAtEpochMs: 2_000,
    });
    expect(buildStatusDisplayInput(snapshot)).toEqual({
      ok: true,
      value: {
        actionFamilyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 1,
        highestImpact: "none",
        providerStatusIndicator: "none",
        tone: "informational",
        valueText: "1",
        fetchedAtEpochMs: 2_000,
      },
    });

    expect(
      buildStatusRendererInput({
        providerId: "openai-api",
        schedulerOutput: {
          schedulerKey: "status|openai-api||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
        },
      }),
    ).toMatchObject({
      actionFamilyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 1,
      highestImpact: "none",
      statusDisplayTone: "informational",
      valueText: "1",
      freshness: "fresh",
      headerLabel: "OpenAI",
    });
  });

  it.each([
    ["none", "operational"],
    ["maintenance", "informational"],
    ["minor", "warning"],
    ["major", "critical"],
    ["critical", "critical"],
  ] as const)("maps aggregate-only OpenAI indicator %s to %s without fabricating incident impact", (indicator, tone) => {
    const snapshot = normalizeStatusIncidents({
      providerId: "openai-api",
      incidents: [],
      providerStatusIndicator: indicator,
      fetchedAtEpochMs: 2_500,
    });
    const display = buildStatusDisplayInput(snapshot);

    expect(snapshot).toEqual({
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 0,
      providerStatusIndicator: indicator,
      fetchedAtEpochMs: 2_500,
    });
    expect(display).toEqual({
      ok: true,
      value: {
        actionFamilyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 0,
        providerStatusIndicator: indicator,
        tone,
        valueText: "0",
        fetchedAtEpochMs: 2_500,
      },
    });
    const rendererInput = buildStatusRendererInput({
      providerId: "openai-api",
      schedulerOutput: {
        schedulerKey: "status|openai-api||none|",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
      },
    });
    expect(rendererInput).toMatchObject({
      activeIncidentCount: 0,
      statusDisplayTone: tone,
      valueText: "0",
    });
    expect(rendererInput).not.toHaveProperty("providerStatusIndicator");

    const staleRendererInput = buildStatusRendererInput({
      providerId: "openai-api",
      schedulerOutput: {
        schedulerKey: "status|openai-api||none|",
        displayState: "stale",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
        staleReason: "refresh-failed",
        failure: {
          category: "validation-drift",
          displayState: "validation-drift",
          retryClass: "rate-limit-backoff",
          safePublicMessage: "Provider response validation failed.",
          diagnostics: { boundary: "status-test", reasonCode: "response-json-schema-mismatch" },
          sanitized: true,
        },
      },
    });
    expect(staleRendererInput).toMatchObject({
      activeIncidentCount: 0,
      statusDisplayTone: tone,
      valueText: "0",
      freshness: "stale",
      failureIndicator: "DATA ERROR",
    });
    expect(staleRendererInput).not.toHaveProperty("providerStatusIndicator");
  });

  it.each([
    ["minor", "none", "warning"],
    ["none", "critical", "critical"],
    ["critical", "minor", "critical"],
  ] as const)(
    "selects the worse tone for incident impact %s and aggregate indicator %s",
    (impact, indicator, tone) => {
      const snapshot = normalizeStatusIncidents({
        providerId: "openai-api",
        incidents: [{ status: "investigating", impact }],
        providerStatusIndicator: indicator,
        fetchedAtEpochMs: 2_750,
      });

      expect(snapshot).toMatchObject({
        activeIncidentCount: 1,
        highestImpact: impact,
        providerStatusIndicator: indicator,
      });
      expect(buildStatusDisplayInput(snapshot)).toMatchObject({
        ok: true,
        value: {
          activeIncidentCount: 1,
          highestImpact: impact,
          providerStatusIndicator: indicator,
          tone,
        },
      });
    },
  );

  it("counts only exact active lifecycles and selects the highest included impact", () => {
    const snapshot = normalizeStatusIncidents({
      providerId: "minimax",
      incidents: [
        { status: "investigating", impact: "none" },
        { status: "identified", impact: "minor" },
        { status: "monitoring", impact: "major" },
        { status: "resolved", impact: "critical" },
        { status: "postmortem", impact: "critical" },
      ],
      fetchedAtEpochMs: 3_000,
    });

    expect(snapshot).toEqual({
      familyId: "status",
      providerId: "minimax",
      activeIncidentCount: 3,
      highestImpact: "major",
      fetchedAtEpochMs: 3_000,
    });
    expect(buildStatusDisplayInput(snapshot)).toMatchObject({
      ok: true,
      value: {
        activeIncidentCount: 3,
        highestImpact: "major",
        tone: "critical",
        valueText: "3",
      },
    });
  });

  it("excludes every maintenance lifecycle and maintenance impact without consuming ignored summary surfaces", () => {
    const input = {
      providerId: "moonshot",
      incidents: [
        { status: "scheduled", impact: "critical" },
        { status: "in_progress", impact: "critical" },
        { status: "verifying", impact: "critical" },
        { status: "completed", impact: "critical" },
        { status: "investigating", impact: "maintenance" },
      ],
      fetchedAtEpochMs: 4_000,
    } as const;
    const inputWithIgnoredSurfaces = {
      ...input,
      components: [{ state: "degraded" }],
      page: { indicator: "major" },
      scheduledMaintenances: [{ state: "active" }],
    };

    const expected = {
      familyId: "status",
      providerId: "moonshot",
      activeIncidentCount: 0,
      fetchedAtEpochMs: 4_000,
    };
    expect(normalizeStatusIncidents(input)).toEqual(expected);
    expect(normalizeStatusIncidents(inputWithIgnoredSurfaces)).toEqual(expected);
  });

  it.each([
    ["none", "informational"],
    ["minor", "warning"],
    ["major", "critical"],
    ["critical", "critical"],
  ] as const)("maps positive impact %s to %s while preserving the impact", (impact, tone) => {
    const snapshot = normalizeStatusIncidents({
      providerId: "anthropic-api",
      incidents: [{ status: "monitoring", impact }],
      fetchedAtEpochMs: 5_000,
    });

    expect(snapshot).toMatchObject({ activeIncidentCount: 1, highestImpact: impact });
    expect(buildStatusDisplayInput(snapshot)).toMatchObject({
      ok: true,
      value: { highestImpact: impact, tone },
    });
    expect(
      buildStatusRendererInput({
        providerId: "anthropic-api",
        schedulerOutput: {
          schedulerKey: "status|anthropic-api||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
        },
      }),
    ).toMatchObject({
      highestImpact: impact,
      statusDisplayTone: tone,
    });
  });

  it("keeps the largest safe incident count intact for renderer shrink-fit", () => {
    const activeIncidentCount = Number.MAX_SAFE_INTEGER;
    const snapshot = {
      familyId: "status",
      providerId: "minimax",
      activeIncidentCount,
      highestImpact: "critical",
      fetchedAtEpochMs: 5_500,
    } as const;

    expect(
      buildStatusRendererInput({
        providerId: "minimax",
        schedulerOutput: {
          schedulerKey: "status|minimax||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
        },
      }),
    ).toMatchObject({
      activeIncidentCount,
      statusDisplayTone: "critical",
      valueText: String(activeIncidentCount),
    });
  });

  it("keeps a retained Status count and tone stale with the existing failure indicator", () => {
    const snapshot = {
      familyId: "status",
      providerId: "moonshot",
      activeIncidentCount: 4,
      highestImpact: "major",
      fetchedAtEpochMs: 6_000,
    } as const;

    expect(
      buildStatusRendererInput({
        providerId: "moonshot",
        schedulerOutput: {
          schedulerKey: "status|moonshot||none|",
          displayState: "stale",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
          staleReason: "refresh-failed",
          failure: {
            category: "validation-drift",
            displayState: "validation-drift",
            retryClass: "rate-limit-backoff",
            safePublicMessage: "Provider response validation failed.",
            diagnostics: { boundary: "status-test", reasonCode: "provider-schema-drift" },
            sanitized: true,
          },
        },
      }),
    ).toMatchObject({
      activeIncidentCount: 4,
      highestImpact: "major",
      statusDisplayTone: "critical",
      valueText: "4",
      displayState: "stale",
      freshness: "stale",
      stale: true,
      failureIndicator: "DATA ERROR",
      fetchedAtEpochMs: 6_000,
    });
  });

  it("renders a no-snapshot validation failure as degraded Status instead of zero operational", () => {
    const result = buildStatusRendererInput({
      providerId: "anthropic-api",
      schedulerOutput: {
        schedulerKey: "status|anthropic-api||none|",
        displayState: "validation-drift",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        failure: {
          category: "validation-drift",
          displayState: "validation-drift",
          retryClass: "rate-limit-backoff",
          safePublicMessage: "Provider response validation failed.",
          diagnostics: { boundary: "status-test", reasonCode: "provider-schema-drift" },
          sanitized: true,
        },
      },
    });

    expect(result).toMatchObject({
      actionFamilyId: "status",
      providerId: "anthropic-api",
      headerLabel: "Anthropic",
      displayState: "validation-drift",
      freshness: "degraded",
      stale: false,
      valueText: "Validation drift",
    });
    expect(result).not.toHaveProperty("activeIncidentCount");
    expect(result).not.toHaveProperty("statusDisplayTone");
  });

  it("keeps renderer assembly invariant when ignored incident surfaces are added", () => {
    const snapshot = {
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 2,
      highestImpact: "minor",
      providerStatusIndicator: "none",
      fetchedAtEpochMs: 6_500,
    } as const;
    const withIgnoredSurfaces = {
      ...snapshot,
      incidentTitle: "ignored fixture prose",
      components: [{ state: "degraded" }],
      scheduledMaintenances: [{ state: "active" }],
      page: { indicator: "critical" },
      thresholds: { warningAt: 1 },
    };
    const render = (candidate: typeof snapshot | typeof withIgnoredSurfaces) =>
      buildStatusRendererInput({
        providerId: "openai-api",
        schedulerOutput: {
          schedulerKey: "status|openai-api||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot: candidate,
        },
      });

    expect(render(withIgnoredSurfaces)).toEqual(render(snapshot));
    expect(JSON.stringify(render(withIgnoredSurfaces))).not.toContain("ignored fixture prose");
  });

  it("selects the same highest impact regardless of incident order", () => {
    const incidents = [
      { status: "investigating", impact: "minor" },
      { status: "identified", impact: "critical" },
      { status: "monitoring", impact: "major" },
    ] as const;

    const forward = normalizeStatusIncidents({
      providerId: "openai-api",
      incidents,
      providerStatusIndicator: "minor",
      fetchedAtEpochMs: 6_000,
    });
    const reverse = normalizeStatusIncidents({
      providerId: "openai-api",
      incidents: [...incidents].reverse(),
      providerStatusIndicator: "minor",
      fetchedAtEpochMs: 6_000,
    });

    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({ activeIncidentCount: 3, highestImpact: "critical" });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "rejects invalid active incident count %s instead of building display input",
    (activeIncidentCount) => {
      expect(
        buildStatusDisplayInput({
          familyId: "status",
          providerId: "anthropic-api",
          activeIncidentCount,
          highestImpact: "minor",
          fetchedAtEpochMs: 7_000,
        }),
      ).toEqual({ ok: false, reason: "invalid-status-snapshot" });
    },
  );

  it("rejects a zero count carrying a highest impact", () => {
    expect(
      buildStatusDisplayInput({
        familyId: "status",
        providerId: "anthropic-api",
        activeIncidentCount: 0,
        highestImpact: "critical",
        fetchedAtEpochMs: 8_000,
      }),
    ).toEqual({ ok: false, reason: "invalid-status-snapshot" });
  });

  it("rejects a positive count without a highest impact", () => {
    expect(
      buildStatusDisplayInput({
        familyId: "status",
        providerId: "anthropic-api",
        activeIncidentCount: 1,
        fetchedAtEpochMs: 9_000,
      }),
    ).toEqual({ ok: false, reason: "invalid-status-snapshot" });
  });

  it("rejects OpenAI snapshots without an aggregate indicator", () => {
    expect(
      buildStatusDisplayInput({
        familyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 0,
        fetchedAtEpochMs: 10_000,
      }),
    ).toEqual({ ok: false, reason: "invalid-status-snapshot" });
  });

  it("rejects strict-provider snapshots carrying an aggregate indicator", () => {
    expect(
      buildStatusDisplayInput({
        familyId: "status",
        providerId: "minimax",
        activeIncidentCount: 0,
        providerStatusIndicator: "none",
        fetchedAtEpochMs: 11_000,
      }),
    ).toEqual({ ok: false, reason: "invalid-status-snapshot" });
  });
});
