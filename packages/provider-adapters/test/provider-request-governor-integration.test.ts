import {
  HttpClient as PlatformHttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Effect, Either, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  BALANCE_PROVIDER_IDS,
  serializeSchedulerKey,
  type BalanceProviderId,
  type SchedulerKeyParts,
  type UsageProviderId,
} from "../../contracts/src/index.js";
import { createSanitizedFailure } from "../../errors/src/index.js";
import { findProviderEntry, type ProviderCapabilityMetadata } from "../../provider-registry/src/index.js";
import type {
  GovernorSourceLease,
  GovernorSourceSettlement,
  ProviderRequestGovernorService,
  SchedulerFetchRequest,
} from "../../scheduler/src/index.js";

import { createBalanceProviderSourceFetchEffect } from "../src/providers/balance/index.js";
import { createUsageProviderSourceFetchEffect } from "../src/providers/usage/index.js";
import { createSourceGatedBalanceFetchEffect, createSourceGatedUsageFetchEffect } from "../src/source-gates.js";
import { makeAdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";
import type { AdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";
import type { CreateBalanceProviderSourceFetchInput, CreateUsageProviderSourceFetchInput } from "../src/types.js";

const usageProviders = ["claude-code", "codex", "zai-coding-plan", "minimax"] as const satisfies readonly UsageProviderId[];
const balanceProviders = BALANCE_PROVIDER_IDS;

type ProviderUnderTest = (typeof usageProviders)[number] | (typeof balanceProviders)[number];

interface RecordedGovernor {
  readonly events: string[];
  readonly settlements: GovernorSourceSettlement[];
  readonly service: ProviderRequestGovernorService;
}

function recordedGovernor(options: { readonly blockSource?: boolean } = {}): RecordedGovernor {
  const events: string[] = [];
  const settlements: GovernorSourceSettlement[] = [];
  const service: ProviderRequestGovernorService = {
    acquireSource: (identity) => {
      const providerId = identity.rateLimitScope.providerId;
      events.push(`source:${providerId}`);
      if (options.blockSource === true) {
        return Effect.fail({
          _tag: "GovernorBlocked" as const,
          failure: createSanitizedFailure({
            category: "rate-limited",
            diagnostics: {
              boundary: "provider-request-governor",
              reasonCode: "fixture-governor-blocked",
            },
          }),
          retryAfterSeconds: 17,
        });
      }
      let settled = false;
      const lease: GovernorSourceLease = {
        acquireAttempt: () =>
          Effect.sync(() => {
            events.push(`permit:${providerId}`);
          }).pipe(Effect.as({ release: () => Effect.void })),
        reportRateLimit: () =>
          Effect.sync(() => {
            events.push(`rate-limit:${providerId}`);
          }),
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
    credentialGenerationFor: () => Effect.succeed(0),
    advanceCredentialGeneration: () => Effect.succeed(1),
    diagnostics: () =>
      Effect.succeed({
        stopped: false,
        activeSourceCount: 0,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      }),
    shutdown: () => Effect.void,
  };
  return { events, settlements, service };
}

function request(
  providerId: ProviderUnderTest,
  familyId: "usage" | "balance",
  windowOrPeriod?: SchedulerKeyParts["windowOrPeriod"],
): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId,
    providerId,
    credentialProfileId: "profile-test",
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
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

function capabilityFor(providerId: ProviderUnderTest, familyId: "usage" | "balance"): ProviderCapabilityMetadata {
  const capability = findProviderEntry(providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === familyId);
  if (capability === undefined) {
    throw new Error(`Missing ${familyId} capability for ${providerId}`);
  }
  return capability;
}

function responseLayer(
  events: string[],
  responses: readonly { readonly body: unknown; readonly status?: number }[],
): Layer.Layer<PlatformHttpClient.HttpClient> {
  const pending = [...responses];
  return Layer.succeed(
    PlatformHttpClient.HttpClient,
    PlatformHttpClient.make((httpRequest: HttpClientRequest.HttpClientRequest) => {
      const next = pending.shift();
      if (next === undefined) {
        return Effect.die("unexpected provider HTTP attempt");
      }
      const providerId = events.findLast((event) => event.startsWith("permit:"))?.slice("permit:".length) ?? "unknown";
      events.push(`http:${providerId}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          httpRequest,
          new Response(JSON.stringify(next.body), {
            status: next.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
}

function balanceSourceInput(
  providerId: BalanceProviderId,
  sourceFlightRuntime: AdapterSourceFlightRuntime,
): CreateBalanceProviderSourceFetchInput {
  return {
    providerId,
    baseUrl: "https://provider.example.test",
    sourceFlightRuntime: sourceFlightRuntime.capability,
    credentialProfileId: "profile-test",
    rateLimitDomain: "provider-profile",
    resolveCredential: async () => ({ ok: true as const, value: { value: Redacted.make("fixture-credential") } }),
    now: () => Date.UTC(2026, 6, 15),
  };
}

function usageSourceInput(
  providerId: UsageProviderId,
  sourceFlightRuntime: AdapterSourceFlightRuntime,
): CreateUsageProviderSourceFetchInput {
  return {
    ...balanceSourceInput("fal", sourceFlightRuntime),
    providerId,
  };
}

describe("provider request governor production adapter route", () => {
  it("admits every current provider source before every protected HTTP helper attempt", async () => {
    const governor = recordedGovernor();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const httpResponses = [...usageProviders, ...balanceProviders].flatMap((providerId) =>
            providerId === "claude-code" || providerId === "codex"
              ? [{ body: { error: "unauthorized" }, status: 401 }, { body: { error: "unauthorized" }, status: 401 }]
              : [{ body: { error: "unauthorized" }, status: 401 }],
          );
          const httpLayer = responseLayer(governor.events, httpResponses);

          for (const providerId of usageProviders) {
            const windowOrPeriod = "five-hour";
            const sourceFetch = createUsageProviderSourceFetchEffect({
              ...usageSourceInput(providerId, sourceFlightRuntime),
              localSources: {
                ...(providerId === "claude-code"
                  ? { claudeCode: { readCredential: async () => ({ ok: true as const, accessToken: "fixture-token" }) } }
                  : {}),
                ...(providerId === "codex"
                  ? {
                      codex: {
                        readCredential: async () => ({ ok: true as const, accessToken: "fixture-token", accountId: "fixture-account" }),
                        readSessionSnapshot: async () => undefined,
                      },
                    }
                  : {}),
              },
            });
            if (sourceFetch === undefined) {
              return yield* Effect.die(`Missing source fetch for ${providerId}`);
            }
            const gated = createSourceGatedUsageFetchEffect({
              providerId,
              capability: capabilityFor(providerId, "usage"),
              sourceFetch,
            });
            yield* Effect.either(gated(request(providerId, "usage", windowOrPeriod)).pipe(Effect.provide(httpLayer)));
          }

          for (const providerId of balanceProviders) {
            const capability = capabilityFor(providerId, "balance");
            const sourceFetch = createBalanceProviderSourceFetchEffect(balanceSourceInput(providerId, sourceFlightRuntime));
            if (sourceFetch === undefined) {
              return yield* Effect.die(`Missing source fetch for ${providerId}`);
            }
            const gated = createSourceGatedBalanceFetchEffect({ providerId, capability, sourceFetch });
            yield* Effect.either(gated(request(providerId, "balance", capability.coverageKind)).pipe(Effect.provide(httpLayer)));
          }
        }),
      ),
    );

    for (const providerId of [...usageProviders, ...balanceProviders]) {
      const sourceIndex = governor.events.indexOf(`source:${providerId}`);
      const permitIndex = governor.events.indexOf(`permit:${providerId}`);
      const httpIndex = governor.events.indexOf(`http:${providerId}`);
      expect(sourceIndex, `${providerId} must acquire source admission`).toBeGreaterThanOrEqual(0);
      expect(permitIndex, `${providerId} must acquire a fresh attempt permit`).toBeGreaterThan(sourceIndex);
      expect(httpIndex, `${providerId} must start HTTP only after its permit`).toBeGreaterThan(permitIndex);
    }
    expect(governor.events.filter((event) => event === "permit:claude-code")).toHaveLength(2);
    expect(governor.events.filter((event) => event === "permit:codex")).toHaveLength(2);
    expect(governor.settlements).toHaveLength(16);
  });

  it("fails closed at the source gate when the runtime capability is absent", async () => {
    const sourceFetch = createBalanceProviderSourceFetchEffect({
      providerId: "fal",
      baseUrl: "https://provider.example.test",
      resolveCredential: async () => ({ ok: true as const, value: { value: Redacted.make("fixture-credential") } }),
    });
    const httpStarts: string[] = [];
    const httpLayer = responseLayer(httpStarts, [{ body: { credits: { current_balance: 1 } } }]);
    const result = await Effect.runPromise(
      Effect.either(
        createSourceGatedBalanceFetchEffect({
          providerId: "fal",
          capability: capabilityFor("fal", "balance"),
          ...(sourceFetch === undefined ? {} : { sourceFetch }),
        })(request("fal", "balance", "evergreen")).pipe(Effect.provide(httpLayer)),
      ),
    );

    expect(result._tag).toBe("Left");
    expect(httpStarts).toEqual([]);
  });

  it("maps a Usage governor block at dispatch to the existing scheduler-safe failure without starting HTTP", async () => {
    const governor = recordedGovernor({ blockSource: true });
    const httpStarts: string[] = [];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const sourceFetch = createUsageProviderSourceFetchEffect({
            ...usageSourceInput("claude-code", sourceFlightRuntime),
            localSources: {
              claudeCode: {
                readCredential: async () => ({ ok: true as const, accessToken: "fixture-token" }),
              },
            },
          });
          if (sourceFetch === undefined) {
            return yield* Effect.die("Missing Usage source fetch");
          }
          return yield* Effect.either(
            sourceFetch(request("claude-code", "usage", "five-hour")).pipe(
              Effect.provide(responseLayer(httpStarts, [])),
            ),
          );
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        failure: {
          category: "rate-limited",
          diagnostics: {
            boundary: "provider-request-governor",
            reasonCode: "fixture-governor-blocked",
          },
        },
        retry: { retryAfterSeconds: 17 },
      },
    });
    expect(httpStarts).toEqual([]);
  });

  it("maps a Balance governor block at dispatch to the existing scheduler-safe failure without starting HTTP", async () => {
    const governor = recordedGovernor({ blockSource: true });
    const httpStarts: string[] = [];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const sourceFetch = createBalanceProviderSourceFetchEffect(balanceSourceInput("fal", sourceFlightRuntime));
          if (sourceFetch === undefined) {
            return yield* Effect.die("Missing Balance source fetch");
          }
          return yield* Effect.either(
            sourceFetch(request("fal", "balance", "evergreen")).pipe(Effect.provide(responseLayer(httpStarts, []))),
          );
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        failure: {
          category: "rate-limited",
          diagnostics: {
            boundary: "provider-request-governor",
            reasonCode: "fixture-governor-blocked",
          },
        },
        retry: { retryAfterSeconds: 17 },
      },
    });
    expect(httpStarts).toEqual([]);
  });

  it("preserves fresh permits for pagination, discovery, and Runpod's dependent calls", async () => {
    const governor = recordedGovernor();
    const scenarios = [
      {
        providerId: "anthropic-api" as const,
        responses: [
          {
            body: {
              data: [
                {
                  starting_at: "2026-07-01T00:00:00Z",
                  ending_at: "2026-07-02T00:00:00Z",
                  results: [{ amount: "1", currency: "USD" }],
                },
              ],
              has_more: true,
              next_page: "next",
            },
          },
          {
            body: {
              data: [
                {
                  starting_at: "2026-07-02T00:00:00Z",
                  ending_at: "2026-07-03T00:00:00Z",
                  results: [{ amount: "1", currency: "USD" }],
                },
              ],
              has_more: false,
              next_page: null,
            },
          },
        ],
      },
      {
        providerId: "openai-api" as const,
        responses: [
          { body: { data: [], has_more: true, next_page: "next" } },
          { body: { data: [], has_more: false, next_page: null } },
        ],
      },
      {
        providerId: "deepgram" as const,
        responses: [{ body: [{ project_id: "project-a" }] }, { body: { balances: [{ amount: 1, units: "USD" }] } }],
      },
      {
        providerId: "exa" as const,
        responses: [
          { body: { apiKeys: [{ id: "key-a" }] } },
          {
            body: {
              period: { start: "2026-07-01", end: "2026-07-15" },
              total_cost_usd: 1,
              cost_breakdown: [],
              metadata: { generated_at: "2026-07-15T00:00:00Z" },
            },
          },
        ],
      },
      {
        providerId: "runpod" as const,
        responses: [{ body: [{ amount: 1 }] }, { body: [{ amount: 2 }] }],
      },
    ] as const;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
          for (const scenario of scenarios) {
            const capability = capabilityFor(scenario.providerId, "balance");
            const sourceFetch = createBalanceProviderSourceFetchEffect(balanceSourceInput(scenario.providerId, sourceFlightRuntime));
            if (sourceFetch === undefined) {
              return yield* Effect.die(`Missing source fetch for ${scenario.providerId}`);
            }
            const gated = createSourceGatedBalanceFetchEffect({ providerId: scenario.providerId, capability, sourceFetch });
            const outcome = yield* Effect.either(
              gated(request(scenario.providerId, "balance", capability.coverageKind)).pipe(
                Effect.provide(responseLayer(governor.events, scenario.responses)),
              ),
            );
            if (Either.isLeft(outcome)) {
              return yield* Effect.die(
                `Composite source failed for ${scenario.providerId}: ${outcome.left.failure.diagnostics.reasonCode}; ${governor.events.join(",")}`,
              );
            }
          }
        }),
      ),
    );

    for (const scenario of scenarios) {
      expect(governor.events.filter((event) => event === `permit:${scenario.providerId}`)).toHaveLength(2);
      expect(governor.events.filter((event) => event === `http:${scenario.providerId}`)).toHaveLength(2);
    }
  });
});
