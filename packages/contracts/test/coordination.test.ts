import { describe, expect, it } from "vitest";

import {
  DEFAULT_RATE_LIMIT_DOMAIN,
  GOVERNOR_EVENT_IDS,
  GOVERNOR_REASON_CODES,
  serializeRateLimitScope,
  serializeSourceRequestIdentity,
} from "../src/index.js";
import type { RateLimitScopeInput, SourceRequestIdentityInput } from "../src/index.js";

const scope: RateLimitScopeInput = {
  providerId: "claude-code",
  credentialProfileId: "profile-ref-a",
  credentialGeneration: 3,
  rateLimitDomain: DEFAULT_RATE_LIMIT_DOMAIN,
};

const sourceRequest: SourceRequestIdentityInput = {
  rateLimitScope: scope,
  sourceIdentity: "oauth-usage",
  normalizedRequestVariant: "default",
};

const fabricatedSecretLikeValue = "test-secret-value";

function expectExactErrorMessage(operation: () => unknown, expectedMessage: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(expectedMessage);
}

describe("provider request coordination contracts", () => {
  it("keeps the initial conservative policy identifiers explicit and distinct", () => {
    expect(DEFAULT_RATE_LIMIT_DOMAIN).toBe("provider-profile");
    expect(GOVERNOR_REASON_CODES).toEqual(["governor-queue-full"]);
    expect(new Set(GOVERNOR_EVENT_IDS).size).toBe(GOVERNOR_EVENT_IDS.length);
  });

  it("serializes opaque scope inputs as plain data without a source identity", () => {
    expect(JSON.parse(JSON.stringify(scope))).toEqual(scope);
    expect(serializeRateLimitScope(scope)).toBe(serializeRateLimitScope({ ...scope }));
    expect(serializeRateLimitScope(scope)).not.toBe(
      serializeRateLimitScope({ ...scope, credentialProfileId: "profile-ref-b" }),
    );
    expect(serializeRateLimitScope(scope)).not.toBe(
      serializeRateLimitScope({ ...scope, credentialGeneration: 4 }),
    );
  });

  it("keeps source identity and normalized variant separate from the rate-limit scope", () => {
    const sameScopeDifferentSource: SourceRequestIdentityInput = {
      ...sourceRequest,
      sourceIdentity: "usage-summary",
    };
    const sameSourceDifferentVariant: SourceRequestIdentityInput = {
      ...sourceRequest,
      normalizedRequestVariant: "summary",
    };

    expect(serializeRateLimitScope(sourceRequest.rateLimitScope)).toBe(
      serializeRateLimitScope(sameScopeDifferentSource.rateLimitScope),
    );
    expect(serializeSourceRequestIdentity(sourceRequest)).not.toBe(
      serializeSourceRequestIdentity(sameScopeDifferentSource),
    );
    expect(serializeSourceRequestIdentity(sourceRequest)).not.toBe(
      serializeSourceRequestIdentity(sameSourceDifferentVariant),
    );
  });

  it("cannot collide when opaque coordination values contain the serialization delimiter", () => {
    const injected: SourceRequestIdentityInput = {
      rateLimitScope: { ...scope, credentialProfileId: "profile|ref" },
      sourceIdentity: "oauth-usage",
      normalizedRequestVariant: "default",
    };

    expect(serializeSourceRequestIdentity(injected)).not.toBe(serializeSourceRequestIdentity(sourceRequest));
  });

  it.each([
    { ...sourceRequest, sourceIdentity: `${fabricatedSecretLikeValue}_identity` },
    { ...sourceRequest, normalizedRequestVariant: `${fabricatedSecretLikeValue}/variant` },
  ])("rejects an unsafe source identity or normalized request variant", (unsafeRequest) => {
    expectExactErrorMessage(() => serializeSourceRequestIdentity(unsafeRequest), "Invalid source request identity");
  });
});
