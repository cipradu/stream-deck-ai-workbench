import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";

/** Everything public must be exported through src/index.ts. */
describe("@ai-workbench/contracts index surface", () => {
  it("re-exports the contract const unions and helpers", () => {
    expect(contracts.ACTION_FAMILY_IDS).toBeDefined();
    expect(contracts.PROVIDER_IDS).toBeDefined();
    expect(contracts.CREDENTIAL_CLASSES).toBeDefined();
    expect(contracts.METRIC_KINDS).toBeDefined();
    expect(contracts.METRIC_DIRECTIONS).toBeDefined();
    expect(contracts.METRIC_KIND_DIRECTION).toBeDefined();
    expect(contracts.METRIC_KIND_UNIT).toBeDefined();
    expect(contracts.DISPLAY_UNITS).toBeDefined();
    expect(contracts.USAGE_WINDOW_IDS).toBeDefined();
    expect(contracts.COVERAGE_KINDS).toBeDefined();
    expect(contracts.DISPLAY_STATES).toBeDefined();
    expect(contracts.ERROR_CATEGORIES).toBeDefined();
    expect(contracts.RETRY_CLASSES).toBeDefined();
    expect(contracts.SEVERITY_LEVELS).toBeDefined();
    expect(contracts.SEVERITY_STATES).toBeDefined();
    expect(contracts.SEVERITY_THRESHOLD_BASES).toBeDefined();
    expect(contracts.IMPLEMENTATION_STATUSES).toBeDefined();
    expect(contracts.USAGE_DISPLAY_MODES).toBeDefined();
    expect(contracts.REFRESH_INTERVAL_DEFAULT_SECONDS).toBeDefined();
    expect(contracts.REFRESH_INTERVAL_MIN_SECONDS).toBeDefined();
    expect(contracts.REFRESH_INTERVAL_MAX_SECONDS).toBeDefined();
    expect(typeof contracts.serializeSchedulerKey).toBe("function");
  });
});
