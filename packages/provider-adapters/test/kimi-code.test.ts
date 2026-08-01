import { HttpClient as PlatformHttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Deferred, Effect, Either, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { serializeSchedulerKey, type SchedulerKeyParts } from "../../contracts/src/index.js";
import type {
  GovernorSourceLease,
  ProviderRequestGovernorService,
  SchedulerFetchRequest,
} from "../../scheduler/src/index.js";
import { ProviderAdapterAttemptContext } from "../src/governed-request.js";
import { createUsageProviderSourceFetchEffect } from "../src/providers/usage/index.js";
import {
  createKimiCodeUsageSourceOperation,
  projectKimiCodeUsageResponse,
  type KimiCodeUsageResponse,
} from "../src/providers/usage/kimi-code/index.js";
import { makeAdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";

const FIXTURE_CREDENTIAL = "fixture-kimi-credential";
const NOW_MS = Date.UTC(2026, 7, 1, 10);

function request(windowOrPeriod: "five-hour" | "seven-day" | "extra-usage"): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId: "usage",
    providerId: "kimi-code",
    credentialProfileId: "local-kimi-code",
    windowOrPeriod,
  };
  const schedulerKey = serializeSchedulerKey(keyParts);
  return {
    schedulerKey,
    key: schedulerKey,
    keyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: NOW_MS,
    signal: new AbortController().signal,
  };
}

const response: KimiCodeUsageResponse = {
  usage: {
    used: "197",
    limit: "10000",
    resetTime: "2026-08-08T04:43:12.691Z",
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        used: 987,
        limit: 10000,
        resetTime: "2026-08-01T09:43:11.691Z",
      },
    },
  ],
  boosterWallet: {
    monthlyUsed: { currency: "USD", priceInCents: "125" },
    monthlyChargeLimit: { currency: "USD", priceInCents: "10000" },
  },
};

describe("Kimi Code usage projections", () => {
  it("normalizes the 300-minute and weekly rows independently", async () => {
    const fiveHour = await Effect.runPromise(projectKimiCodeUsageResponse(response, request("five-hour"), () => NOW_MS));
    const sevenDay = await Effect.runPromise(projectKimiCodeUsageResponse(response, request("seven-day"), () => NOW_MS));

    expect(fiveHour).toMatchObject({
      providerId: "kimi-code",
      metricKind: "usage-percent",
      value: 9.87,
      coverage: { kind: "rolling-window", window: "five-hour" },
      resetsAtEpochMs: Date.parse("2026-08-01T09:43:11.691Z"),
    });
    expect(sevenDay).toMatchObject({
      providerId: "kimi-code",
      metricKind: "usage-percent",
      value: 1.97,
      coverage: { kind: "rolling-window", window: "seven-day" },
      resetsAtEpochMs: Date.parse("2026-08-08T04:43:12.691Z"),
    });
  });

  it("isolates malformed categories and rejects zero limits", async () => {
    const malformed: KimiCodeUsageResponse = {
      usage: { used: "1", limit: "0", resetTime: "invalid" },
      limits: response.limits,
      boosterWallet: "malformed",
    };

    const fiveHour = await Effect.runPromise(projectKimiCodeUsageResponse(malformed, request("five-hour"), () => NOW_MS));
    const weekly = await Effect.runPromise(Effect.either(projectKimiCodeUsageResponse(malformed, request("seven-day"), () => NOW_MS)));
    const extra = await Effect.runPromise(Effect.either(projectKimiCodeUsageResponse(malformed, request("extra-usage"), () => NOW_MS)));

    expect(fiveHour).toMatchObject({ value: 9.87 });
    expect(weekly).toMatchObject({ _tag: "Left", left: { failure: { diagnostics: { reasonCode: "usage-kimi-seven-day-not-returned" } } } });
    expect(extra).toMatchObject({ _tag: "Left", left: { failure: { diagnostics: { reasonCode: "usage-kimi-extra-usage-not-returned" } } } });
  });

  it("renders an absent booster wallet as Off", async () => {
    const snapshot = await Effect.runPromise(
      projectKimiCodeUsageResponse({ usage: response.usage, limits: response.limits }, request("extra-usage"), () => NOW_MS),
    );

    expect(snapshot).toMatchObject({
      providerId: "kimi-code",
      metricKind: "usage-spend",
      spendState: "off",
      autoReloadOn: false,
      value: 0,
    });
  });

  it("treats an enabled wallet with an omitted zero used scalar as active zero-dollar spend without a cap", async () => {
    const snapshot = await Effect.runPromise(
      projectKimiCodeUsageResponse(
        {
          boosterWallet: {
            monthlyUsed: { currency: "USD" },
            monthlyChargeLimit: { currency: "USD", priceInCents: "10000" },
          },
        },
        request("extra-usage"),
        () => NOW_MS,
      ),
    );

    expect(snapshot).toMatchObject({
      spendState: "active",
      spendDisplay: "money-used",
      usedMinor: 0,
      currency: "USD",
      exponent: 2,
    });
    expect(snapshot).not.toHaveProperty("percent");
    expect(snapshot).not.toHaveProperty("capMinor");
  });

  it("ignores the configurable monthly charge limit and rejects malformed monthly-used money", async () => {
    const cases: readonly KimiCodeUsageResponse[] = [
      {
        boosterWallet: {
          monthlyUsed: { currency: "USD", priceInCents: "125" },
          monthlyChargeLimit: { currency: "CAD", priceInCents: "0" },
        },
      },
      {
        boosterWallet: {
          monthlyUsed: { currency: "USD", priceInCents: "invalid" },
        },
      },
    ];

    const ignoredLimit = await Effect.runPromise(projectKimiCodeUsageResponse(cases[0]!, request("extra-usage"), () => NOW_MS));
    expect(ignoredLimit).toMatchObject({ spendDisplay: "money-used", value: 1.25, usedMinor: 125 });

    const malformedUsed = await Effect.runPromise(Effect.either(projectKimiCodeUsageResponse(cases[1]!, request("extra-usage"), () => NOW_MS)));
    expect(malformedUsed).toMatchObject({ _tag: "Left", left: { failure: { diagnostics: { reasonCode: "usage-kimi-extra-usage-not-returned" } } } });
  });
});

describe("Kimi Code credential and HTTP boundary", () => {
  it("re-reads a locally expired Unix-seconds credential once and makes no HTTP call at equality", async () => {
    let reads = 0;
    let calls = 0;
    const source = createKimiCodeUsageSourceOperation({
      providerId: "kimi-code",
      baseUrl: "https://api.kimi.example/coding/v1",
      resolveCredential: async () => {
        throw new Error("Kimi must not use plugin credentials");
      },
      localSources: {
        kimiCode: {
          readCredential: async () => {
            reads += 1;
            return { ok: true as const, accessToken: FIXTURE_CREDENTIAL, expiresAtEpochSeconds: NOW_MS / 1000 };
          },
        },
      },
      now: () => NOW_MS,
    });
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make(() => {
        calls += 1;
        return Effect.die("expired Kimi credential must not reach HTTP");
      }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        source(request("five-hour")).pipe(
          Effect.provideService(ProviderAdapterAttemptContext, {
            attempt: (operation) => operation,
            reportRateLimit: () => Effect.void,
          }),
          Effect.provide(httpLayer),
        ),
      ),
    );

    expect(reads).toBe(2);
    expect(calls).toBe(0);
    expect(outcome).toMatchObject({ _tag: "Left", left: { failure: { category: "unauthorized-expired" } } });
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_CREDENTIAL);
  });

  it("recovers when the proactive re-read returns a fresh credential", async () => {
    let reads = 0;
    let calls = 0;
    const source = createKimiCodeUsageSourceOperation({
      providerId: "kimi-code",
      baseUrl: "https://api.kimi.example/coding/v1",
      resolveCredential: async () => {
        throw new Error("Kimi must not use plugin credentials");
      },
      localSources: {
        kimiCode: {
          readCredential: async () => {
            reads += 1;
            return {
              ok: true as const,
              accessToken: FIXTURE_CREDENTIAL,
              expiresAtEpochSeconds: NOW_MS / 1000 + (reads === 1 ? 0 : 3600),
            };
          },
        },
      },
      now: () => NOW_MS,
    });
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make((httpRequest) => {
        calls += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }),
          ),
        );
      }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        source(request("five-hour")).pipe(
          Effect.provideService(ProviderAdapterAttemptContext, {
            attempt: (operation) => operation,
            reportRateLimit: () => Effect.void,
          }),
          Effect.provide(httpLayer),
        ),
      ),
    );

    expect(outcome).toMatchObject({ _tag: "Right" });
    expect(reads).toBe(2);
    expect(calls).toBe(1);
  });

  it("uses the managed endpoint and re-reads once after 401", async () => {
    let reads = 0;
    let permits = 0;
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const source = createKimiCodeUsageSourceOperation({
      providerId: "kimi-code",
      baseUrl: "https://api.kimi.example/coding/v1",
      resolveCredential: async () => {
        throw new Error("Kimi must not use plugin credentials");
      },
      localSources: {
        kimiCode: {
          readCredential: async () => {
            reads += 1;
            return { ok: true as const, accessToken: `${FIXTURE_CREDENTIAL}-${reads}`, expiresAtEpochSeconds: NOW_MS / 1000 + 3600 };
          },
        },
      },
      now: () => NOW_MS,
    });
    let responseIndex = 0;
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make((httpRequest) => {
        requests.push(httpRequest);
        responseIndex += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response(responseIndex === 1 ? JSON.stringify({ error: "unauthorized" }) : JSON.stringify(response), {
              status: responseIndex === 1 ? 401 : 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        source(request("five-hour")).pipe(
          Effect.provideService(ProviderAdapterAttemptContext, {
            attempt: (operation) => Effect.sync(() => permits += 1).pipe(Effect.zipRight(operation)),
            reportRateLimit: () => Effect.void,
          }),
          Effect.provide(httpLayer),
        ),
      ),
    );

    expect(Either.isRight(outcome)).toBe(true);
    expect(reads).toBe(2);
    expect(permits).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.every((item) => item.method === "GET" && item.url === "https://api.kimi.example/coding/v1/usages")).toBe(true);
    expect(requests.every((item) => typeof item.headers.authorization === "string")).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_CREDENTIAL);
  });

  it("stops after one credential re-read when authorization remains rejected", async () => {
    let reads = 0;
    let calls = 0;
    const source = createKimiCodeUsageSourceOperation({
      providerId: "kimi-code",
      baseUrl: "https://api.kimi.example/coding/v1",
      resolveCredential: async () => {
        throw new Error("Kimi must not use plugin credentials");
      },
      localSources: {
        kimiCode: {
          readCredential: async () => {
            reads += 1;
            return { ok: true as const, accessToken: FIXTURE_CREDENTIAL, expiresAtEpochSeconds: NOW_MS / 1000 + 3600 };
          },
        },
      },
      now: () => NOW_MS,
    });
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make((httpRequest) => {
        calls += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            httpRequest,
            new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        source(request("five-hour")).pipe(
          Effect.provideService(ProviderAdapterAttemptContext, {
            attempt: (operation) => operation,
            reportRateLimit: () => Effect.void,
          }),
          Effect.provide(httpLayer),
        ),
      ),
    );

    expect(reads).toBe(2);
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ _tag: "Left", left: { failure: { category: "unauthorized-expired" } } });
    expect(JSON.stringify(outcome)).not.toContain(FIXTURE_CREDENTIAL);
  });
});

describe("Kimi Code typed source flight", () => {
  it("shares one managed response across concurrent 5-hour, 7-day, and Extra Usage projections", async () => {
    const events: string[] = [];
    const governor: ProviderRequestGovernorService = {
      acquireSource: () => {
        const lease: GovernorSourceLease = {
          acquireAttempt: () =>
            Effect.sync(() => events.push("permit")).pipe(
              Effect.as({ release: () => Effect.sync(() => events.push("release")) }),
            ),
          reportRateLimit: () => Effect.void,
          settle: () => Effect.void,
        };
        return Effect.succeed(lease);
      },
      credentialGenerationFor: () => Effect.succeed(0),
      advanceCredentialGeneration: () => Effect.succeed(1),
      diagnostics: () =>
        Effect.succeed({ stopped: false, activeSourceCount: 0, queuedSourceCount: 0, activeAttemptCount: 0 }),
      shutdown: () => Effect.void,
    };

    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor);
          const gate = yield* Deferred.make<void>();
          const httpLayer = Layer.succeed(
            PlatformHttpClient.HttpClient,
            PlatformHttpClient.make((httpRequest) => {
              events.push("http");
              return Deferred.await(gate).pipe(
                Effect.as(
                  HttpClientResponse.fromWeb(
                    httpRequest,
                    new Response(JSON.stringify(response), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  ),
                ),
              );
            }),
          );
          const sourceFetch = createUsageProviderSourceFetchEffect({
            providerId: "kimi-code",
            baseUrl: "https://api.kimi.example/coding/v1",
            resolveCredential: async () => {
              throw new Error("Kimi must not use plugin credentials");
            },
            localSources: {
              kimiCode: {
                readCredential: async () => ({
                  ok: true as const,
                  accessToken: FIXTURE_CREDENTIAL,
                  expiresAtEpochSeconds: NOW_MS / 1000 + 3600,
                }),
              },
            },
            sourceFlightRuntime: runtime.capability,
            credentialProfileId: "local-kimi-code",
            rateLimitDomain: "provider-profile",
            now: () => NOW_MS,
          });
          if (sourceFetch === undefined) {
            return yield* Effect.die("Kimi source fetch must be available");
          }

          const first = yield* Effect.fork(Effect.either(sourceFetch(request("five-hour")).pipe(Effect.provide(httpLayer))));
          while (!events.includes("http")) {
            yield* Effect.yieldNow();
          }
          const weekly = yield* Effect.fork(Effect.either(sourceFetch(request("seven-day")).pipe(Effect.provide(httpLayer))));
          const extra = yield* Effect.fork(Effect.either(sourceFetch(request("extra-usage")).pipe(Effect.provide(httpLayer))));
          yield* Effect.yieldNow();
          yield* Deferred.succeed(gate, undefined);
          return yield* Effect.all([Fiber.join(first), Fiber.join(weekly), Fiber.join(extra)]);
        }),
      ),
    );

    expect(outcomes[0]).toMatchObject({ _tag: "Right", right: { value: 9.87 } });
    expect(outcomes[1]).toMatchObject({ _tag: "Right", right: { value: 1.97 } });
    expect(outcomes[2]).toMatchObject({ _tag: "Right", right: { metricKind: "usage-spend", spendState: "active" } });
    expect(events.filter((event) => event === "http")).toHaveLength(1);
    expect(events.filter((event) => event === "permit")).toHaveLength(1);
  });
});
