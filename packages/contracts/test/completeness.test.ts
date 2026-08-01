import { describe, expect, it } from "vitest";

import {
  ACTION_FAMILY_IDS,
  BALANCE_METRIC_KINDS,
  BALANCE_PROVIDER_IDS,
  COVERAGE_KINDS,
  CREDENTIAL_CLASSES,
  DISPLAY_STATES,
  DISPLAY_UNITS,
  ERROR_CATEGORIES,
  IMPLEMENTATION_STATUSES,
  METRIC_DIRECTIONS,
  METRIC_KINDS,
  PROVIDER_IDS,
  RETRY_CLASSES,
  SEVERITY_LEVELS,
  SEVERITY_STATES,
  USAGE_METRIC_KINDS,
  USAGE_PROVIDER_IDS,
  USAGE_WINDOW_IDS,
} from "../src/index.js";
import type { ActionFamilyCapabilityShapes, ActionFamilyId, ActionFamilySnapshotShapes } from "../src/index.js";

/** Exact-membership guards for every spec-required const union. */

function asSortedSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

describe("action families", () => {
  it("contains exactly the two first action families", () => {
    expect(asSortedSet(ACTION_FAMILY_IDS)).toEqual(["balance", "usage"]);
    expect(ACTION_FAMILY_IDS).toHaveLength(2);
  });
});

describe("provider identifiers", () => {
  it("contains exactly the four usage provider ids", () => {
    expect(asSortedSet(USAGE_PROVIDER_IDS)).toEqual(["claude-code", "codex", "kimi-code", "minimax", "zai-coding-plan"]);
    expect(USAGE_PROVIDER_IDS).toHaveLength(5);
  });

  it("contains exactly the twelve balance provider ids", () => {
    expect(asSortedSet(BALANCE_PROVIDER_IDS)).toEqual([
      "anthropic-api",
      "deepgram",
      "deepseek",
      "elevenlabs",
      "exa",
      "fal",
      "jina",
      "moonshot",
      "openai-api",
      "runpod",
      "speechmatics",
      "tavily",
    ]);
    expect(BALANCE_PROVIDER_IDS).toHaveLength(12);
  });

  it("exposes all seventeen catalog providers with no duplicates", () => {
    expect(asSortedSet(PROVIDER_IDS)).toEqual(asSortedSet([...USAGE_PROVIDER_IDS, ...BALANCE_PROVIDER_IDS]));
    expect(PROVIDER_IDS).toHaveLength(17);
    expect(new Set(PROVIDER_IDS).size).toBe(17);
  });
});

describe("credential classes", () => {
  it("contains exactly the five distinct credential classes plus none", () => {
    expect(asSortedSet(CREDENTIAL_CLASSES)).toEqual([
      "admin-api-credential",
      "local-read-only-source",
      "mcp-mediated-source",
      "none",
      "plugin-api-key",
      "sensitive-routing-selector",
    ]);
    expect(CREDENTIAL_CLASSES).toHaveLength(6);
  });
});

describe("metric model", () => {
  it("contains exactly the eleven metric kinds", () => {
    expect(asSortedSet(METRIC_KINDS)).toEqual([
      "current-month-spend",
      "current-period-spend",
      "remaining-balance",
      "remaining-characters",
      "remaining-credits",
      "remaining-tokens",
      "usage-credits",
      "usage-percent",
      "usage-resets",
      "usage-spend",
      "used-time",
    ]);
    expect(METRIC_KINDS).toHaveLength(11);
  });

  it("splits metric kinds by family without overlap", () => {
    expect(asSortedSet(METRIC_KINDS)).toEqual(asSortedSet([...USAGE_METRIC_KINDS, ...BALANCE_METRIC_KINDS]));
    expect(USAGE_METRIC_KINDS.length + BALANCE_METRIC_KINDS.length).toBe(METRIC_KINDS.length);
  });

  it("contains exactly the three metric directions", () => {
    expect(asSortedSet(METRIC_DIRECTIONS)).toEqual(["lower-bound", "none", "upper-bound"]);
  });

  it("contains exactly the display units for the first catalog", () => {
    expect(asSortedSet(DISPLAY_UNITS)).toEqual([
      "characters",
      "count",
      "credits",
      "duration-hours",
      "money",
      "percent",
      "tokens",
    ]);
  });

  it("contains exactly the usage windows and coverage kinds", () => {
    expect(asSortedSet(USAGE_WINDOW_IDS)).toEqual([
      "credit-spend",
      "credits",
      "extra-usage",
      "fable",
      "five-hour",
      "monthly-mcp",
      "resets",
      "seven-day",
    ]);
    expect(asSortedSet(COVERAGE_KINDS)).toEqual(["current-period", "evergreen", "month-to-date", "rolling-window"]);
  });
});

describe("display states (spec Data Concepts)", () => {
  it("contains exactly the fifteen display states", () => {
    expect(asSortedSet(DISPLAY_STATES)).toEqual([
      "fresh",
      "invalid-credentials",
      "missing-credentials",
      "network-failure",
      "no-data-yet",
      "not-implemented",
      "provider-unavailable",
      "rate-limited",
      "settings-invalid",
      "stale",
      "timeout",
      "unauthorized-expired",
      "unknown-sanitized-failure",
      "unsupported-capability",
      "validation-drift",
    ]);
    expect(DISPLAY_STATES).toHaveLength(15);
  });
});

describe("error categories (rules section 11)", () => {
  it("contains exactly the eighteen error categories", () => {
    expect(asSortedSet(ERROR_CATEGORIES)).toEqual([
      "abort",
      "http-status-failure",
      "insufficient-credential-scope",
      "invalid-credentials",
      "missing-credentials",
      "network-failure",
      "no-data-yet",
      "not-implemented",
      "probe-required",
      "provider-unavailable",
      "rate-limited",
      "settings-validation-failure",
      "stale-cached-value",
      "timeout",
      "unauthorized-expired",
      "unknown-sanitized-failure",
      "unsupported-capability",
      "validation-drift",
    ]);
    expect(ERROR_CATEGORIES).toHaveLength(18);
  });
});

describe("retry classes", () => {
  it("contains exactly the seven retry classes", () => {
    expect(asSortedSet(RETRY_CLASSES)).toEqual([
      "credential-settings-refresh",
      "healthy-poll",
      "manual-refresh",
      "no-retry",
      "probe-gated",
      "rate-limit-backoff",
      "transient-retry",
    ]);
    expect(RETRY_CLASSES).toHaveLength(7);
  });
});

describe("severity", () => {
  it("contains exactly the three severity levels plus a distinct not-evaluated state", () => {
    expect(asSortedSet(SEVERITY_LEVELS)).toEqual(["critical", "healthy", "warning"]);
    expect(asSortedSet(SEVERITY_STATES)).toEqual(["critical", "healthy", "not-evaluated", "warning"]);
  });
});

describe("implementation statuses (spec-verbatim terms)", () => {
  it("contains exactly the five implementation statuses", () => {
    expect(asSortedSet(IMPLEMENTATION_STATUSES)).toEqual([
      "docsOnly",
      "implemented",
      "notImplemented",
      "probeRequired",
      "unsupported",
    ]);
    expect(IMPLEMENTATION_STATUSES).toHaveLength(5);
  });
});

/** Type-level guard: the action-family extensibility seam stays keyed by exactly the family ids. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _CapabilitySeamCoversFamilies = AssertTrue<
  MutuallyAssignable<keyof ActionFamilyCapabilityShapes, ActionFamilyId>
>;
type _SnapshotSeamCoversFamilies = AssertTrue<MutuallyAssignable<keyof ActionFamilySnapshotShapes, ActionFamilyId>>;
