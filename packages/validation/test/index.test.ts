import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import * as errorsModule from "../../errors/src/index.js";
import { parseUnknown } from "../src/index.js";

const RAW_NEEDLES = {
  body: "raw provider body fragment",
  diagnostic: "Expected number, actual sensitive provider value",
  token: "fake-token-value",
} as const;

const ProviderBalanceSchema = Schema.Struct({
  providerId: Schema.Literal("openai-api"),
  remainingBalance: Schema.Number,
  status: Schema.Literal("ok"),
});

describe("@ai-workbench/validation parseUnknown", () => {
  it("parses unknown input into a plain contract and discards unconsumed vendor fields", () => {
    const result = parseUnknown(
      ProviderBalanceSchema,
      {
        providerId: "openai-api",
        rawBody: RAW_NEEDLES.body,
        remainingBalance: 12.5,
        status: "ok",
        token: RAW_NEEDLES.token,
      },
      {
        boundary: "provider-response",
        reasonCode: "provider-response-validation",
      },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        providerId: "openai-api",
        remainingBalance: 12.5,
        status: "ok",
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.body);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
  });

  it("maps invalid input to a sanitized validation drift failure", () => {
    const result = parseUnknown(
      ProviderBalanceSchema,
      {
        providerId: "openai-api",
        rawBody: RAW_NEEDLES.body,
        remainingBalance: RAW_NEEDLES.token,
        schemaDiagnostic: RAW_NEEDLES.diagnostic,
        status: "ok",
      },
      {
        boundary: "provider-response",
        fieldPaths: ["remainingBalance"],
        reasonCode: "provider-response-validation",
      },
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        category: "validation-drift",
        diagnostics: {
          boundary: "provider-response",
          fieldPaths: ["remainingBalance"],
          issueCount: expect.any(Number),
          reasonCode: "provider-response-validation",
        },
        displayState: "validation-drift",
        retryClass: "rate-limit-backoff",
        safePublicMessage: "Provider response validation failed.",
        sanitized: true,
      },
    });
    expect(result.ok === false ? result.failure.diagnostics.issueCount : 0).toBeGreaterThan(0);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_NEEDLES.body);
    expect(serialized).not.toContain(RAW_NEEDLES.diagnostic);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain("Expected number");
    expect(serialized).not.toContain("ParseError");
    expect(errorsModule).not.toHaveProperty("getPrivateFailureCause");
  });

  it("uses a safe generic field summary when callers do not provide field paths", () => {
    const result = parseUnknown(
      ProviderBalanceSchema,
      {
        providerId: "openai-api",
        remainingBalance: RAW_NEEDLES.token,
        status: "ok",
      },
      {
        boundary: "provider-response",
        reasonCode: "provider-response-validation",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        diagnostics: {
          boundary: "provider-response",
          fieldPaths: ["<redacted-field>"],
          reasonCode: "provider-response-validation",
        },
      },
    });
  });
});
