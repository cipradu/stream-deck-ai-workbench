import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DISPLAY_STATES,
  ERROR_CATEGORIES,
  RETRY_CLASSES,
  type ErrorCategory,
} from "../../contracts/src/index.js";
import * as errorsModule from "../src/index.js";
import {
  Abort,
  ERROR_CATEGORY_DISPLAY_STATE,
  ERROR_CATEGORY_PUBLIC_MESSAGES,
  ERROR_CATEGORY_RETRY_CLASS,
  HttpStatusFailure,
  InsufficientCredentialScope,
  InvalidCredentials,
  MissingCredentials,
  NetworkFailure,
  NoDataYet,
  NotImplemented,
  ProbeRequired,
  ProviderUnavailable,
  RateLimited,
  SettingsValidationFailure,
  StaleCachedValue,
  TAGGED_ERROR_CATEGORY,
  Timeout,
  UnauthorizedExpired,
  UnknownSanitized,
  UnsupportedCapability,
  ValidationDrift,
  catchAllTaggedFailures,
  createSanitizedFailure,
  mapProviderFailure,
  taggedFailureToSanitizedFailure,
  type SanitizedTaggedError,
} from "../src/index.js";

const RAW_NEEDLES = {
  cause: "raw cause detail with fake bearer value",
  providerBody: "raw provider response fragment",
  schemaDiagnostic: "Expected number, actual sensitive input",
} as const;

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

const TAGGED_CAUSE_NEEDLE = "raw internal cause with fake-bearer-token-should-not-leak";

const TAGGED_ERROR_SAMPLES: readonly SanitizedTaggedError[] = [
  new MissingCredentials({ reasonCode: "provider-missing-key" }),
  new InvalidCredentials({ reasonCode: "provider-invalid-key" }),
  new InsufficientCredentialScope({ reasonCode: "provider-insufficient-scope" }),
  new UnauthorizedExpired({ reasonCode: "provider-unauthorized" }),
  new RateLimited({ reasonCode: "provider-rate-limit", retryAfterSeconds: 42 }),
  new Timeout({ reasonCode: "provider-timeout" }),
  new Abort({ reasonCode: "provider-abort" }),
  new NetworkFailure({ reasonCode: "provider-network" }),
  new HttpStatusFailure({ reasonCode: "provider-http-status", statusClass: "4xx" }),
  new ProviderUnavailable({ reasonCode: "provider-unavailable" }),
  new ValidationDrift({ reasonCode: "provider-schema-drift" }),
  new UnsupportedCapability({ reasonCode: "provider-unsupported" }),
  new NoDataYet({ reasonCode: "provider-no-data" }),
  new StaleCachedValue({ reasonCode: "provider-stale" }),
  new NotImplemented({ reasonCode: "provider-not-implemented" }),
  new ProbeRequired({ reasonCode: "provider-probe-required" }),
  new SettingsValidationFailure({ reasonCode: "settings-validation" }),
  new UnknownSanitized({ reasonCode: "provider-unknown" }),
];

describe("@ai-workbench/errors category policy", () => {
  it("maps every accepted error category to a display state and retry class", () => {
    expect(sorted(Object.keys(ERROR_CATEGORY_DISPLAY_STATE))).toEqual(sorted(ERROR_CATEGORIES));
    expect(sorted(Object.keys(ERROR_CATEGORY_RETRY_CLASS))).toEqual(sorted(ERROR_CATEGORIES));

    for (const category of ERROR_CATEGORIES) {
      expect(DISPLAY_STATES).toContain(ERROR_CATEGORY_DISPLAY_STATE[category]);
      expect(RETRY_CLASSES).toContain(ERROR_CATEGORY_RETRY_CLASS[category]);
    }
  });

  it("keeps important category mappings directionally stable for later scheduler/display consumers", () => {
    expect(ERROR_CATEGORY_DISPLAY_STATE["settings-validation-failure"]).toBe("settings-invalid");
    expect(ERROR_CATEGORY_DISPLAY_STATE["stale-cached-value"]).toBe("stale");
    expect(ERROR_CATEGORY_RETRY_CLASS["rate-limited"]).toBe("rate-limit-backoff");
    expect(ERROR_CATEGORY_RETRY_CLASS["validation-drift"]).toBe("rate-limit-backoff");
    expect(ERROR_CATEGORY_RETRY_CLASS.abort).toBe("transient-retry");
    expect(ERROR_CATEGORY_RETRY_CLASS["missing-credentials"]).toBe("credential-settings-refresh");
    expect(ERROR_CATEGORY_DISPLAY_STATE["insufficient-credential-scope"]).toBe("invalid-credentials");
    expect(ERROR_CATEGORY_RETRY_CLASS["insufficient-credential-scope"]).toBe("credential-settings-refresh");
    expect(ERROR_CATEGORY_DISPLAY_STATE["probe-required"]).toBe("not-implemented");
    expect(ERROR_CATEGORY_RETRY_CLASS["probe-required"]).toBe("probe-gated");
    expect(ERROR_CATEGORY_RETRY_CLASS["unknown-sanitized-failure"]).toBe("transient-retry");
    expect(ERROR_CATEGORY_PUBLIC_MESSAGES["insufficient-credential-scope"]).toContain("scope");
    expect(ERROR_CATEGORY_PUBLIC_MESSAGES["probe-required"]).toContain("probe");
  });
});

describe("@ai-workbench/errors sanitized failures", () => {
  it("creates plain sanitized failures without serializing private causes or raw diagnostics", () => {
    const cause = new Error(RAW_NEEDLES.cause);

    const failure = createSanitizedFailure({
      category: "validation-drift",
      diagnostics: {
        boundary: "provider-response",
        fieldPaths: ["balance.remaining"],
        issueCount: 2,
        reasonCode: "provider-schema-drift",
      },
      cause,
    });

    expect(failure).toEqual({
      category: "validation-drift",
      displayState: "validation-drift",
      retryClass: "rate-limit-backoff",
      safePublicMessage: "Provider response validation failed.",
      diagnostics: {
        boundary: "provider-response",
        fieldPaths: ["balance.remaining"],
        issueCount: 2,
        reasonCode: "provider-schema-drift",
      },
      sanitized: true,
    });
    expect(errorsModule).not.toHaveProperty("getPrivateFailureCause");
    expect(Object.keys(failure)).not.toEqual(expect.arrayContaining(["cause", "privateCause", "internalCause"]));

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.providerBody);
    expect(serialized).not.toContain(RAW_NEEDLES.schemaDiagnostic);
  });

  it("normalizes unsafe diagnostic metadata before returning failures", () => {
    const failure = createSanitizedFailure({
      category: "unknown-sanitized-failure",
      diagnostics: {
        boundary: "provider-response",
        fieldPaths: ["provider.token", "", "usage.amount", "usage.amount"],
        httpStatus: 503,
        issueCount: -1,
        reasonCode: "Raw Cause Pretty Output!",
      },
      cause: RAW_NEEDLES.providerBody,
    });

    expect(failure.diagnostics).toEqual({
      boundary: "provider-response",
      fieldPaths: ["provider.token", "usage.amount"],
      httpStatusClass: "5xx",
      issueCount: 0,
      reasonCode: "raw-cause-pretty-output",
    });
    expect(JSON.stringify(failure)).not.toContain(RAW_NEEDLES.providerBody);
  });
});

describe("@ai-workbench/errors provider failure mapping", () => {
  it("maps provider HTTP failures into shared categories without local UI messages", () => {
    const expected: ReadonlyArray<{
      readonly status: number;
      readonly category: ErrorCategory;
    }> = [
      { status: 401, category: "unauthorized-expired" },
      { status: 403, category: "insufficient-credential-scope" },
      { status: 429, category: "rate-limited" },
      { status: 503, category: "provider-unavailable" },
      { status: 418, category: "http-status-failure" },
    ];

    for (const { status, category } of expected) {
      const failure = mapProviderFailure({
        kind: "http-status",
        httpStatus: status,
        providerFailureClass: "http-status",
        reasonCode: "provider-http-status",
        cause: new Error(RAW_NEEDLES.cause),
      });

      expect(failure.category).toBe(category);
      expect(failure.displayState).toBe(ERROR_CATEGORY_DISPLAY_STATE[category]);
      expect(failure.retryClass).toBe(ERROR_CATEGORY_RETRY_CLASS[category]);
      expect(failure.provider).toEqual({
        failureClass: "http-status",
        reasonCode: "provider-http-status",
      });
      expect(failure.safePublicMessage).toBe(ERROR_CATEGORY_PUBLIC_MESSAGES[category]);
      expect(JSON.stringify(failure)).not.toContain(RAW_NEEDLES.cause);
    }
  });

  it("maps non-HTTP provider failures to the central taxonomy", () => {
    expect(mapProviderFailure({ kind: "network", reasonCode: "provider-network" }).category).toBe(
      "network-failure",
    );
    expect(mapProviderFailure({ kind: "timeout", reasonCode: "provider-timeout" }).category).toBe("timeout");
    expect(mapProviderFailure({ kind: "validation", reasonCode: "provider-schema" }).category).toBe(
      "validation-drift",
    );
    expect(mapProviderFailure({ kind: "unsupported", reasonCode: "source-proof-required" }).category).toBe(
      "unsupported-capability",
    );
    expect(mapProviderFailure({ kind: "insufficient-scope", reasonCode: "provider-scope" }).category).toBe(
      "insufficient-credential-scope",
    );
    expect(mapProviderFailure({ kind: "probe-required", reasonCode: "provider-proof-gated" }).category).toBe(
      "probe-required",
    );
  });
});

describe("@ai-workbench/errors tagged error channel", () => {
  it("defines exactly one tagged error per shared error category", () => {
    expect(sorted(TAGGED_ERROR_SAMPLES.map((error) => error._tag))).toEqual(
      sorted(Object.keys(TAGGED_ERROR_CATEGORY)),
    );
    expect(sorted(Object.values(TAGGED_ERROR_CATEGORY))).toEqual(sorted(ERROR_CATEGORIES));
  });

  it("maps every tagged error to the correct plain sanitized failure at the boundary", () => {
    for (const error of TAGGED_ERROR_SAMPLES) {
      const category = TAGGED_ERROR_CATEGORY[error._tag];
      const failure = taggedFailureToSanitizedFailure(error);

      expect(failure.category).toBe(category);
      expect(failure.displayState).toBe(ERROR_CATEGORY_DISPLAY_STATE[category]);
      expect(failure.retryClass).toBe(ERROR_CATEGORY_RETRY_CLASS[category]);
      expect(failure.safePublicMessage).toBe(ERROR_CATEGORY_PUBLIC_MESSAGES[category]);
      expect(failure.diagnostics.reasonCode).toBe(error.reasonCode);
      expect(failure.sanitized).toBe(true);
      expect(DISPLAY_STATES).toContain(failure.displayState);
      expect(RETRY_CLASSES).toContain(failure.retryClass);
    }
  });

  it("surfaces a sanitized HTTP status class in diagnostics", () => {
    const failure = taggedFailureToSanitizedFailure(
      new HttpStatusFailure({ reasonCode: "provider-http-status", statusClass: "5xx" }),
    );

    expect(failure.category).toBe("http-status-failure");
    expect(failure.diagnostics.httpStatusClass).toBe("5xx");
  });

  it("keeps rate-limit retry timing on the internal channel and off the plain contract", () => {
    const error = new RateLimited({ reasonCode: "provider-rate-limit", retryAfterSeconds: 42 });
    expect(error.retryAfterSeconds).toBe(42);

    const failure = taggedFailureToSanitizedFailure(error);

    expect(failure.category).toBe("rate-limited");
    expect(failure.retryClass).toBe("rate-limit-backoff");
    expect(failure.diagnostics).not.toHaveProperty("retryAfterSeconds");
    expect(Object.keys(failure)).not.toContain("retryAfterSeconds");
    expect(JSON.stringify(failure)).not.toContain("42");
  });

  it("attaches a provider failure block only when the tagged error carries a provider class", () => {
    const withProvider = taggedFailureToSanitizedFailure(
      new HttpStatusFailure({
        reasonCode: "provider-http-status",
        statusClass: "5xx",
        providerFailureClass: "http-status",
      }),
    );
    expect(withProvider.provider).toEqual({ failureClass: "http-status", reasonCode: "provider-http-status" });

    const withoutProvider = taggedFailureToSanitizedFailure(new Timeout({ reasonCode: "provider-timeout" }));
    expect(withoutProvider).not.toHaveProperty("provider");
  });

  it("never lets a raw internal cause reach the plain sanitized failure", () => {
    const error = new ValidationDrift({
      reasonCode: "provider-schema-drift",
      boundary: "provider-response",
      fieldPaths: ["balance.remaining"],
      issueCount: 2,
      internalCause: new Error(TAGGED_CAUSE_NEEDLE),
    });

    const failure = taggedFailureToSanitizedFailure(error);

    expect(failure.diagnostics).toEqual({
      boundary: "provider-response",
      fieldPaths: ["balance.remaining"],
      issueCount: 2,
      reasonCode: "provider-schema-drift",
    });
    expect(Object.keys(failure)).not.toEqual(
      expect.arrayContaining(["cause", "internalCause", "privateCause"]),
    );
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(TAGGED_CAUSE_NEEDLE);
    expect(serialized).not.toContain("fake-bearer-token-should-not-leak");
  });
});

describe("@ai-workbench/errors tagged channel catchTags boundary", () => {
  it("recovers every tagged error through the catchTags boundary into its plain failure", () => {
    for (const error of TAGGED_ERROR_SAMPLES) {
      const recovered = Effect.runSync(Effect.flip(catchAllTaggedFailures(Effect.fail(error))));
      expect(recovered).toEqual(taggedFailureToSanitizedFailure(error));
    }
  });

  it("passes successful effects through the catchTags boundary unchanged", () => {
    expect(Effect.runSync(catchAllTaggedFailures(Effect.succeed("ready")))).toBe("ready");
  });

  it("does not leak an internal cause when mapping through the catchTags boundary", () => {
    const effect = Effect.fail(
      new NetworkFailure({ reasonCode: "provider-network", internalCause: new Error(TAGGED_CAUSE_NEEDLE) }),
    );

    const failure = Effect.runSync(Effect.flip(catchAllTaggedFailures(effect)));

    expect(failure.category).toBe("network-failure");
    expect(JSON.stringify(failure)).not.toContain(TAGGED_CAUSE_NEEDLE);
  });

  it("handles the tagged union exhaustively with Effect.catchTags", () => {
    const toTag = (error: SanitizedTaggedError): Effect.Effect<string> =>
      Effect.fail(error).pipe(
        Effect.catchTags({
          MissingCredentials: (failure) => Effect.succeed(failure._tag),
          InvalidCredentials: (failure) => Effect.succeed(failure._tag),
          InsufficientCredentialScope: (failure) => Effect.succeed(failure._tag),
          UnauthorizedExpired: (failure) => Effect.succeed(failure._tag),
          RateLimited: (failure) => Effect.succeed(failure._tag),
          Timeout: (failure) => Effect.succeed(failure._tag),
          Abort: (failure) => Effect.succeed(failure._tag),
          NetworkFailure: (failure) => Effect.succeed(failure._tag),
          HttpStatusFailure: (failure) => Effect.succeed(failure._tag),
          ProviderUnavailable: (failure) => Effect.succeed(failure._tag),
          ValidationDrift: (failure) => Effect.succeed(failure._tag),
          UnsupportedCapability: (failure) => Effect.succeed(failure._tag),
          NoDataYet: (failure) => Effect.succeed(failure._tag),
          StaleCachedValue: (failure) => Effect.succeed(failure._tag),
          NotImplemented: (failure) => Effect.succeed(failure._tag),
          ProbeRequired: (failure) => Effect.succeed(failure._tag),
          SettingsValidationFailure: (failure) => Effect.succeed(failure._tag),
          UnknownSanitized: (failure) => Effect.succeed(failure._tag),
        }),
      );

    for (const error of TAGGED_ERROR_SAMPLES) {
      expect(Effect.runSync(toTag(error))).toBe(error._tag);
    }
  });
});
