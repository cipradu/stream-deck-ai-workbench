import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BALANCE_PROVIDER_IDS,
  ERROR_CATEGORIES,
  USAGE_PROVIDER_IDS,
  type BalanceProviderId,
  type BalanceSnapshot,
  type DisplayState,
  type ErrorCategory,
  type MetricSnapshot,
  type ProviderId,
  type RetryClass,
  type SeverityThresholdSet,
  type StatusSnapshot,
  type UsagePercentSnapshot,
  type UsageProviderId,
} from "../../contracts/src/index.js";
import { findProviderEntry, type ProviderCapabilityMetadata } from "../../provider-registry/src/index.js";
import { describe, expect, it } from "vitest";

import {
  buildRendererInput,
  buildStatusRendererInput,
  evaluateSeverity,
  formatCoverageMarker,
  formatDisplayValue,
  packageName,
  resolveSeverityThresholds,
  usageWindowShortLabel,
} from "../src/index.js";

interface RegistryCapabilityFixture {
  readonly providerId: ProviderId;
  readonly capability: ProviderCapabilityMetadata;
}

type StaleFailureIndicatorCase = readonly [ErrorCategory, DisplayState, RetryClass, string | undefined];

const STALE_FAILURE_INDICATOR_CASES = [
  ["missing-credentials", "missing-credentials", "credential-settings-refresh", "AUTH REQUIRED"],
  ["invalid-credentials", "invalid-credentials", "credential-settings-refresh", "AUTH REQUIRED"],
  ["insufficient-credential-scope", "invalid-credentials", "credential-settings-refresh", "ACCESS DENIED"],
  ["unauthorized-expired", "unauthorized-expired", "credential-settings-refresh", "AUTH REQUIRED"],
  ["rate-limited", "rate-limited", "rate-limit-backoff", "RATE LIMITED"],
  ["timeout", "timeout", "transient-retry", "TIMEOUT"],
  ["abort", "provider-unavailable", "transient-retry", "REFRESH STOPPED"],
  ["network-failure", "network-failure", "transient-retry", "NETWORK ERROR"],
  ["http-status-failure", "provider-unavailable", "transient-retry", "HTTP ERROR"],
  ["provider-unavailable", "provider-unavailable", "transient-retry", "UNAVAILABLE"],
  ["validation-drift", "validation-drift", "rate-limit-backoff", "DATA ERROR"],
  ["unsupported-capability", "unsupported-capability", "no-retry", "UNSUPPORTED"],
  ["no-data-yet", "no-data-yet", "healthy-poll", "NO DATA"],
  ["stale-cached-value", "stale", "healthy-poll", undefined],
  ["not-implemented", "not-implemented", "no-retry", "NOT AVAILABLE"],
  ["probe-required", "not-implemented", "probe-gated", "SETUP REQUIRED"],
  ["settings-validation-failure", "settings-invalid", "credential-settings-refresh", "CHECK SETTINGS"],
  ["unknown-sanitized-failure", "unknown-sanitized-failure", "transient-retry", "REFRESH ERROR"],
] as const satisfies readonly StaleFailureIndicatorCase[];

function registryCapability(providerId: ProviderId): RegistryCapabilityFixture {
  const entry = findProviderEntry(providerId);
  expect(entry).toBeDefined();
  expect(entry?.capabilities).toHaveLength(1);
  return {
    providerId,
    capability: entry?.capabilities[0] as ProviderCapabilityMetadata,
  };
}

function snapshotFor(
  fixture: RegistryCapabilityFixture,
  input: { readonly value: number; readonly fetchedAtEpochMs?: number } = { value: 0 },
): MetricSnapshot {
  const fetchedAtEpochMs = input.fetchedAtEpochMs ?? 1_000;
  if (fixture.capability.actionFamilyId === "usage") {
    if (
      !isUsageProviderId(fixture.providerId) ||
      fixture.capability.metricKind !== "usage-percent" ||
      fixture.capability.metricDirection !== "upper-bound" ||
      fixture.capability.displayUnit !== "percent"
    ) {
      throw new Error(`Expected a Usage percentage capability for ${fixture.providerId}`);
    }
    const coverage = coverageFor(fixture.capability);
    if (coverage.kind !== "rolling-window") {
      throw new Error(`Expected rolling-window Usage coverage for ${fixture.providerId}`);
    }
    const snapshot: UsagePercentSnapshot = {
      familyId: "usage",
      providerId: fixture.providerId,
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      unit: "percent",
      coverage,
      value: input.value,
      fetchedAtEpochMs,
    };
    return snapshot;
  }
  if (fixture.capability.actionFamilyId === "balance" && isBalanceProviderId(fixture.providerId)) {
    const snapshot: BalanceSnapshot = {
      familyId: "balance",
      providerId: fixture.providerId,
      metricKind: fixture.capability.metricKind,
      metricDirection: fixture.capability.metricDirection,
      unit: fixture.capability.displayUnit,
      coverage: coverageFor(fixture.capability),
      value: input.value,
      fetchedAtEpochMs,
    };
    return snapshot;
  }
  throw new Error(`Expected a metric capability for ${fixture.providerId}`);
}

function isUsageProviderId(providerId: ProviderId): providerId is UsageProviderId {
  return USAGE_PROVIDER_IDS.some((candidate) => candidate === providerId);
}

function isBalanceProviderId(providerId: ProviderId): providerId is BalanceProviderId {
  return BALANCE_PROVIDER_IDS.some((candidate) => candidate === providerId);
}

function coverageFor(capability: ProviderCapabilityMetadata): MetricSnapshot["coverage"] {
  if (capability.coverageKind === "rolling-window") {
    return { kind: "rolling-window", window: capability.supportedWindows?.[0] ?? "five-hour" };
  }
  return { kind: capability.coverageKind };
}

function staleFailureIndicatorCaseFor(category: ErrorCategory): StaleFailureIndicatorCase {
  const match = STALE_FAILURE_INDICATOR_CASES.find(([candidate]) => candidate === category);
  if (match === undefined) {
    throw new Error(`Missing stale failure indicator test case for ${category}`);
  }
  return match;
}

function failure(
  category: ErrorCategory = "validation-drift",
  options: {
    readonly boundary?: string;
    readonly httpStatusClass?: "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";
    readonly reasonCode?: string;
    readonly safePublicMessage?: string;
  } = {},
) {
  const [, displayState, retryClass] = staleFailureIndicatorCaseFor(category);
  return {
    category,
    displayState,
    retryClass,
    safePublicMessage:
      options.safePublicMessage ?? (category === "no-data-yet" ? "No provider data is available yet." : "Provider response validation failed."),
    diagnostics: {
      boundary: options.boundary ?? "display-test",
      reasonCode: options.reasonCode ?? (category === "no-data-yet" ? "no-current-data" : "provider-schema-drift"),
      ...(options.httpStatusClass === undefined ? {} : { httpStatusClass: options.httpStatusClass }),
    },
    sanitized: true,
  } as const;
}

describe("@ai-workbench/display public surface", () => {
  it("exposes central display behavior exports", () => {
    expect(packageName).toBe("@ai-workbench/display");
    expect(typeof evaluateSeverity).toBe("function");
    expect(typeof resolveSeverityThresholds).toBe("function");
    expect(typeof formatDisplayValue).toBe("function");
    expect(typeof formatCoverageMarker).toBe("function");
    expect(typeof buildRendererInput).toBe("function");
  });
});

describe("Status renderer input", () => {
  it("builds a positive impact-none snapshot as informational without metric severity", () => {
    const snapshot: StatusSnapshot = {
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 2,
      highestImpact: "none",
      providerStatusIndicator: "none",
      fetchedAtEpochMs: 1_000,
    };

    expect(
      buildStatusRendererInput({
        schedulerOutput: {
          schedulerKey: "status|openai-api||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
        },
        statusDisplayInput: {
          actionFamilyId: "status",
          providerId: "openai-api",
          activeIncidentCount: 2,
          highestImpact: "none",
          providerStatusIndicator: "none",
          tone: "informational",
          valueText: "2",
          fetchedAtEpochMs: 1_000,
        },
        headerLabel: "OpenAI",
      }),
    ).toEqual({
      actionFamilyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 2,
      highestImpact: "none",
      statusDisplayTone: "informational",
      valueText: "2",
      displayState: "fresh",
      stale: false,
      freshness: "fresh",
      fetchedAtEpochMs: 1_000,
      headerLabel: "OpenAI",
    });
    expect(
      buildStatusRendererInput({
        schedulerOutput: {
          schedulerKey: "status|openai-api||none|",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot,
        },
        statusDisplayInput: {
          actionFamilyId: "status",
          providerId: "openai-api",
          activeIncidentCount: 2,
          highestImpact: "none",
          providerStatusIndicator: "none",
          tone: "informational",
          valueText: "2",
          fetchedAtEpochMs: 1_000,
        },
      }),
    ).not.toHaveProperty("providerStatusIndicator");
  });

  it.each([
    ["maintenance", "informational"],
    ["minor", "warning"],
    ["major", "critical"],
    ["critical", "critical"],
  ] as const)("passes aggregate-only %s through as final %s tone without exposing indicator text", (indicator, tone) => {
    const snapshot: StatusSnapshot = {
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 0,
      providerStatusIndicator: indicator,
      fetchedAtEpochMs: 2_000,
    };
    const result = buildStatusRendererInput({
      schedulerOutput: {
        schedulerKey: "status|openai-api||none|",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
      },
      statusDisplayInput: {
        actionFamilyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 0,
        providerStatusIndicator: indicator,
        tone,
        valueText: "0",
        fetchedAtEpochMs: 2_000,
      },
    });

    expect(result).toMatchObject({
      actionFamilyId: "status",
      activeIncidentCount: 0,
      statusDisplayTone: tone,
      valueText: "0",
    });
    expect(result).not.toHaveProperty("providerStatusIndicator");
  });
});

describe("direction-aware severity policy", () => {
  it.each([
    ["usage-percent", "claude-code", 79.99, "healthy"],
    ["usage-percent warning edge", "claude-code", 80, "warning"],
    ["usage-percent critical edge", "claude-code", 90, "critical"],
    ["remaining money warning edge", "fal", 10, "warning"],
    ["remaining money critical edge", "fal", 5, "critical"],
    ["remaining money below critical", "fal", 4.99, "critical"],
    ["current-month spend warning edge", "openai-api", 40, "warning"],
    ["current-month spend critical edge", "openai-api", 50, "critical"],
  ] as const)("computes %s from central registry defaults", (_label, providerId, value, expectedSeverity) => {
    const { capability } = registryCapability(providerId);

    expect(evaluateSeverity({ capability, value }).severity).toBe(expectedSeverity);
  });

  it("computes lower-bound remaining percent from the registry default strategy reference", () => {
    const remainingPercentCapability: ProviderCapabilityMetadata = {
      actionFamilyId: "usage",
      adapterBindingId: "usage.remaining-percent-test",
      implementationStatus: "implemented",
      sourceProofStatus: "docsBacked",
      credentialClasses: ["local-read-only-source"],
      sensitiveSelectorRequirements: [],
      requiredSettings: ["severity-profile-optional"],
      metricKind: "usage-percent",
      metricDirection: "lower-bound",
      displayUnit: "percent",
      displayBasis: "bounded-percentage",
      coverageKind: "rolling-window",
      supportedWindows: ["five-hour"],
      severityStrategy: {
        kind: "registry-default",
        reference: "lower-bound-remaining-percent-default",
      },
    };

    expect(evaluateSeverity({ capability: remainingPercentCapability, value: 20.01 }).severity).toBe("healthy");
    expect(evaluateSeverity({ capability: remainingPercentCapability, value: 20 }).severity).toBe("warning");
    expect(evaluateSeverity({ capability: remainingPercentCapability, value: 10 }).severity).toBe("critical");
  });

  it.each(["jina", "tavily", "elevenlabs", "speechmatics"] as const)(
    "returns not-evaluated and normal renderer tone for %s without a safe default or override",
    (providerId) => {
      const { capability } = registryCapability(providerId);

      const result = evaluateSeverity({ capability, value: 100 });

      expect(resolveSeverityThresholds({ capability }).kind).toBe("not-evaluated");
      expect(result).toMatchObject({
        severity: "not-evaluated",
        rendererSeverityState: "normal",
      });
    },
  );

  it("uses user override thresholds when supplied and preserves lower-bound directionality", () => {
    const { capability } = registryCapability("jina");
    const thresholds: SeverityThresholdSet = {
      direction: "lower-bound",
      basis: "absolute",
      warningAt: 1_000,
      criticalAt: 500,
    };

    expect(evaluateSeverity({ capability, value: 1_001, thresholds }).severity).toBe("healthy");
    expect(evaluateSeverity({ capability, value: 1_000, thresholds }).severity).toBe("warning");
    expect(evaluateSeverity({ capability, value: 500, thresholds }).severity).toBe("critical");
  });

  it("does not evaluate mismatched or directionally invalid override thresholds", () => {
    const { capability } = registryCapability("jina");

    expect(
      evaluateSeverity({
        capability,
        value: 100,
        thresholds: {
          direction: "upper-bound",
          basis: "absolute",
          warningAt: 50,
          criticalAt: 100,
        },
      }),
    ).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
    });

    expect(
      evaluateSeverity({
        capability,
        value: 100,
        thresholds: {
          direction: "lower-bound",
          basis: "absolute",
          warningAt: 50,
          criticalAt: 100,
        },
      }).severity,
    ).toBe("not-evaluated");
  });

  it("does not evaluate override thresholds whose basis does not match the metric value basis", () => {
    const usage = registryCapability("claude-code");
    const fal = registryCapability("fal");
    const absoluteThresholds: SeverityThresholdSet = {
      direction: "upper-bound",
      basis: "absolute",
      warningAt: 10,
      criticalAt: 20,
    };
    const percentThresholds: SeverityThresholdSet = {
      direction: "lower-bound",
      basis: "percent",
      warningAt: 20,
      criticalAt: 10,
    };

    expect(evaluateSeverity({ capability: usage.capability, value: 85, thresholds: absoluteThresholds })).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      thresholdResolution: {
        kind: "not-evaluated",
        reason: "threshold-basis-mismatch",
      },
    });
    expect(
      buildRendererInput({
        schedulerOutput: {
          schedulerKey: "usage:claude-code",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot: snapshotFor(usage, { value: 85 }),
        },
        thresholds: absoluteThresholds,
      }),
    ).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      displayState: "fresh",
    });

    expect(evaluateSeverity({ capability: fal.capability, value: 4, thresholds: percentThresholds })).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      thresholdResolution: {
        kind: "not-evaluated",
        reason: "threshold-basis-mismatch",
      },
    });
    expect(
      buildRendererInput({
        schedulerOutput: {
          schedulerKey: "balance:fal",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot: snapshotFor(fal, { value: 4 }),
        },
        thresholds: percentThresholds,
      }),
    ).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      displayState: "fresh",
    });
  });

  it("requires an explicit value basis when evaluating thresholds without capability metadata", () => {
    const thresholds: SeverityThresholdSet = {
      direction: "upper-bound",
      basis: "percent",
      warningAt: 80,
      criticalAt: 90,
    };

    expect(evaluateSeverity({ metricDirection: "upper-bound", value: 85, thresholds })).toMatchObject({
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      thresholdResolution: {
        kind: "not-evaluated",
        reason: "threshold-basis-mismatch",
      },
    });

    expect(evaluateSeverity({ metricDirection: "upper-bound", valueBasis: "percent", value: 85, thresholds })).toMatchObject({
      severity: "warning",
      rendererSeverityState: "warning",
    });
  });

  it("can evaluate a registry default strategy with explicit direction and value basis", () => {
    expect(
      evaluateSeverity({
        severityStrategy: {
          kind: "registry-default",
          reference: "lower-bound-remaining-percent-default",
        },
        metricDirection: "lower-bound",
        valueBasis: "percent",
        value: 10,
      }),
    ).toMatchObject({
      severity: "critical",
      rendererSeverityState: "critical",
    });
  });
});

describe("display basis, value formatting, and coverage markers", () => {
  it("keeps Usage remaining center display separate from percent-used progress and severity basis", () => {
    const usage = registryCapability("claude-code");
    const thresholds: SeverityThresholdSet = {
      direction: "upper-bound",
      basis: "percent",
      warningAt: 70,
      criticalAt: 90,
    };

    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "usage:claude-code",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(usage, { value: 75 }),
      },
      displayPreferences: { usageDisplayMode: "remaining" },
      thresholds,
    });

    expect(input).toMatchObject({
      valueText: "25%",
      valueLabel: "remaining",
      progressPercent: 75,
      usageWindow: "five-hour",
      severity: "warning",
      rendererSeverityState: "warning",
      stale: false,
      displayState: "fresh",
      severityBasisValue: 75,
      displayValue: 25,
    });
  });

  it("does not invent progress percentages for non-percentage metrics", () => {
    const fal = registryCapability("fal");

    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
      },
    });

    expect(input.valueText).toBe("$4.99");
    expect(input.progressPercent).toBeUndefined();
    expect(input.severity).toBe("critical");
  });

  it("formats period-bound values with safe coverage markers and does not add fake markers to evergreen values", () => {
    const openAi = registryCapability("openai-api");
    const fal = registryCapability("fal");

    expect(formatDisplayValue({ snapshot: snapshotFor(openAi, { value: 40 }), capability: openAi.capability })).toMatchObject({
      valueText: "$40.00",
      valueLabel: "spent",
      coverageMarker: "current month",
    });
    expect(formatDisplayValue({ snapshot: snapshotFor(fal, { value: 10 }), capability: fal.capability })).toMatchObject({
      valueText: "$10.00",
      valueLabel: "remaining",
    });
    expect(formatDisplayValue({ snapshot: snapshotFor(fal, { value: 10 }), capability: fal.capability }).coverageMarker).toBeUndefined();
    expect(formatCoverageMarker({ kind: "current-period" })).toBe("current period");
    expect(formatCoverageMarker({ kind: "rolling-window", window: "seven-day" })).toBe("7-day rolling window");
    // claude-code Fable is a rolling weekly usage-percent window: its own coverage marker + short label.
    expect(formatCoverageMarker({ kind: "rolling-window", window: "fable" })).toBe("weekly Fable window");
    expect(usageWindowShortLabel("fable")).toBe("Fable");
  });

  it.each([
    [0.8, "48 min"],
    [1.6, "1:36"],
  ] as const)("formats Speechmatics decimal hours %s as %s", (value, expectedText) => {
    const speechmatics = registryCapability("speechmatics");

    expect(formatDisplayValue({ snapshot: snapshotFor(speechmatics, { value }), capability: speechmatics.capability })).toMatchObject({
      valueText: expectedText,
      valueLabel: "used",
      coverageMarker: "current period",
    });
  });
});

describe("balance value formatting at 4 significant figures", () => {
  function countValueText(value: number): string {
    const jina = registryCapability("jina"); // remaining-tokens → tokens → count path (no currency symbol)
    return formatDisplayValue({ snapshot: snapshotFor(jina, { value }), capability: jina.capability }).valueText;
  }

  function currencyValueText(value: number): string {
    const fal = registryCapability("fal"); // remaining-balance → money → "$" (USD default)
    return formatDisplayValue({ snapshot: snapshotFor(fal, { value }), capability: fal.capability }).valueText;
  }

  it.each([
    [49_815, "49.82k"],
    [587_767_266, "587.8M"],
    [1_234_567, "1.235M"],
    [12_345, "12.35k"],
    [4_216, "4216"],
    [999, "999"],
    [0, "0"],
    [-49_815, "-49.82k"],
    [1_500_000_000, "1.500B"],
  ] as const)("formats count %d as %s (owner acceptance: 4 sig figs, k/M/B, zero, negative)", (value, expected) => {
    expect(countValueText(value)).toBe(expected);
  });

  it.each([
    [10_000, "10.00k"], // exactly at the abbreviation threshold → abbreviate
    [9_999, "9999"], // just below → natural, 4 sig figs, no thousands separator
    [100_000, "100.0k"],
    [999_999, "1.000M"], // 4-sig-fig round-up rolls the unit up
    [999_999_999, "1.000B"],
  ] as const)("formats count edge %d as %s", (value, expected) => {
    expect(countValueText(value)).toBe(expected);
  });

  it("renders zero and tiny positive counts visibly (never blank)", () => {
    expect(countValueText(0)).toBe("0");
    expect(countValueText(1)).toBe("1");
    expect(countValueText(0.0001)).toMatch(/\d/);
  });

  it.each([
    [17.8, "$17.80"],
    [179.83, "$179.8"],
    [1_234.56, "$1235"],
    [12_345, "$12.35k"],
    [0, "$0.00"],
    [-5.5, "-$5.50"],
  ] as const)("formats currency %d as %s (owner acceptance: 4 sig figs, zero, sign before symbol)", (value, expected) => {
    expect(currencyValueText(value)).toBe(expected);
  });

  it.each([
    [10_000, "$10.00k"], // exactly at the abbreviation threshold → abbreviate
    [9_999, "$9999"], // just below → natural, 4 sig figs, no cents
    [4.99, "$4.99"], // preserves the pre-existing small-currency behavior
    [40, "$40.00"],
  ] as const)("formats currency edge %d as %s", (value, expected) => {
    expect(currencyValueText(value)).toBe(expected);
  });

  it("renders zero and tiny positive currency amounts visibly (never blank)", () => {
    expect(currencyValueText(0)).toBe("$0.00");
    expect(currencyValueText(0.01)).toBe("$0.01");
    expect(currencyValueText(0.0001)).toBe("$0.00"); // rounds to zero cents but stays visible
  });

  it("leaves the Speechmatics used-time format unaffected by the 4-significant-figure change", () => {
    const speechmatics = registryCapability("speechmatics");
    // duration-hours routes to the time formatter, not the count/currency formatter: minutes < 1h, h:mm >= 1h.
    expect(formatDisplayValue({ snapshot: snapshotFor(speechmatics, { value: 0.5 }), capability: speechmatics.capability }).valueText).toBe("30 min");
    expect(formatDisplayValue({ snapshot: snapshotFor(speechmatics, { value: 2.25 }), capability: speechmatics.capability }).valueText).toBe("2:15");
  });

  it("leaves the Usage percentage format unaffected by the 4-significant-figure change", () => {
    const usage = registryCapability("claude-code");
    expect(formatDisplayValue({ snapshot: snapshotFor(usage, { value: 75 }), capability: usage.capability }).valueText).toBe("75%");
  });
});

describe("stale and degraded renderer-safe display inputs", () => {
  it("keeps retained stale snapshots visible with current safe failure context", () => {
    const fal = registryCapability("fal");

    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal",
        displayState: "stale",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
        failure: failure("validation-drift"),
        staleReason: "refresh-failed",
      },
    });

    expect(input).toMatchObject({
      valueText: "$4.99",
      severity: "critical",
      displayState: "stale",
      stale: true,
      freshness: "stale",
      failureContext: {
        category: "validation-drift",
        displayState: "validation-drift",
        retryClass: "rate-limit-backoff",
        reasonCode: "provider-schema-drift",
      },
    });
  });

  it("derives the exact stale failure indicator catalog from retained failure categories", () => {
    const fal = registryCapability("fal");

    expect(STALE_FAILURE_INDICATOR_CASES.map(([category]) => category)).toEqual(ERROR_CATEGORIES);

    for (const [category, _displayState, _retryClass, expectedIndicator] of STALE_FAILURE_INDICATOR_CASES) {
      const input = buildRendererInput({
        schedulerOutput: {
          schedulerKey: `balance:fal:${category}`,
          displayState: "stale",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot: snapshotFor(fal, { value: 4.99 }),
          failure: failure(category),
          staleReason: "refresh-failed",
        },
      });

      expect(input.failureContext?.category).toBe(category);
      expect(input.failureIndicator).toBe(expectedIndicator);
    }
  });

  it.each([
    ["unauthorized-expired", "AUTH REQUIRED"],
    ["insufficient-credential-scope", "ACCESS DENIED"],
    ["rate-limited", "RATE LIMITED"],
  ] as const)("derives the retained HTTP stale indicator for %s from category only", (category, expectedIndicator) => {
    const fal = registryCapability("fal");

    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: `balance:fal:${category}`,
        displayState: "stale",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
        failure: failure(category, {
          httpStatusClass: "5xx",
          reasonCode: "raw-server-says-rate-limited",
          safePublicMessage: "ACCESS DENIED bearer raw-token account_123",
        }),
        staleReason: "refresh-failed",
      },
    });

    expect(input.failureContext).toMatchObject({
      category,
      httpStatusClass: "5xx",
      reasonCode: "raw-server-says-rate-limited",
      safePublicMessage: "ACCESS DENIED bearer raw-token account_123",
    });
    expect(input.failureIndicator).toBe(expectedIndicator);
    expect(input.failureIndicator).not.toBe(input.failureContext?.safePublicMessage);
  });

  it("does not invent stale failure indicators for fresh, age-only, local-fallback, stale-without-failure, or degraded states", () => {
    const fal = registryCapability("fal");

    const fresh = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal:fresh",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
        failure: failure("unauthorized-expired"),
      },
    });
    const ageOnly = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal:age-stale",
        displayState: "stale",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
        failure: failure("stale-cached-value"),
        staleReason: "age-stale",
      },
    });
    const staleWithoutFailure = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal:stale-without-failure",
        displayState: "stale",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: snapshotFor(fal, { value: 4.99 }),
        staleReason: "age-stale",
      },
    });
    const localFallback = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal:local-fallback",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: { ...snapshotFor(fal, { value: 4.99 }), source: "local-fallback" },
      },
    });
    const degraded = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal:degraded",
        displayState: "unauthorized-expired",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        failure: failure("unauthorized-expired"),
      },
    });

    expect(fresh.failureIndicator).toBeUndefined();
    expect(ageOnly.failureIndicator).toBeUndefined();
    expect(staleWithoutFailure.failureIndicator).toBeUndefined();
    expect(localFallback.sourceFallback).toBe(true);
    expect(localFallback.failureIndicator).toBeUndefined();
    expect(degraded.freshness).toBe("degraded");
    expect(degraded.failureIndicator).toBeUndefined();
  });

  it("renders no-snapshot failures as degraded no-data without fabricating value or progress", () => {
    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal",
        displayState: "no-data-yet",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        failure: failure("no-data-yet"),
      },
    });

    expect(input).toMatchObject({
      valueText: "No data",
      severity: "not-evaluated",
      rendererSeverityState: "normal",
      displayState: "no-data-yet",
      stale: false,
      freshness: "degraded",
      failureContext: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        retryClass: "healthy-poll",
        reasonCode: "no-current-data",
      },
    });
    expect(input.progressPercent).toBeUndefined();
    expect(input.displayValue).toBeUndefined();
    expect(input.severityBasisValue).toBeUndefined();
  });

  it("maps a local-fallback snapshot source to sourceFallback for renderer honesty", () => {
    const fal = registryCapability("fal");

    const input = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "balance:fal",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: { ...snapshotFor(fal, { value: 4.99, fetchedAtEpochMs: 1_699_999_000_000 }), source: "local-fallback" },
      },
    });

    expect(input.sourceFallback).toBe(true);
    expect(input.freshness).toBe("fresh");
  });
});

describe("display boundary guards", () => {
  it("keeps display source free of SDK, provider adapter, HTTP/runtime/logging, Effect, and fetch imports", async () => {
    const roots = [
      fileURLToPath(new URL("../src", import.meta.url)),
      fileURLToPath(new URL("../test", import.meta.url)),
    ];
    const files = (
      await Promise.all(
        roots.map(async (root) =>
          (await readdir(root))
            .filter((file) => file.endsWith(".ts"))
            .map((file) => new URL(`${root.endsWith("/") ? root : `${root}/`}${file}`, "file://")),
        ),
      )
    ).flat();
    const packageJson = new URL("../package.json", import.meta.url);
    const source = (await Promise.all([...files, packageJson].map((file) => readFile(file, "utf8")))).join("\n");
    const forbiddenPatterns = [
      ["@elgato", "/", "streamdeck"].join(""),
      ["provider", "-", "adapters"].join(""),
      ["@ai-workbench", "/", "http"].join(""),
      ["@ai-workbench", "/", "runtime-foundation"].join(""),
      ["@ai-workbench", "/", "logging"].join(""),
      ["from\\s+['\"]", "effect", "['\"]"].join(""),
      ["from\\s+['\"]", "@", "effect/"].join(""),
      ["globalThis", "\\.", "fetch"].join(""),
      ["\\bfe", "tch\\("].join(""),
    ];

    for (const pattern of forbiddenPatterns) {
      expect(source).not.toMatch(new RegExp(pattern));
    }
  });
});

describe("Codex credits category display", () => {
  const creditsSnapshot = (value: number): MetricSnapshot => ({
    familyId: "usage",
    providerId: "codex",
    metricKind: "usage-credits",
    metricDirection: "lower-bound",
    unit: "credits",
    coverage: { kind: "evergreen" },
    value,
    fetchedAtEpochMs: 1_000,
  });

  it("abbreviates the credits value with lowercase k / uppercase M, one decimal, dropping a trailing .0", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "0"],
      [25_000, "25k"],
      [25_100, "25.1k"],
      [300, "0.3k"],
      [108_300, "108.3k"],
      [1_200_000, "1.2M"],
    ];
    for (const [value, expected] of cases) {
      expect(formatDisplayValue({ snapshot: creditsSnapshot(value) }).valueText).toBe(expected);
    }
  });

  it("renders the credits snapshot as a remaining-value pool with NO redundant unit row (header already says Credits)", () => {
    const formatted = formatDisplayValue({ snapshot: creditsSnapshot(25_000) });
    expect(formatted).toMatchObject({
      valueText: "25k",
      valueLabel: "remaining",
      unit: "credits",
      displayBasis: "remaining-value",
    });
    // No dim "credits" unit row — the key header already reads "Codex Credits", so it
    // would repeat itself; the amount carries only the "remaining" value label.
    expect(formatted.unitRowText).toBeUndefined();
    // Evergreen coverage carries no coverage marker.
    expect(formatted.coverageMarker).toBeUndefined();
  });

  it("evaluates lower-bound credits floors: none→green, warn-only, critical-only, both", () => {
    const basis = { metricDirection: "lower-bound", valueBasis: "absolute" } as const;

    // No thresholds + no-default (requires-user-profile) strategy: not-evaluated → renders green.
    expect(
      evaluateSeverity({
        ...basis,
        value: 900,
        severityStrategy: { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" },
      }),
    ).toMatchObject({ severity: "not-evaluated", rendererSeverityState: "normal" });

    // Warn-only floor (fires at-or-below 1000): green above, amber at/below.
    const warnOnly: SeverityThresholdSet = { direction: "lower-bound", basis: "absolute", warningAt: 1_000 };
    expect(evaluateSeverity({ ...basis, value: 1_001, thresholds: warnOnly }).severity).toBe("healthy");
    expect(evaluateSeverity({ ...basis, value: 1_000, thresholds: warnOnly }).severity).toBe("warning");

    // Critical-only floor: green above, red at/below.
    const criticalOnly: SeverityThresholdSet = { direction: "lower-bound", basis: "absolute", criticalAt: 500 };
    expect(evaluateSeverity({ ...basis, value: 501, thresholds: criticalOnly }).severity).toBe("healthy");
    expect(evaluateSeverity({ ...basis, value: 500, thresholds: criticalOnly }).severity).toBe("critical");

    // Both floors: green / amber / red across the bands (lower-bound requires warningAt >= criticalAt).
    const both: SeverityThresholdSet = { direction: "lower-bound", basis: "absolute", warningAt: 1_000, criticalAt: 500 };
    expect(evaluateSeverity({ ...basis, value: 1_001, thresholds: both }).severity).toBe("healthy");
    expect(evaluateSeverity({ ...basis, value: 900, thresholds: both }).severity).toBe("warning");
    expect(evaluateSeverity({ ...basis, value: 500, thresholds: both }).severity).toBe("critical");
  });

  it("colors the credits key by the lower-bound floor via buildRendererInput (integration)", () => {
    const rendered = buildRendererInput({
      schedulerOutput: {
        schedulerKey: "usage:codex:credits",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot: creditsSnapshot(400),
      },
      actionFamilyId: "usage",
      providerId: "codex",
      severityStrategy: { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" },
      thresholds: { direction: "lower-bound", basis: "absolute", warningAt: 1_000, criticalAt: 500 },
    });

    // 400 is at/below the 500 critical floor → red, and the abbreviated value has no gauge (no progressPercent).
    expect(rendered).toMatchObject({ valueText: "0.4k", rendererSeverityState: "critical", severity: "critical" });
    expect(rendered.progressPercent).toBeUndefined();
  });
});

describe("Codex resets category display", () => {
  const resetsSnapshot = (value: number, resetsAtEpochMs?: number): MetricSnapshot => ({
    familyId: "usage",
    providerId: "codex",
    metricKind: "usage-resets",
    metricDirection: "lower-bound",
    unit: "count",
    coverage: { kind: "evergreen" },
    value,
    fetchedAtEpochMs: 1_000,
    ...(resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs }),
  });

  const MS_PER_DAY = 86_400_000;
  // A resets snapshot whose earliest-expiry sits exactly `days` of runway ahead of the fetch instant,
  // so the derived days-to-expiry severity basis equals `days` (integer ms keeps the edges exact).
  const resetsSnapshotInDays = (count: number, days: number): MetricSnapshot =>
    resetsSnapshot(count, 1_000 + Math.round(days * MS_PER_DAY));
  // The Codex resets registry default: lower-bound on the days runway, warn 7 / crit 3 (owned by
  // DEFAULT_SEVERITY_THRESHOLDS). Applied unless a user PI floor (in days) overrides it.
  const RESETS_DEFAULT_STRATEGY = { kind: "registry-default", reference: "lower-bound-resets-days-default" } as const;
  const renderResets = (snapshot: MetricSnapshot, thresholds?: SeverityThresholdSet) =>
    buildRendererInput({
      schedulerOutput: {
        schedulerKey: "usage:codex:resets",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
      },
      actionFamilyId: "usage",
      providerId: "codex",
      severityStrategy: RESETS_DEFAULT_STRATEGY,
      ...(thresholds === undefined ? {} : { thresholds }),
    });

  it("renders the available count as a plain integer (no separator, no k/M abbreviation)", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "0"],
      [1, "1"],
      [2, "2"],
    ];
    for (const [value, expected] of cases) {
      expect(formatDisplayValue({ snapshot: resetsSnapshot(value) }).valueText).toBe(expected);
    }
  });

  it("renders the resets snapshot as a lower-bound remaining count with NO unit-word row and no gauge", () => {
    const formatted = formatDisplayValue({ snapshot: resetsSnapshot(2) });
    expect(formatted).toMatchObject({
      valueText: "2",
      valueLabel: "available",
      unit: "count",
      displayBasis: "remaining-value",
    });
    // No dim unit-word row (the header already reads "Codex · Resets"), no evergreen coverage marker,
    // and no progressPercent (routes through the balance-style body, so the key shows no gauge).
    expect(formatted.unitRowText).toBeUndefined();
    expect(formatted.coverageMarker).toBeUndefined();
    expect(formatted.progressPercent).toBeUndefined();
  });

  it("keeps the count as the displayValue while days-to-expiry drives the severity basis (the seam)", () => {
    // 6 days of runway, 2 available resets: the shown/tinted number is the COUNT (2), the severity is
    // judged on the DAYS (6) — displayValue vs severityBasisValue are deliberately different quantities.
    const formatted = formatDisplayValue({ snapshot: resetsSnapshotInDays(2, 6) });
    expect(formatted.displayValue).toBe(2);
    expect(formatted.valueText).toBe("2");
    expect(formatted.severityBasisValue).toBe(6);
  });

  it("derives the days-to-expiry basis from resetsAtEpochMs − fetchedAtEpochMs, clamps to >= 0, and is NaN with no expiry", () => {
    // Exactly 5 days of runway → basis 5 (the fetchedAtEpochMs Clock seam is the reference instant).
    expect(formatDisplayValue({ snapshot: resetsSnapshotInDays(1, 5) }).severityBasisValue).toBe(5);
    // Defensive clamp: a (drifted) past expiry never yields a negative basis.
    expect(formatDisplayValue({ snapshot: resetsSnapshot(1, 1_000 - 3 * MS_PER_DAY) }).severityBasisValue).toBe(0);
    // No upcoming expiry → NaN basis (→ engine not-evaluated), for count 0 and a positive count alike.
    expect(formatDisplayValue({ snapshot: resetsSnapshot(0) }).severityBasisValue).toBeNaN();
    expect(formatDisplayValue({ snapshot: resetsSnapshot(2) }).severityBasisValue).toBeNaN();
  });

  it("colors the count by the registry-default 7/3-day thresholds at the at-or-below edges", () => {
    // Fewer days of runway is worse; the COUNT ("2") is the element that carries the tone.
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [10, "normal", "healthy"],
      [7.01, "normal", "healthy"],
      [7, "warning", "warning"],
      [3, "critical", "critical"],
      [2.9, "critical", "critical"],
    ];
    for (const [days, rendererSeverityState, severity] of cases) {
      const rendered = renderResets(resetsSnapshotInDays(2, days));
      expect(rendered.valueText).toBe("2");
      expect(rendered.rendererSeverityState).toBe(rendererSeverityState);
      expect(rendered.severity).toBe(severity);
      // The plain count routes through the balance-style body → no gauge.
      expect(rendered.progressPercent).toBeUndefined();
    }
  });

  it("treats no upcoming expiry as not-evaluated → normal tone even under the registry default (count 0 or positive)", () => {
    for (const [count, text] of [[0, "0"], [2, "2"]] as const) {
      const rendered = renderResets(resetsSnapshot(count));
      expect(rendered).toMatchObject({ valueText: text, severity: "not-evaluated", rendererSeverityState: "normal" });
    }
  });

  it("applies the 7/3-day registry default with no override, and lets a user day-floor override win", () => {
    // 5 days: the registry default (warn 7 / crit 3) → warning.
    expect(renderResets(resetsSnapshotInDays(2, 5))).toMatchObject({ severity: "warning" });
    // Same 5 days, but a user PI floor in days (warn 4 / crit 2) overrides the default → healthy.
    const dayFloor: SeverityThresholdSet = { direction: "lower-bound", basis: "absolute", warningAt: 4, criticalAt: 2 };
    expect(renderResets(resetsSnapshotInDays(2, 5), dayFloor)).toMatchObject({ severity: "healthy", valueText: "2" });
  });
});

describe("Claude Code credit-spend category display", () => {
  const spendActive = (
    percent: number,
    usedMinor: number,
    capMinor: number,
    options?: { readonly currency?: string; readonly exponent?: number; readonly autoReloadOn?: boolean },
  ): MetricSnapshot => {
    const exponent = options?.exponent ?? 2;
    return {
      familyId: "usage",
      providerId: "claude-code",
      metricKind: "usage-spend",
      metricDirection: "upper-bound",
      unit: "money",
      coverage: { kind: "current-period" },
      value: usedMinor / 10 ** exponent,
      fetchedAtEpochMs: 1_000,
      spendState: "active",
      autoReloadOn: options?.autoReloadOn ?? false,
      percent,
      usedMinor,
      capMinor,
      currency: options?.currency ?? "CAD",
      exponent,
    };
  };

  const spendStatus = (spendState: "off" | "out-of-credits", autoReloadOn = false): MetricSnapshot => ({
    familyId: "usage",
    providerId: "claude-code",
    metricKind: "usage-spend",
    metricDirection: "upper-bound",
    unit: "money",
    coverage: { kind: "current-period" },
    value: 0,
    fetchedAtEpochMs: 1_000,
    spendState,
    autoReloadOn,
  });

  const SPEND_STRATEGY = { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" } as const;
  const renderSpend = (snapshot: MetricSnapshot, thresholds?: SeverityThresholdSet) =>
    buildRendererInput({
      schedulerOutput: {
        schedulerKey: "usage:claude-code:credit-spend",
        displayState: "fresh",
        refreshIntervalSeconds: 600,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
      },
      actionFamilyId: "usage",
      providerId: "claude-code",
      severityStrategy: SPEND_STRATEGY,
      ...(thresholds === undefined ? {} : { thresholds }),
    });

  it("shows the percent as the displayValue while the money SPENT drives the severity basis (the seam)", () => {
    // used 350 → $3.50, cap 2500 → $25.00 (minor units + exponent). Plain "$" only, no currency code. The
    // prominent number is the percent (14%), the dim line is the money pair, the severity basis is the $ spent.
    const formatted = formatDisplayValue({ snapshot: spendActive(14, 350, 2500) });
    expect(formatted.valueText).toBe("14%");
    expect(formatted.displayValue).toBe(14);
    expect(formatted.progressPercent).toBe(14);
    expect(formatted.secondaryLine).toBe("$3.50 / $25.00");
    expect(formatted.severityBasisValue).toBe(3.5);
    expect(formatted.statusTone).toBeUndefined();
  });

  it("formats the confirmed $0 / $25 funded-ON state with a plain $ (no currency code) and reuses the exponent for both amounts", () => {
    expect(formatDisplayValue({ snapshot: spendActive(0, 0, 2500) }).secondaryLine).toBe("$0.00 / $25.00");
    // Currency code is dropped entirely: every account renders the same plain "$" prefix.
    expect(formatDisplayValue({ snapshot: spendActive(50, 500, 1000, { currency: "USD" }) }).secondaryLine).toBe("$5.00 / $10.00");
  });

  it("stays green (not-evaluated) until the owner sets thresholds, then colors the gauge by the absolute $ spent (upper-bound)", () => {
    // No thresholds: requires-user-profile → not-evaluated → normal (green) tone, but still a gauge.
    const green = renderSpend(spendActive(50, 1250, 2500));
    expect(green).toMatchObject({ severity: "not-evaluated", rendererSeverityState: "normal" });
    expect(green.progressPercent).toBe(50);

    // User $ thresholds (upper-bound absolute): the gauge tints amber at/above the warn dollars and
    // red at/above the critical dollars — judged on the $ SPENT, not the percent.
    const dollarFloor: SeverityThresholdSet = { direction: "upper-bound", basis: "absolute", warningAt: 10, criticalAt: 20 };
    expect(renderSpend(spendActive(20, 500, 2500), dollarFloor)).toMatchObject({ severity: "healthy", rendererSeverityState: "normal" }); // $5
    expect(renderSpend(spendActive(40, 1000, 2500), dollarFloor)).toMatchObject({ severity: "warning", rendererSeverityState: "warning" }); // $10
    expect(renderSpend(spendActive(80, 2000, 2500), dollarFloor)).toMatchObject({ severity: "critical", rendererSeverityState: "critical" }); // $20
  });

  it("renders off / out-of-credits as neutral status words (no gauge, no money), escalating out-of-credits to critical only when auto-reload is on", () => {
    const off = formatDisplayValue({ snapshot: spendStatus("off") });
    expect(off).toMatchObject({ valueText: "Off", statusTone: "neutral" });
    expect(off.progressPercent).toBeUndefined();
    expect(off.secondaryLine).toBeUndefined();
    expect(off.severityBasisValue).toBeNaN();

    expect(formatDisplayValue({ snapshot: spendStatus("out-of-credits", false) })).toMatchObject({ valueText: "Out", statusTone: "neutral" });
    expect(formatDisplayValue({ snapshot: spendStatus("out-of-credits", true) })).toMatchObject({ valueText: "Out", statusTone: "critical" });
    // Auto-reload on the OFF state does not escalate — only the out-of-credits burn condition does.
    expect(formatDisplayValue({ snapshot: spendStatus("off", true) }).statusTone).toBe("neutral");
  });

  it("flows statusTone through buildRendererInput and keeps off/out severity not-evaluated (never a green healthy tone)", () => {
    const off = renderSpend(spendStatus("off"));
    expect(off).toMatchObject({ valueText: "Off", statusTone: "neutral", severity: "not-evaluated", rendererSeverityState: "normal" });
    expect(off.progressPercent).toBeUndefined();
    expect(renderSpend(spendStatus("out-of-credits", true))).toMatchObject({ valueText: "Out", statusTone: "critical" });
  });

  it("labels the credit-spend window as Credits", () => {
    expect(usageWindowShortLabel("credit-spend")).toBe("Credits");
  });
});

describe("Kimi Code Extra Usage display", () => {
  const kimiSpend = (usedMinor: number): MetricSnapshot => ({
    familyId: "usage",
    providerId: "kimi-code",
    metricKind: "usage-spend",
    metricDirection: "upper-bound",
    unit: "money",
    coverage: { kind: "current-period" },
    value: usedMinor / 100,
    fetchedAtEpochMs: 1_000,
    spendState: "active",
    spendDisplay: "money-used",
    autoReloadOn: false,
    usedMinor,
    currency: "USD",
    exponent: 2,
  });

  const SPEND_STRATEGY = { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" } as const;

  it("shows the dollar amount without a percentage gauge", () => {
    const formatted = formatDisplayValue({ snapshot: kimiSpend(1_250) });

    expect(formatted).toMatchObject({
      valueText: "$12.50",
      valueLabel: "spent",
      displayValue: 12.5,
      severityBasisValue: 12.5,
      coverageMarker: "current period",
    });
    expect(formatted.progressPercent).toBeUndefined();
    expect(formatted.secondaryLine).toBeUndefined();
  });

  it("turns amber and red at or above the configured dollar thresholds", () => {
    const render = (usedMinor: number) =>
      buildRendererInput({
        schedulerOutput: {
          schedulerKey: "usage:kimi-code:extra-usage",
          displayState: "fresh",
          refreshIntervalSeconds: 600,
          activeRefCount: 1,
          inFlight: false,
          snapshot: kimiSpend(usedMinor),
        },
        actionFamilyId: "usage",
        providerId: "kimi-code",
        severityStrategy: SPEND_STRATEGY,
        thresholds: { direction: "upper-bound", basis: "absolute", warningAt: 10, criticalAt: 20 },
      });

    expect(render(999)).toMatchObject({ severity: "healthy", rendererSeverityState: "normal" });
    expect(render(1_000)).toMatchObject({ severity: "warning", rendererSeverityState: "warning" });
    expect(render(2_000)).toMatchObject({ severity: "critical", rendererSeverityState: "critical" });
  });
});
