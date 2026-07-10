import { describe, expect, it, vi } from "vitest";

import {
  BALANCE_PROVIDER_IDS,
  METRIC_KIND_DIRECTION,
  METRIC_KIND_UNIT,
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  serializeSchedulerKey,
  type BalanceMetricKind,
  type BalanceProviderId,
  type CoverageKind,
  type NormalizedSnapshot,
  type SchedulerKeyParts,
  type SeverityThresholdSet,
  type SnapshotCoverage,
} from "../../contracts/src/index.js";
import { findProviderEntry } from "../../provider-registry/src/index.js";
import type { SchedulerOutput } from "../../scheduler/src/index.js";
import type { NormalizedActionSettingsView } from "../../settings/src/index.js";
import {
  buildBalanceRendererInput,
  buildSourceGatedBalanceSchedulerOutput,
  listBalanceProviderOptions,
  packageName,
  resolveBalanceProviderOption,
} from "../src/index.js";

function balanceSettings(providerId: BalanceProviderId, windowOrPeriod?: CoverageKind): NormalizedActionSettingsView {
  const schedulerKeyParts: SchedulerKeyParts = {
    familyId: "balance",
    providerId,
    credentialProfileId: "none",
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
  };

  return {
    familyId: "balance",
    providerId,
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    displayPreferences: {},
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
    schedulerKeyParts,
    schedulerKey: serializeSchedulerKey(schedulerKeyParts),
  };
}

function balanceSnapshot(input: {
  readonly providerId: BalanceProviderId;
  readonly metricKind: BalanceMetricKind;
  readonly coverageKind: CoverageKind;
  readonly value: number;
}): NormalizedSnapshot {
  return {
    familyId: "balance",
    providerId: input.providerId,
    metricKind: input.metricKind,
    metricDirection: METRIC_KIND_DIRECTION[input.metricKind],
    unit: METRIC_KIND_UNIT[input.metricKind],
    coverage: coverageFromKind(input.coverageKind),
    value: input.value,
    fetchedAtEpochMs: 1_000,
  };
}

function coverageFromKind(coverageKind: CoverageKind): SnapshotCoverage {
  switch (coverageKind) {
    case "evergreen":
      return { kind: "evergreen" };
    case "month-to-date":
      return { kind: "month-to-date" };
    case "current-period":
      return { kind: "current-period" };
    case "rolling-window":
      return { kind: "rolling-window", window: "five-hour" };
  }
}

function schedulerOutput(actionSettings: NormalizedActionSettingsView, snapshot: NormalizedSnapshot): SchedulerOutput {
  return {
    schedulerKey: actionSettings.schedulerKey,
    displayState: "fresh",
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    activeRefCount: 1,
    inFlight: false,
    snapshot,
  };
}

describe("@ai-workbench/action-balance public surface", () => {
  it("exposes Balance action-family orchestration exports", () => {
    expect(packageName).toBe("@ai-workbench/action-balance");
    expect(typeof listBalanceProviderOptions).toBe("function");
    expect(typeof resolveBalanceProviderOption).toBe("function");
    expect(typeof buildSourceGatedBalanceSchedulerOutput).toBe("function");
    expect(typeof buildBalanceRendererInput).toBe("function");
  });
});

describe("Balance catalog and settings coverage", () => {
  it("lists all first Balance providers from registry metadata with current source gates and metric truth", () => {
    const options = listBalanceProviderOptions();

    expect(options.map((option) => option.providerId)).toEqual(BALANCE_PROVIDER_IDS);
    expect(options.every((option) => option.implementationStatus === "implemented")).toBe(true);
    expect(options.every((option) => option.fetchAllowed === true)).toBe(true);
    expect(options.every((option) => option.selectionEligible === true)).toBe(true);

    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "fal",
        productLabel: "Fal.AI",
        metricKind: "remaining-balance",
        metricDirection: "lower-bound",
        unit: "money",
        coverageKind: "evergreen",
        sourceProofStatus: "probeAccepted",
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "runpod",
        metricKind: "current-period-spend",
        metricDirection: "upper-bound",
        unit: "money",
        coverageKind: "current-period",
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "speechmatics",
        metricKind: "used-time",
        metricDirection: "upper-bound",
        unit: "duration-hours",
        coverageKind: "current-period",
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "elevenlabs",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "jina",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
      }),
    );
  });

  it("resolves Balance providers when action settings omit coverage and rejects mismatched supplied coverage", () => {
    expect(resolveBalanceProviderOption({ providerId: "fal" })).toMatchObject({
      ok: true,
      value: {
        providerId: "fal",
        coverageKind: "evergreen",
      },
    });
    expect(resolveBalanceProviderOption({ providerId: "fal", windowOrPeriod: "evergreen" })).toMatchObject({
      ok: true,
      value: {
        providerId: "fal",
        coverageKind: "evergreen",
      },
    });

    const unsupported = resolveBalanceProviderOption({ providerId: "fal", windowOrPeriod: "month-to-date" });

    expect(unsupported).toMatchObject({
      ok: false,
      failure: {
        category: "unsupported-capability",
        displayState: "unsupported-capability",
        retryClass: "no-retry",
        provider: {
          failureClass: "unsupported",
          reasonCode: "unsupported-balance-coverage",
        },
      },
    });
  });

  it("keeps Balance provider option truth derived from registry capability metadata", () => {
    for (const option of listBalanceProviderOptions()) {
      const capability = findProviderEntry(option.providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "balance");

      expect(capability).toBeDefined();
      expect(option.metricKind).toBe(capability?.metricKind);
      expect(option.metricDirection).toBe(capability?.metricDirection);
      expect(option.unit).toBe(capability?.displayUnit);
      expect(option.coverageKind).toBe(capability?.coverageKind);
    }
  });
});

describe("source-gated Balance scheduler and display output", () => {
  it("calls source fetch for implemented docs-backed Balance providers and returns trusted snapshots", async () => {
    const actionSettings = balanceSettings("fal");
    const snapshot = balanceSnapshot({
      providerId: "fal",
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: 10,
    });
    const sourceFetch = vi.fn(() => ({
      ok: true,
      snapshot,
    }) as const);

    const schedulerResult = await buildSourceGatedBalanceSchedulerOutput({
      actionSettings,
      sourceFetch,
    });
    const displayInput = buildBalanceRendererInput({ actionSettings, schedulerOutput: schedulerResult });

    expect(sourceFetch).toHaveBeenCalledOnce();
    expect(schedulerResult).toMatchObject({
      schedulerKey: actionSettings.schedulerKey,
      displayState: "fresh",
      refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
      activeRefCount: 1,
      inFlight: false,
      snapshot,
    });
    expect(displayInput).toMatchObject({
      valueText: "$10.00",
      displayState: "fresh",
      freshness: "fresh",
    });
  });

  it("executes implemented docs-backed and probe-sourced Balance providers without fake snapshots", async () => {
    for (const providerId of ["elevenlabs", "jina"] as const) {
      const actionSettings = balanceSettings(providerId);
      const snapshot = balanceSnapshot({
        providerId,
        metricKind: providerId === "elevenlabs" ? "remaining-characters" : "remaining-tokens",
        coverageKind: "evergreen",
        value: 10,
      });
      const sourceFetch = vi.fn(() => ({
        ok: true,
        snapshot,
      }) as const);

      const schedulerResult = await buildSourceGatedBalanceSchedulerOutput({
        actionSettings,
        sourceFetch,
      });

      expect(sourceFetch).toHaveBeenCalledOnce();
      expect(schedulerResult).toMatchObject({
        displayState: "fresh",
        snapshot,
      });
    }
  });

  it("executes Anthropic and Tavily implemented Balance source fetches", async () => {
    for (const providerId of ["anthropic-api", "tavily"] as const) {
      const actionSettings = balanceSettings(providerId);
      const snapshot = balanceSnapshot({
        providerId,
        metricKind: providerId === "anthropic-api" ? "current-month-spend" : "remaining-credits",
        coverageKind: providerId === "anthropic-api" ? "month-to-date" : "evergreen",
        value: 10,
      });
      const sourceFetch = vi.fn(() => ({
        ok: true,
        snapshot,
      }) as const);

      const schedulerResult = await buildSourceGatedBalanceSchedulerOutput({
        actionSettings,
        sourceFetch,
      });

      expect(sourceFetch).toHaveBeenCalledOnce();
      expect(schedulerResult).toMatchObject({
        displayState: "fresh",
        snapshot,
      });
    }
  });
});

describe("Balance renderer integration through display boundary", () => {
  it("formats Speechmatics decimal hours as minutes below one hour and hours:minutes at one hour or more", () => {
    const actionSettings = balanceSettings("speechmatics", "current-period");

    expect(
      buildBalanceRendererInput({
        actionSettings,
        schedulerOutput: schedulerOutput(
          actionSettings,
          balanceSnapshot({
            providerId: "speechmatics",
            metricKind: "used-time",
            coverageKind: "current-period",
            value: 0.8,
          }),
        ),
      }),
    ).toMatchObject({
      valueText: "48 min",
      valueLabel: "used",
      coverageMarker: "current period",
      displayBasis: "used-value",
      severity: "not-evaluated",
      rendererSeverityState: "normal",
    });

    expect(
      buildBalanceRendererInput({
        actionSettings,
        schedulerOutput: schedulerOutput(
          actionSettings,
          balanceSnapshot({
            providerId: "speechmatics",
            metricKind: "used-time",
            coverageKind: "current-period",
            value: 1.6,
          }),
        ),
      }),
    ).toMatchObject({
      valueText: "1:36",
      valueLabel: "used",
      coverageMarker: "current period",
    });
  });

  it("uses current-month coverage and upper-bound spend severity for OpenAI and Exa spend snapshots", () => {
    const thresholds: SeverityThresholdSet = {
      direction: "upper-bound",
      basis: "absolute",
      warningAt: 20,
      criticalAt: 40,
    };

    for (const providerId of ["openai-api", "exa"] as const) {
      const actionSettings = balanceSettings(providerId, "month-to-date");

      expect(
        buildBalanceRendererInput({
          actionSettings,
          thresholds,
          schedulerOutput: schedulerOutput(
            actionSettings,
            balanceSnapshot({
              providerId,
              metricKind: "current-month-spend",
              coverageKind: "month-to-date",
              value: 25,
            }),
          ),
        }),
      ).toMatchObject({
        valueText: "$25.00",
        valueLabel: "spent",
        coverageMarker: "current month",
        displayBasis: "current-period-value",
        displayValue: 25,
        severityBasisValue: 25,
        severity: "warning",
        rendererSeverityState: "warning",
      });
    }
  });

  it("renders Runpod as current-period spend and never as remaining balance", () => {
    const actionSettings = balanceSettings("runpod", "current-period");
    const displayInput = buildBalanceRendererInput({
      actionSettings,
      schedulerOutput: schedulerOutput(
        actionSettings,
        balanceSnapshot({
          providerId: "runpod",
          metricKind: "current-period-spend",
          coverageKind: "current-period",
          value: 12.5,
        }),
      ),
    });

    expect(displayInput).toMatchObject({
      valueText: "$12.50",
      valueLabel: "spent",
      coverageMarker: "current period",
      displayBasis: "current-period-value",
      unit: "money",
    });
    expect(displayInput.valueLabel).not.toBe("remaining");
  });
});
