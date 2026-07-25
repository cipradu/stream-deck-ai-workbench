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
  RESPONSE_DIAGNOSTIC_CATALOG,
  RESPONSE_DIAGNOSTIC_RECEIVED_TYPES,
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
  getResponseDiagnosticReceivedTypeSelector,
  mapProviderFailure,
  normalizeResponseDiagnostic,
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
const RESPONSE_DIAGNOSTIC_SENTINEL = "fabricated-sensitive-response-diagnostic-sentinel";

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
    expect(ERROR_CATEGORY_PUBLIC_MESSAGES["insufficient-credential-scope"]).toBe(
      "Provider credentials lack the required access or scope. Check access or scope.",
    );
    expect(ERROR_CATEGORY_PUBLIC_MESSAGES["unauthorized-expired"]).toBe(
      "Provider authorization expired or was rejected. Reauthorize or update credentials.",
    );
    expect(ERROR_CATEGORY_PUBLIC_MESSAGES["rate-limited"]).toBe(
      "Provider rate limit is active. Retry follows the current policy.",
    );
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
      httpStatus: 503,
      httpStatusClass: "5xx",
      issueCount: 0,
      reasonCode: "raw-cause-pretty-output",
    });
    expect(JSON.stringify(failure)).not.toContain(RAW_NEEDLES.providerBody);
  });

  it("rejects invalid exact HTTP status diagnostics instead of preserving status metadata", () => {
    for (const httpStatus of [99, 600, Number.NaN, "401"] as const) {
      const failure = createSanitizedFailure({
        category: "http-status-failure",
        diagnostics: {
          httpStatus: httpStatus as never,
          reasonCode: "provider-http-status",
        },
      });

      expect(failure.diagnostics).toEqual({ reasonCode: "provider-http-status" });
      expect(JSON.stringify(failure)).not.toContain(String(httpStatus));
    }
  });
});

describe("@ai-workbench/errors response diagnostic catalog", () => {
  it("owns frozen static selectors only for structural response diagnostic codes", () => {
    const structuralSelectors = {
      "claude-code-usage-root-not-object": [],
      "claude-code-usage-five-hour-not-object": ["five_hour"],
      "claude-code-usage-five-hour-utilization-invalid": ["five_hour", "utilization"],
      "claude-code-usage-five-hour-resets-at-invalid": ["five_hour", "resets_at"],
      "claude-code-usage-seven-day-not-object": ["seven_day"],
      "claude-code-usage-seven-day-utilization-invalid": ["seven_day", "utilization"],
      "claude-code-usage-seven-day-resets-at-invalid": ["seven_day", "resets_at"],
    } as const;

    for (const [code, selector] of Object.entries(structuralSelectors)) {
      const receivedTypeSelector = getResponseDiagnosticReceivedTypeSelector(code);
      expect(receivedTypeSelector).toEqual(selector);
      expect(Object.isFrozen(receivedTypeSelector)).toBe(true);
    }

    for (const code of [
      "response-body-unreadable",
      "response-body-empty",
      "response-body-not-json",
      "response-json-schema-mismatch",
      "unregistered-response-diagnostic",
    ]) {
      expect(getResponseDiagnosticReceivedTypeSelector(code)).toBeUndefined();
    }
    expect(getResponseDiagnosticReceivedTypeSelector({ code: "claude-code-usage-root-not-object" })).toBeUndefined();
  });

  it("normalizes every catalog member with only its fixed expected and permitted received types", () => {
    const permittedReceivedTypes = {
      "claude-code-usage-root-not-object": ["array", "boolean", "null", "number", "string"],
      "claude-code-usage-five-hour-not-object": ["array", "boolean", "null", "number", "string"],
      "claude-code-usage-five-hour-utilization-invalid": ["array", "boolean", "object", "string"],
      "claude-code-usage-five-hour-resets-at-invalid": ["array", "boolean", "null", "number", "object"],
      "claude-code-usage-seven-day-not-object": ["array", "boolean", "null", "number", "string"],
      "claude-code-usage-seven-day-utilization-invalid": ["array", "boolean", "object", "string"],
      "claude-code-usage-seven-day-resets-at-invalid": ["array", "boolean", "null", "number", "object"],
    } as const;

    for (const [code, definition] of Object.entries(RESPONSE_DIAGNOSTIC_CATALOG)) {
      if (definition.expectedType === undefined) {
        expect(normalizeResponseDiagnostic({ code })).toEqual({ code });
        for (const receivedType of RESPONSE_DIAGNOSTIC_RECEIVED_TYPES) {
          expect(normalizeResponseDiagnostic({ code, receivedType })).toBeUndefined();
        }
        continue;
      }

      expect(normalizeResponseDiagnostic({ code })).toBeUndefined();
      const permitted = permittedReceivedTypes[code as keyof typeof permittedReceivedTypes];
      for (const receivedType of RESPONSE_DIAGNOSTIC_RECEIVED_TYPES) {
        if (permitted.includes(receivedType as never)) {
          expect(normalizeResponseDiagnostic({ code, receivedType })).toEqual({
            code,
            expectedType: definition.expectedType,
            receivedType,
          });
        } else {
          expect(normalizeResponseDiagnostic({ code, receivedType })).toBeUndefined();
        }
      }
    }
  });

  it("rejects inherited catalog names and resists catalog mutation", () => {
    for (const inheritedCode of ["toString", "constructor", "__proto__"]) {
      expect(normalizeResponseDiagnostic({ code: inheritedCode })).toBeUndefined();
    }

    expect(Object.isFrozen(RESPONSE_DIAGNOSTIC_CATALOG)).toBe(true);
    expect(Object.isFrozen(RESPONSE_DIAGNOSTIC_CATALOG["claude-code-usage-root-not-object"])).toBe(true);
    expect(
      Object.isFrozen(RESPONSE_DIAGNOSTIC_CATALOG["claude-code-usage-root-not-object"].receivedTypes),
    ).toBe(true);
    expect(
      Reflect.set(
        RESPONSE_DIAGNOSTIC_CATALOG as Record<string, unknown>,
        "response-body-empty",
        { expectedType: "object" },
      ),
    ).toBe(false);
    expect(normalizeResponseDiagnostic({ code: "response-body-empty" })).toEqual({
      code: "response-body-empty",
    });
  });

  it("drops unregistered, malformed, and value-bearing response diagnostic input", () => {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      [],
      { code: "unregistered-response-diagnostic", receivedType: "array" },
      { code: "response-body-empty", expectedType: "object" },
      { code: "claude-code-usage-root-not-object" },
      { code: "claude-code-usage-root-not-object", receivedType: "number-or-null" },
      {
        code: "claude-code-usage-root-not-object",
        expectedType: "object",
        receivedType: "array",
      },
      {
        code: "claude-code-usage-root-not-object",
        receivedType: "array",
        dynamicPath: "root.untrusted",
        explanation: RESPONSE_DIAGNOSTIC_SENTINEL,
        value: RESPONSE_DIAGNOSTIC_SENTINEL,
      },
      { code: RESPONSE_DIAGNOSTIC_SENTINEL, receivedType: "array" },
      { code: 42, receivedType: "array" },
      { code: "claude-code-usage-root-not-object", receivedType: 42 },
    ];

    for (const input of invalidInputs) {
      expect(normalizeResponseDiagnostic(input)).toBeUndefined();
    }
  });

  it("keeps only a normalized response diagnostic on tagged and plain validation failures", () => {
    const tagged = new ValidationDrift({
      reasonCode: "response-schema-invalid",
      fieldPaths: ["dynamic.provider.path", RESPONSE_DIAGNOSTIC_SENTINEL],
      internalCause: new Error(RESPONSE_DIAGNOSTIC_SENTINEL),
      responseDiagnostic: {
        code: "claude-code-usage-root-not-object",
        receivedType: "array",
      },
    });
    const plain = taggedFailureToSanitizedFailure(tagged);
    const serialized = JSON.stringify(tagged) + JSON.stringify(plain);

    expect(tagged).toMatchObject({
      reasonCode: "claude-code-usage-root-not-object",
      responseDiagnostic: {
        code: "claude-code-usage-root-not-object",
        expectedType: "object",
        receivedType: "array",
      },
    });
    expect(tagged).not.toHaveProperty("fieldPaths");
    expect(tagged).not.toHaveProperty("internalCause");
    expect(plain.diagnostics).toEqual({
      reasonCode: "claude-code-usage-root-not-object",
      responseDiagnostic: {
        code: "claude-code-usage-root-not-object",
        expectedType: "object",
        receivedType: "array",
      },
    });
    expect(serialized).not.toContain(RESPONSE_DIAGNOSTIC_SENTINEL);
  });

  it("strips unsafe response diagnostic input from non-validation tagged errors before serialization", () => {
    const tagged = new NetworkFailure({
      reasonCode: "provider-network",
      responseDiagnostic: {
        code: "claude-code-usage-root-not-object",
        receivedType: "array",
        value: RESPONSE_DIAGNOSTIC_SENTINEL,
      },
    } as never);
    const plain = taggedFailureToSanitizedFailure(tagged);
    const serialized = JSON.stringify(tagged) + JSON.stringify(plain);

    expect(tagged).not.toHaveProperty("responseDiagnostic");
    expect(plain.diagnostics).not.toHaveProperty("responseDiagnostic");
    expect(serialized).not.toContain(RESPONSE_DIAGNOSTIC_SENTINEL);
  });

  it("fails closed when hostile proxy reflection throws", () => {
    const marker = "fabricated-hostile-proxy-throw-marker";
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(marker);
        },
      },
    );
    let result: ReturnType<typeof normalizeResponseDiagnostic>;

    expect(() => {
      result = normalizeResponseDiagnostic(hostile);
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(String(JSON.stringify(result))).not.toContain(marker);
  });

  it("preserves legacy field paths and validation-drift category and retry behavior for non-response callers", () => {
    const failure = taggedFailureToSanitizedFailure(
      new ValidationDrift({
        reasonCode: "provider-schema-drift",
        fieldPaths: ["balance.remaining"],
      }),
    );

    expect(failure.category).toBe("validation-drift");
    expect(failure.retryClass).toBe("rate-limit-backoff");
    expect(failure.diagnostics).toEqual({
      fieldPaths: ["balance.remaining"],
      reasonCode: "provider-schema-drift",
    });
  });
});

describe("@ai-workbench/errors provider failure mapping", () => {
  it("maps provider HTTP failures into shared categories with exact safe status and without local UI messages", () => {
    const expected: ReadonlyArray<{
      readonly status: number;
      readonly category: ErrorCategory;
      readonly httpStatusClass: string;
    }> = [
      { status: 401, category: "unauthorized-expired", httpStatusClass: "4xx" },
      { status: 403, category: "insufficient-credential-scope", httpStatusClass: "4xx" },
      { status: 408, category: "timeout", httpStatusClass: "4xx" },
      { status: 429, category: "rate-limited", httpStatusClass: "4xx" },
      { status: 503, category: "provider-unavailable", httpStatusClass: "5xx" },
      { status: 418, category: "http-status-failure", httpStatusClass: "4xx" },
    ];

    for (const { status, category, httpStatusClass } of expected) {
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
      expect(failure.diagnostics.httpStatus).toBe(status);
      expect(failure.diagnostics.httpStatusClass).toBe(httpStatusClass);
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

  it("surfaces exact safe HTTP status and compatible class in diagnostics", () => {
    const failure = taggedFailureToSanitizedFailure(
      new HttpStatusFailure({ reasonCode: "provider-http-status", httpStatus: 503, statusClass: "5xx" }),
    );

    expect(failure.category).toBe("http-status-failure");
    expect(failure.diagnostics.httpStatus).toBe(503);
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
