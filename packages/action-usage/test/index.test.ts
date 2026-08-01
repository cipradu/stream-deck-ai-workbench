import { describe, expect, it, vi } from "vitest";

import {
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  USAGE_WINDOW_IDS,
  serializeSchedulerKey,
  type NormalizedSnapshot,
  type SchedulerKeyParts,
  type SeverityThresholdSet,
  type UsageProviderId,
  type UsageWindowId,
} from "../../contracts/src/index.js";
import type { SchedulerOutput } from "../../scheduler/src/index.js";
import type { NormalizedActionSettingsView } from "../../settings/src/index.js";
import {
  buildSourceGatedUsageSchedulerOutput,
  buildUsageRendererInput,
  listUsageProviderOptions,
  packageName,
  resolveUsageProviderOption,
} from "../src/index.js";

function usageSettings(
  providerId: UsageProviderId,
  windowOrPeriod: UsageWindowId,
  usageDisplayMode: "used" | "remaining" = "used",
): NormalizedActionSettingsView {
  const schedulerKeyParts: SchedulerKeyParts = {
    familyId: "usage",
    providerId,
    windowOrPeriod,
    credentialProfileId: "none",
  };

  return {
    familyId: "usage",
    providerId,
    refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
    displayPreferences: { usageDisplayMode },
    windowOrPeriod,
    schedulerKeyParts,
    schedulerKey: serializeSchedulerKey(schedulerKeyParts),
  };
}

function usageSnapshot(providerId: UsageProviderId, window: UsageWindowId, value: number): NormalizedSnapshot {
  return {
    familyId: "usage",
    providerId,
    metricKind: "usage-percent",
    metricDirection: "upper-bound",
    unit: "percent",
    coverage: { kind: "rolling-window", window },
    value,
    fetchedAtEpochMs: 1_000,
  };
}

describe("@ai-workbench/action-usage public surface", () => {
  it("exposes Usage action-family orchestration exports", () => {
    expect(packageName).toBe("@ai-workbench/action-usage");
    expect(typeof listUsageProviderOptions).toBe("function");
    expect(typeof resolveUsageProviderOption).toBe("function");
    expect(typeof buildSourceGatedUsageSchedulerOutput).toBe("function");
    expect(typeof buildUsageRendererInput).toBe("function");
  });
});

describe("Usage catalog and source gates", () => {
  it("lists every Usage provider from registry metadata with supported windows and gates", () => {
    const options = listUsageProviderOptions();

    expect(options.map((option) => option.providerId)).toEqual(["claude-code", "codex", "kimi-code", "zai-coding-plan", "minimax"]);
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "claude-code",
        productLabel: "Claude Code",
        supportedWindows: ["five-hour", "seven-day", "fable", "credit-spend"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
        credentialClasses: ["local-read-only-source"],
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "codex",
        productLabel: "Codex",
        supportedWindows: ["five-hour", "seven-day", "credits", "resets"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
        credentialClasses: ["local-read-only-source"],
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "kimi-code",
        productLabel: "Kimi Code",
        supportedWindows: ["five-hour", "seven-day", "extra-usage"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
        credentialClasses: ["local-read-only-source"],
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "zai-coding-plan",
        productLabel: "Z.AI",
        supportedWindows: ["five-hour", "monthly-mcp"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
        credentialClasses: ["plugin-api-key"],
      }),
    );
    expect(options).toContainEqual(
      expect.objectContaining({
        providerId: "minimax",
        productLabel: "MiniMax",
        supportedWindows: ["five-hour", "seven-day"],
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        selectionEligible: true,
        credentialClasses: ["plugin-api-key"],
      }),
    );
  });

  it("recognizes every contract Usage window through the scheduler source gate", async () => {
    for (const windowOrPeriod of USAGE_WINDOW_IDS) {
      const option = listUsageProviderOptions().find((candidate) => candidate.supportedWindows.includes(windowOrPeriod));
      expect(option).toBeDefined();
      if (option === undefined) {
        continue;
      }

      const schedulerOutput = await buildSourceGatedUsageSchedulerOutput({
        actionSettings: usageSettings(option.providerId, windowOrPeriod),
      });

      expect(schedulerOutput.failure?.provider?.reasonCode).not.toBe("usage-window-missing");
    }
  });

  it("gates a hidden usage window (z.ai seven-day) as unsupported-usage-window", async () => {
    // z.ai's registry supportedWindows no longer include seven-day (weekly hidden), so the
    // source gate must reject a seven-day request for z.ai even though seven-day is still a
    // valid global window id that claude-code/codex use — bidirectional lockstep with the hide.
    const schedulerOutput = await buildSourceGatedUsageSchedulerOutput({
      actionSettings: usageSettings("zai-coding-plan", "seven-day"),
    });

    expect(schedulerOutput.failure?.provider?.reasonCode).toBe("unsupported-usage-window");
  });

  it("validates Usage windows without inventing unsupported periods", () => {
    expect(resolveUsageProviderOption({ providerId: "claude-code", windowOrPeriod: "five-hour" })).toMatchObject({
      ok: true,
      value: {
        providerId: "claude-code",
        windowOrPeriod: "five-hour",
      },
    });
    expect(resolveUsageProviderOption({ providerId: "codex", windowOrPeriod: "seven-day" })).toMatchObject({
      ok: true,
      value: {
        providerId: "codex",
        windowOrPeriod: "seven-day",
      },
    });
    expect(resolveUsageProviderOption({ providerId: "zai-coding-plan", windowOrPeriod: "monthly-mcp" })).toMatchObject({
      ok: true,
      value: {
        providerId: "zai-coding-plan",
        windowOrPeriod: "monthly-mcp",
      },
    });

    const unsupported = resolveUsageProviderOption({ providerId: "claude-code", windowOrPeriod: "monthly-mcp" });

    expect(unsupported).toMatchObject({
      ok: false,
      failure: {
        category: "unsupported-capability",
        displayState: "unsupported-capability",
        retryClass: "no-retry",
        provider: {
          failureClass: "unsupported",
          reasonCode: "unsupported-usage-window",
        },
      },
    });
  });
});

describe("source-gated Usage scheduler and display output", () => {
  it("passes Claude Code and Codex local-source snapshots through the scheduler output", async () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      const actionSettings = usageSettings(providerId, "five-hour");
      const snapshot = usageSnapshot(providerId, "five-hour", 42);
      const sourceFetch = vi.fn(() => ({
        ok: true,
        snapshot,
      }) as const);

      const schedulerOutput = await buildSourceGatedUsageSchedulerOutput({
        actionSettings,
        sourceFetch,
      });
      const displayInput = buildUsageRendererInput({ actionSettings, schedulerOutput });

      expect(sourceFetch).toHaveBeenCalledOnce();
      expect(schedulerOutput).toMatchObject({
        schedulerKey: actionSettings.schedulerKey,
        displayState: "fresh",
        refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
        activeRefCount: 1,
        inFlight: false,
        snapshot,
      });
      expect(displayInput.valueText).toBe("42%");
      expect(displayInput.progressPercent).toBe(42);
    }
  });

  it("passes z.ai monthly MCP source snapshots through the scheduler output without fake defaults", async () => {
    const actionSettings = usageSettings("zai-coding-plan", "monthly-mcp");
    const snapshot = usageSnapshot("zai-coding-plan", "monthly-mcp", 24);
    const sourceFetch = vi.fn(() => ({
      ok: true,
      snapshot,
    }) as const);

    const schedulerOutput = await buildSourceGatedUsageSchedulerOutput({
      actionSettings,
      sourceFetch,
    });
    const displayInput = buildUsageRendererInput({ actionSettings, schedulerOutput });

    expect(sourceFetch).toHaveBeenCalledOnce();
    expect(schedulerOutput).toMatchObject({
      displayState: "fresh",
      snapshot,
    });
    expect(displayInput.valueText).toBe("24%");
    expect(displayInput.progressPercent).toBe(24);
  });

  it("passes trusted Usage scheduler snapshots through the display boundary so remaining center value does not alter percent-used progress or severity", () => {
    const actionSettings = usageSettings("claude-code", "five-hour", "remaining");
    const thresholds: SeverityThresholdSet = {
      direction: "upper-bound",
      basis: "percent",
      warningAt: 70,
      criticalAt: 90,
    };
    const schedulerOutput: SchedulerOutput = {
      schedulerKey: actionSettings.schedulerKey,
      displayState: "fresh",
      refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
      activeRefCount: 1,
      inFlight: false,
      snapshot: usageSnapshot("claude-code", "five-hour", 75),
    };

    expect(buildUsageRendererInput({ actionSettings, schedulerOutput, thresholds })).toMatchObject({
      valueText: "25%",
      valueLabel: "remaining",
      displayValue: 25,
      progressPercent: 75,
      severityBasisValue: 75,
      severity: "warning",
      rendererSeverityState: "warning",
      displayState: "fresh",
      freshness: "fresh",
    });
  });
});
