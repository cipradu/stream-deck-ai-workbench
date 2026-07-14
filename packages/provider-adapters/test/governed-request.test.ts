import { HttpClient as PlatformHttpClient, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createSanitizedFailure, UnauthorizedExpired } from "../../errors/src/index.js";
import type { GovernorSourceLease } from "../../scheduler/src/index.js";

import {
  governedAdapterFetchAttempt,
  governedRequestJsonSchema,
  makeGovernorBackedAttemptContext,
  ProviderAdapterAttemptContext,
} from "../src/governed-request.js";
import type { AdapterFetchFailure } from "../src/effect-fetch.js";

function testLease(events: string[]): GovernorSourceLease {
  return {
    acquireAttempt: () =>
      Effect.sync(() => {
        events.push("acquire");
      }).pipe(
        Effect.as({
          release: () =>
            Effect.sync(() => {
              events.push("release");
            }),
        }),
      ),
    reportRateLimit: (notice) =>
      Effect.sync(() => {
        events.push(`report:${notice.retryAfterSeconds ?? "none"}`);
      }),
    settle: () => Effect.void,
  };
}

describe("governed adapter attempt seam", () => {
  it("forwards a registered response classifier through one governed JSON attempt", async () => {
    const events: string[] = [];
    let requests = 0;
    const context = makeGovernorBackedAttemptContext(testLease(events));
    const httpClient = PlatformHttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    const outcome = await Effect.runPromise(
      Effect.either(
        governedRequestJsonSchema(
          { url: "https://provider.example.test/usage" },
          Schema.Struct({ utilization: Schema.Number }),
          { responseClassifier: () => "claude-code-usage-root-not-object" },
        ).pipe(
          Effect.provideService(ProviderAdapterAttemptContext, context),
          Effect.provideService(PlatformHttpClient.HttpClient, httpClient),
        ),
      ),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    const failure = Option.getOrThrow(Either.getLeft(outcome));
    expect(failure._tag).toBe("ValidationDrift");
    if (failure._tag === "ValidationDrift") {
      expect(failure.responseDiagnostic).toEqual({
        code: "claude-code-usage-root-not-object",
        expectedType: "object",
        receivedType: "array",
      });
    }
    expect(requests).toBe(1);
    expect(events).toEqual(["acquire", "release"]);
  });

  it("preserves an adapter operation's typed success, error, and environment while bracketing one fresh permit", async () => {
    const events: string[] = [];
    const HttpDependency = Context.GenericTag<{ readonly baseUrl: string }>("test/HttpDependency");
    const context = makeGovernorBackedAttemptContext(testLease(events));

    const result = await Effect.runPromise(
      context
        .attempt(
          Effect.gen(function* () {
            const http = yield* HttpDependency;
            if (http.baseUrl === "provider.test") {
              return yield* Effect.fail(new UnauthorizedExpired({ reasonCode: "test-unauthorized" }));
            }
            return "unexpected";
          }),
        )
        .pipe(
          Effect.catchTag("UnauthorizedExpired", (error) => Effect.succeed(error._tag)),
          Effect.catchAll(() => Effect.succeed("unexpected-governor-block")),
          Effect.provideService(HttpDependency, { baseUrl: "provider.test" }),
        ),
    );

    expect(result).toBe("UnauthorizedExpired");
    expect(events).toEqual(["acquire", "release"]);
  });

  it("retains an actual platform HttpClient environment without translating the typed error", async () => {
    const events: string[] = [];
    const context = makeGovernorBackedAttemptContext(testLease(events));
    const httpClient = PlatformHttpClient.make(() => Effect.die("unused-test-client"));

    const result = await Effect.runPromise(
      context
        .attempt(
          Effect.gen(function* () {
            const client = yield* PlatformHttpClient.HttpClient;
            return yield* Effect.fail(
              new UnauthorizedExpired({ reasonCode: client === httpClient ? "test-http-client" : "test-wrong-client" }),
            );
          }),
        )
        .pipe(
          Effect.catchTag("UnauthorizedExpired", (error) => Effect.succeed(error.reasonCode)),
          Effect.catchAll(() => Effect.succeed("unexpected-governor-block")),
          Effect.provideService(PlatformHttpClient.HttpClient, httpClient),
        ),
    );

    expect(result).toBe("test-http-client");
    expect(events).toEqual(["acquire", "release"]);
  });

  it("reports only the safe retry notice before preserving the original typed rate-limit failure", async () => {
    const events: string[] = [];
    const rateLimited: AdapterFetchFailure = {
      failure: createSanitizedFailure({
        category: "rate-limited",
        diagnostics: { boundary: "test", reasonCode: "test-rate-limit" },
      }),
      retry: { retryAfterSeconds: 27 },
    };
    const context = makeGovernorBackedAttemptContext(testLease(events));

    const outcome = await Effect.runPromise(
      Effect.either(governedAdapterFetchAttempt(context, Effect.fail(rateLimited))),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    expect(Option.getOrThrow(Either.getLeft(outcome))).toBe(rateLimited);
    expect(events).toEqual(["acquire", "report:27", "release"]);
  });

  it("does not report a cooldown for a non-rate adapter failure", async () => {
    const events: string[] = [];
    const nonRateFailure: AdapterFetchFailure = {
      failure: createSanitizedFailure({
        category: "network-failure",
        diagnostics: { boundary: "test", reasonCode: "test-network" },
      }),
    };
    const context = makeGovernorBackedAttemptContext(testLease(events));

    const outcome = await Effect.runPromise(
      Effect.either(governedAdapterFetchAttempt(context, Effect.fail(nonRateFailure))),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    expect(Option.getOrThrow(Either.getLeft(outcome))).toBe(nonRateFailure);
    expect(events).toEqual(["acquire", "release"]);
  });
});
