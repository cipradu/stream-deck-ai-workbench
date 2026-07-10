import { describe, expect, it } from "vitest";

import type {
  ActionSettingsView,
  BalanceSnapshot,
  CredentialProfileReference,
  ErrorRetryability,
  NormalizedSnapshot,
  RendererInput,
  SchedulerKeyParts,
  SeverityProfileReference,
  SeverityThresholdSet,
  SnapshotCoverage,
  UsageSnapshot,
} from "../src/index.js";

/**
 * Every public contract value must survive a JSON round-trip with
 * deep equality (plain, serializable TypeScript; no dates, functions,
 * class instances, or non-JSON values in contract shapes).
 */
function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// Fabricated representative values only (rules section 6: no raw provider payloads).
const usageSnapshot: UsageSnapshot = {
  familyId: "usage",
  providerId: "claude-code",
  metricKind: "usage-percent",
  metricDirection: "upper-bound",
  unit: "percent",
  coverage: { kind: "rolling-window", window: "five-hour" },
  value: 42.5,
  fetchedAtEpochMs: 1_751_700_000_000,
};

const balanceSnapshot: BalanceSnapshot = {
  familyId: "balance",
  providerId: "runpod",
  metricKind: "current-period-spend",
  metricDirection: "upper-bound",
  unit: "money",
  coverage: { kind: "current-period" },
  value: 12.34,
  fetchedAtEpochMs: 1_751_700_000_000,
};

const evergreenBalanceSnapshot: NormalizedSnapshot = {
  familyId: "balance",
  providerId: "fal",
  metricKind: "remaining-balance",
  metricDirection: "lower-bound",
  unit: "money",
  coverage: { kind: "evergreen" },
  value: 25,
  fetchedAtEpochMs: 1_751_700_000_000,
};

const coverageVariants: readonly SnapshotCoverage[] = [
  { kind: "rolling-window", window: "monthly-mcp" },
  { kind: "rolling-window", window: "seven-day" },
  { kind: "month-to-date" },
  { kind: "current-period" },
  { kind: "evergreen" },
];

const credentialProfileRef: CredentialProfileReference = {
  kind: "credential-profile",
  credentialClass: "admin-api-credential",
  profileId: "profile-1",
};

const severityProfileRef: SeverityProfileReference = {
  kind: "severity-profile",
  profileId: "thresholds-1",
};

const thresholds: SeverityThresholdSet = {
  direction: "lower-bound",
  basis: "absolute",
  warningAt: 10,
  criticalAt: 5,
};

const settingsView: ActionSettingsView = {
  familyId: "balance",
  providerId: "tavily",
  refreshIntervalSeconds: 600,
  displayPreferences: {},
  credentialProfileRef,
  severityProfileRef,
};

const usageSettingsView: ActionSettingsView = {
  familyId: "usage",
  providerId: "codex",
  refreshIntervalSeconds: 60,
  displayPreferences: { usageDisplayMode: "remaining" },
};

const schedulerKeyParts: SchedulerKeyParts = {
  familyId: "usage",
  providerId: "zai-coding-plan",
  windowOrPeriod: "monthly-mcp",
  credentialProfileId: "profile-1",
  metricVariant: "mcp",
};

const rendererInput: RendererInput = {
  valueText: "42%",
  severity: "warning",
  displayState: "fresh",
  stale: false,
  progressPercent: 42.5,
};

const degradedRendererInput: RendererInput = {
  valueText: "!",
  severity: "not-evaluated",
  displayState: "rate-limited",
  stale: true,
};

const retryability: ErrorRetryability = {
  category: "rate-limited",
  retryClass: "rate-limit-backoff",
};

describe("contract serializability", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["usage snapshot", usageSnapshot],
    ["balance snapshot", balanceSnapshot],
    ["evergreen balance snapshot", evergreenBalanceSnapshot],
    ["coverage variants", coverageVariants],
    ["credential profile reference", credentialProfileRef],
    ["severity profile reference", severityProfileRef],
    ["severity threshold set", thresholds],
    ["action settings view", settingsView],
    ["usage action settings view", usageSettingsView],
    ["scheduler key parts", schedulerKeyParts],
    ["renderer input", rendererInput],
    ["degraded renderer input", degradedRendererInput],
    ["error retryability", retryability],
  ];

  it.each(cases)("%s survives a JSON round-trip", (_name, value) => {
    expect(roundTrip(value)).toEqual(value);
  });
});
