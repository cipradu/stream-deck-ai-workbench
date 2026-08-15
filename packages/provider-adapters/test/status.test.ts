import {
  Headers as PlatformHeaders,
  HttpClientError,
  HttpClient as PlatformHttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Either, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_BOUNDED_JSON_RESPONSE_BYTES,
} from "../../http/src/index.js";
import {
  serializeSchedulerKey,
  type SchedulerKeyParts,
  type SourceRequestIdentityInput,
  type StatusProviderId,
} from "../../contracts/src/index.js";
import type {
  GovernorSourceLease,
  ProviderRequestGovernorService,
  SchedulerFetchRequest,
} from "../../scheduler/src/index.js";
import {
  resolveProviderCapability,
  type StatusProviderCapabilityMetadata,
} from "../../provider-registry/src/index.js";

import {
  createSourceGatedStatusFetch,
  createStatusProviderSourceFetchEffect,
  findProviderAdapterBinding,
  listStatusProviderAdapterBindings,
} from "../src/index.js";
import { makeAdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";

interface RecordedGovernor {
  readonly events: string[];
  readonly sourceIdentities: SourceRequestIdentityInput[];
  readonly service: ProviderRequestGovernorService;
}

function recordedGovernor(): RecordedGovernor {
  const events: string[] = [];
  const sourceIdentities: SourceRequestIdentityInput[] = [];
  const service: ProviderRequestGovernorService = {
    acquireSource: (identity) => {
      sourceIdentities.push(identity);
      events.push(`source:${identity.rateLimitScope.providerId}`);
      const lease: GovernorSourceLease = {
        acquireAttempt: () =>
          Effect.sync(() => {
            events.push(`permit:${identity.rateLimitScope.providerId}`);
          }).pipe(Effect.as({ release: () => Effect.void })),
        reportRateLimit: (notice) =>
          Effect.sync(() => {
            events.push(`rate-limit:${notice.retryAfterSeconds ?? "none"}`);
          }),
        settle: () => Effect.void,
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
  return { events, sourceIdentities, service };
}

function statusRequest(providerId: StatusProviderId): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId: "status",
    providerId,
    credentialProfileId: "none",
  };
  const schedulerKey = serializeSchedulerKey(keyParts);
  return {
    schedulerKey,
    key: schedulerKey,
    keyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: 1_000,
    signal: new AbortController().signal,
  };
}

function statusCapability(providerId: StatusProviderId): StatusProviderCapabilityMetadata {
  const capability = resolveProviderCapability(providerId, "status")?.capability;
  if (capability === undefined) {
    throw new Error(`Missing ${providerId} Status capability fixture`);
  }
  return capability;
}

type FakeExecute = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

function respondJson(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): FakeExecute {
  return (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    );
}

async function runStatusSource(
  providerId: StatusProviderId,
  execute: FakeExecute,
  sourceRequest = statusRequest(providerId),
) {
  const governor = recordedGovernor();
  const captured: HttpClientRequest.HttpClientRequest[] = [];
  const httpLayer = Layer.succeed(
    PlatformHttpClient.HttpClient,
    PlatformHttpClient.make((request) => {
      captured.push(request);
      return execute(request);
    }),
  );
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
        const runFetch = createStatusProviderSourceFetchEffect({
          providerId,
          sourceFlightRuntime: sourceFlightRuntime.capability,
        });
        if (runFetch === undefined) {
          return yield* Effect.die(`Missing ${providerId} Status source binding`);
        }
        return yield* Effect.either(runFetch(sourceRequest).pipe(Effect.provide(httpLayer)));
      }),
    ),
  );
  return { captured, governor, outcome };
}

describe("governed Status provider sources", () => {
  it("exposes explicit bindings for the exact four approved Status providers", () => {
    expect(
      listStatusProviderAdapterBindings().map((binding) => ({
        adapterBindingId: binding.adapterBindingId,
        providerId: binding.providerId,
        credentialClass: binding.credentialClass,
        sourceAccess: binding.sourceAccess,
      })),
    ).toEqual([
      {
        adapterBindingId: "status.anthropic-api",
        providerId: "anthropic-api",
        credentialClass: "none",
        sourceAccess: "source-fetch",
      },
      {
        adapterBindingId: "status.openai-api",
        providerId: "openai-api",
        credentialClass: "none",
        sourceAccess: "source-fetch",
      },
      {
        adapterBindingId: "status.moonshot",
        providerId: "moonshot",
        credentialClass: "none",
        sourceAccess: "source-fetch",
      },
      {
        adapterBindingId: "status.minimax",
        providerId: "minimax",
        credentialClass: "none",
        sourceAccess: "source-fetch",
      },
    ]);
    expect(findProviderAdapterBinding("status.anthropic-api")).toMatchObject({
      providerId: "anthropic-api",
      actionFamilyId: "status",
      fetchAllowed: true,
      retryOwner: "scheduler",
      errorOwner: "shared-errors",
    });
  });

  it("delegates a matching Status request through the public source gate and rejects hidden window semantics", async () => {
    let sourceCalls = 0;
    const snapshot = {
      familyId: "status",
      providerId: "anthropic-api",
      activeIncidentCount: 0,
      fetchedAtEpochMs: 1_000,
    } as const;
    const runFetch = createSourceGatedStatusFetch({
      providerId: "anthropic-api",
      capability: statusCapability("anthropic-api"),
      sourceFetch: async () => {
        sourceCalls += 1;
        return { ok: true, snapshot };
      },
    });

    await expect(Promise.resolve(runFetch(statusRequest("anthropic-api")))).resolves.toEqual({ ok: true, snapshot });
    const validRequest = statusRequest("anthropic-api");
    const invalidRequest: SchedulerFetchRequest = {
      ...validRequest,
      keyParts: { ...validRequest.keyParts, windowOrPeriod: "five-hour" },
    };
    await expect(Promise.resolve(runFetch(invalidRequest))).resolves.toMatchObject({
      ok: false,
      failure: { diagnostics: { reasonCode: "unsupported-status-source" } },
    });
    expect(sourceCalls).toBe(1);
  });

  it("Anthropic Status performs one bounded GET without credentials and returns a zero-incident snapshot", async () => {
    const { captured, governor, outcome } = await runStatusSource(
      "anthropic-api",
      respondJson({ incidents: [] }),
    );
    const snapshot = Option.getOrThrow(Either.getRight(outcome));

    expect(snapshot).toEqual({
      familyId: "status",
      providerId: "anthropic-api",
      activeIncidentCount: 0,
      fetchedAtEpochMs: 1_000,
    });
    expect(governor.events).toEqual(["source:anthropic-api", "permit:anthropic-api"]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("GET");
    expect(String(captured[0]?.url)).toBe("https://status.claude.com/api/v2/summary.json");
    for (const header of ["authorization", "cookie", "x-api-key"]) {
      expect(PlatformHeaders.get(captured[0]!.headers, header)).toStrictEqual(Option.none());
    }
  });

  it.each([
    ["anthropic-api", "https://status.claude.com/api/v2/summary.json"],
    ["openai-api", "https://status.openai.com/api/v2/summary.json"],
    ["moonshot", "https://status.moonshot.cn/api/v2/summary.json"],
    ["minimax", "https://status.minimax.io/api/v2/summary.json"],
  ] as const)("%s uses its exact immutable credential-free endpoint", async (providerId, endpointUrl) => {
    const responseBody = providerId === "openai-api"
      ? { status: { indicator: "none" }, incidents: [] }
      : { incidents: [] };
    const { captured, governor, outcome } = await runStatusSource(providerId, respondJson(responseBody));

    expect(Either.isRight(outcome)).toBe(true);
    expect(governor.events).toEqual([`source:${providerId}`, `permit:${providerId}`]);
    expect(governor.sourceIdentities).toEqual([
      {
        rateLimitScope: {
          providerId,
          credentialProfileId: "none",
          credentialGeneration: 0,
          rateLimitDomain: "provider-profile",
        },
        sourceIdentity: "public-status-summary",
        normalizedRequestVariant: "summary",
      },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("GET");
    expect(String(captured[0]?.url)).toBe(endpointUrl);
    for (const header of ["authorization", "cookie", "x-api-key"]) {
      expect(PlatformHeaders.get(captured[0]!.headers, header)).toStrictEqual(Option.none());
    }
  });

  it("accepts OpenAI's no-active-incident envelope without defaulting aggregate status", async () => {
    const { outcome } = await runStatusSource(
      "openai-api",
      respondJson({ status: { indicator: "none" } }),
    );

    expect(outcome).toEqual(
      Either.right({
        familyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 0,
        providerStatusIndicator: "none",
        fetchedAtEpochMs: 1_000,
      }),
    );
  });

  it.each(["none", "maintenance", "minor", "major", "critical"] as const)(
    "preserves exact OpenAI aggregate indicator %s when incidents are absent",
    async (indicator) => {
      const { outcome } = await runStatusSource(
        "openai-api",
        respondJson({ status: { indicator } }),
      );

      expect(Option.getOrThrow(Either.getRight(outcome))).toEqual({
        familyId: "status",
        providerId: "openai-api",
        activeIncidentCount: 0,
        providerStatusIndicator: indicator,
        fetchedAtEpochMs: 1_000,
      });
    },
  );

  it("accepts OpenAI's reduced envelope and discards unknown top-level and incident fields", async () => {
    const { outcome } = await runStatusSource(
      "openai-api",
      respondJson({
        status: { indicator: "minor" },
        incidents: [
          {
            status: "investigating",
            impact: "none",
            ignored_field: { nested: true },
          },
        ],
        ignored_envelope_field: true,
      }),
    );

    expect(Option.getOrThrow(Either.getRight(outcome))).toEqual({
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 1,
      highestImpact: "none",
      providerStatusIndicator: "minor",
      fetchedAtEpochMs: 1_000,
    });
  });

  it("decodes known maintenance data and lets Status policy exclude inactive and maintenance incidents", async () => {
    const { outcome } = await runStatusSource(
      "moonshot",
      respondJson({
        incidents: [
          { status: "investigating", impact: "none" },
          { status: "identified", impact: "minor" },
          { status: "monitoring", impact: "major" },
          { status: "resolved", impact: "critical" },
          { status: "postmortem", impact: "critical" },
          { status: "scheduled", impact: "maintenance" },
          { status: "in_progress", impact: "minor" },
          { status: "verifying", impact: "major" },
          { status: "completed", impact: "critical" },
          { status: "monitoring", impact: "maintenance" },
        ],
        components: [{ status: "major_outage" }],
        page: { status: "major_outage" },
        scheduled_maintenances: [{ status: "in_progress" }],
      }),
    );

    expect(Option.getOrThrow(Either.getRight(outcome))).toEqual({
      familyId: "status",
      providerId: "moonshot",
      activeIncidentCount: 3,
      highestImpact: "major",
      fetchedAtEpochMs: 1_000,
    });
  });

  it("keeps OpenAI aggregate status separate while filtering exact incident lifecycle and impact values", async () => {
    const { outcome } = await runStatusSource(
      "openai-api",
      respondJson({
        status: { indicator: "critical" },
        incidents: [
          { status: "investigating", impact: "none" },
          { status: "identified", impact: "minor" },
          { status: "monitoring", impact: "major" },
          { status: "resolved", impact: "critical" },
          { status: "postmortem", impact: "critical" },
          { status: "scheduled", impact: "maintenance" },
          { status: "in_progress", impact: "minor" },
          { status: "verifying", impact: "major" },
          { status: "completed", impact: "critical" },
          { status: "monitoring", impact: "maintenance" },
        ],
      }),
    );

    expect(Option.getOrThrow(Either.getRight(outcome))).toEqual({
      familyId: "status",
      providerId: "openai-api",
      activeIncidentCount: 3,
      highestImpact: "major",
      providerStatusIndicator: "critical",
      fetchedAtEpochMs: 1_000,
    });
  });

  it.each(["none", "minor", "major", "critical"] as const)(
    "preserves active %s impact in the normalized snapshot",
    async (impact) => {
      const { outcome } = await runStatusSource(
        "anthropic-api",
        respondJson({ incidents: [{ status: "monitoring", impact }] }),
      );

      expect(Option.getOrThrow(Either.getRight(outcome))).toMatchObject({
        activeIncidentCount: 1,
        highestImpact: impact,
      });
    },
  );

  it.each([
    ["missing incidents", {}],
    ["wrong incidents type", { incidents: "invalid" }],
    ["missing status", { incidents: [{ impact: "minor" }] }],
    ["missing impact", { incidents: [{ status: "monitoring" }] }],
    ["unknown status", { incidents: [{ status: "observing", impact: "minor" }] }],
    ["unknown impact", { incidents: [{ status: "monitoring", impact: "severe" }] }],
    ["wrong consumed type", { incidents: [{ status: 1, impact: "minor" }] }],
  ] as const)("maps %s to sanitized validation drift without false green", async (_label, body) => {
    const serializedBody = JSON.stringify(body);
    const { outcome } = await runStatusSource("minimax", respondJson(body));
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure.category).toBe("validation-drift");
    expect(failure.failure.sanitized).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(serializedBody);
  });

  it.each([
    ["missing status", {}],
    ["missing indicator", { status: {} }],
    ["unknown indicator", { status: { indicator: "degraded" } }],
    ["wrong indicator type", { status: { indicator: 1 } }],
    ["wrong incidents type", { status: { indicator: "none" }, incidents: "invalid" }],
    [
      "unknown lifecycle",
      { status: { indicator: "none" }, incidents: [{ status: "observing", impact: "minor" }] },
    ],
    [
      "missing present-incident impact",
      { status: { indicator: "none" }, incidents: [{ status: "monitoring" }] },
    ],
  ] as const)("maps OpenAI %s to sanitized validation drift", async (_label, body) => {
    const serializedBody = JSON.stringify(body);
    const { outcome } = await runStatusSource("openai-api", respondJson(body));
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure).toMatchObject({
      category: "validation-drift",
      sanitized: true,
      diagnostics: { reasonCode: "response-json-schema-mismatch" },
    });
    expect(JSON.stringify(failure)).not.toContain(serializedBody);
  });

  it.each(["anthropic-api", "moonshot", "minimax"] as const)(
    "%s keeps incidents required while ignoring malformed unconsumed page and component fields",
    async (providerId) => {
      const incidents = [{ status: "monitoring", impact: "minor" }] as const;
      const baseline = await runStatusSource(providerId, respondJson({ incidents }));
      const withMalformedUnconsumedFields = await runStatusSource(
        providerId,
        respondJson({
          incidents,
          status: { indicator: { malformed: true } },
          page: "malformed",
          components: { malformed: true },
        }),
      );
      const missingIncidents = await runStatusSource(
        providerId,
        respondJson({
          status: { indicator: "none" },
          components: [],
        }),
      );
      const baselineSnapshot = Option.getOrThrow(Either.getRight(baseline.outcome));
      const malformedSnapshot = Option.getOrThrow(Either.getRight(withMalformedUnconsumedFields.outcome));
      const missingFailure = Option.getOrThrow(Either.getLeft(missingIncidents.outcome));

      expect(malformedSnapshot).toEqual(baselineSnapshot);
      expect(malformedSnapshot).not.toHaveProperty("providerStatusIndicator");
      expect(missingFailure.failure).toMatchObject({
        category: "validation-drift",
        sanitized: true,
        diagnostics: { reasonCode: "response-json-schema-mismatch" },
      });
    },
  );

  it.each([401, 403] as const)("maps credential-free HTTP %i to generic HTTP status failure", async (status) => {
    const { outcome } = await runStatusSource("anthropic-api", respondJson({}, status));
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure).toMatchObject({
      category: "http-status-failure",
      retryClass: "transient-retry",
      diagnostics: {
        httpStatus: status,
        httpStatusClass: "4xx",
        reasonCode: "provider-http-status",
      },
    });
    expect(failure.failure.safePublicMessage).not.toMatch(/credential|auth|access denied/i);
  });

  it.each([500, 503] as const)("preserves HTTP %i as the existing provider-unavailable failure", async (status) => {
    const { outcome } = await runStatusSource("moonshot", respondJson({}, status));
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure).toMatchObject({
      category: "provider-unavailable",
      retryClass: "transient-retry",
      diagnostics: {
        httpStatus: status,
        httpStatusClass: "5xx",
        reasonCode: "provider-http-status",
      },
    });
  });

  it("maps malformed JSON to sanitized validation drift without leaking response text", async () => {
    const rawBody = "not-json-sensitive-sentinel";
    const { outcome } = await runStatusSource("minimax", (request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(rawBody, { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ),
    );
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure.category).toBe("validation-drift");
    expect(JSON.stringify(failure)).not.toContain(rawBody);
  });

  it("keeps repeated direct adapter calls as independent governed attempts", async () => {
    const governor = recordedGovernor();
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make((request) => {
        captured.push(request);
        return respondJson({ incidents: [] })(request);
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
          const runFetch = createStatusProviderSourceFetchEffect({
            providerId: "anthropic-api",
            sourceFlightRuntime: sourceFlightRuntime.capability,
          });
          if (runFetch === undefined) {
            return yield* Effect.die("Missing Anthropic Status source binding");
          }
          yield* runFetch(statusRequest("anthropic-api")).pipe(Effect.provide(httpLayer));
          yield* runFetch(statusRequest("anthropic-api")).pipe(Effect.provide(httpLayer));
        }),
      ),
    );

    expect(captured).toHaveLength(2);
    expect(governor.events).toEqual([
      "source:anthropic-api",
      "permit:anthropic-api",
      "source:anthropic-api",
      "permit:anthropic-api",
    ]);
  });

  it("maps an over-cap response to validation drift before JSON decode", async () => {
    const rawBody = "x".repeat(MAX_BOUNDED_JSON_RESPONSE_BYTES + 1);
    const { outcome } = await runStatusSource("openai-api", (request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(rawBody, { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ),
    );
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure.category).toBe("validation-drift");
    expect(failure.failure.diagnostics.reasonCode).toBe("response-body-too-large");
    expect(JSON.stringify(failure)).not.toContain(rawBody);
  });

  it("preserves active caller abort as the existing typed abort failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = { ...statusRequest("minimax"), signal: controller.signal };
    const { outcome } = await runStatusSource("minimax", () => Effect.never, request);
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure).toMatchObject({
      category: "abort",
      retryClass: "transient-retry",
      diagnostics: { reasonCode: "request-aborted" },
    });
  });

  it("preserves a stalled request deadline as the existing typed timeout failure", async () => {
    const governor = recordedGovernor();
    const started = Promise.withResolvers<void>();
    const httpLayer = Layer.succeed(
      PlatformHttpClient.HttpClient,
      PlatformHttpClient.make(() => {
        started.resolve();
        return Effect.never;
      }),
    );
    const program = Effect.scoped(
      Effect.gen(function* () {
        const sourceFlightRuntime = yield* makeAdapterSourceFlightRuntime(governor.service);
        const runFetch = createStatusProviderSourceFetchEffect({
          providerId: "moonshot",
          sourceFlightRuntime: sourceFlightRuntime.capability,
        });
        if (runFetch === undefined) {
          return yield* Effect.die("Missing Moonshot Status source binding");
        }
        const fiber = yield* Effect.fork(
          Effect.either(runFetch(statusRequest("moonshot")).pipe(Effect.provide(httpLayer))),
        );
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust(Duration.seconds(30));
        return yield* Fiber.join(fiber);
      }),
    );

    const outcome = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
    const failure = Option.getOrThrow(Either.getLeft(outcome));
    expect(failure.failure).toMatchObject({
      category: "timeout",
      diagnostics: { reasonCode: "request-timeout" },
    });
  });

  it("preserves rate-limit retry metadata and reports only the safe cooldown notice", async () => {
    const { governor, outcome } = await runStatusSource(
      "openai-api",
      respondJson({}, 429, { "retry-after": "12" }),
    );
    const failure = Option.getOrThrow(Either.getLeft(outcome));

    expect(failure.failure.category).toBe("rate-limited");
    expect(failure.retry).toEqual({ retryAfterSeconds: 12 });
    expect(governor.events).toContain("rate-limit:12");
  });
});
