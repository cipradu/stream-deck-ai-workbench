import { describe, expect, it } from "vitest";

import {
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  REFRESH_INTERVAL_MAX_SECONDS,
  REFRESH_INTERVAL_MIN_SECONDS,
} from "../src/index.js";

describe("refresh interval constants (spec retry/refresh policy defaults)", () => {
  it("defaults to 600 seconds", () => {
    expect(REFRESH_INTERVAL_DEFAULT_SECONDS).toBe(600);
  });

  it("bounds user-configurable intervals to 60..3600 seconds", () => {
    expect(REFRESH_INTERVAL_MIN_SECONDS).toBe(60);
    expect(REFRESH_INTERVAL_MAX_SECONDS).toBe(3600);
  });

  it("keeps the default inside the allowed bounds", () => {
    expect(REFRESH_INTERVAL_DEFAULT_SECONDS).toBeGreaterThanOrEqual(REFRESH_INTERVAL_MIN_SECONDS);
    expect(REFRESH_INTERVAL_DEFAULT_SECONDS).toBeLessThanOrEqual(REFRESH_INTERVAL_MAX_SECONDS);
  });
});
