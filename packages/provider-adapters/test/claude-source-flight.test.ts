import {
  HttpClient as PlatformHttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Deferred, Effect, Either, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { serializeSchedulerKey, type SchedulerKeyParts } from "../../contracts/src/index.js";
import type {
  GovernorSourceLease,
  GovernorSourceSettlement,
  ProviderRequestGovernorService,
  SchedulerFetchRequest,
} from "../../scheduler/src/index.js";

import { createUsageProviderSourceFetchEffect } from "../src/providers/usage/index.js";
import { makeAdapterSourceFlightRuntime, type AdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";

const categoryWindows = ["five-hour", "seven-day", "fable", "credit-spend"] as const;
type ClaudeCategoryWindow = (typeof categoryWindows)[number];

interface RecordingGovernor {
  readonly events: string[];
  readonly settlements: GovernorSourceSettlement[];
  readonly service: ProviderRequestGovernorService;
  readonly setGeneration: (generation: number) => void;
}

function recordingGovernor(): RecordingGovernor {
  const events: string[] = [];
  const settlements: GovernorSourceSettlement[] = [];
  let generation = 0;
  const service: ProviderRequestGovernorService = {
    acquireSource: (identity) => {
      events.push(`source:${identity.rateLimitScope.credentialProfileId}:${identity.rateLimitScope.credentialGeneration}`);
      let settled = false;
      const lease: GovernorSourceLease = {
        acquireAttempt: () =>
          Effect.sync(() => {
            events.push("permit");
          }).pipe(Effect.as({ release: () => Effect.sync(() => events.push("release")) })),
        reportRateLimit: () => Effect.sync(() => events.push("rate-limit")),
        settle: (settlement) =>
          Effect.sync(() => {
            if (!settled) {
              settled = true;
              settlements.push(settlement);
            }
          }),
      };
      return Effect.succeed(lease);
    },
    credentialGenerationFor: () => Effect.succeed(generation),
    advanceCredentialGeneration: () => Effect.sync(() => ++generation),
    diagnostics: () =>
      Effect.succeed({
        stopped: false,
        activeSourceCount: 0,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      }),
    shutdown: () => Effect.void,
  };
  return {
    events,
    settlements,
    service,
    setGeneration: (next) => {
      generation = next;
    },
  };
}

function request(windowOrPeriod: ClaudeCategoryWindow, credentialProfileId = "profile-claude"): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId: "usage",
    providerId: "claude-code",
    credentialProfileId,
    windowOrPeriod,
  };
  const schedulerKey = serializeSchedulerKey(keyParts);
  return {
    schedulerKey,
    key: schedulerKey,
    keyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: Date.UTC(2026, 6, 15),
    signal: new AbortController().signal,
  };
}

function claudeFetch(runtime: AdapterSourceFlightRuntime, credentialProfileId = "profile-claude") {
  const sourceFetch = createUsageProviderSourceFetchEffect({
    providerId: "claude-code",
    baseUrl: "https://provider.example.test",
    sourceFlightRuntime: runtime.capability,
    credentialProfileId,
    rateLimitDomain: "provider-profile",
    localSources: {
      claudeCode: {
        readCredential: async () => ({ ok: true as const, accessToken: "fixture-credential" }),
      },
    },
    resolveCredential: async () => {
      throw new Error("Claude local source must not resolve plugin credentials");
    },
    now: () => Date.UTC(2026, 6, 15),
  });
  if (sourceFetch === undefined) {
    throw new Error("Claude source fetch must be available");
  }
  return sourceFetch;
}

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function responseLayer(
  events: string[],
  responses: readonly (
    | { readonly body: unknown; readonly status?: number }
    | { readonly waitFor: Deferred.Deferred<void>; readonly body: unknown; readonly onInterrupt?: Deferred.Deferred<void> }
  )[],
): Layer.Layer<PlatformHttpClient.HttpClient> {
  const pending = [...responses];
  return Layer.succeed(
    PlatformHttpClient.HttpClient,
    PlatformHttpClient.make((httpRequest) => {
      const next = pending.shift();
      if (next === undefined) {
        return Effect.die("unexpected Claude OAuth request");
      }
      events.push("http");
      if ("waitFor" in next) {
        return Deferred.await(next.waitFor).pipe(
          Effect.as(jsonResponse(httpRequest, next.body)),
          Effect.onInterrupt(() => (next.onInterrupt === undefined ? Effect.void : Deferred.succeed(next.onInterrupt, undefined).pipe(Effect.asVoid))),
        );
      }
      return Effect.succeed(jsonResponse(httpRequest, next.body, next.status));
    }),
  );
}

function awaitHttpStarts(events: readonly string[], expected: number): Effect.Effect<void> {
  return events.filter((event) => event === "http").length >= expected
    ? Effect.void
    : Effect.yieldNow().pipe(Effect.zipRight(Effect.suspend(() => awaitHttpStarts(events, expected))));
}

const validUsageWithMalformedOptionalCategories = {
  five_hour: { utilization: 42, resets_at: "2026-07-15T12:00:00Z" },
  seven_day: { utilization: 73, resets_at: "2026-07-20T12:00:00Z" },
  limits: "malformed-optional-limits",
  spend: "malformed-optional-spend",
};

describe("Claude Code typed source flight", () => {
  it("shares one decoded OAuth source across four category closures, isolates malformed optional projections, and evicts on settlement", async () => {
    const governor = recordingGovernor();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const responseGate = yield* Deferred.make<void>();
          const events: string[] = [];
          const httpLayer = responseLayer(events, [
            { waitFor: responseGate, body: validUsageWithMalformedOptionalCategories },
            { waitFor: responseGate, body: validUsageWithMalformedOptionalCategories },
            { waitFor: responseGate, body: validUsageWithMalformedOptionalCategories },
            { waitFor: responseGate, body: validUsageWithMalformedOptionalCategories },
          ]);
          const fetches = categoryWindows.map(() => claudeFetch(runtime));
          const first = yield* Effect.fork(
            Effect.either(fetches[0]!(request("five-hour")).pipe(Effect.provide(httpLayer))),
          );
          while (!events.includes("http")) {
            yield* Effect.yieldNow();
          }
          const duplicates = yield* Effect.forEach(
            categoryWindows.slice(1),
            (window, index) => Effect.fork(Effect.either(fetches[index + 1]!(request(window)).pipe(Effect.provide(httpLayer)))),
          );
          yield* Deferred.succeed(responseGate, undefined);
          const outcomes = yield* Effect.all([Fiber.join(first), ...duplicates.map(Fiber.join)]);

          const postSettlement = yield* Effect.either(
            claudeFetch(runtime)(request("five-hour")).pipe(
              Effect.provide(responseLayer(events, [{ body: validUsageWithMalformedOptionalCategories }])),
            ),
          );
          return { outcomes, postSettlement, httpStarts: events.filter((event) => event === "http").length };
        }),
      ),
    );

    expect(observed.outcomes[0]).toMatchObject({ _tag: "Right", right: { value: 42, coverage: { window: "five-hour" } } });
    expect(observed.outcomes[1]).toMatchObject({ _tag: "Right", right: { value: 73, coverage: { window: "seven-day" } } });
    expect(observed.outcomes[2]).toMatchObject({ _tag: "Left", left: { failure: { diagnostics: { reasonCode: "usage-claude-fable-not-returned" } } } });
    expect(observed.outcomes[3]).toMatchObject({ _tag: "Left", left: { failure: { diagnostics: { reasonCode: "usage-claude-credit-spend-not-returned" } } } });
    expect(Either.isRight(observed.postSettlement)).toBe(true);
    expect(observed.httpStarts).toBe(2);
    expect(governor.events.filter((event) => event === "permit")).toHaveLength(2);
  });

  it("does not join an incompatible credential profile or credential generation", async () => {
    const governor = recordingGovernor();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const gate = yield* Deferred.make<void>();
          const events: string[] = [];
          const httpLayer = responseLayer(events, [
            { waitFor: gate, body: validUsageWithMalformedOptionalCategories },
            { waitFor: gate, body: validUsageWithMalformedOptionalCategories },
            { waitFor: gate, body: validUsageWithMalformedOptionalCategories },
          ]);
          const first = yield* Effect.fork(Effect.either(claudeFetch(runtime)(request("five-hour")).pipe(Effect.provide(httpLayer))));
          yield* awaitHttpStarts(events, 1);
          governor.setGeneration(1);
          const generationChanged = yield* Effect.fork(
            Effect.either(claudeFetch(runtime)(request("seven-day")).pipe(Effect.provide(httpLayer))),
          );
          yield* awaitHttpStarts(events, 2);
          const profileChanged = yield* Effect.fork(
            Effect.either(claudeFetch(runtime, "profile-other")(request("fable", "profile-other")).pipe(Effect.provide(httpLayer))),
          );
          yield* awaitHttpStarts(events, 3);
          yield* Deferred.succeed(gate, undefined);
          yield* Effect.all([Fiber.join(first), Fiber.join(generationChanged), Fiber.join(profileChanged)]);
          return events.filter((event) => event === "http").length;
        }),
      ),
    );

    expect(observed).toBe(3);
  });

  it("takes a fresh permit for the typed 401 credential refresh retry", async () => {
    const governor = recordingGovernor();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const events: string[] = [];
          return yield* Effect.either(
            claudeFetch(runtime)(request("five-hour")).pipe(
              Effect.provide(
                responseLayer(events, [
                  { status: 401, body: { error: "unauthorized" } },
                  { body: validUsageWithMalformedOptionalCategories },
                ]),
              ),
            ),
          );
        }),
      ),
    );

    expect(outcome).toMatchObject({ _tag: "Right", right: { value: 42 } });
    expect(governor.events.filter((event) => event === "permit")).toHaveLength(2);
    expect(governor.events.filter((event) => event === "release")).toHaveLength(2);
  });

  it("reports a rate limit before releasing its permit and permits a later fresh source", async () => {
    const governor = recordingGovernor();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const events: string[] = [];
          const rateLimited = yield* Effect.either(
            claudeFetch(runtime)(request("five-hour")).pipe(
              Effect.provide(responseLayer(events, [{ status: 429, body: { error: "rate-limited" } }])),
            ),
          );
          const recovered = yield* Effect.either(
            claudeFetch(runtime)(request("five-hour")).pipe(
              Effect.provide(responseLayer(events, [{ body: validUsageWithMalformedOptionalCategories }])),
            ),
          );
          return { rateLimited, recovered };
        }),
      ),
    );

    expect(observed.rateLimited).toMatchObject({ _tag: "Left", left: { failure: { category: "rate-limited" } } });
    expect(observed.recovered).toMatchObject({ _tag: "Right", right: { value: 42 } });
    expect(governor.events.indexOf("rate-limit")).toBeLessThan(governor.events.indexOf("release"));
    expect(governor.events.filter((event) => event === "permit")).toHaveLength(2);
  });

  it("closes the shared worker when the last subscriber detaches and does not retain a completed cache", async () => {
    const governor = recordingGovernor();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const interrupted = yield* Deferred.make<void>();
          const never = yield* Deferred.make<void>();
          const events: string[] = [];
          const firstLayer = responseLayer(events, [
            { waitFor: never, body: validUsageWithMalformedOptionalCategories, onInterrupt: interrupted },
          ]);
          const active = yield* Effect.fork(
            claudeFetch(runtime)(request("five-hour")).pipe(Effect.provide(firstLayer), Effect.either),
          );
          while (!events.includes("http")) {
            yield* Effect.yieldNow();
          }
          yield* Fiber.interrupt(active);
          yield* Deferred.await(interrupted);

          const fresh = yield* Effect.either(
            claudeFetch(runtime)(request("five-hour")).pipe(
              Effect.provide(responseLayer(events, [{ body: validUsageWithMalformedOptionalCategories }])),
            ),
          );
          return { fresh, starts: events.filter((event) => event === "http").length };
        }),
      ),
    );

    expect(observed.fresh).toMatchObject({ _tag: "Right", right: { value: 42 } });
    expect(observed.starts).toBe(2);
    expect(governor.settlements).toContainEqual({ kind: "cancelled" });
  });
});
