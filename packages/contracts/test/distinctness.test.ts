import { describe, expect, it } from "vitest";

import { CREDENTIAL_CLASSES, METRIC_KIND_DIRECTION, METRIC_KIND_UNIT, METRIC_KINDS } from "../src/index.js";

describe("credential class distinctness", () => {
  it("keeps every credential class a distinct value", () => {
    expect(new Set(CREDENTIAL_CLASSES).size).toBe(CREDENTIAL_CLASSES.length);
  });

  it("does not collapse credential classes into one generic api-key value", () => {
    // The degenerate pass rejects: one `apiKey`/`api-key` value reused
    // for admin tokens, routing selectors, local sources, and MCP credentials.
    expect(CREDENTIAL_CLASSES).not.toContain("api-key");
    expect(CREDENTIAL_CLASSES).not.toContain("apiKey");
    const nonNone = CREDENTIAL_CLASSES.filter((credentialClass) => credentialClass !== "none");
    expect(nonNone).toHaveLength(5);
    expect(new Set(nonNone).size).toBe(5);
  });
});

describe("metric direction mapping (rules section 15)", () => {
  it("classifies usage, spend, and used-time metrics as upper-bound", () => {
    expect(METRIC_KIND_DIRECTION["usage-percent"]).toBe("upper-bound");
    expect(METRIC_KIND_DIRECTION["current-month-spend"]).toBe("upper-bound");
    expect(METRIC_KIND_DIRECTION["current-period-spend"]).toBe("upper-bound");
    expect(METRIC_KIND_DIRECTION["used-time"]).toBe("upper-bound");
  });

  it("classifies remaining-* metrics as lower-bound", () => {
    expect(METRIC_KIND_DIRECTION["remaining-balance"]).toBe("lower-bound");
    expect(METRIC_KIND_DIRECTION["remaining-credits"]).toBe("lower-bound");
    expect(METRIC_KIND_DIRECTION["remaining-tokens"]).toBe("lower-bound");
    expect(METRIC_KIND_DIRECTION["remaining-characters"]).toBe("lower-bound");
  });

  it("maps every metric kind to a direction and a display unit", () => {
    for (const kind of METRIC_KINDS) {
      expect(METRIC_KIND_DIRECTION[kind]).toBeDefined();
      expect(METRIC_KIND_UNIT[kind]).toBeDefined();
    }
  });

  it("gives money units to spend and balance metrics and specific units to the rest", () => {
    expect(METRIC_KIND_UNIT["usage-percent"]).toBe("percent");
    expect(METRIC_KIND_UNIT["current-month-spend"]).toBe("money");
    expect(METRIC_KIND_UNIT["current-period-spend"]).toBe("money");
    expect(METRIC_KIND_UNIT["remaining-balance"]).toBe("money");
    expect(METRIC_KIND_UNIT["used-time"]).toBe("duration-hours");
    expect(METRIC_KIND_UNIT["remaining-credits"]).toBe("credits");
    expect(METRIC_KIND_UNIT["remaining-tokens"]).toBe("tokens");
    expect(METRIC_KIND_UNIT["remaining-characters"]).toBe("characters");
  });
});
