import { Cause, Data, Effect, Logger, LogLevel, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  createSanitizedLogEvent,
  makeStreamDeckLogger,
  makeStreamDeckLoggerLayer,
  redactText,
  sanitizeLogContext,
  writeSanitizedLogEvent,
  type SanitizedLogEvent,
  type StreamDeckLogSink,
} from "../src/index.js";

const RAW_NEEDLES = {
  account: "account_01fakeidentifier",
  body: "raw response body fragment",
  cause: "Cause.pretty stack with fake defect detail",
  contact: "fake-contact@example.invalid",
  money: "$123.45",
  organization: "org_01fakeidentifier",
  project: "project_01fakeidentifier",
  providerMetricValues: [
    "remainingBalance=123.45",
    "token count 99",
    "cost is 42",
    "remaining balance 123.45",
    "credits: 99",
    "tokens 99",
    "characters 500",
    "spend 42",
    "usage percent 81",
    "used time 12",
    "current month spend 42",
    "currentPeriodSpend=42",
  ],
  providerMetricValuesWithCurrency: [
    "remainingBalance=1,234.56",
    "currentPeriodSpend is USD 1,234.56",
    "current month spend approximately 1,234.56 USD",
    "balance was CAD 1,234",
    "cost is EUR 42",
    "usage percent is 82.5%",
    "amount in JPY 5,000",
  ],
  providerValues: "balance 123.45 credits 99",
  redactedValue: "Redacted.value(fake-hidden-value)",
  routing: "routing_01fakeidentifier",
  sensitiveCorrelation: "org_01fakeidentifier:project_01fakeidentifier",
  sensitiveReason: "account_01fakeidentifier_balance_123_45",
  team: "team_01fakeidentifier",
  token: "Bearer fake-token-value",
} as const;

describe("@ai-workbench/logging redaction primitives", () => {
  it("redacts unsafe text without exposing credential, identifier, or value fragments", () => {
    const redacted = redactText(
      `authorization ${RAW_NEEDLES.token} for ${RAW_NEEDLES.contact} ${RAW_NEEDLES.account} ${RAW_NEEDLES.organization} ${RAW_NEEDLES.project} ${RAW_NEEDLES.routing} ${RAW_NEEDLES.team} ${RAW_NEEDLES.money} ${RAW_NEEDLES.providerValues} ${RAW_NEEDLES.redactedValue}`,
    );

    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(RAW_NEEDLES.token);
    expect(redacted).not.toContain(RAW_NEEDLES.contact);
    expect(redacted).not.toContain(RAW_NEEDLES.account);
    expect(redacted).not.toContain(RAW_NEEDLES.organization);
    expect(redacted).not.toContain(RAW_NEEDLES.project);
    expect(redacted).not.toContain(RAW_NEEDLES.routing);
    expect(redacted).not.toContain(RAW_NEEDLES.team);
    expect(redacted).not.toContain(RAW_NEEDLES.money);
    expect(redacted).not.toContain(RAW_NEEDLES.providerValues);
    expect(redacted).not.toContain(RAW_NEEDLES.redactedValue);
  });
});

describe("@ai-workbench/logging context allow-list", () => {
  it("keeps only safe structured fields and derives status class instead of raw status", () => {
    const context = sanitizeLogContext({
      actionFamilyId: "balance",
      accountId: RAW_NEEDLES.account,
      authorization: RAW_NEEDLES.token,
      correlationId: RAW_NEEDLES.sensitiveCorrelation,
      elapsedMs: 127.8,
      httpStatus: 429,
      implementationStatus: "docsOnly",
      providerFinancialValue: RAW_NEEDLES.money,
      providerId: "openai-api",
      rawBody: RAW_NEEDLES.body,
      reasonCode: RAW_NEEDLES.sensitiveReason,
      retryClass: "rate-limit-backoff",
      unsafeCause: RAW_NEEDLES.cause,
    });

    expect(context).toEqual({
      actionFamilyId: "balance",
      elapsedMs: 128,
      httpStatusClass: "4xx",
      implementationStatus: "docsOnly",
      providerId: "openai-api",
      reasonCode: "redacted",
      retryClass: "rate-limit-backoff",
    });

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(RAW_NEEDLES.account);
    expect(serialized).not.toContain(RAW_NEEDLES.body);
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.sensitiveCorrelation);
    expect(serialized).not.toContain(RAW_NEEDLES.sensitiveReason);
    expect(serialized).not.toContain(RAW_NEEDLES.money);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
  });
});

describe("@ai-workbench/logging sanitized event contract", () => {
  it("redacts common provider metric labels and values from messages and structured strings", () => {
    const event = createSanitizedLogEvent({
      context: {
        actionFamilyId: "balance",
        correlationId: "currentPeriodSpend:42",
        httpStatus: 200,
        providerId: "openai-api",
        reasonCode: "remainingBalance=123.45",
        retryClass: "healthy-poll",
      },
      eventName: "usage percent 81",
      level: "info",
      message: `Provider values ${RAW_NEEDLES.providerMetricValues.join(" ")}`,
    });

    expect(event.context).toEqual({
      actionFamilyId: "balance",
      httpStatusClass: "2xx",
      providerId: "openai-api",
      reasonCode: "redacted",
      retryClass: "healthy-poll",
    });
    expect(event.eventName).toBe("redacted");
    expect(event.message).toContain("[redacted]");

    const serialized = JSON.stringify(event);
    for (const rawValue of RAW_NEEDLES.providerMetricValues) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(serialized).not.toContain("currentPeriodSpend:42");
    expect(serialized).not.toContain("remainingBalance=123.45");
  });

  it("fails closed for comma grouped and currency coded provider metric values", () => {
    const event = createSanitizedLogEvent({
      context: {
        actionFamilyId: "balance",
        correlationId: "currentMonthSpend:USD:1,234.56",
        httpStatus: 200,
        providerId: "openai-api",
        reasonCode: "current period spend was USD 1,234.56",
        retryClass: "healthy-poll",
      },
      eventName: "remaining balance was CAD 1,234",
      level: "info",
      message: `Provider summary ${RAW_NEEDLES.providerMetricValuesWithCurrency.join(" and ")}`,
    });

    expect(event.context).toEqual({
      actionFamilyId: "balance",
      httpStatusClass: "2xx",
      providerId: "openai-api",
      reasonCode: "redacted",
      retryClass: "healthy-poll",
    });
    expect(event.eventName).toBe("redacted");
    expect(event.message).toBe("[redacted]");

    const serialized = JSON.stringify(event);
    for (const rawValue of RAW_NEEDLES.providerMetricValuesWithCurrency) {
      expect(serialized).not.toContain(rawValue);
    }
    for (const leakedFragment of ["1,234.56", "1,234", "5,000", "82.5%", "USD", "CAD", "EUR", "JPY"]) {
      expect(serialized).not.toContain(leakedFragment);
    }
    expect(serialized).not.toContain("currentMonthSpend:USD:1,234.56");
  });

  it("creates sanitized events without arbitrary untrusted context fields or raw Cause output", () => {
    const event = createSanitizedLogEvent({
      context: {
        actionFamilyId: "balance",
        correlationId: "refresh:balance:openai-api",
        httpStatus: 503,
        implementationStatus: "docsOnly",
        providerId: "openai-api",
        rawBody: RAW_NEEDLES.body,
        reasonCode: "provider-unavailable",
        retryClass: "transient-retry",
      },
      eventName: RAW_NEEDLES.redactedValue,
      level: "warn",
      message: `Refresh failed because ${RAW_NEEDLES.cause} ${RAW_NEEDLES.token} ${RAW_NEEDLES.redactedValue}`,
    });

    expect(event).toEqual({
      context: {
        actionFamilyId: "balance",
        correlationId: "refresh:balance:openai-api",
        httpStatusClass: "5xx",
        implementationStatus: "docsOnly",
        providerId: "openai-api",
        reasonCode: "provider-unavailable",
        retryClass: "transient-retry",
      },
      eventName: "redacted",
      level: "warn",
      message: "Refresh failed because [redacted]",
      sanitized: true,
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(RAW_NEEDLES.body);
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.redactedValue);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
  });

  it("writes only already-sanitized events to a future Stream Deck sink interface", async () => {
    const written: SanitizedLogEvent[] = [];
    const event = createSanitizedLogEvent({
      context: {
        reasonCode: "validation-drift",
      },
      eventName: "validation drift",
      level: "error",
      message: "Provider response validation failed.",
    });

    await writeSanitizedLogEvent(
      {
        write: (sanitizedEvent) => {
          written.push(sanitizedEvent);
        },
      },
      event,
    );

    expect(written).toEqual([event]);
  });
  it("accepts a pre-sanitized httpStatusClass string and rejects non-class strings", () => {
    expect(sanitizeLogContext({ httpStatusClass: "4xx" })).toEqual({ httpStatusClass: "4xx" });
    expect(sanitizeLogContext({ httpStatusClass: "unknown" })).toEqual({ httpStatusClass: "unknown" });
    expect(sanitizeLogContext({ httpStatusClass: "teapot" })).toEqual({});
    expect(sanitizeLogContext({ httpStatusClass: "6xx" })).toEqual({});
  });

});

describe("@ai-workbench/logging Effect Logger sink", () => {
  function captureEffectLogs(effect: Effect.Effect<void>): SanitizedLogEvent[] {
    const captured: SanitizedLogEvent[] = [];
    const sink: StreamDeckLogSink = {
      write: (event) => {
        captured.push(event);
      },
    };

    Effect.runSync(Effect.provide(effect, makeStreamDeckLoggerLayer(sink)));

    return captured;
  }

  it("exposes a value that Effect recognizes as a Logger", () => {
    const sink: StreamDeckLogSink = { write: () => undefined };

    expect(Logger.isLogger(makeStreamDeckLogger(sink))).toBe(true);
  });

  it("routes an Effect log record through the sanitizer and allow-list to the injected sink", () => {
    const captured = captureEffectLogs(
      Effect.logInfo("provider refresh completed").pipe(
        Effect.annotateLogs({
          actionFamilyId: "balance",
          authorization: RAW_NEEDLES.token,
          elapsedMs: 42.7,
          eventName: "provider refresh",
          httpStatus: 200,
          providerId: "openai-api",
          rawBody: RAW_NEEDLES.body,
          retryClass: "healthy-poll",
        }),
      ),
    );

    expect(captured).toEqual([
      {
        context: {
          actionFamilyId: "balance",
          elapsedMs: 43,
          httpStatusClass: "2xx",
          providerId: "openai-api",
          retryClass: "healthy-poll",
        },
        eventName: "provider-refresh",
        level: "info",
        message: "provider refresh completed",
        sanitized: true,
      },
    ]);

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.body);
  });

  it("renders a Redacted value as [redacted] and never unwraps it", () => {
    const captured = captureEffectLogs(Effect.logWarning("credential loaded", Redacted.make("super-secret-key-value")));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe("warn");
    expect(captured[0]?.message).toContain("[redacted]");

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("super-secret-key-value");
    expect(serialized).not.toContain("<redacted>");
  });

  it("never lets a raw Cause, tagged-error internalCause, or secret reach the sink", () => {
    class RefreshFailure extends Data.TaggedError("RefreshFailure")<{
      readonly internalCause: unknown;
      readonly reason: string;
    }> {}

    const secret = "Bearer sk-fake-LEAK-CANARY-0xC0FFEE";
    const failure = new RefreshFailure({ internalCause: secret, reason: "upstream_5xx_marker" });

    // The secret is seeded through three vectors at once: the tagged error's
    // internalCause carried inside an Effect Cause, a forbidden annotation key,
    // and inline in the log message. None may reach the sink.
    const captured = captureEffectLogs(
      Effect.logError(`refresh failed exposing ${secret}`, Cause.die(failure)).pipe(
        Effect.annotateLogs({
          authorization: secret,
          eventName: "provider-refresh",
          providerId: "anthropic-api",
        }),
      ),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe("error");
    expect(captured[0]?.context).toEqual({ providerId: "anthropic-api" });
    expect(captured[0]?.message).toBe("refresh failed exposing [redacted]");

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-fake");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("internalCause");
    expect(serialized).not.toContain("RefreshFailure");
    expect(serialized).not.toContain("upstream_5xx_marker");
  });

  it("maps Effect log levels onto the sanitized level union", () => {
    const captured = captureEffectLogs(
      Effect.gen(function* () {
        yield* Effect.logTrace("trace-line");
        yield* Effect.logDebug("debug-line");
        yield* Effect.logInfo("info-line");
        yield* Effect.logWarning("warn-line");
        yield* Effect.logError("error-line");
        yield* Effect.logFatal("fatal-line");
      }).pipe(Logger.withMinimumLogLevel(LogLevel.Trace)),
    );

    expect(captured.map((event) => event.level)).toEqual(["debug", "debug", "info", "warn", "error", "error"]);
  });
});
