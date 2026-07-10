import { describe, expect, it } from "vitest";

import {
  BALANCE_PROVIDER_IDS,
  IMPLEMENTATION_STATUSES,
  METRIC_KIND_DIRECTION,
  METRIC_KIND_UNIT,
  USAGE_PROVIDER_IDS,
} from "../../contracts/src/index.js";
import type { ImplementationStatus } from "../../contracts/src/index.js";
import {
  IMPLEMENTATION_STATUS_BEHAVIOR,
  PROVIDER_REGISTRY,
  SEVERITY_STRATEGY_REFERENCES,
  SOURCE_PROOF_STATUSES,
  deriveProviderSelectionOptions,
  findProviderEntry,
  listProviderEntriesForFamily,
  resolveCapabilityMetricForWindow,
} from "../src/index.js";
import type { ProviderRegistryEntry } from "../src/index.js";

function asSortedSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function allCapabilities() {
  return PROVIDER_REGISTRY.flatMap((entry) =>
    entry.capabilities.map((capability) => ({
      providerId: entry.providerId,
      productLabel: entry.productLabel,
      ...capability,
    })),
  );
}

function firstCapability(providerId: string) {
  const entry = findProviderEntry(providerId);
  expect(entry).toBeDefined();
  expect(entry?.capabilities).toHaveLength(1);
  return entry?.capabilities[0];
}

function expectRequiresUserProfileSeverity(providerId: string) {
  expect(firstCapability(providerId)?.severityStrategy).toEqual({
    kind: "requires-user-profile",
    reason: "absolute-threshold-requires-owner-profile",
  });
}

describe("provider registry catalog completeness", () => {
  it("contains exactly the first Usage provider catalog", () => {
    expect(asSortedSet(listProviderEntriesForFamily("usage").map((entry) => entry.providerId))).toEqual(
      asSortedSet(USAGE_PROVIDER_IDS),
    );
  });

  it("contains exactly the first Balance provider catalog", () => {
    expect(asSortedSet(listProviderEntriesForFamily("balance").map((entry) => entry.providerId))).toEqual(
      asSortedSet(BALANCE_PROVIDER_IDS),
    );
  });

  it("keeps each first-catalog provider in one authoritative registry entry", () => {
    const expectedProviderIds = asSortedSet([...USAGE_PROVIDER_IDS, ...BALANCE_PROVIDER_IDS]);
    expect(asSortedSet(PROVIDER_REGISTRY.map((entry) => entry.providerId))).toEqual(expectedProviderIds);
    expect(PROVIDER_REGISTRY).toHaveLength(expectedProviderIds.length);
    expect(new Set(PROVIDER_REGISTRY.map((entry) => entry.providerId)).size).toBe(PROVIDER_REGISTRY.length);
  });
});

describe("provider registry metadata derives shared contract truth", () => {
  it("derives every metric direction and display unit from contract maps", () => {
    for (const capability of allCapabilities()) {
      expect(capability.metricDirection).toBe(METRIC_KIND_DIRECTION[capability.metricKind]);
      expect(capability.displayUnit).toBe(METRIC_KIND_UNIT[capability.metricKind]);
    }
  });

  it("marks every first-catalog provider implemented while preserving proof status metadata", () => {
    const implementedProviderIds = allCapabilities()
      .filter((capability) => capability.implementationStatus === "implemented")
      .map((capability) => capability.providerId);

    expect(asSortedSet(implementedProviderIds)).toEqual(asSortedSet([...USAGE_PROVIDER_IDS, ...BALANCE_PROVIDER_IDS]));

    for (const providerId of ["claude-code", "codex"] as const) {
      const capability = firstCapability(providerId);
      expect(capability?.implementationStatus).toBe("implemented");
      expect(capability?.sourceProofStatus).toBe("probeAccepted");
      expect(capability).not.toHaveProperty("unavailableReason");
    }
  });

  it("covers every implementation status and source-proof status in public behavior maps", () => {
    expect(asSortedSet(Object.keys(IMPLEMENTATION_STATUS_BEHAVIOR))).toEqual(asSortedSet(IMPLEMENTATION_STATUSES));
    expect(asSortedSet(SOURCE_PROOF_STATUSES)).toEqual([
      "decisionGated",
      "docsBacked",
      "notApplicable",
      "probeAccepted",
      "probeRequired",
      "sourceProofRequired",
      "unsupported",
    ]);

    const unavailableStatuses = IMPLEMENTATION_STATUSES.filter((status) => status !== "implemented");
    for (const status of unavailableStatuses) {
      expect(IMPLEMENTATION_STATUS_BEHAVIOR[status].selectionEligible).toBe(false);
      expect(IMPLEMENTATION_STATUS_BEHAVIOR[status].fetchAllowed).toBe(false);
      expect(IMPLEMENTATION_STATUS_BEHAVIOR[status].unavailableDisplayState).toBeDefined();
    }
    expect(IMPLEMENTATION_STATUS_BEHAVIOR.implemented.selectionEligible).toBe(true);
    expect(IMPLEMENTATION_STATUS_BEHAVIOR.implemented.fetchAllowed).toBe(true);
  });

  it("names every built-in severity strategy reference required by the approved defaults", () => {
    expect(asSortedSet(SEVERITY_STRATEGY_REFERENCES)).toEqual([
      "lower-bound-remaining-money-default",
      "lower-bound-remaining-percent-default",
      "lower-bound-resets-days-default",
      "upper-bound-spend-money-default",
      "upper-bound-usage-percent-default",
    ]);
  });
});

describe("Usage provider gates and windows", () => {
  it("models Claude Code and Codex as local-source Usage providers with percentage windows", () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      const capability = firstCapability(providerId);
      expect(capability?.actionFamilyId).toBe("usage");
      expect(capability?.metricKind).toBe("usage-percent");
      expect(capability?.credentialClasses).toEqual(["local-read-only-source"]);
      expect(capability?.implementationStatus).toBe("implemented");
      expect(capability?.sourceProofStatus).toBe("probeAccepted");
    }
    // Claude Code additionally offers the "fable" weekly scoped usage window
    // and the "credit-spend" extra-usage money guard.
    expect(firstCapability("claude-code")?.supportedWindows).toEqual(["five-hour", "seven-day", "fable", "credit-spend"]);
    // Codex additionally offers the evergreen "credits" and "resets"
    // categories.
    expect(firstCapability("codex")?.supportedWindows).toEqual(["five-hour", "seven-day", "credits", "resets"]);
  });

  it("resolves the Codex credits category to a lower-bound usage-credits metric with a no-default severity strategy", () => {
    const capability = firstCapability("codex");
    expect(capability).toBeDefined();
    if (capability === undefined) {
      return;
    }

    expect(resolveCapabilityMetricForWindow(capability, "credits")).toEqual({
      metricKind: "usage-credits",
      metricDirection: "lower-bound",
      displayUnit: "credits",
      displayBasis: "remaining-value",
      coverageKind: "evergreen",
      severityStrategy: { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" },
    });

    // The percentage windows keep the capability default (upper-bound usage-percent, registry default).
    const fiveHour = resolveCapabilityMetricForWindow(capability, "five-hour");
    expect(fiveHour.metricKind).toBe("usage-percent");
    expect(fiveHour.metricDirection).toBe("upper-bound");
    expect(fiveHour.severityStrategy).toEqual({ kind: "registry-default", reference: "upper-bound-usage-percent-default" });

    // Claude Code has no credits category — its credits resolution falls back to the default metric.
    const claudeCode = firstCapability("claude-code");
    expect(claudeCode).toBeDefined();
    if (claudeCode !== undefined) {
      expect(resolveCapabilityMetricForWindow(claudeCode, "credits").metricKind).toBe("usage-percent");
    }
  });

  it("resolves the Codex resets category to a lower-bound usage-resets count metric with the registry-default days-runway severity strategy", () => {
    const capability = firstCapability("codex");
    expect(capability).toBeDefined();
    if (capability === undefined) {
      return;
    }

    // Severity is judged on the reset-credit runway (days), not the count, so — unlike the no-default
    // credits pool — resets ships a registry default keyed to the lower-bound-resets-days threshold set.
    expect(resolveCapabilityMetricForWindow(capability, "resets")).toEqual({
      metricKind: "usage-resets",
      metricDirection: "lower-bound",
      displayUnit: "count",
      displayBasis: "remaining-value",
      coverageKind: "evergreen",
      severityStrategy: { kind: "registry-default", reference: "lower-bound-resets-days-default" },
    });

    // Claude Code has no resets category — its resets resolution falls back to the default metric.
    const claudeCode = firstCapability("claude-code");
    expect(claudeCode).toBeDefined();
    if (claudeCode !== undefined) {
      expect(resolveCapabilityMetricForWindow(claudeCode, "resets").metricKind).toBe("usage-percent");
    }
  });

  it("resolves the claude-code fable category to the default upper-bound usage-percent metric (no override) and offers it only for claude-code", () => {
    const capability = firstCapability("claude-code");
    expect(capability).toBeDefined();
    if (capability === undefined) {
      return;
    }

    // Fable has NO categoryMetrics override — it is a plain rolling weekly usage-percent window, so it
    // resolves to exactly the capability default (identical to the 5h/7d windows).
    expect(resolveCapabilityMetricForWindow(capability, "fable")).toEqual({
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      displayUnit: "percent",
      displayBasis: "bounded-percentage",
      coverageKind: "rolling-window",
      severityStrategy: { kind: "registry-default", reference: "upper-bound-usage-percent-default" },
    });

    // Only Claude Code declares the fable window — codex/z.ai/minimax must not offer it.
    for (const otherUsageProvider of ["codex", "zai-coding-plan", "minimax"] as const) {
      expect(firstCapability(otherUsageProvider)?.supportedWindows?.includes("fable")).not.toBe(true);
    }
  });

  it("resolves the claude-code credit-spend category to an upper-bound usage-spend money metric with a no-default severity strategy, only for claude-code", () => {
    const capability = firstCapability("claude-code");
    expect(capability).toBeDefined();
    if (capability === undefined) {
      return;
    }

    // credit-spend is an UPPER-BOUND money spend guard with current-period coverage and NO registry
    // default (green until the owner sets absolute dollar thresholds) — distinct from the lower-bound
    // Codex credits count pool, and never routes through the percentage default.
    expect(resolveCapabilityMetricForWindow(capability, "credit-spend")).toEqual({
      metricKind: "usage-spend",
      metricDirection: "upper-bound",
      displayUnit: "money",
      displayBasis: "current-period-value",
      coverageKind: "current-period",
      severityStrategy: { kind: "requires-user-profile", reason: "absolute-threshold-requires-owner-profile" },
    });

    // Only Claude Code declares the credit-spend window; the others fall back to the default metric.
    for (const otherUsageProvider of ["codex", "zai-coding-plan", "minimax"] as const) {
      expect(firstCapability(otherUsageProvider)?.supportedWindows?.includes("credit-spend")).not.toBe(true);
      expect(resolveCapabilityMetricForWindow(firstCapability(otherUsageProvider)!, "credit-spend").metricKind).toBe("usage-percent");
    }
  });

  it("models z.ai as probe-accepted direct-key usage for five-hour and monthly MCP windows (weekly hidden — z.ai returns no weekly tier)", () => {
    const capability = firstCapability("zai-coding-plan");
    expect(capability?.actionFamilyId).toBe("usage");
    expect(capability?.supportedWindows).toEqual(["five-hour", "monthly-mcp"]);
    expect(capability?.credentialClasses).toEqual(["plugin-api-key"]);
    expect(capability?.implementationStatus).toBe("implemented");
    expect(capability?.sourceProofStatus).toBe("probeAccepted");
    expect(capability?.openDecision).toBeUndefined();
  });

  it("models MiniMax as probe-accepted keyed usage for the five-hour and seven-day windows on the standard usage-percent default", () => {
    const entry = findProviderEntry("minimax");
    expect(entry?.productLabel).toBe("MiniMax");

    const capability = firstCapability("minimax");
    expect(capability?.actionFamilyId).toBe("usage");
    expect(capability?.supportedWindows).toEqual(["five-hour", "seven-day"]);
    expect(capability?.credentialClasses).toEqual(["plugin-api-key"]);
    expect(capability?.implementationStatus).toBe("implemented");
    expect(capability?.sourceProofStatus).toBe("probeAccepted");
    expect(capability?.categoryMetrics).toBeUndefined();
    expect(capability?.openDecision).toBeUndefined();

    // Both windows resolve to the standard upper-bound usage-percent metric with the shared
    // registry-default severity — identical class to z.ai/Codex percentage windows.
    for (const windowId of ["five-hour", "seven-day"] as const) {
      const metric = resolveCapabilityMetricForWindow(capability!, windowId);
      expect(metric.metricKind).toBe("usage-percent");
      expect(metric.metricDirection).toBe("upper-bound");
      expect(metric.displayUnit).toBe("percent");
      expect(metric.coverageKind).toBe("rolling-window");
      expect(metric.severityStrategy).toEqual({
        kind: "registry-default",
        reference: "upper-bound-usage-percent-default",
      });
    }
  });
});

describe("Balance metric truth matrix", () => {
  it("represents probe-verified Balance provider truth without substituting easier metrics", () => {
    const expected = {
      fal: ["remaining-balance", "evergreen", "probeAccepted"],
      "openai-api": ["current-month-spend", "month-to-date", "probeAccepted"],
      deepgram: ["remaining-balance", "evergreen", "probeAccepted"],
      runpod: ["current-period-spend", "current-period", "probeAccepted"],
      speechmatics: ["used-time", "current-period", "probeAccepted"],
      exa: ["current-month-spend", "month-to-date", "probeAccepted"],
      moonshot: ["remaining-balance", "evergreen", "probeAccepted"],
      deepseek: ["remaining-balance", "evergreen", "probeAccepted"],
    } as const;

    for (const [providerId, [metricKind, coverageKind, sourceProofStatus]] of Object.entries(expected)) {
      const capability = firstCapability(providerId);
      expect(capability?.actionFamilyId).toBe("balance");
      expect(capability?.metricKind).toBe(metricKind);
      expect(capability?.coverageKind).toBe(coverageKind);
      expect(capability?.sourceProofStatus).toBe(sourceProofStatus);
      expect(capability?.implementationStatus).toBe("implemented");
    }
  });

  it("implements Anthropic and Tavily with their researched Balance metric truth", () => {
    for (const providerId of ["anthropic-api", "tavily"] as const) {
      const capability = firstCapability(providerId);

      expect(capability?.actionFamilyId).toBe("balance");
      expect(capability?.implementationStatus).toBe("implemented");
      expect(capability?.sourceProofStatus).toBe("probeAccepted");
    }

    expect(firstCapability("anthropic-api")?.metricKind).toBe("current-month-spend");
    expect(firstCapability("anthropic-api")?.coverageKind).toBe("month-to-date");
    expect(firstCapability("tavily")?.metricKind).toBe("remaining-credits");
    expect(firstCapability("tavily")?.coverageKind).toBe("evergreen");
  });

  it("keeps Runpod as current-period spend/usage only, never remaining balance", () => {
    const capability = firstCapability("runpod");
    expect(capability?.metricKind).toBe("current-period-spend");
    expect(capability?.metricKind).not.toBe("remaining-balance");
    expect(capability?.coverageKind).toBe("current-period");
  });

  it("implements ElevenLabs and keeps Jina marked as probe-sourced", () => {
    expect(firstCapability("elevenlabs")?.metricKind).toBe("remaining-characters");
    expect(firstCapability("elevenlabs")?.implementationStatus).toBe("implemented");
    expect(firstCapability("elevenlabs")?.sourceProofStatus).toBe("probeAccepted");

    expect(firstCapability("jina")?.metricKind).toBe("remaining-tokens");
    expect(firstCapability("jina")?.implementationStatus).toBe("implemented");
    expect(firstCapability("jina")?.sourceProofStatus).toBe("probeAccepted");
  });

  it("does not invent registry severity defaults for absolute non-money units", () => {
    expectRequiresUserProfileSeverity("speechmatics");
    expectRequiresUserProfileSeverity("tavily");
    expectRequiresUserProfileSeverity("elevenlabs");
    expectRequiresUserProfileSeverity("jina");
  });
});

describe("registry-derived provider selection and onboarding", () => {
  const fakeFutureProvider: ProviderRegistryEntry<"future-balance-provider"> = {
    providerId: "future-balance-provider",
    productLabel: "Future Balance Provider",
    capabilities: [
      {
        actionFamilyId: "balance",
        adapterBindingId: "balance.future-provider",
        coverageKind: "evergreen",
        credentialClasses: ["plugin-api-key"],
        displayBasis: "remaining-value",
        displayUnit: "money",
        implementationStatus: "implemented" satisfies ImplementationStatus,
        metricDirection: "lower-bound",
        metricKind: "remaining-balance",
        requiredSettings: ["credential-profile"],
        sensitiveSelectorRequirements: [],
        severityStrategy: {
          kind: "registry-default",
          reference: "lower-bound-remaining-money-default",
        },
        sourceProofStatus: "docsBacked",
      },
    ],
  };

  it("requires both implemented registry metadata and an adapter binding for picker eligibility", () => {
    const registry = [...PROVIDER_REGISTRY, fakeFutureProvider];

    expect(
      deriveProviderSelectionOptions(registry, {
        actionFamilyId: "balance",
        adapterBindings: [],
      }).some((option) => option.providerId === fakeFutureProvider.providerId),
    ).toBe(false);

    expect(
      deriveProviderSelectionOptions(registry, {
        actionFamilyId: "balance",
        adapterBindings: [{ adapterBindingId: "balance.future-provider" }],
      }),
    ).toContainEqual({
      providerId: "future-balance-provider",
      productLabel: "Future Balance Provider",
      actionFamilyId: "balance",
      adapterBindingId: "balance.future-provider",
      implementationStatus: "implemented",
      metricKind: "remaining-balance",
      metricDirection: "lower-bound",
      displayUnit: "money",
    });
  });
});
