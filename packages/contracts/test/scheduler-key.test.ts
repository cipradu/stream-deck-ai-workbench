import { describe, expect, it } from "vitest";

import { serializeSchedulerKey } from "../src/index.js";
import type { SchedulerKeyParts } from "../src/index.js";

/**
 * Spec scheduler-key contract: action family + provider id + window/period
 * (optional) + credential/profile reference + metric/source variant
 * (optional), with one canonical, deterministic, collision-free
 * serialization.
 */

const fullParts: SchedulerKeyParts = {
  familyId: "usage",
  providerId: "claude-code",
  windowOrPeriod: "five-hour",
  credentialProfileId: "profile-1",
  metricVariant: "oauth",
};

describe("serializeSchedulerKey", () => {
  it("is deterministic for equal parts", () => {
    expect(serializeSchedulerKey(fullParts)).toBe(serializeSchedulerKey({ ...fullParts }));
  });

  it("includes every part in the canonical key", () => {
    const key = serializeSchedulerKey(fullParts);
    expect(key).toContain("usage");
    expect(key).toContain("claude-code");
    expect(key).toContain("five-hour");
    expect(key).toContain("profile-1");
    expect(key).toContain("oauth");
  });

  it("produces distinct keys when any part differs", () => {
    const variants: readonly SchedulerKeyParts[] = [
      fullParts,
      { ...fullParts, familyId: "balance", providerId: "fal" },
      { ...fullParts, providerId: "codex" },
      { ...fullParts, windowOrPeriod: "seven-day" },
      { ...fullParts, credentialProfileId: "profile-2" },
      { ...fullParts, metricVariant: "session" },
      { familyId: "usage", providerId: "claude-code", credentialProfileId: "profile-1" },
    ];
    const keys = variants.map((parts) => serializeSchedulerKey(parts));
    expect(new Set(keys).size).toBe(variants.length);
  });

  it("cannot be forged through delimiter injection in opaque reference ids", () => {
    const injected = serializeSchedulerKey({
      familyId: "usage",
      providerId: "claude-code",
      credentialProfileId: "profile|five-hour",
    });
    const legitimate = serializeSchedulerKey({
      familyId: "usage",
      providerId: "claude-code",
      windowOrPeriod: "five-hour",
      credentialProfileId: "profile",
    });
    expect(injected).not.toBe(legitimate);
  });

  it("treats absent optional parts consistently", () => {
    const withoutOptionals: SchedulerKeyParts = {
      familyId: "balance",
      providerId: "deepgram",
      credentialProfileId: "profile-1",
    };
    expect(serializeSchedulerKey(withoutOptionals)).toBe(serializeSchedulerKey({ ...withoutOptionals }));
  });

  it("serializes Status through the unchanged five-segment key format", () => {
    expect(
      serializeSchedulerKey({
        familyId: "status",
        providerId: "anthropic-api",
        credentialProfileId: "none",
      }),
    ).toBe("status|anthropic-api||none|");
  });
});
