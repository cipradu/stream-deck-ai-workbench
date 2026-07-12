import { describe, expect, it } from "vitest";

import { RateLimited, createSanitizedFailure } from "../../errors/src/index.js";
import type { GovernorBlocked } from "../../scheduler/src/index.js";

import { isGovernorBlocked, type AdapterFetchFailure } from "../src/effect-fetch.js";

describe("isGovernorBlocked", () => {
  it("recognizes only a genuine governor block across the adapter and tagged error channels", () => {
    const blocked: GovernorBlocked = {
      _tag: "GovernorBlocked",
      failure: createSanitizedFailure({
        category: "rate-limited",
        diagnostics: { reasonCode: "fixture-governor-blocked" },
      }),
      retryAfterSeconds: 17,
    };
    const adapterFailure: AdapterFetchFailure = {
      failure: createSanitizedFailure({
        category: "rate-limited",
        diagnostics: { reasonCode: "fixture-adapter-rate-limited" },
      }),
      retry: { retryAfterSeconds: 23 },
    };
    const taggedFailure = new RateLimited({
      reasonCode: "fixture-tagged-rate-limited",
      retryAfterSeconds: 31,
    });

    expect(isGovernorBlocked(blocked)).toBe(true);
    expect(isGovernorBlocked(adapterFailure)).toBe(false);
    expect(adapterFailure.retry).toEqual({ retryAfterSeconds: 23 });
    expect(isGovernorBlocked(taggedFailure)).toBe(false);
  });
});
