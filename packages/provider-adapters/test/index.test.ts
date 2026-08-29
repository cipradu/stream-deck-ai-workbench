import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Option, Redacted, Schema, TestClock, TestContext } from "effect";
import {
  Headers as PlatformHeaders,
  HttpClientError,
  HttpClient as PlatformHttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { describe, expect, it } from "vitest";

import {
  BALANCE_METRIC_KINDS,
  BALANCE_PROVIDER_IDS,
  METRIC_KIND_DIRECTION,
  METRIC_KIND_UNIT,
  STATUS_PROVIDER_IDS,
  USAGE_PROVIDER_IDS,
  serializeSchedulerKey,
  type BalanceMetricKind,
  type BalanceProviderId,
  type BalanceSnapshot,
  type CoverageKind,
  type MetricSnapshot,
  type NormalizedSnapshot,
  type ProviderId,
  type SchedulerKeyParts,
  type UsageProviderId,
  type UsageWindowId,
} from "../../contracts/src/index.js";
import { mapProviderFailure } from "../../errors/src/index.js";
import { findProviderEntry, type ProviderCapabilityMetadata } from "../../provider-registry/src/index.js";
import type { SchedulerFetchRequest } from "../../scheduler/src/index.js";

import {
  createSourceGatedBalanceFetch,
  createSourceGatedUsageFetch,
  findProviderAdapterBinding,
  listBalanceProviderAdapterBindings,
  listUsageProviderAdapterBindings,
  normalizeBalanceProviderResponse,
  packageName,
  type ClaudeCodeCredentialResult,
  type CodexCredentialResult,
  type CodexSessionSnapshot,
} from "../src/index.js";
import { bridgeEffectSchedulerFetch } from "./effect-fetch-bridge.js";
import {
  defineAdapterSourceOperation,
  ProviderAdapterAttemptContext,
  governedRequestJsonSchema,
} from "../src/governed-request.js";
import { monthStartDateString, monthStartEpochMs } from "../src/balance-normalization.js";
import { anthropicApiBalanceProviderModule } from "../src/providers/balance/anthropic-api/index.js";
import { deepgramBalanceProviderModule } from "../src/providers/balance/deepgram/index.js";
import { deepseekBalanceProviderModule } from "../src/providers/balance/deepseek/index.js";
import { elevenlabsBalanceProviderModule } from "../src/providers/balance/elevenlabs/index.js";
import { exaBalanceProviderModule } from "../src/providers/balance/exa/index.js";
import { falBalanceProviderModule } from "../src/providers/balance/fal/index.js";
import { jinaBalanceProviderModule } from "../src/providers/balance/jina/index.js";
import { moonshotBalanceProviderModule } from "../src/providers/balance/moonshot/index.js";
import { openAiApiBalanceProviderModule } from "../src/providers/balance/openai-api/index.js";
import { openrouterBalanceProviderModule } from "../src/providers/balance/openrouter/index.js";
import { runpodBalanceProviderModule } from "../src/providers/balance/runpod/index.js";
import { speechmaticsBalanceProviderModule } from "../src/providers/balance/speechmatics/index.js";
import { tavilyBalanceProviderModule } from "../src/providers/balance/tavily/index.js";
import { claudeCodeUsageProviderModule } from "../src/providers/usage/claude-code/index.js";
import { codexUsageProviderModule } from "../src/providers/usage/codex/index.js";
import { minimaxUsageProviderModule } from "../src/providers/usage/minimax/index.js";
import { zaiCodingPlanUsageProviderModule } from "../src/providers/usage/zai-coding-plan/index.js";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function providerModulePaths(
  familyId: "usage" | "balance" | "status",
  providerIds: readonly string[],
): readonly string[] {
  return providerIds.map((providerId) => join(sourceRoot, "providers", familyId, providerId, "index.ts"));
}

function providerCapabilityEntries(familyId: "usage" | "balance" | "status"): readonly string[] {
  const familyRoot = join(sourceRoot, "providers", familyId);
  if (!existsSync(familyRoot)) {
    return [];
  }

  return readdirSync(familyRoot).sort();
}

function providerTreeEntries(
  root = join(sourceRoot, "providers"),
): readonly {
  readonly path: string;
  readonly kind: "directory" | "file";
}[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      return [{ path: entryPath, kind: "directory" as const }, ...providerTreeEntries(entryPath)];
    }

    return [{ path: entryPath, kind: "file" as const }];
  });
}

function isExpectedProviderModule(modulePath: string): boolean {
  const expectedModules = new Set([
    ...providerModulePaths("usage", USAGE_PROVIDER_IDS),
    ...providerModulePaths("balance", BALANCE_PROVIDER_IDS),
    ...providerModulePaths("status", STATUS_PROVIDER_IDS),
  ]);

  return expectedModules.has(modulePath);
}

function isProviderFamilyIndex(modulePath: string): boolean {
  return (
    modulePath === join(sourceRoot, "providers", "usage", "index.ts") ||
    modulePath === join(sourceRoot, "providers", "balance", "index.ts") ||
    modulePath === join(sourceRoot, "providers", "status", "index.ts") ||
    modulePath === join(sourceRoot, "providers", "index.ts")
  );
}

function countGovernedHelperCalls(modulePath: string): number {
  const source = readFileSync(modulePath, "utf8");
  return [...source.matchAll(/\bgoverned(?:RequestJsonSchema|RequestTextBody|ExecuteRequest)\s*\(/g)].length;
}

function directProviderHelperCallLocations(): readonly string[] {
  const directHelperCall = /\b(?:requestJsonSchema|requestTextBody|executeRequest)\s*\(/g;
  const sanctionedModules = new Set([join(sourceRoot, "governed-request.ts")]);

  return providerTreeEntries(sourceRoot)
    .filter((entry) => entry.kind === "file" && entry.path.endsWith(".ts"))
    .flatMap((entry) => {
      const matchCount = [...readFileSync(entry.path, "utf8").matchAll(directHelperCall)].length;
      return matchCount === 0 || sanctionedModules.has(entry.path)
        ? []
        : [`${relative(sourceRoot, entry.path)} (${matchCount})`];
    });
}

function usageCapability(providerId: UsageProviderId): ProviderCapabilityMetadata {
  const capability = findProviderEntry(providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "usage");
  expect(capability).toBeDefined();
  return capability as ProviderCapabilityMetadata;
}

function balanceCapability(providerId: BalanceProviderId): ProviderCapabilityMetadata {
  const capability = findProviderEntry(providerId)?.capabilities.find((candidate) => candidate.actionFamilyId === "balance");
  expect(capability).toBeDefined();
  return capability as ProviderCapabilityMetadata;
}

function usageRequest(providerId: UsageProviderId, windowOrPeriod: UsageWindowId): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId: "usage",
    providerId,
    windowOrPeriod,
    credentialProfileId: "none",
  };

  return schedulerRequest(keyParts);
}

function balanceRequest(providerId: BalanceProviderId, windowOrPeriod?: CoverageKind): SchedulerFetchRequest {
  const keyParts: SchedulerKeyParts = {
    familyId: "balance",
    providerId,
    credentialProfileId: "none",
    ...(windowOrPeriod === undefined ? {} : { windowOrPeriod }),
  };

  return schedulerRequest(keyParts);
}

function schedulerRequest(keyParts: SchedulerKeyParts): SchedulerFetchRequest {
  return {
    schedulerKey: serializeSchedulerKey(keyParts),
    key: serializeSchedulerKey(keyParts),
    keyParts,
    trigger: "healthy-poll",
    startedAtEpochMs: 1_000,
    signal: {
      aborted: false,
      addEventListener: () => undefined,
    },
  };
}

function normalize(providerId: BalanceProviderId, response: unknown) {
  return normalizeBalanceProviderResponse({
    providerId,
    response,
    fetchedAtEpochMs: 2_000,
  });
}

function expectNormalizedSnapshot(input: {
  readonly providerId: BalanceProviderId;
  readonly response: unknown;
  readonly metricKind: BalanceMetricKind;
  readonly coverageKind: CoverageKind;
  readonly value: number;
  readonly currencyCode?: string;
}) {
  const result = normalize(input.providerId, input.response);

  expect(result).toMatchObject({
    ok: true,
    snapshot: {
      familyId: "balance",
      providerId: input.providerId,
      metricKind: input.metricKind,
      metricDirection: METRIC_KIND_DIRECTION[input.metricKind],
      unit: METRIC_KIND_UNIT[input.metricKind],
      coverage: { kind: input.coverageKind },
      value: input.value,
      fetchedAtEpochMs: 2_000,
    },
    ...(input.currencyCode === undefined ? {} : { currencyCode: input.currencyCode }),
  });
}

function fakeBalanceSnapshot(providerId: BalanceProviderId): BalanceSnapshot {
  const capability = balanceCapability(providerId);
  if (!isBalanceMetricKind(capability.metricKind)) {
    throw new Error(`Expected a Balance metric kind for ${providerId}`);
  }
  return {
    familyId: "balance",
    providerId,
    metricKind: capability.metricKind,
    metricDirection: METRIC_KIND_DIRECTION[capability.metricKind],
    unit: METRIC_KIND_UNIT[capability.metricKind],
    coverage: coverageForKind(capability.coverageKind),
    value: 10,
    fetchedAtEpochMs: 1,
  };
}

function isBalanceMetricKind(metricKind: MetricSnapshot["metricKind"]): metricKind is BalanceMetricKind {
  return BALANCE_METRIC_KINDS.some((candidate) => candidate === metricKind);
}

function coverageForKind(coverageKind: CoverageKind): MetricSnapshot["coverage"] {
  switch (coverageKind) {
    case "month-to-date":
      return { kind: "month-to-date" };
    case "current-period":
      return { kind: "current-period" };
    case "evergreen":
      return { kind: "evergreen" };
    case "rolling-window":
      return { kind: "rolling-window", window: "five-hour" };
  }
}

describe("@ai-workbench/provider-adapters public surface", () => {
  it("exposes Usage and Balance adapter binding exports plus Balance response normalization", () => {
    expect(packageName).toBe("@ai-workbench/provider-adapters");
    expect(typeof listUsageProviderAdapterBindings).toBe("function");
    expect(typeof listBalanceProviderAdapterBindings).toBe("function");
    expect(typeof findProviderAdapterBinding).toBe("function");
    expect(typeof createSourceGatedUsageFetch).toBe("function");
    expect(typeof createSourceGatedBalanceFetch).toBe("function");
    expect(typeof normalizeBalanceProviderResponse).toBe("function");
  });
});

describe("provider request-helper census", () => {
  it("routes every current provider HTTP helper call through the only sanctioned wrapper", () => {
    const expectedGovernedCalls = new Map<string, number>([
      ["providers/usage/zai-coding-plan/index.ts", 1],
      ["providers/usage/minimax/index.ts", 1],
      ["providers/usage/codex/index.ts", 2],
      ["providers/usage/claude-code/index.ts", 1],
      ["providers/balance/anthropic-api/index.ts", 1],
      ["providers/balance/openai-api/index.ts", 1],
      ["providers/balance/jina/index.ts", 1],
      ["providers/balance/tavily/index.ts", 1],
      ["providers/balance/speechmatics/index.ts", 1],
      ["providers/balance/elevenlabs/index.ts", 1],
      ["providers/balance/runpod/index.ts", 2],
      ["providers/balance/deepseek/index.ts", 1],
      ["providers/balance/deepgram/index.ts", 2],
      ["providers/balance/fal/index.ts", 1],
      ["providers/balance/exa/index.ts", 2],
      ["providers/balance/moonshot/index.ts", 1],
      ["providers/balance/openrouter/index.ts", 1],
    ]);

    expect([...expectedGovernedCalls.values()].reduce((total, count) => total + count, 0)).toBe(21);
    expect(directProviderHelperCallLocations()).toEqual([]);

    for (const [modulePath, expectedCount] of expectedGovernedCalls) {
      expect(countGovernedHelperCalls(join(sourceRoot, modulePath)), modulePath).toBe(expectedCount);
    }
  });
});

const ANTHROPIC_SECRET = "sk-ant-fixture-secret-value";

function anthropicCostReportBody(overrides?: Record<string, unknown>): unknown {
  return {
    data: [
      {
        starting_at: "2026-07-01T00:00:00Z",
        ending_at: "2026-07-02T00:00:00Z",
        results: [
          { amount: "125", currency: "USD" },
          { amount: "50", currency: "USD" },
        ],
      },
    ],
    has_more: false,
    next_page: null,
    ...(overrides ?? {}),
  };
}

function anthropicEffectAdapterInput(
  nowMs = Date.UTC(2026, 6, 15),
): Parameters<typeof anthropicApiBalanceProviderModule.createSourceFetchEffect>[0] {
  return {
    providerId: "anthropic-api",    baseUrl: "https://api.anthropic.com",
    resolveCredential: async () => ({ ok: true, value: { value: Redacted.make(ANTHROPIC_SECRET) } }),
    now: () => nowMs,
  };
}

type FakeExecute = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

function recordingHttpClientLayer(
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
): Layer.Layer<PlatformHttpClient.HttpClient> {
  return Layer.succeed(
    PlatformHttpClient.HttpClient,
    PlatformHttpClient.make((request) => {
      captured.push(request);
      return execute(request);
    }),
  );
}

const CompositeAttemptSchema = Schema.Struct({
  step: Schema.String,
});

describe("governed provider HTTP attempts", () => {
  it("keeps a declared source result typed inside the adapter projection seam", async () => {
    const request = usageRequest("claude-code", "five-hour");
    const operation = defineAdapterSourceOperation({
      sourceIdentity: "fixture-source",
      normalizedRequestVariant: "five-hour",
      source: () => Effect.succeed({ utilization: 42 }),
      project: (sourceResult, sourceRequest) =>
        Effect.succeed<NormalizedSnapshot>({
          familyId: "usage",
          providerId: "claude-code",
          metricKind: "usage-percent",
          metricDirection: "upper-bound",
          unit: "percent",
          coverage: { kind: "rolling-window", window: sourceRequest.keyParts.windowOrPeriod as UsageWindowId },
          value: sourceResult.utilization,
          fetchedAtEpochMs: sourceRequest.startedAtEpochMs,
        }),
    });

    const projection = await Effect.runPromise(operation.project({ utilization: 42 }, request));

    expect(projection).toMatchObject({
      providerId: "claude-code",
      coverage: { kind: "rolling-window", window: "five-hour" },
      value: 42,
    });
  });

  it("starts a helper only with an installed permit context", async () => {
    let starts = 0;
    const httpLayer = recordingHttpClientLayer([], (request) => {
      starts += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ step: "ungoverned-compatibility" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    const result = await Effect.runPromise(
      governedRequestJsonSchema(
        { url: "https://provider.example.test/compatibility" },
        CompositeAttemptSchema,
      ).pipe(
        Effect.provide(httpLayer),
        Effect.provideService(ProviderAdapterAttemptContext, {
          attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
          reportRateLimit: () => Effect.void,
        }),
      ),
    );

    expect(result).toEqual({ step: "ungoverned-compatibility" });
    expect(starts).toBe(1);
  });

  it("obtains a fresh permit immediately before every JSON call in a composite source operation", async () => {
    const events: string[] = [];
    const context = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          events.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    let responseNumber = 0;
    const httpLayer = recordingHttpClientLayer([], (request) => {
      responseNumber += 1;
      events.push(`http-${responseNumber}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ step: `response-${responseNumber}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* governedRequestJsonSchema(
          { url: "https://provider.example.test/first" },
          CompositeAttemptSchema,
        );
        const second = yield* governedRequestJsonSchema(
          { url: "https://provider.example.test/second" },
          CompositeAttemptSchema,
        );
        return { first, second };
      }).pipe(
        Effect.provide(httpLayer),
        Effect.provideService(ProviderAdapterAttemptContext, context),
      ),
    );

    expect(result).toEqual({ first: { step: "response-1" }, second: { step: "response-2" } });
    expect(events).toEqual(["permit", "http-1", "permit", "http-2"]);
  });

  it("does not start a later composite HTTP call after the active context observes a 429", async () => {
    const events: string[] = [];
    let blockedFailure: unknown;
    const context = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          if (blockedFailure !== undefined) {
            events.push("blocked");
            return Effect.fail(blockedFailure as E);
          }
          events.push("permit");
          return operation.pipe(
            Effect.tapError((failure) =>
              Effect.sync(() => {
                blockedFailure = failure;
              }),
            ),
          );
        }),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    let starts = 0;
    const httpLayer = recordingHttpClientLayer([], (request) => {
      starts += 1;
      events.push(`http-${starts}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          }),
        ),
      );
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.either(
          governedRequestJsonSchema(
            { url: "https://provider.example.test/first" },
            CompositeAttemptSchema,
          ),
        );
        return yield* Effect.either(
          governedRequestJsonSchema(
            { url: "https://provider.example.test/second" },
            CompositeAttemptSchema,
          ),
        );
      }).pipe(
        Effect.provide(httpLayer),
        Effect.provideService(ProviderAdapterAttemptContext, context),
      ),
    );

    expect(starts).toBe(1);
    expect(events).toEqual(["permit", "http-1", "blocked"]);
  });
});

function respondJson(status: number, body: unknown, headers?: Readonly<Record<string, string>>): FakeExecute {
  return (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...(headers ?? {}) },
        }),
      ),
    );
}

function anthropicEffectSourceFetch(
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
  attemptContext?: ProviderAdapterAttemptContext,
  nowMs?: number,
) {
  const effectFetch = anthropicApiBalanceProviderModule.createSourceFetchEffect(anthropicEffectAdapterInput(nowMs));
  return bridgeEffectSchedulerFetch(
    attemptContext === undefined
      ? effectFetch
      : (request) => effectFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attemptContext)),
    recordingHttpClientLayer(captured, execute),
  );
}

describe("anthropic-api Effect-native adapter", () => {
  it("returns zero for the first UTC day without an Anthropic request", async () => {
    const nowMs = Date.UTC(2026, 7, 1, 12);
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const permits: string[] = [];
    const attemptContext = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          permits.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    const runFetch = anthropicEffectSourceFetch(
      captured,
      respondJson(400, { error: "invalid request" }),
      attemptContext,
      nowMs,
    );

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        providerId: "anthropic-api",
        metricKind: "current-month-spend",
        value: 0,
        fetchedAtEpochMs: nowMs,
        dataThroughEpochMs: monthStartEpochMs(nowMs),
      },
    });
    expect(captured).toHaveLength(0);
    expect(permits).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(ANTHROPIC_SECRET);
  });

  it("keeps the zero-without-request behavior through the final millisecond of the first UTC day", async () => {
    const nowMs = Date.UTC(2026, 7, 1, 23, 59, 59, 999);
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const permits: string[] = [];
    const attemptContext = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          permits.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    const runFetch = anthropicEffectSourceFetch(
      captured,
      respondJson(400, { error: "invalid request" }),
      attemptContext,
      nowMs,
    );

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        value: 0,
        fetchedAtEpochMs: nowMs,
        dataThroughEpochMs: monthStartEpochMs(nowMs),
      },
    });
    expect(captured).toHaveLength(0);
    expect(permits).toHaveLength(0);
  });

  it("resumes the normal Anthropic request path at UTC day two midnight", async () => {
    const nowMs = Date.UTC(2026, 7, 2);
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const permits: string[] = [];
    const attemptContext = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          permits.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    const response = anthropicCostReportBody({
      data: [
        {
          starting_at: "2026-08-01T00:00:00Z",
          ending_at: "2026-08-02T00:00:00Z",
          results: [
            { amount: "125", currency: "USD" },
            { amount: "50", currency: "USD" },
          ],
        },
      ],
    });
    const runFetch = anthropicEffectSourceFetch(captured, respondJson(200, response), attemptContext, nowMs);

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        value: 1.75,
        fetchedAtEpochMs: nowMs,
        dataThroughEpochMs: Date.UTC(2026, 7, 2),
      },
    });
    expect(captured).toHaveLength(1);
    expect(permits).toEqual(["permit"]);
    expect(captured[0]!.urlParams).toContainEqual(["starting_at", "2026-08-01T00:00:00Z"]);
  });

  it("fetches and decodes the vendor body at the source via the central one-read decoder into a normalized snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = anthropicEffectSourceFetch(captured, respondJson(200, anthropicCostReportBody()));

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "balance",
        providerId: "anthropic-api",
        metricKind: "current-month-spend",
        value: 1.75,
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain("/v1/organizations/cost_report");
  });

  it("carries the raw key in the x-api-key header via the single Redacted.value unwrap", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = anthropicEffectSourceFetch(captured, respondJson(200, anthropicCostReportBody()));

    await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(PlatformHeaders.get(captured[0]!.headers, "x-api-key")).toStrictEqual(Option.some(ANTHROPIC_SECRET));
    expect(PlatformHeaders.get(captured[0]!.headers, "anthropic-version")).toStrictEqual(Option.some("2023-06-01"));
  });

  it("keeps the credential redacted and never leaks the raw secret in a sanitized failure", async () => {
    const material = { value: Redacted.make(ANTHROPIC_SECRET) };
    expect(String(material.value)).toBe("<redacted>");
    expect(JSON.stringify(material)).not.toContain(ANTHROPIC_SECRET);

    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = anthropicEffectSourceFetch(captured, respondJson(401, { error: "unauthorized" }));
    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(ANTHROPIC_SECRET);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
  });

  it("surfaces the rate-limit Retry-After through the bridge for the scheduler", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = anthropicEffectSourceFetch(
      captured,
      respondJson(429, { error: "rate limited" }, { "retry-after": "30" }),
    );

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result).toMatchObject({
      ok: false,
      retry: { retryAfterSeconds: 30 },
      failure: { displayState: "rate-limited" },
    });
  });

  it("maps a credential-resolution failure to a sanitized failure without any HTTP call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const effectFetch = anthropicApiBalanceProviderModule.createSourceFetchEffect({
      providerId: "anthropic-api",      baseUrl: "https://api.anthropic.com",
      resolveCredential: async () => ({
        ok: false,
        failure: mapProviderFailure({ kind: "unknown", reasonCode: "missing" }),
      }),
      now: () => Date.UTC(2026, 6, 15),
    });
    const runFetch = bridgeEffectSchedulerFetch(effectFetch, recordingHttpClientLayer(captured, respondJson(200, {})));

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("stops cost-report pagination on a failing page N>1 and maps the tagged error to a provider-unavailable failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let page = 0;
    // Page 1 (N=1) reports more pages (has_more + a next_page cursor); page 2 (N>1) fails with a 5xx.
    const pagedThenFail: FakeExecute = (request) => {
      page += 1;
      return page === 1
        ? respondJson(200, anthropicCostReportBody({ has_more: true, next_page: "cursor-2" }))(request)
        : respondJson(503, { error: "service unavailable" })(request);
    };
    const runFetch = anthropicEffectSourceFetch(captured, pagedThenFail);

    const result = await runFetch(balanceRequest("anthropic-api", "month-to-date"));

    expect(result.ok).toBe(false);
    // The loop STOPPED at the failing second page: exactly two requests, no third page fetch.
    expect(captured).toHaveLength(2);
    // The failing request is page N>1 — it carries the pagination cursor; the first page did not.
    // (@effect/platform keeps query params in `urlParams`, not in the `.url` string.)
    expect(captured[0]!.urlParams.some(([key]) => key === "page")).toBe(false);
    expect(captured[1]!.urlParams.some(([key, value]) => key === "page" && value === "cursor-2")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(ANTHROPIC_SECRET);
    if (!result.ok) {
      // 5xx on the follow-up page maps through the shared Data.TaggedError taxonomy to provider-unavailable.
      expect(result.failure.displayState).toBe("provider-unavailable");
      expect(result.failure.retryClass).toBe("transient-retry");
    }
  });
});

const ZAI_SECRET = "fixture-zai-key-secret-value";

const zaiQuotaBody = {
  success: true,
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1_000_000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 55, nextResetTime: 2_000_000 },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 5 },
    ],
    level: "pro",
  },
} as const;

function zaiEffectAdapterInput(): Parameters<typeof zaiCodingPlanUsageProviderModule.createSourceFetchEffect>[0] {
  return {
    providerId: "zai-coding-plan",    baseUrl: "https://api.z.ai",
    resolveCredential: async () => ({ ok: true, value: { value: Redacted.make(ZAI_SECRET) } }),
    now: () => 3_000,
  };
}

function zaiEffectSourceFetch(captured: HttpClientRequest.HttpClientRequest[], execute: FakeExecute) {
  return bridgeEffectSchedulerFetch(
    zaiCodingPlanUsageProviderModule.createSourceFetchEffect(zaiEffectAdapterInput()),
    recordingHttpClientLayer(captured, execute),
  );
}

describe("zai-coding-plan Effect-native usage adapter", () => {
  it("fetches + decodes the quota body at the source and maps the weekly triple into a usage snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = zaiEffectSourceFetch(captured, respondJson(200, zaiQuotaBody));

    const result = await runFetch(usageRequest("zai-coding-plan", "seven-day"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "zai-coding-plan",
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 55,
        resetsAtEpochMs: 2_000_000,
        fetchedAtEpochMs: 3_000,
      },
    });
    // ONE HTTP attempt (no adapter retry — the scheduler owns retry).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("carries the raw key in the authorization header (no Bearer) via the single Redacted.value unwrap", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = zaiEffectSourceFetch(captured, respondJson(200, zaiQuotaBody));

    await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    // Raw key by vendor contract — no "Bearer" prefix (old working adapter, live-verified).
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(Option.some(ZAI_SECRET));
    expect(PlatformHeaders.get(captured[0]!.headers, "accept-language")).toStrictEqual(Option.some("en-US,en"));
    expect(PlatformHeaders.get(captured[0]!.headers, "content-type")).toStrictEqual(Option.some("application/json"));
  });

  it("keeps the credential redacted and never leaks the raw secret in a sanitized failure", async () => {
    const material = { value: Redacted.make(ZAI_SECRET) };
    expect(String(material.value)).toBe("<redacted>");
    expect(JSON.stringify(material)).not.toContain(ZAI_SECRET);

    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = zaiEffectSourceFetch(captured, respondJson(401, { error: "unauthorized" }));
    const result = await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(ZAI_SECRET);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
  });

  it("surfaces the rate-limit Retry-After through the bridge for the scheduler", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = zaiEffectSourceFetch(captured, respondJson(429, { error: "rate limited" }, { "retry-after": "30" }));

    const result = await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      retry: { retryAfterSeconds: 30 },
      failure: { displayState: "rate-limited" },
    });
  });

  it("maps a success:false vendor flag to a sanitized validation-drift failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = zaiEffectSourceFetch(captured, respondJson(200, { success: false, data: { limits: [] } }));

    const result = await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { displayState: "validation-drift", provider: { reasonCode: "usage-zai-success-flag-false" } },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("treats a declared-but-absent window as no-data-yet rather than a defaulted zero", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // Only the weekly triple is present; the requested five-hour window is absent.
    const runFetch = zaiEffectSourceFetch(
      captured,
      respondJson(200, { success: true, data: { limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 55 }] } }),
    );

    const result = await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-zai-window-not-returned" } },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("maps a credential-resolution failure to a sanitized failure without any HTTP call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const effectFetch = zaiCodingPlanUsageProviderModule.createSourceFetchEffect({
      providerId: "zai-coding-plan",      baseUrl: "https://api.z.ai",
      resolveCredential: async () => ({ ok: false, failure: mapProviderFailure({ kind: "unknown", reasonCode: "missing" }) }),
      now: () => 3_000,
    });
    const runFetch = bridgeEffectSchedulerFetch(effectFetch, recordingHttpClientLayer(captured, respondJson(200, {})));

    const result = await runFetch(usageRequest("zai-coding-plan", "five-hour"));

    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

const MINIMAX_SECRET = "sk-cp-fixture-minimax-key-secret-value";

// The confirmed live-probe response shape (owner 2026-07-10): the top-level `base_resp` status
// wrapper plus a per-model `model_remains` array. The `general` entry carries the exact confirmed
// fields (interval_remaining_percent 100, weekly_remaining_percent 73); the `video` entry is listed
// FIRST with different percentages so the tests prove name-based selection, not first-entry pick.
// All counts are 0 while the *_remaining_percent fields stay authoritative.
const minimaxRemainsBody = {
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [
    {
      model_name: "video",
      end_time: 9_999_999_999_999,
      weekly_end_time: 9_999_999_999_999,
      current_interval_remaining_percent: 5,
      current_weekly_remaining_percent: 5,
    },
    {
      start_time: 1_783_659_600_000,
      end_time: 1_783_677_600_000,
      remains_time: 17_302_055,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: "general",
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1_783_296_000_000,
      weekly_end_time: 1_783_900_800_000,
      weekly_remains_time: 240_502_055,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 73,
    },
  ],
} as const;

function minimaxEffectAdapterInput(): Parameters<typeof minimaxUsageProviderModule.createSourceFetchEffect>[0] {
  return {
    providerId: "minimax",
    baseUrl: "https://api.minimax.io",
    resolveCredential: async () => ({ ok: true, value: { value: Redacted.make(MINIMAX_SECRET) } }),
    now: () => 3_000,
  };
}

function minimaxEffectSourceFetch(captured: HttpClientRequest.HttpClientRequest[], execute: FakeExecute) {
  return bridgeEffectSchedulerFetch(
    minimaxUsageProviderModule.createSourceFetchEffect(minimaxEffectAdapterInput()),
    recordingHttpClientLayer(captured, execute),
  );
}

describe("minimax Effect-native usage adapter", () => {
  it("decodes the confirmed response, selects `general` (ignoring `video`), and maps the weekly remaining-percent to used%", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(captured, respondJson(200, minimaxRemainsBody));

    const result = await runFetch(usageRequest("minimax", "seven-day"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "minimax",
        metricKind: "usage-percent",
        metricDirection: "upper-bound",
        unit: "percent",
        coverage: { kind: "rolling-window", window: "seven-day" },
        // 100 - current_weekly_remaining_percent (73) = 27, from the `general` entry, NOT `video` (5).
        value: 27,
        resetsAtEpochMs: 1_783_900_800_000,
        fetchedAtEpochMs: 3_000,
      },
    });
    // ONE HTTP attempt (no adapter retry — the scheduler owns retry).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://api.minimax.io/v1/coding_plan/remains");
  });

  it("maps the five-hour interval remaining-percent to used% and reads the interval reset time", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(captured, respondJson(200, minimaxRemainsBody));

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "five-hour" },
        // 100 - current_interval_remaining_percent (100) = 0, from `general` (not `video`'s 5 → 95).
        value: 0,
        resetsAtEpochMs: 1_783_677_600_000,
      },
    });
  });

  it("computes used% as 100 minus the remaining-percent for an arbitrary interval value", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const body = {
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: "general", current_interval_remaining_percent: 40, end_time: 2_500 }],
    };
    const runFetch = minimaxEffectSourceFetch(captured, respondJson(200, body));

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    // 100 - 40 = 60.
    expect(result).toMatchObject({ ok: true, snapshot: { value: 60, resetsAtEpochMs: 2_500 } });
  });

  it("sends the Bearer authorization + Accept headers via the single Redacted.value unwrap", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(captured, respondJson(200, minimaxRemainsBody));

    await runFetch(usageRequest("minimax", "five-hour"));

    // MiniMax uses the `Bearer ` prefix (owner live-probe-confirmed), unlike z.ai's raw key.
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${MINIMAX_SECRET}`));
    expect(PlatformHeaders.get(captured[0]!.headers, "accept")).toStrictEqual(Option.some("application/json"));
  });

  it("keeps the credential redacted and never leaks the raw secret in a sanitized failure", async () => {
    const material = { value: Redacted.make(MINIMAX_SECRET) };
    expect(String(material.value)).toBe("<redacted>");
    expect(JSON.stringify(material)).not.toContain(MINIMAX_SECRET);

    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(captured, respondJson(401, { error: "unauthorized" }));
    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(MINIMAX_SECRET);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
  });

  it("maps a non-zero base_resp.status_code to a sanitized validation-drift failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(
      captured,
      respondJson(200, { base_resp: { status_code: 1004, status_msg: "auth failed" }, model_remains: [] }),
    );

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { displayState: "validation-drift", provider: { reasonCode: "usage-minimax-status-code-nonzero" } },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("treats a missing `general` model as no-data-yet rather than a defaulted zero", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(
      captured,
      respondJson(200, {
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: "video", current_interval_remaining_percent: 5 }],
      }),
    );

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-minimax-model-absent" } },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("treats a missing or non-finite remaining-percent for the requested window as no-data-yet", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // The `general` entry carries a weekly percent but no interval percent; a five-hour request
    // must be no-data-yet (never a defaulted 0), not fall back to the weekly figure.
    const runFetch = minimaxEffectSourceFetch(
      captured,
      respondJson(200, {
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: "general", current_weekly_remaining_percent: 73 }],
      }),
    );

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-minimax-remaining-percent-missing" } },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("treats an out-of-range remaining-percent (below 0 or above 100) as no-data-yet, never a clamped extreme", async () => {
    // A corrupt percent outside [0,100] must not render a clamped 0%/100% used value; it is no-data.
    for (const badPercent of [150, -5]) {
      const captured: HttpClientRequest.HttpClientRequest[] = [];
      const runFetch = minimaxEffectSourceFetch(
        captured,
        respondJson(200, {
          base_resp: { status_code: 0 },
          model_remains: [{ model_name: "general", current_interval_remaining_percent: badPercent, end_time: 2_500 }],
        }),
      );

      const result = await runFetch(usageRequest("minimax", "five-hour"));

      expect(result).toMatchObject({
        ok: false,
        failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-minimax-remaining-percent-missing" } },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("omits the reset countdown when the window's reset time is absent or non-positive", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = minimaxEffectSourceFetch(
      captured,
      respondJson(200, {
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: "general", current_weekly_remaining_percent: 73, weekly_end_time: 0 }],
      }),
    );

    const result = await runFetch(usageRequest("minimax", "seven-day"));

    expect(result).toMatchObject({ ok: true, snapshot: { value: 27 } });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  it("maps a credential-resolution failure to a sanitized failure without any HTTP call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const effectFetch = minimaxUsageProviderModule.createSourceFetchEffect({
      providerId: "minimax",
      baseUrl: "https://api.minimax.io",
      resolveCredential: async () => ({ ok: false, failure: mapProviderFailure({ kind: "unknown", reasonCode: "missing" }) }),
      now: () => 3_000,
    });
    const runFetch = bridgeEffectSchedulerFetch(effectFetch, recordingHttpClientLayer(captured, respondJson(200, {})));

    const result = await runFetch(usageRequest("minimax", "five-hour"));

    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(0);
  });
});

const CLAUDE_CODE_ACCESS_TOKEN = "fixture-claude-access-token-secret-value";

function claudeCodeEffectAdapterInput(
  readCredential: () => Promise<ClaudeCodeCredentialResult>,
  now: () => number,
  refreshCredential?: () => Promise<void>,
): Parameters<typeof claudeCodeUsageProviderModule.createSourceFetchEffect>[0] {
  return {
    providerId: "claude-code",    baseUrl: "https://api.anthropic.com",
    localSources: { claudeCode: { readCredential, ...(refreshCredential === undefined ? {} : { refreshCredential }) } },
    // The hybrid adapter reads the local Keychain credential, never `resolveCredential`.
    resolveCredential: () => Promise.reject(new Error("claude-code usage adapter must not use resolveCredential")),
    now,
  };
}

function claudeCodeEffectSourceFetch(
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
  readCredential: () => Promise<ClaudeCodeCredentialResult>,
  now: () => number = () => 2_000,
  attemptContext?: ProviderAdapterAttemptContext,
  refreshCredential?: () => Promise<void>,
) {
  const effectFetch = claudeCodeUsageProviderModule.createSourceFetchEffect(
    claudeCodeEffectAdapterInput(readCredential, now, refreshCredential),
  );
  return bridgeEffectSchedulerFetch(
    attemptContext === undefined
      ? effectFetch
      : (request) => effectFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attemptContext)),
    recordingHttpClientLayer(captured, execute),
  );
}

describe("claude-code Effect-native usage adapter", () => {
  const structuralMismatchCases = [
    {
      name: "a non-object response root",
      body: [],
      diagnostic: {
        code: "claude-code-usage-root-not-object",
        expectedType: "object",
        receivedType: "array",
      },
    },
    {
      name: "a non-object five-hour window",
      body: { five_hour: [] },
      diagnostic: {
        code: "claude-code-usage-five-hour-not-object",
        expectedType: "object",
        receivedType: "array",
      },
    },
    {
      name: "a non-object seven-day window",
      body: { seven_day: false },
      diagnostic: {
        code: "claude-code-usage-seven-day-not-object",
        expectedType: "object",
        receivedType: "boolean",
      },
    },
    {
      name: "an invalid five-hour utilization",
      body: { five_hour: { utilization: [] } },
      diagnostic: {
        code: "claude-code-usage-five-hour-utilization-invalid",
        expectedType: "number-or-null",
        receivedType: "array",
      },
    },
    {
      name: "an invalid seven-day utilization",
      body: { seven_day: { utilization: false } },
      diagnostic: {
        code: "claude-code-usage-seven-day-utilization-invalid",
        expectedType: "number-or-null",
        receivedType: "boolean",
      },
    },
  ] as const;

  const nullableRollingWindowResetCases = [
    {
      name: "a five-hour reset",
      body: { five_hour: { utilization: 42, resets_at: null } },
      window: "five-hour",
      value: 42,
    },
    {
      name: "a seven-day reset",
      body: { seven_day: { utilization: 31, resets_at: null } },
      window: "seven-day",
      value: 31,
    },
  ] as const;

  it.each(nullableRollingWindowResetCases)("treats null $name metadata as reset-unavailable while retaining usage", async ({ body, window, value }) => {
    const runFetch = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, body),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", window));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window },
        value,
      },
    });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  const preservedRollingWindowResetCases: readonly {
    readonly name: string;
    readonly body: unknown;
    readonly window: "five-hour" | "seven-day";
    readonly value: number;
    readonly resetsAtEpochMs?: number;
  }[] = [
    {
      name: "an omitted five-hour reset",
      body: { five_hour: { utilization: 42 } },
      window: "five-hour",
      value: 42,
    },
    {
      name: "a valid five-hour reset",
      body: { five_hour: { utilization: 42, resets_at: "2026-07-07T12:00:00Z" } },
      window: "five-hour",
      value: 42,
      resetsAtEpochMs: Date.parse("2026-07-07T12:00:00Z"),
    },
    {
      name: "an unparseable five-hour reset",
      body: { five_hour: { utilization: 42, resets_at: "not-a-date" } },
      window: "five-hour",
      value: 42,
    },
    {
      name: "an omitted seven-day reset",
      body: { seven_day: { utilization: 31 } },
      window: "seven-day",
      value: 31,
    },
    {
      name: "a valid seven-day reset",
      body: { seven_day: { utilization: 31, resets_at: "2026-07-10T12:00:00Z" } },
      window: "seven-day",
      value: 31,
      resetsAtEpochMs: Date.parse("2026-07-10T12:00:00Z"),
    },
    {
      name: "an unparseable seven-day reset",
      body: { seven_day: { utilization: 31, resets_at: "not-a-date" } },
      window: "seven-day",
      value: 31,
    },
  ] as const;

  it.each(preservedRollingWindowResetCases)("preserves $name normalization", async ({ body, window, value, resetsAtEpochMs }) => {
    const runFetch = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, body),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", window));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window },
        value,
      },
    });
    if (result.ok && resetsAtEpochMs === undefined) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
    if (result.ok && resetsAtEpochMs !== undefined) {
      expect(result.snapshot).toMatchObject({ resetsAtEpochMs });
    }
  });

  const strictRollingWindowResetCases = [
    {
      name: "a boolean five-hour reset",
      body: { five_hour: { resets_at: false } },
      window: "five-hour",
      diagnostic: {
        code: "claude-code-usage-five-hour-resets-at-invalid",
        expectedType: "string",
        receivedType: "boolean",
      },
    },
    {
      name: "an array five-hour reset",
      body: { five_hour: { resets_at: [] } },
      window: "five-hour",
      diagnostic: {
        code: "claude-code-usage-five-hour-resets-at-invalid",
        expectedType: "string",
        receivedType: "array",
      },
    },
    {
      name: "a numeric five-hour reset",
      body: { five_hour: { resets_at: 1 } },
      window: "five-hour",
      diagnostic: {
        code: "claude-code-usage-five-hour-resets-at-invalid",
        expectedType: "string",
        receivedType: "number",
      },
    },
    {
      name: "an object five-hour reset",
      body: { five_hour: { resets_at: {} } },
      window: "five-hour",
      diagnostic: {
        code: "claude-code-usage-five-hour-resets-at-invalid",
        expectedType: "string",
        receivedType: "object",
      },
    },
    {
      name: "a boolean seven-day reset",
      body: { seven_day: { resets_at: false } },
      window: "seven-day",
      diagnostic: {
        code: "claude-code-usage-seven-day-resets-at-invalid",
        expectedType: "string",
        receivedType: "boolean",
      },
    },
    {
      name: "an array seven-day reset",
      body: { seven_day: { resets_at: [] } },
      window: "seven-day",
      diagnostic: {
        code: "claude-code-usage-seven-day-resets-at-invalid",
        expectedType: "string",
        receivedType: "array",
      },
    },
    {
      name: "a numeric seven-day reset",
      body: { seven_day: { resets_at: 1 } },
      window: "seven-day",
      diagnostic: {
        code: "claude-code-usage-seven-day-resets-at-invalid",
        expectedType: "string",
        receivedType: "number",
      },
    },
    {
      name: "an object seven-day reset",
      body: { seven_day: { resets_at: {} } },
      window: "seven-day",
      diagnostic: {
        code: "claude-code-usage-seven-day-resets-at-invalid",
        expectedType: "string",
        receivedType: "object",
      },
    },
  ] as const;

  it.each(strictRollingWindowResetCases)("keeps $name on the shared strict diagnostic path", async ({ body, window, diagnostic }) => {
    const runFetch = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, body),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", window));

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        diagnostics: { responseDiagnostic: diagnostic },
      },
    });
    expect(JSON.stringify(result)).not.toContain(`${window.replace("-", "_")}.resets_at`);
  });

  it.each(structuralMismatchCases)("classifies $name through the shared diagnostic seam", async ({ body, diagnostic }) => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, body),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        diagnostics: { responseDiagnostic: diagnostic },
      },
    });
    expect(captured).toHaveLength(1);
  });

  it("does not serialize a fabricated invalid response value or a dynamic field path", async () => {
    const responseValueSentinel = "fixture-response-value-sentinel";
    const runFetch = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, { five_hour: { utilization: responseValueSentinel } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        diagnostics: {
          responseDiagnostic: {
            code: "claude-code-usage-five-hour-utilization-invalid",
            expectedType: "number-or-null",
            receivedType: "string",
          },
        },
      },
    });
    expect(serialized).not.toContain(responseValueSentinel);
    expect(serialized).not.toContain(CLAUDE_CODE_ACCESS_TOKEN);
    expect(serialized).not.toContain("five_hour.utilization");
    expect(serialized).not.toContain("ParseError");
  });

  it("keeps missing optional windows and excess response fields tolerated", async () => {
    const missingWindow = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, { seven_day: { utilization: 31 } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );
    const withExcessFields = claudeCodeEffectSourceFetch(
      [],
      respondJson(200, { five_hour: { utilization: 42 }, unrecognized_response_section: { ignored: true } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    expect(await missingWindow(usageRequest("claude-code", "five-hour"))).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        provider: { reasonCode: "usage-claude-window-not-returned" },
      },
    });
    expect(await withExcessFields(usageRequest("claude-code", "five-hour"))).toMatchObject({
      ok: true,
      snapshot: { value: 42 },
    });
  });

  it("reads the local Keychain credential, fetches the OAuth usage endpoint, and decodes at the source", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42, resets_at: "2026-07-07T12:00:00Z" } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "claude-code",
        metricKind: "usage-percent",
        metricDirection: "upper-bound",
        unit: "percent",
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 42,
        fetchedAtEpochMs: 2_000,
      },
    });
    // ONE HTTP attempt (no adapter retry — the scheduler owns retry).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://api.anthropic.com/api/oauth/usage");
  });

  it("carries the local token as a Bearer credential via the single Redacted.value unwrap", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    await runFetch(usageRequest("claude-code", "five-hour"));

    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(
      Option.some(`Bearer ${CLAUDE_CODE_ACCESS_TOKEN}`),
    );
    expect(PlatformHeaders.get(captured[0]!.headers, "anthropic-beta")).toStrictEqual(Option.some("oauth-2025-04-20"));
  });

  it("proactively re-reads a stale-expiresAt token before the first call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { seven_day: { utilization: 31, resets_at: "2026-07-10T12:00:00Z" } }),
      async () => {
        reads += 1;
        // now() is 2_000; the first token's expiresAt (1_000) is already stale.
        return reads === 1
          ? { ok: true, accessToken: "fixture-expired-token", expiresAt: 1_000 }
          : { ok: true, accessToken: "fixture-renewed-token" };
      },
    );

    const result = await runFetch(usageRequest("claude-code", "seven-day"));

    expect(reads).toBe(2);
    // The proactive re-read happens BEFORE the first (and only) HTTP call, which uses the renewed token.
    expect(captured).toHaveLength(1);
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(
      Option.some("Bearer fixture-renewed-token"),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: { coverage: { kind: "rolling-window", window: "seven-day" }, value: 31 },
    });
  });

  it("runs one CLI-owned recovery for an expired token before rereading and fetching usage", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    let refreshes = 0;
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 } }),
      async () => {
        reads += 1;
        return reads === 1
          ? { ok: true, accessToken: "fixture-expired-token", expiresAt: 1_000 }
          : { ok: true, accessToken: "fixture-renewed-token", expiresAt: 10_000 };
      },
      () => 2_000,
      undefined,
      async () => {
        refreshes += 1;
      },
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(refreshes).toBe(1);
    expect(reads).toBe(2);
    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, snapshot: { value: 42 } });
    expect(JSON.stringify(result)).not.toContain("fixture-expired-token");
  });

  it("fails fast with unauthorized-expired when the re-read token is ALSO expired, issuing no HTTP request", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    let refreshes = 0;
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 } }),
      // now() is 2_000; BOTH reads return an already-expired token (expiresAt 1_000). This is the
      // real steady state while the Claude Code CLI is not running: only the CLI can mint a new
      // token, so re-reading the Keychain returns the same dead credential.
      async (): Promise<ClaudeCodeCredentialResult> => {
        reads += 1;
        return { ok: true, accessToken: "fixture-expired-token", expiresAt: 1_000 };
      },
      () => 2_000,
      undefined,
      async () => {
        refreshes += 1;
      },
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    // Initial read + the single re-read = 2 reads, then STOP. A known-dead token must never reach
    // the provider: it would be a guaranteed 401 that still spends provider rate-limit budget, and
    // enough of those trip a 429 whose governor cooldown blocks the recovery path itself.
    expect(reads).toBe(2);
    expect(refreshes).toBe(1);
    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "unauthorized-expired", displayState: "unauthorized-expired" },
    });
  });

  it("re-reads the credential once and retries exactly once with the fresh token after a 401", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const readTokens = ["fixture-stale-token", "fixture-fresh-token"];
    let reads = 0;
    let refreshes = 0;
    const permitEvents: string[] = [];
    const attemptContext = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          permitEvents.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJsonSequence([
        { status: 401, body: { error: "unauthorized" } },
        { status: 200, body: { five_hour: { utilization: 55, resets_at: "2026-07-07T12:00:00Z" } } },
      ]),
      async () => {
        const accessToken = readTokens[Math.min(reads, readTokens.length - 1)]!;
        reads += 1;
        return { ok: true, accessToken };
      },
      () => 2_000,
      attemptContext,
      async () => {
        refreshes += 1;
      },
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    // One initial read (token not stale) + one 401-triggered re-read = 2 reads, 2 HTTP calls.
    expect(reads).toBe(2);
    expect(refreshes).toBe(1);
    expect(captured).toHaveLength(2);
    expect(permitEvents).toEqual(["permit", "permit"]);
    expect(PlatformHeaders.get(captured[1]!.headers, "authorization")).toStrictEqual(
      Option.some("Bearer fixture-fresh-token"),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { value: 55 } });
  });

  it("classifies a missing local credential without issuing any HTTP request", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, {}),
      async () => ({ ok: false, reasonCode: "claude-code-keychain-denied" }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("keeps the local token redacted and never leaks the raw secret in a sanitized failure", async () => {
    expect(String(Redacted.make(CLAUDE_CODE_ACCESS_TOKEN))).toBe("<redacted>");

    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // A persistent 401: the single re-read budget is spent by the refresh, and the retry's 401 surfaces.
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(401, { error: "unauthorized" }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CLAUDE_CODE_ACCESS_TOKEN);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
    // Two HTTP calls: the first 401 spends the refresh budget, the retry's 401 surfaces.
    expect(captured).toHaveLength(2);
  });

  it("drives credential-expiry staleness via Effect Clock when no now-seam is injected", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    // No `now` seam is passed, so the adapter must read time from Effect `Clock`; TestClock
    // (below) drives the staleness deterministically without a wall-clock read.
    const effectFetch = claudeCodeUsageProviderModule.createSourceFetchEffect({
      providerId: "claude-code",
      baseUrl: "https://api.anthropic.com",
      resolveCredential: () => Promise.reject(new Error("claude-code usage adapter must not use resolveCredential")),
      localSources: {
        claudeCode: {
          readCredential: async () => {
            reads += 1;
            // TestClock is set to 2_000ms below; the first token's expiresAt (1_000) is already stale.
            return reads === 1
              ? { ok: true, accessToken: "fixture-clock-stale-token", expiresAt: 1_000 }
              : { ok: true, accessToken: "fixture-clock-renewed-token" };
          },
        },
      },
    });

    const program = Effect.gen(function* () {
      yield* TestClock.setTime(2_000);
      return yield* effectFetch(usageRequest("claude-code", "five-hour"));
    }).pipe(
      Effect.provide(recordingHttpClientLayer(captured, respondJson(200, { five_hour: { utilization: 42 } }))),
      Effect.provide(TestContext.TestContext),
      Effect.provideService(ProviderAdapterAttemptContext, {
        attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
        reportRateLimit: () => Effect.void,
      }),
    );

    const snapshot = await Effect.runPromise(program);

    // The Clock-driven staleness check forced a proactive re-read before the single HTTP call.
    expect(reads).toBe(2);
    expect(captured).toHaveLength(1);
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(
      Option.some("Bearer fixture-clock-renewed-token"),
    );
    expect(snapshot).toMatchObject({ value: 42 });
  });

  it("classifies a rejected local credential read as missing-credentials without issuing any HTTP request (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 } }),
      // The Keychain reader REJECTS (the defensive `credentialReadRejected` path; the reader
      // resolves ok/not-ok in practice). No cause crosses onto the sanitized failure.
      async (): Promise<ClaudeCodeCredentialResult> => {
        throw new Error("claude-code keychain read failed");
      },
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("surfaces missing-credentials when the post-401 credential re-read is no longer authorized (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(401, { error: "unauthorized" }),
      // Initial read ok (not stale, no expiresAt so the single re-read budget is unspent); the
      // 401-triggered re-read finds the credential gone.
      async (): Promise<ClaudeCodeCredentialResult> => {
        reads += 1;
        return reads === 1
          ? { ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }
          : { ok: false, reasonCode: "claude-code-keychain-denied" };
      },
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    // Initial read + one 401-triggered re-read = 2 reads; only the first attempt hit the network.
    expect(reads).toBe(2);
    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("classifies a 200 response that omits the requested window as no-data-yet (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      // 200 OK but the requested (five-hour) window is absent.
      respondJson(200, { seven_day: { utilization: 31 } }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "five-hour"));

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "no-data-yet", displayState: "no-data-yet" },
    });
  });

  it("holds the window guard for a monthly-mcp window it does not offer, returning no-data-yet without any local read or HTTP call (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let credentialReads = 0;
    // A corrupted/hand-edited global-settings payload can carry a `SchedulerWindowOrPeriod` this
    // provider never offers: claude-code supports only five-hour/seven-day, so `monthly-mcp` is
    // registry-unreachable but reachable at runtime. The defensive guard must hold gracefully.
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 } }),
      async (): Promise<ClaudeCodeCredentialResult> => {
        credentialReads += 1;
        return { ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN };
      },
    );

    const result = await runFetch(usageRequest("claude-code", "monthly-mcp"));

    // The guard fires before any local credential read or HTTP call — no throw, no crash.
    expect(credentialReads).toBe(0);
    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-claude-window-not-returned" },
      },
    });
    expect(result).not.toHaveProperty("snapshot");
    // Nothing sensitive is touched on the guarded path.
    expect(JSON.stringify(result)).not.toContain(CLAUDE_CODE_ACCESS_TOKEN);
  });

  // The confirmed live `limits[]` shape (owner probe): session + weekly_all + the weekly_scoped Fable
  // entry. `scope.model.id` is null on the wire, so Fable is selected by `display_name`. Extra fields
  // (group/severity/is_active/scope.surface/scope.model.id) are excess-ignored by the strict per-entry
  // decode. The active-Fable variants raise percent off 0 (and give a real reset) so the assertions
  // prove selection-by-display-name and the reset mapping unambiguously.
  const claudeCodeFableResetsAt = "2026-07-14T00:00:00.237813+00:00";
  const claudeCodeLimitsWithFable = (fablePercent: number, fableResetsAt: string | null): readonly unknown[] => [
    { kind: "session", group: "session", percent: 2, severity: "normal", resets_at: "2026-07-10T16:10:00.237795+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 11, severity: "normal", resets_at: claudeCodeFableResetsAt, scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: fablePercent, severity: "normal", resets_at: fableResetsAt, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: fableResetsAt !== null },
  ];

  it("sources the Fable category from the limits[] weekly_scoped entry by display name and maps its percent + reset to a usage-percent snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 }, limits: claudeCodeLimitsWithFable(7, claudeCodeFableResetsAt) }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "fable"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "claude-code",
        metricKind: "usage-percent",
        metricDirection: "upper-bound",
        unit: "percent",
        coverage: { kind: "rolling-window", window: "fable" },
        // Fable's OWN percent (7), NOT weekly_all's 11 or session's 2 — proves display-name selection.
        value: 7,
        resetsAtEpochMs: Date.parse(claudeCodeFableResetsAt),
      },
    });
    if (result.ok) {
      expect(result.snapshot.familyId).toBe("usage");
      if (result.snapshot.familyId === "usage") {
        expect(result.snapshot.value).not.toBe(11);
      }
    }
    // One HTTP attempt against the SAME OAuth usage endpoint (no separate Fable call).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://api.anthropic.com/api/oauth/usage");
  });

  it("treats the confirmed inactive Fable entry (0% + null reset) as a real 0 with no countdown, not no-data", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      // Exact confirmed shape: Fable inactive → percent 0, resets_at null.
      respondJson(200, { five_hour: { utilization: 42 }, limits: claudeCodeLimitsWithFable(0, null) }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "fable"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: { coverage: { kind: "rolling-window", window: "fable" }, value: 0 },
    });
    // 0% inactive is a REAL 0 (green), and a null reset yields NO countdown.
    if (result.ok) {
      expect(result.snapshot.familyId).toBe("usage");
      if (result.snapshot.familyId === "usage") {
        expect(result.snapshot.value).toBe(0);
      }
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  it("returns no-data (never a defaulted 0) with the fable reason code when the limits[] Fable entry is absent", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = claudeCodeEffectSourceFetch(
      captured,
      // Only session + weekly_all present; no weekly_scoped Fable entry.
      respondJson(200, {
        five_hour: { utilization: 42 },
        limits: [
          { kind: "session", group: "session", percent: 2, resets_at: "2026-07-10T16:10:00.237795+00:00", scope: null, is_active: false },
          { kind: "weekly_all", group: "weekly", percent: 11, resets_at: claudeCodeFableResetsAt, scope: null, is_active: true },
        ],
      }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

    const result = await runFetch(usageRequest("claude-code", "fable"));

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-claude-fable-not-returned" },
      },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("tolerant utilization: a malformed five_hour window (null or missing utilization) degrades to per-window no-data while seven_day still decodes from the same response", async () => {
    // Before the tolerance fix, a `five_hour.utilization` of null (or missing) failed the WHOLE decode
    // (ValidationDrift), briefly blanking the key during credit-toggling. Now the malformed window
    // degrades to per-window no-data and the sibling seven-day window decodes from the same body.
    for (const brokenFiveHour of [{ utilization: null }, {}]) {
      const captured: HttpClientRequest.HttpClientRequest[] = [];
      const runFetch = claudeCodeEffectSourceFetch(
        captured,
        respondJson(200, { five_hour: brokenFiveHour, seven_day: { utilization: 33, resets_at: "2026-07-14T00:00:00Z" } }),
        async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
      );

      expect(await runFetch(usageRequest("claude-code", "five-hour"))).toMatchObject({
        ok: false,
        failure: {
          category: "no-data-yet",
          displayState: "no-data-yet",
          provider: { reasonCode: "usage-claude-window-not-returned" },
        },
      });
      expect(await runFetch(usageRequest("claude-code", "seven-day"))).toMatchObject({
        ok: true,
        snapshot: { metricKind: "usage-percent", coverage: { kind: "rolling-window", window: "seven-day" }, value: 33 },
      });
    }
  });

  it("isolation: a non-array limits value (null, string, number) fails only the Fable path to no-data while five_hour still decodes", async () => {
    // `limits` is decoded as Schema.Unknown, so any non-array value must NOT reject the shared response
    // decode: the Fable path fails soft to no-data and the sibling five-hour window still resolves.
    for (const brokenLimits of [null, "garbage", 42]) {
      const runFetch = claudeCodeEffectSourceFetch(
        [],
        respondJson(200, { five_hour: { utilization: 42 }, limits: brokenLimits }),
        async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
      );
      expect(await runFetch(usageRequest("claude-code", "fable"))).toMatchObject({
        ok: false,
        failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-claude-fable-not-returned" } },
      });
      expect(await runFetch(usageRequest("claude-code", "five-hour"))).toMatchObject({
        ok: true,
        snapshot: { metricKind: "usage-percent", coverage: { kind: "rolling-window", window: "five-hour" }, value: 42 },
      });
    }
  });

  it("isolation: a limits[] Fable entry that fails the strict per-entry decode is SKIPPED to no-data (never throws), five_hour intact", async () => {
    const runFetch = claudeCodeEffectSourceFetch(
      [],
      // A weekly_scoped/Fable entry whose percent is the wrong type: the isolated strict per-entry decode
      // fails, so decodeUnknownOption -> getOrUndefined skips it rather than rejecting the whole response.
      respondJson(200, {
        five_hour: { utilization: 42 },
        limits: [
          { kind: "weekly_scoped", group: "weekly", percent: "not-a-number", resets_at: null, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
        ],
      }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );
    expect(await runFetch(usageRequest("claude-code", "fable"))).toMatchObject({
      ok: false,
      failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-claude-fable-not-returned" } },
    });
    expect(await runFetch(usageRequest("claude-code", "five-hour"))).toMatchObject({
      ok: true,
      snapshot: { metricKind: "usage-percent", coverage: { kind: "rolling-window", window: "five-hour" }, value: 42 },
    });
  });
});

describe("claude-code credit-spend category", () => {
  // The owner-confirmed funded-ON `spend` object, which lives in the SAME /api/oauth/usage response
  // (excess-ignored until now — no extra HTTP call). CAD is the confirmed account currency.
  const activeSpendCAD = {
    used: { amount_minor: 0, currency: "CAD", exponent: 2 },
    limit: { amount_minor: 2500, currency: "CAD", exponent: 2 },
    percent: 0,
    enabled: true,
    disabled_reason: null,
    cap: { money: { amount_minor: 2500, currency: "CAD", exponent: 2 }, credits: null },
    balance: null,
    auto_reload: null,
  };

  const runSpend = (spend: unknown, captured: HttpClientRequest.HttpClientRequest[] = []) =>
    claudeCodeEffectSourceFetch(
      captured,
      respondJson(200, { five_hour: { utilization: 42 }, spend }),
      async () => ({ ok: true, accessToken: CLAUDE_CODE_ACCESS_TOKEN }),
    );

  it("maps the confirmed funded-ON spend to an active usage-spend snapshot from the same OAuth usage response (no extra call)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const result = await runSpend(activeSpendCAD, captured)(usageRequest("claude-code", "credit-spend"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "claude-code",
        metricKind: "usage-spend",
        metricDirection: "upper-bound",
        unit: "money",
        coverage: { kind: "current-period" },
        value: 0,
        fetchedAtEpochMs: 2_000,
        spendState: "active",
        autoReloadOn: false,
        percent: 0,
        usedMinor: 0,
        capMinor: 2500,
        currency: "CAD",
        exponent: 2,
      },
    });
    // ONE HTTP attempt against the SAME OAuth usage endpoint (spend rides that response — no new call).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://api.anthropic.com/api/oauth/usage");
  });

  it("carries used/cap minor units + currency + exponent (used 350 → $3.50, cap 2500 → $25.00 downstream)", async () => {
    const result = await runSpend({ ...activeSpendCAD, used: { amount_minor: 350, currency: "CAD", exponent: 2 }, percent: 14 })(
      usageRequest("claude-code", "credit-spend"),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: { spendState: "active", percent: 14, usedMinor: 350, capMinor: 2500, currency: "CAD", exponent: 2, value: 3.5 },
    });
  });

  it("derives the cap from limit ?? cap.money when limit is absent, and derives percent from used/cap when spend.percent is absent", async () => {
    const capFromCapMoney = await runSpend({
      used: { amount_minor: 1250, currency: "CAD", exponent: 2 },
      cap: { money: { amount_minor: 2500, currency: "CAD", exponent: 2 } },
      enabled: true,
      disabled_reason: null,
    })(usageRequest("claude-code", "credit-spend"));
    // No `limit` and no `percent`: cap falls back to cap.money (2500) and percent is derived (1250/2500 = 50%).
    expect(capFromCapMoney).toMatchObject({ ok: true, snapshot: { spendState: "active", percent: 50, usedMinor: 1250, capMinor: 2500 } });
  });

  it("maps the confirmed OFF/funded state to an off status snapshot (no money shown, currency may differ)", async () => {
    // OFF/funded: enabled false, disabled_reason null — the limit may be absent and the currency may
    // differ, so no money is extracted; the key shows a neutral "Off".
    const result = await runSpend({ enabled: false, disabled_reason: null, used: { amount_minor: 0, currency: "USD", exponent: 2 } })(
      usageRequest("claude-code", "credit-spend"),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { metricKind: "usage-spend", spendState: "off", value: 0, autoReloadOn: false } });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("usedMinor");
    }
  });

  it("maps the confirmed OFF/out-of-credits state to an out-of-credits status snapshot", async () => {
    const result = await runSpend({ enabled: false, disabled_reason: "out_of_credits" })(usageRequest("claude-code", "credit-spend"));
    expect(result).toMatchObject({ ok: true, snapshot: { spendState: "out-of-credits", autoReloadOn: false } });
  });

  it("interprets auto_reload tolerantly: null → off, a present config → on, an unknown shape → off (fail safe, never crash)", async () => {
    const outWith = (autoReload: unknown) =>
      runSpend({ enabled: false, disabled_reason: "out_of_credits", auto_reload: autoReload })(usageRequest("claude-code", "credit-spend"));
    // Confirmed null → off (the only shape the owner's probes ever return).
    expect(await outWith(null)).toMatchObject({ ok: true, snapshot: { spendState: "out-of-credits", autoReloadOn: false } });
    // A clearly-present config (bare true, or a non-null object not explicitly disabled) → on (red).
    expect(await outWith(true)).toMatchObject({ ok: true, snapshot: { autoReloadOn: true } });
    expect(await outWith({ enabled: true })).toMatchObject({ ok: true, snapshot: { autoReloadOn: true } });
    expect(await outWith({})).toMatchObject({ ok: true, snapshot: { autoReloadOn: true } });
    // An explicitly-disabled object, or any unrecognized primitive → off (fail safe), and NEVER crashes.
    expect(await outWith({ enabled: false })).toMatchObject({ ok: true, snapshot: { autoReloadOn: false } });
    expect(await outWith("weird")).toMatchObject({ ok: true, snapshot: { autoReloadOn: false } });
    expect(await outWith(0)).toMatchObject({ ok: true, snapshot: { autoReloadOn: false } });
  });

  it("fails soft to no-data (never a broken gauge) when enabled but the used/cap money is missing or non-finite", async () => {
    const brokenActiveStates: readonly unknown[] = [
      { enabled: true, disabled_reason: null },
      { enabled: true, used: { amount_minor: 350, currency: "CAD" } },
      { enabled: true, used: { amount_minor: 350, exponent: 2 } },
      { enabled: true, used: { amount_minor: 350, currency: "CAD", exponent: 2 } },
    ];
    for (const brokenActive of brokenActiveStates) {
      expect(await runSpend(brokenActive)(usageRequest("claude-code", "credit-spend"))).toMatchObject({
        ok: false,
        failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-claude-credit-spend-not-returned" } },
      });
    }
  });

  it("isolation: a malformed/non-object spend (or a bad field) fails ONLY the credit-spend path to no-data; five_hour still decodes from the same response", async () => {
    // `spend` is decoded as Schema.Unknown, so any non-object value — or a present-but-bad field such as
    // a non-boolean `enabled` — must NEVER reject the shared response decode (mirrors the Fable/credits
    // isolation). The credit-spend path fails soft to no-data; the sibling five-hour window resolves.
    const brokenSpends: readonly unknown[] = [null, "garbage", 42, [], { enabled: "yes" }];
    for (const brokenSpend of brokenSpends) {
      const runFetch = runSpend(brokenSpend);
      expect(await runFetch(usageRequest("claude-code", "credit-spend"))).toMatchObject({
        ok: false,
        failure: { displayState: "no-data-yet", provider: { reasonCode: "usage-claude-credit-spend-not-returned" } },
      });
      expect(await runFetch(usageRequest("claude-code", "five-hour"))).toMatchObject({
        ok: true,
        snapshot: { metricKind: "usage-percent", coverage: { kind: "rolling-window", window: "five-hour" }, value: 42 },
      });
    }
  });

  it("never leaks the local token on the credit-spend path", async () => {
    const result = await runSpend(activeSpendCAD)(usageRequest("claude-code", "credit-spend"));
    expect(JSON.stringify(result)).not.toContain(CLAUDE_CODE_ACCESS_TOKEN);
  });
});

const CODEX_ACCESS_TOKEN = "fixture-codex-access-token-secret-value";
const CODEX_ACCOUNT_ID = "fixture-codex-account-id-secret-value";

function codexEffectAdapterInput(
  readCredential: () => Promise<CodexCredentialResult>,
  readSessionSnapshot: () => Promise<CodexSessionSnapshot | undefined>,
  now: () => number,
): Parameters<typeof codexUsageProviderModule.createSourceFetchEffect>[0] {
  return {
    providerId: "codex",    baseUrl: "https://chatgpt.com",
    localSources: { codex: { readCredential, readSessionSnapshot } },
    // The hybrid adapter reads the local auth.json credential, never `resolveCredential`.
    resolveCredential: () => Promise.reject(new Error("codex usage adapter must not use resolveCredential")),
    now,
  };
}

function codexEffectSourceFetch(
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
  readCredential: () => Promise<CodexCredentialResult>,
  readSessionSnapshot: () => Promise<CodexSessionSnapshot | undefined> = async () => undefined,
  now: () => number = () => 2_000,
) {
  return bridgeEffectSchedulerFetch(
    codexUsageProviderModule.createSourceFetchEffect(codexEffectAdapterInput(readCredential, readSessionSnapshot, now)),
    recordingHttpClientLayer(captured, execute),
  );
}

const codexOkCredential = async (): Promise<CodexCredentialResult> => ({
  ok: true,
  accessToken: CODEX_ACCESS_TOKEN,
  accountId: CODEX_ACCOUNT_ID,
});

describe("codex Effect-native usage adapter", () => {
  it("reads the local auth.json credential, fetches the usage endpoint, and decodes the primary window", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 } } }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "codex",
        metricKind: "usage-percent",
        metricDirection: "upper-bound",
        unit: "percent",
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 18,
        // reset_at is epoch SECONDS; the adapter multiplies by 1000.
        resetsAtEpochMs: 1_805_000_000_000,
        fetchedAtEpochMs: 2_000,
      },
    });
    // ONE HTTP attempt (no adapter retry — the scheduler owns retry).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://chatgpt.com/backend-api/wham/usage");
  });

  it("maps the secondary window to the seven-day usage snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, { rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 64, reset_at: 1_805_000_000 } } }),
      codexOkCredential,
      async () => undefined,
      () => 3_000,
    );

    const result = await runFetch(usageRequest("codex", "seven-day"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 64,
        resetsAtEpochMs: 1_805_000_000_000,
        fetchedAtEpochMs: 3_000,
      },
    });
  });

  it("resolves the temporary one-window HTTP shape by explicit seconds without relabeling seven-day as five-hour", async () => {
    const temporaryResponse = {
      rate_limit: {
        primary_window: { limit_window_seconds: 604_800, used_percent: 7, reset_at: 1_806_000_000 },
        secondary_window: null,
      },
    };

    const sevenDay = await codexEffectSourceFetch(
      [],
      respondJson(200, temporaryResponse),
      codexOkCredential,
      async () => undefined,
      () => 3_000,
    )(usageRequest("codex", "seven-day"));

    expect(sevenDay).toMatchObject({
      ok: true,
      snapshot: {
        metricKind: "usage-percent",
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 7,
        resetsAtEpochMs: 1_806_000_000_000,
        fetchedAtEpochMs: 3_000,
      },
    });

    let sessionReads = 0;
    const fiveHour = await codexEffectSourceFetch(
      [],
      respondJson(200, temporaryResponse),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return undefined;
      },
      () => 3_000,
    )(usageRequest("codex", "five-hour"));

    expect(sessionReads).toBe(1);
    expect(fiveHour).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-codex-window-not-returned" },
      },
    });
    expect(fiveHour).not.toHaveProperty("snapshot");
  });

  it("resolves reversed HTTP slots by explicit seconds", async () => {
    const reversedResponse = {
      rate_limit: {
        primary_window: { limit_window_seconds: 604_800, used_percent: 64, reset_at: 1_806_000_000 },
        secondary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 },
      },
    };

    const fiveHour = await codexEffectSourceFetch(
      [],
      respondJson(200, reversedResponse),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    )(usageRequest("codex", "five-hour"));

    expect(fiveHour).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 18,
        resetsAtEpochMs: 1_805_000_000_000,
      },
    });

    const sevenDay = await codexEffectSourceFetch(
      [],
      respondJson(200, reversedResponse),
      codexOkCredential,
      async () => undefined,
      () => 3_000,
    )(usageRequest("codex", "seven-day"));

    expect(sevenDay).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 64,
        resetsAtEpochMs: 1_806_000_000_000,
      },
    });
  });

  it("treats missing and unsupported HTTP durations as unavailable without positional fallback", async () => {
    for (const body of [
      { rate_limit: {} },
      { rate_limit: { primary_window: { limit_window_seconds: 86_400, used_percent: 99 } } },
      { rate_limit: { primary_window: { limit_window_seconds: 604_800, used_percent: 64 }, secondary_window: null } },
    ]) {
      let sessionReads = 0;
      const result = await codexEffectSourceFetch(
        [],
        respondJson(200, body),
        codexOkCredential,
        async () => {
          sessionReads += 1;
          return undefined;
        },
      )(usageRequest("codex", "five-hour"));

      expect(sessionReads).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        failure: {
          category: "no-data-yet",
          displayState: "no-data-yet",
          provider: { reasonCode: "usage-codex-window-not-returned" },
        },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("rejects duplicate requested HTTP durations instead of choosing an arbitrary root candidate", async () => {
    let sessionReads = 0;
    const result = await codexEffectSourceFetch(
      [],
      respondJson(200, {
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 18 },
          secondary_window: { limit_window_seconds: 18_000, used_percent: 19 },
        },
      }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return undefined;
      },
    )(usageRequest("codex", "five-hour"));

    expect(sessionReads).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-codex-window-not-returned" },
      },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("does not use additional_rate_limits to supply or override the general HTTP window", async () => {
    const additionalOnly = await codexEffectSourceFetch(
      [],
      respondJson(200, {
        additional_rate_limits: [{ limit_window_seconds: 604_800, used_percent: 88 }],
      }),
      codexOkCredential,
      async () => undefined,
    )(usageRequest("codex", "seven-day"));

    expect(additionalOnly).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-codex-window-not-returned" },
      },
    });
    expect(additionalOnly).not.toHaveProperty("snapshot");

    const rootPlusAdditional = await codexEffectSourceFetch(
      [],
      respondJson(200, {
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 18 },
        },
        additional_rate_limits: [{ limit_window_seconds: 18_000, used_percent: 99 }],
      }),
      codexOkCredential,
      async () => undefined,
    )(usageRequest("codex", "five-hour"));

    expect(rootPlusAdditional).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 18,
      },
    });
  });

  it("keeps a valid primary window when the unrelated secondary window is null", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, {
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 },
          secondary_window: null,
        },
      }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        metricKind: "usage-percent",
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 18,
        resetsAtEpochMs: 1_805_000_000_000,
      },
    });
  });

  it("keeps a valid secondary window when the unrelated primary window is null", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, {
        rate_limit: {
          primary_window: null,
          secondary_window: { limit_window_seconds: 604_800, used_percent: 64, reset_at: 1_805_000_000 },
        },
      }),
      codexOkCredential,
      async () => undefined,
      () => 3_000,
    );

    const result = await runFetch(usageRequest("codex", "seven-day"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        metricKind: "usage-percent",
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 64,
        resetsAtEpochMs: 1_805_000_000_000,
      },
    });
  });

  it("keeps malformed present window objects as validation drift", async () => {
    for (const rateLimit of [
      { primary_window: {} },
      { primary_window: { limit_window_seconds: "18000", used_percent: 18 } },
      { primary_window: { limit_window_seconds: 18_000, used_percent: null } },
      { secondary_window: { limit_window_seconds: 604_800, used_percent: "64" } },
    ]) {
      const runFetch = codexEffectSourceFetch([], respondJson(200, { rate_limit: rateLimit }), codexOkCredential);
      const result = await runFetch(usageRequest("codex", "five-hour"));

      expect(result).toMatchObject({
        ok: false,
        failure: { category: "validation-drift", displayState: "validation-drift", sanitized: true },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("carries BOTH the access token and account id headers via the two Redacted.value unwraps", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18 } } }),
      codexOkCredential,
    );

    await runFetch(usageRequest("codex", "five-hour"));

    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(
      Option.some(`Bearer ${CODEX_ACCESS_TOKEN}`),
    );
    expect(PlatformHeaders.get(captured[0]!.headers, "chatgpt-account-id")).toStrictEqual(Option.some(CODEX_ACCOUNT_ID));
  });

  it("re-reads the credential once and retries exactly once with the fresh token after a 401", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const readTokens = ["fixture-stale-codex-token", "fixture-fresh-codex-token"];
    let reads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJsonSequence([
        { status: 401, body: { error: "unauthorized" } },
        { status: 200, body: { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 } } } },
      ]),
      async () => {
        const accessToken = readTokens[Math.min(reads, readTokens.length - 1)]!;
        reads += 1;
        return { ok: true, accessToken, accountId: CODEX_ACCOUNT_ID };
      },
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    // Codex has no proactive re-read: one initial read + one 401-triggered re-read = 2 reads, 2 HTTP calls.
    expect(reads).toBe(2);
    expect(captured).toHaveLength(2);
    expect(PlatformHeaders.get(captured[1]!.headers, "authorization")).toStrictEqual(
      Option.some("Bearer fixture-fresh-codex-token"),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { value: 18, resetsAtEpochMs: 1_805_000_000_000 } });
  });

  it("classifies a missing local credential without issuing any HTTP request or reading the session file", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, {}),
      async () => ({ ok: false, reasonCode: "codex-auth-missing" }),
      async () => {
        sessionReads += 1;
        return undefined;
      },
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(captured).toHaveLength(0);
    expect(sessionReads).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("keeps BOTH local secrets redacted and never leaks either in a sanitized failure", async () => {
    expect(String(Redacted.make(CODEX_ACCESS_TOKEN))).toBe("<redacted>");
    expect(String(Redacted.make(CODEX_ACCOUNT_ID))).toBe("<redacted>");

    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // A persistent 401: the one-shot refresh re-reads + retries, and the retry's 401 surfaces.
    const runFetch = codexEffectSourceFetch(captured, respondJson(401, { error: "unauthorized" }), codexOkCredential);

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCOUNT_ID);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
    // Two HTTP calls: the first 401 triggers the one-shot re-read, the retry's 401 surfaces.
    expect(captured).toHaveLength(2);
  });

  it("never masks a Codex auth failure with the session fallback (the session file is not read)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      // Persistent 401: after the one-shot refresh the retry's 401 surfaces as an auth failure.
      respondJsonSequence([
        { status: 401, body: { error: "unauthorized" } },
        { status: 401, body: { error: "unauthorized" } },
      ]),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return { fetchedAtEpochMs: 5_000, fiveHourPercent: 61 };
      },
      () => 9_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(sessionReads).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: { category: "unauthorized-expired" } });
  });

  it("adopts the session fallback only when it is strictly newer than the retained snapshot", async () => {
    const sessionSnapshot: CodexSessionSnapshot = { fetchedAtEpochMs: 5_000, fiveHourPercent: 61 };
    const makeFetch = () =>
      codexEffectSourceFetch(
        [],
        respondJson(503, { error: "unavailable" }),
        codexOkCredential,
        async () => sessionSnapshot,
        () => 9_000,
      );

    // No retained snapshot: the strictly-newer session fallback is adopted and marked local-fallback.
    const adopted = await makeFetch()(usageRequest("codex", "five-hour"));
    expect(adopted).toMatchObject({
      ok: true,
      snapshot: { value: 61, fetchedAtEpochMs: 5_000, source: "local-fallback" },
    });

    const request = usageRequest("codex", "five-hour");
    const previousSnapshot: NormalizedSnapshot = {
      familyId: "usage",
      providerId: "codex",
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      unit: "percent",
      coverage: { kind: "rolling-window", window: "five-hour" },
      value: 40,
      fetchedAtEpochMs: 8_000,
    };

    // Retained snapshot NEWER than the session file: keep the failure so the scheduler serves its
    // cached value with stale marking.
    const kept = await makeFetch()({ ...request, previousSnapshot });
    expect(kept).toMatchObject({ ok: false });

    // Retained snapshot OLDER than the session file: adopt the strictly-newer fallback.
    const adoptedOverOlder = await makeFetch()({
      ...request,
      previousSnapshot: { ...previousSnapshot, fetchedAtEpochMs: 3_000 },
    });
    expect(adoptedOverOlder).toMatchObject({
      ok: true,
      snapshot: { value: 61, fetchedAtEpochMs: 5_000, source: "local-fallback" },
    });

    // EQUAL timestamps are not strictly newer: keep the failure (no same-file re-adopt).
    const keptEqual = await makeFetch()({
      ...request,
      previousSnapshot: { ...previousSnapshot, fetchedAtEpochMs: 5_000 },
    });
    expect(keptEqual).toMatchObject({ ok: false });
  });

  it("keeps the failure when the session file has no window value or a non-positive timestamp", async () => {
    // No value for the requested window: keep the failure (no adoption).
    const noValue = await codexEffectSourceFetch(
      [],
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => ({ fetchedAtEpochMs: 5_000, sevenDayPercent: 71 }),
      () => 9_000,
    )(usageRequest("codex", "five-hour"));
    expect(noValue).toMatchObject({ ok: false });

    // fetchedAtEpochMs === 0 is not a usable snapshot: keep the failure.
    const zeroStamp = await codexEffectSourceFetch(
      [],
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => ({ fetchedAtEpochMs: 0, fiveHourPercent: 61 }),
      () => 9_000,
    )(usageRequest("codex", "five-hour"));
    expect(zeroStamp).toMatchObject({ ok: false });

    // No session snapshot at all: keep the failure.
    const noSnapshot = await codexEffectSourceFetch(
      [],
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => undefined,
      () => 9_000,
    )(usageRequest("codex", "five-hour"));
    expect(noSnapshot).toMatchObject({ ok: false });
  });

  it("adopts the newest session snapshot with its per-window reset when the live endpoint fails", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => ({ sevenDayPercent: 71, sevenDayResetsAtEpochMs: 1_806_000_000_000, fetchedAtEpochMs: 4_000 }),
    );

    const result = await runFetch(usageRequest("codex", "seven-day"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "codex",
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 71,
        fetchedAtEpochMs: 4_000,
        resetsAtEpochMs: 1_806_000_000_000,
        source: "local-fallback",
      },
    });
  });

  it("routes a requested null secondary window through the session fallback", async () => {
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { rate_limit: { secondary_window: null } }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return { sevenDayPercent: 71, sevenDayResetsAtEpochMs: 1_806_000_000_000, fetchedAtEpochMs: 4_000 };
      },
    );

    const result = await runFetch(usageRequest("codex", "seven-day"));

    expect(sessionReads).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        coverage: { kind: "rolling-window", window: "seven-day" },
        value: 71,
        fetchedAtEpochMs: 4_000,
        resetsAtEpochMs: 1_806_000_000_000,
        source: "local-fallback",
      },
    });
  });

  it("treats a requested null window as no-data when no session snapshot can be adopted", async () => {
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { rate_limit: { primary_window: null } }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return undefined;
      },
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(sessionReads).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-codex-window-not-returned" },
      },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("classifies a rejected local credential read as missing-credentials without issuing any HTTP request (R07c3c defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18 } } }),
      // The auth.json reader REJECTS (the defensive `credentialReadRejected` path; the reader
      // resolves ok/not-ok in practice). No cause crosses onto the sanitized failure.
      async (): Promise<CodexCredentialResult> => {
        throw new Error("codex auth.json read failed");
      },
      async () => {
        sessionReads += 1;
        return undefined;
      },
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    // A rejected read is an auth failure: no HTTP request, and the session file is never consulted.
    expect(captured).toHaveLength(0);
    expect(sessionReads).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("surfaces missing-credentials when the post-401 credential re-read is no longer authorized (R07c3c defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(401, { error: "unauthorized" }),
      // Initial read ok; the 401-triggered re-read finds the credential gone (auth.json removed).
      async (): Promise<CodexCredentialResult> => {
        reads += 1;
        return reads === 1
          ? { ok: true, accessToken: CODEX_ACCESS_TOKEN, accountId: CODEX_ACCOUNT_ID }
          : { ok: false, reasonCode: "codex-auth-missing" };
      },
      async () => {
        sessionReads += 1;
        return undefined;
      },
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    // Initial read + one 401-triggered re-read = 2 reads; only the first attempt hit the network.
    expect(reads).toBe(2);
    expect(captured).toHaveLength(1);
    // A missing-credentials failure is an auth failure, so the session file is never consulted.
    expect(sessionReads).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "missing-credentials", displayState: "missing-credentials" },
    });
  });

  it("keeps the original failure when the session-fallback read itself rejects (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      // A non-auth failure (503) consults the session fallback...
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      // ...but the session read REJECTS, so nothing can be adopted and the 503 failure is kept.
      async () => {
        throw new Error("codex session file unreadable");
      },
      () => 9_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(result).toMatchObject({
      ok: false,
      failure: { category: "provider-unavailable", displayState: "provider-unavailable" },
    });
    // The rejected session read cannot adopt anything: no fallback snapshot is surfaced.
    expect("snapshot" in result).toBe(false);
  });

  it("consults the session fallback when a 200 omits the requested window and keeps the failure with no session data (R07c3c defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      // 200 OK but the requested (five-hour/primary) window is absent -> window-not-returned.
      respondJson(200, { rate_limit: { secondary_window: { limit_window_seconds: 604_800, used_percent: 30 } } }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return undefined;
      },
      () => 9_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    expect(captured).toHaveLength(1);
    // A window-not-returned (no-data) failure is non-auth, so the session fallback IS consulted;
    // with no session data available the failure is kept.
    expect(sessionReads).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "no-data-yet", displayState: "no-data-yet" },
    });
  });

  it("holds the window guard for a monthly-mcp window it does not offer, returning no-data-yet without any local read, HTTP call, or session fallback (defensive branch)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let credentialReads = 0;
    let sessionReads = 0;
    // A corrupted/hand-edited global-settings payload can carry a `SchedulerWindowOrPeriod` this
    // provider never offers: codex supports only five-hour/seven-day, so `monthly-mcp` is
    // registry-unreachable but reachable at runtime. The defensive guard must hold gracefully —
    // and, critically, must not consult the session-JSONL fallback for an unoffered window.
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(200, { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18 } } }),
      async (): Promise<CodexCredentialResult> => {
        credentialReads += 1;
        return { ok: true, accessToken: CODEX_ACCESS_TOKEN, accountId: CODEX_ACCOUNT_ID };
      },
      async () => {
        sessionReads += 1;
        return undefined;
      },
    );

    const result = await runFetch(usageRequest("codex", "monthly-mcp"));

    // The guard fires before any local credential read, HTTP call, or session-fallback read.
    expect(credentialReads).toBe(0);
    expect(sessionReads).toBe(0);
    expect(captured).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "no-data-yet",
        displayState: "no-data-yet",
        provider: { reasonCode: "usage-codex-window-not-returned" },
      },
    });
    expect(result).not.toHaveProperty("snapshot");
    // Nothing sensitive is touched on the guarded path.
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCOUNT_ID);
  });

  // --- Credits category ---

  it("decodes credits.balance from the same usage endpoint into an evergreen usage-credits snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = codexEffectSourceFetch(
      captured,
      // The SAME /backend-api/wham/usage response also carries credits.balance as a numeric STRING.
      respondJson(200, {
        rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 } },
        credits: { balance: "25000" },
      }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "credits"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "codex",
        metricKind: "usage-credits",
        metricDirection: "lower-bound",
        unit: "credits",
        coverage: { kind: "evergreen" },
        value: 25_000,
        fetchedAtEpochMs: 2_000,
      },
    });
    // Evergreen pool: no reset countdown, no local-fallback source.
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
      expect(result.snapshot).not.toHaveProperty("source");
    }
    // Same single endpoint as the percentage path, one HTTP attempt (scheduler owns retry).
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://chatgpt.com/backend-api/wham/usage");
  });

  it("also decodes a numeric (non-string) credits.balance so a vendor type change never breaks the shared decode", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { credits: { balance: 108_300 } }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "credits"));

    expect(result).toMatchObject({ ok: true, snapshot: { metricKind: "usage-credits", value: 108_300 } });
  });

  it("keeps credits decoding intact when unrelated percentage windows are null", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, {
        rate_limit: { primary_window: null, secondary_window: null },
        credits: { balance: "25000" },
      }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "credits"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        metricKind: "usage-credits",
        coverage: { kind: "evergreen" },
        value: 25_000,
        fetchedAtEpochMs: 2_000,
      },
    });
  });

  it("fails closed to no-data (not validation-drift) on absent/null/malformed credits, never a fake zero", async () => {
    const malformed = [
      { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18 } } }, // credits absent
      { credits: null },
      { credits: {} }, // balance missing
      { credits: { balance: null } },
      { credits: { balance: "unlimited" } }, // non-numeric string
    ];
    for (const body of malformed) {
      const runFetch = codexEffectSourceFetch([], respondJson(200, body), codexOkCredential);
      const result = await runFetch(usageRequest("codex", "credits"));
      // The credits path fails SOFT to clean no-data — NOT ValidationDrift.
      expect(result).toMatchObject({
        ok: false,
        failure: {
          category: "no-data-yet",
          displayState: "no-data-yet",
          provider: { reasonCode: "usage-codex-credits-not-returned" },
        },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("keeps the 5h/7d percentage decode robust to ANY malformed credits shape", async () => {
    // A present-but-malformed credits value must NEVER fail the shared decode of the (untouched)
    // percentage path — the tolerant Schema.Unknown credits node isolates it entirely.
    for (const credits of ["unlimited", null, {}, { balance: "unlimited" }, { balance: null }, 42]) {
      const runFetch = codexEffectSourceFetch(
        [],
        respondJson(200, { rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 } }, credits }),
        codexOkCredential,
        async () => undefined,
        () => 2_000,
      );

      const result = await runFetch(usageRequest("codex", "five-hour"));

      expect(result).toMatchObject({
        ok: true,
        snapshot: { metricKind: "usage-percent", unit: "percent", value: 18, resetsAtEpochMs: 1_805_000_000_000 },
      });
    }
  });

  it("does not consult the session-file fallback on the credits path (HTTP-only) and surfaces the failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      // A non-auth 503 that the 5h/7d path WOULD arbitrate against the session file.
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return { fetchedAtEpochMs: 5_000, fiveHourPercent: 61 };
      },
      () => 9_000,
    );

    const result = await runFetch(usageRequest("codex", "credits"));

    // Unlike the percentage window path, the credits path never reads the session file.
    expect(sessionReads).toBe(0);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("snapshot");
  });

  it("leaves the 5h/7d percentage path unchanged when the response also carries a credits balance", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, {
        rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 18, reset_at: 1_805_000_000 } },
        credits: { balance: "25000" },
      }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "five-hour"));

    // The five-hour request still returns the usage-percent window snapshot; the credits field is
    // ignored on this path (additive-only).
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        metricKind: "usage-percent",
        unit: "percent",
        value: 18,
        coverage: { kind: "rolling-window", window: "five-hour" },
        resetsAtEpochMs: 1_805_000_000_000,
      },
    });
  });

  // --- Resets category ---

  it("fetches the DEDICATED reset-credits endpoint with the reset-credits headers and decodes the count + earliest upcoming expiry", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const now = Date.parse("2026-07-01T00:00:00Z");
    const runFetch = codexEffectSourceFetch(
      captured,
      // The dedicated /wham/rate-limit-reset-credits response (NOT /wham/usage): a credits[] array +
      // available_count. The earliest UPCOMING available expiry is 2026-07-20 (before the 2026-07-26 one).
      respondJson(200, {
        credits: [
          { status: "available", granted_at: "2026-06-01T00:00:00Z", expires_at: "2026-07-26T23:55:22.496886Z", redeemed_at: null },
          { status: "available", granted_at: "2026-06-15T00:00:00Z", expires_at: "2026-07-20T10:00:00Z", redeemed_at: null },
        ],
        available_count: 2,
        total_earned_count: 0,
      }),
      codexOkCredential,
      async () => undefined,
      () => now,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        familyId: "usage",
        providerId: "codex",
        metricKind: "usage-resets",
        metricDirection: "lower-bound",
        unit: "count",
        coverage: { kind: "evergreen" },
        value: 2,
        resetsAtEpochMs: Date.parse("2026-07-20T10:00:00Z"),
        fetchedAtEpochMs: now,
      },
    });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("source");
    }
    // ONE HTTP attempt against the DEDICATED endpoint (not /wham/usage), scheduler owns retry.
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    // Reuses the two Redacted.value credential headers and layers the reset-credits static headers.
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${CODEX_ACCESS_TOKEN}`));
    expect(PlatformHeaders.get(captured[0]!.headers, "chatgpt-account-id")).toStrictEqual(Option.some(CODEX_ACCOUNT_ID));
    expect(PlatformHeaders.get(captured[0]!.headers, "openai-beta")).toStrictEqual(Option.some("codex-1"));
    expect(PlatformHeaders.get(captured[0]!.headers, "originator")).toStrictEqual(Option.some("Codex Desktop"));
    expect(PlatformHeaders.get(captured[0]!.headers, "user-agent")).toStrictEqual(Option.some("CodexBar"));
    expect(PlatformHeaders.get(captured[0]!.headers, "accept")).toStrictEqual(Option.some("application/json"));
  });

  it("treats a genuine available_count of 0 as a real 0 with no countdown", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { credits: [], available_count: 0, total_earned_count: 0 }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    expect(result).toMatchObject({ ok: true, snapshot: { metricKind: "usage-resets", value: 0 } });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  it("shows no countdown when the count is 0 even if a stray available future credit is present (count-gated invariant)", async () => {
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { credits: [{ status: "available", expires_at: "2099-01-01T00:00:00Z" }], available_count: 0 }),
      codexOkCredential,
      async () => undefined,
      () => 2_000,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    expect(result).toMatchObject({ ok: true, snapshot: { metricKind: "usage-resets", value: 0 } });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  it("computes the earliest UPCOMING expiry, excluding past, null, unparseable, and non-available credits", async () => {
    const now = Date.parse("2026-07-20T00:00:00Z");
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, {
        credits: [
          { status: "available", expires_at: "2026-07-10T00:00:00Z" }, // past -> excluded
          { status: "available", expires_at: null }, // null -> excluded
          { status: "available", expires_at: "not-a-date" }, // unparseable -> excluded
          { status: "redeemed", expires_at: "2026-07-21T00:00:00Z" }, // not available -> excluded
          { status: "available", expires_at: "2026-07-25T00:00:00Z" }, // future
          { status: "available", expires_at: "2026-07-22T00:00:00Z" }, // future, EARLIEST
        ],
        available_count: 2,
      }),
      codexOkCredential,
      async () => undefined,
      () => now,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: { metricKind: "usage-resets", value: 2, resetsAtEpochMs: Date.parse("2026-07-22T00:00:00Z") },
    });
  });

  it("selects a 6-fractional-digit expires_at as the earliest upcoming expiry, pinning the sub-ms parse outcome", async () => {
    // The single qualifying available credit carries the real 6-fractional-digit expiry. If Date.parse
    // ever returned NaN for the extended-fraction form (beyond the ES 3-digit guarantee), the credit
    // would be Number.isFinite-excluded and resetsAtEpochMs would be absent -> this asserts the exact
    // truncated epoch, so a toolchain regression on the highest-risk parse fails the suite.
    const now = Date.parse("2026-07-01T00:00:00Z");
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, {
        credits: [{ status: "available", granted_at: "2026-06-01T00:00:00Z", expires_at: "2026-07-26T23:55:22.496886Z", redeemed_at: null }],
        available_count: 1,
        total_earned_count: 0,
      }),
      codexOkCredential,
      async () => undefined,
      () => now,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    // 1_785_110_122_496 === Date.parse("2026-07-26T23:55:22.496886Z") on V8 (microseconds truncated to ms).
    expect(result).toMatchObject({
      ok: true,
      snapshot: { metricKind: "usage-resets", value: 1, resetsAtEpochMs: 1_785_110_122_496 },
    });
  });

  it("leaves resetsAtEpochMs absent when a positive count has no upcoming available expiry", async () => {
    const now = Date.parse("2026-07-20T00:00:00Z");
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(200, { credits: [{ status: "available", expires_at: "2026-07-10T00:00:00Z" }], available_count: 1 }),
      codexOkCredential,
      async () => undefined,
      () => now,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    expect(result).toMatchObject({ ok: true, snapshot: { metricKind: "usage-resets", value: 1 } });
    if (result.ok) {
      expect(result.snapshot).not.toHaveProperty("resetsAtEpochMs");
    }
  });

  it("fails closed to no-data (not validation-drift) when available_count is absent/null/non-numeric/negative, never a fake zero", async () => {
    const malformed = [
      { credits: [] }, // available_count absent
      { available_count: null },
      { available_count: "unlimited" }, // non-numeric string
      { available_count: {} }, // wrong type
      { available_count: -1 }, // negative is invalid for a count
      { available_count: 2.5 }, // fractional is not a valid integer count (display truncates; severity would mismatch)
    ];
    for (const body of malformed) {
      const runFetch = codexEffectSourceFetch([], respondJson(200, body), codexOkCredential);
      const result = await runFetch(usageRequest("codex", "resets"));
      // Fails SOFT to clean no-data — NOT ValidationDrift, and NEVER a fake zero.
      expect(result).toMatchObject({
        ok: false,
        failure: {
          category: "no-data-yet",
          displayState: "no-data-yet",
          provider: { reasonCode: "usage-codex-resets-not-returned" },
        },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("does not consult the session-file fallback on the resets path (HTTP-only) and surfaces the failure", async () => {
    let sessionReads = 0;
    const runFetch = codexEffectSourceFetch(
      [],
      respondJson(503, { error: "unavailable" }),
      codexOkCredential,
      async () => {
        sessionReads += 1;
        return { fetchedAtEpochMs: 5_000, fiveHourPercent: 61 };
      },
      () => 9_000,
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    // Unlike the percentage window path, the resets path never reads the session file.
    expect(sessionReads).toBe(0);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("snapshot");
  });

  it("performs the ungated one-shot 401 auth refresh on the resets endpoint and never leaks the codex secrets", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    let reads = 0;
    const runFetch = codexEffectSourceFetch(
      captured,
      respondJson(401, { error: "unauthorized" }),
      async (): Promise<CodexCredentialResult> => {
        reads += 1;
        return { ok: true, accessToken: CODEX_ACCESS_TOKEN, accountId: CODEX_ACCOUNT_ID };
      },
    );

    const result = await runFetch(usageRequest("codex", "resets"));

    // Initial read + one 401-triggered re-read = 2 reads; two HTTP attempts, BOTH against the resets endpoint.
    expect(reads).toBe(2);
    expect(captured).toHaveLength(2);
    expect(String(captured[1]?.url)).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.displayState).toBe("unauthorized-expired");
      expect(result.failure.sanitized).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCOUNT_ID);
  });
});

describe("provider capability module structure", () => {
  it("keeps one self-contained provider capability module folder per approved provider family", () => {
    const usageProviderModules = providerModulePaths("usage", USAGE_PROVIDER_IDS);
    const balanceProviderModules = providerModulePaths("balance", BALANCE_PROVIDER_IDS);
    const statusProviderModules = providerModulePaths("status", STATUS_PROVIDER_IDS);

    for (const modulePath of [...usageProviderModules, ...balanceProviderModules, ...statusProviderModules]) {
      expect(existsSync(modulePath), `${relative(sourceRoot, modulePath)} should exist`).toBe(true);
    }

    expect(providerCapabilityEntries("usage")).toEqual(["claude-code", "codex", "index.ts", "kimi-code", "minimax", "zai-coding-plan"]);
    expect(providerCapabilityEntries("balance")).toEqual([
      "anthropic-api",
      "deepgram",
      "deepseek",
      "elevenlabs",
      "exa",
      "fal",
      "index.ts",
      "jina",
      "moonshot",
      "openai-api",
      "openrouter",
      "runpod",
      "speechmatics",
      "tavily",
    ]);
    expect(providerCapabilityEntries("status")).toEqual([
      "anthropic-api",
      "index.ts",
      "minimax",
      "moonshot",
      "openai-api",
    ]);
  });

  it("keeps concrete provider schema, normalizer, and gate ownership out of the public index and shared buckets", () => {
    const indexSource = readFileSync(join(sourceRoot, "index.ts"), "utf8");

    expect(indexSource).not.toContain("Schema.");
    expect(indexSource).not.toMatch(/normalize(?:Fal|OpenAi|Deepgram|Runpod|Speechmatics|Exa|Moonshot|DeepSeek)Response/);
    expect(indexSource).not.toContain("gatedNormalizationFailure");
    expect(indexSource).not.toContain("balance-fal-response-schema");
    expect(indexSource).not.toContain("schema-owner-gated");

    const unexpectedProviderBuckets = providerTreeEntries()
      .filter((entry) => entry.kind === "file" && basename(entry.path) === "index.ts")
      .filter((entry) => !isExpectedProviderModule(entry.path) && !isProviderFamilyIndex(entry.path));

    expect(unexpectedProviderBuckets.map((entry) => relative(sourceRoot, entry.path))).toEqual([]);
  });
});

describe("Usage source-gated adapter bindings", () => {
  it("exposes Usage adapter bindings as fetchable source adapters", () => {
    const bindings = listUsageProviderAdapterBindings();

    expect(bindings.map((binding) => binding.providerId)).toEqual(["claude-code", "codex", "kimi-code", "zai-coding-plan", "minimax"]);
    expect(bindings).toContainEqual(
      expect.objectContaining({
        adapterBindingId: "usage.claude-code",
        providerId: "claude-code",
        actionFamilyId: "usage",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        sourceAccess: "source-fetch",
      }),
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        adapterBindingId: "usage.codex",
        providerId: "codex",
        actionFamilyId: "usage",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        sourceAccess: "source-fetch",
      }),
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        adapterBindingId: "usage.zai-coding-plan",
        providerId: "zai-coding-plan",
        actionFamilyId: "usage",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        sourceAccess: "source-fetch",
      }),
    );
    expect(bindings).toContainEqual(
      expect.objectContaining({
        adapterBindingId: "usage.minimax",
        providerId: "minimax",
        actionFamilyId: "usage",
        implementationStatus: "implemented",
        sourceProofStatus: "probeAccepted",
        fetchAllowed: true,
        sourceAccess: "source-fetch",
      }),
    );

    expect(findProviderAdapterBinding("usage.claude-code")).toMatchObject({
      providerId: "claude-code",
      fetchAllowed: true,
    });
    expect(findProviderAdapterBinding("usage.missing-provider")).toBeUndefined();
  });

  it("calls source fetches for implemented Claude Code and Codex usage providers", async () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      let sourceCalls = 0;
      const snapshot = {
        familyId: "usage",
        providerId,
        metricKind: "usage-percent",
        metricDirection: "upper-bound",
        unit: "percent",
        coverage: { kind: "rolling-window", window: "five-hour" },
        value: 1,
        fetchedAtEpochMs: 1,
      } as const satisfies NormalizedSnapshot;
      const schedulerFetch = createSourceGatedUsageFetch({
        providerId,
        capability: usageCapability(providerId),
        sourceFetch: () => {
          sourceCalls += 1;
          return {
            ok: true,
            snapshot,
          };
        },
      });

      const result = await schedulerFetch(usageRequest(providerId, "five-hour"));

      expect(sourceCalls).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        snapshot,
      });
    }
  });

  it("executes z.ai implemented source fetches without fake values from the gate", async () => {
    let sourceCalls = 0;
    const snapshot = {
      familyId: "usage",
      providerId: "zai-coding-plan",
      metricKind: "usage-percent",
      metricDirection: "upper-bound",
      unit: "percent",
      coverage: { kind: "rolling-window", window: "monthly-mcp" },
      value: 24,
      fetchedAtEpochMs: 1,
    } as const satisfies NormalizedSnapshot;
    const schedulerFetch = createSourceGatedUsageFetch({
      providerId: "zai-coding-plan",
      capability: usageCapability("zai-coding-plan"),
      sourceFetch: () => {
        sourceCalls += 1;
        return {
          ok: true,
          snapshot,
        };
      },
    });

    const result = await schedulerFetch(usageRequest("zai-coding-plan", "monthly-mcp"));

    expect(sourceCalls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      snapshot,
    });
  });
});

describe("Balance adapter bindings and source gates", () => {
  it("exposes all implemented first Balance provider bindings as fetchable source adapters", () => {
    const bindings = listBalanceProviderAdapterBindings();

    expect(bindings.map((binding) => binding.providerId)).toEqual(BALANCE_PROVIDER_IDS);
    expect(bindings.every((binding) => binding.fetchAllowed === true)).toBe(true);
    expect(bindings.every((binding) => binding.sourceAccess === "source-fetch")).toBe(true);
    expect(bindings.every((binding) => binding.retryOwner === "scheduler")).toBe(true);
    expect(bindings.every((binding) => binding.errorOwner === "shared-errors")).toBe(true);
    expect(bindings.every((binding) => binding.displayOwner === "display-boundary")).toBe(true);

    expect(findProviderAdapterBinding("balance.fal")).toMatchObject({
      adapterBindingId: "balance.fal",
      providerId: "fal",
      actionFamilyId: "balance",
      implementationStatus: "implemented",
      sourceProofStatus: "probeAccepted",
      fetchAllowed: true,
    });
  });

  it("calls source fetches for implemented Balance providers", async () => {
    let sourceCalls = 0;
    const snapshot = fakeBalanceSnapshot("fal");
    const schedulerFetch = createSourceGatedBalanceFetch({
      providerId: "fal",
      capability: balanceCapability("fal"),
      sourceFetch: () => {
        sourceCalls += 1;
        return {
          ok: true,
          snapshot,
        };
      },
    });

    const result = await schedulerFetch(balanceRequest("fal"));

    expect(sourceCalls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      snapshot,
    });
  });

  it("executes implemented probe-sourced Balance providers instead of using source-proof metadata as a runtime gate", async () => {
    for (const providerId of ["runpod", "jina"] as const) {
      let sourceCalls = 0;
      const snapshot = fakeBalanceSnapshot(providerId);
      const schedulerFetch = createSourceGatedBalanceFetch({
        providerId,
        capability: balanceCapability(providerId),
        sourceFetch: () => {
          sourceCalls += 1;
          return {
            ok: true,
            snapshot,
          };
        },
      });

      const result = await schedulerFetch(balanceRequest(providerId));

      expect(sourceCalls).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        snapshot,
      });
    }
  });

  it("executes implemented Anthropic and Tavily Balance source fetches", async () => {
    for (const providerId of ["anthropic-api", "tavily"] as const) {
      let sourceCalls = 0;
      const snapshot = fakeBalanceSnapshot(providerId);
      const schedulerFetch = createSourceGatedBalanceFetch({
        providerId,
        capability: balanceCapability(providerId),
        sourceFetch: () => {
          sourceCalls += 1;
          return {
            ok: true,
            snapshot,
          };
        },
      });

      const result = await schedulerFetch(balanceRequest(providerId));

      expect(sourceCalls).toBe(1);
      expect(result).toMatchObject({
        ok: true,
        snapshot,
      });
    }
  });

  it("allows a test-only future implemented Balance provider to reuse the same source-gate and scheduler contract", async () => {
    const futureProviderId = "future-balance-provider" as ProviderId;
    const capability: ProviderCapabilityMetadata = {
      actionFamilyId: "balance",
      adapterBindingId: "balance.future-balance-provider",
      implementationStatus: "implemented",
      sourceProofStatus: "docsBacked",
      credentialClasses: ["plugin-api-key"],
      sensitiveSelectorRequirements: [],
      requiredSettings: ["credential-profile"],
      metricKind: "remaining-balance",
      metricDirection: METRIC_KIND_DIRECTION["remaining-balance"],
      displayUnit: METRIC_KIND_UNIT["remaining-balance"],
      displayBasis: "remaining-value",
      coverageKind: "evergreen",
      severityStrategy: {
        kind: "registry-default",
        reference: "lower-bound-remaining-money-default",
      },
    };
    const keyParts: SchedulerKeyParts = {
      familyId: "balance",
      providerId: futureProviderId,
      windowOrPeriod: "evergreen",
      credentialProfileId: "none",
    };
    const futureSnapshot = {
      familyId: "balance",
      providerId: futureProviderId,
      metricKind: "remaining-balance",
      metricDirection: "lower-bound",
      unit: "money",
      coverage: { kind: "evergreen" },
      value: 10,
      fetchedAtEpochMs: 1,
    } as unknown as NormalizedSnapshot;
    const schedulerFetch = createSourceGatedBalanceFetch({
      providerId: futureProviderId,
      capability,
      sourceFetch: () => ({
        ok: true,
        snapshot: futureSnapshot,
      }),
    });

    expect(await schedulerFetch(schedulerRequest(keyParts))).toMatchObject({
      ok: true,
      snapshot: {
        providerId: futureProviderId,
        value: 10,
      },
    });
  });
});

describe("docs-shaped Balance response normalization", () => {
  it("normalizes fal.ai, Deepgram, Moonshot, and DeepSeek remaining balances as lower-bound money snapshots", () => {
    expectNormalizedSnapshot({
      providerId: "fal",
      response: { credits: { current_balance: 42.25, currency: "USD" } },
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: 42.25,
      currencyCode: "USD",
    });
    // The FIRST balance row is prominent; additional rows surface as the
    // "+N" extra-currencies marker instead of a summed total (old behavior).
    expectNormalizedSnapshot({
      providerId: "deepgram",
      response: {
        balances: [
          { balance_id: "fixture-balance-a", amount: 10, units: "USD", purchase_order_id: "fixture-order-a" },
          { balance_id: "fixture-balance-b", amount: 2.5, units: "USD", purchase_order_id: "fixture-order-b" },
        ],
      },
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: 10,
      currencyCode: "USD",
    });
    expectNormalizedSnapshot({
      providerId: "moonshot",
      response: {
        data: {
          available_balance: "7.75",
          voucher_balance: "1.25",
          cash_balance: "6.50",
        },
      },
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: 7.75,
    });
    expectNormalizedSnapshot({
      providerId: "deepseek",
      response: {
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "8.50", granted_balance: "1.00", topped_up_balance: "7.50" }],
      },
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: 8.5,
      currencyCode: "USD",
    });
  });

  it("derives OpenRouter remaining credit from complete numeric fields without clamping or retaining unknown fields", () => {
    for (const response of [
      { data: { total_credits: 250, total_usage: 175.5 } },
      { data: { total_credits: "250", total_usage: "175.5" } },
      {
        data: { total_credits: 250, total_usage: 175.5, ignored_vendor_field: "ignored" },
        ignored_root_field: true,
      },
    ]) {
      expectNormalizedSnapshot({
        providerId: "openrouter",
        response,
        metricKind: "remaining-balance",
        coverageKind: "evergreen",
        value: 74.5,
      });
    }

    expectNormalizedSnapshot({
      providerId: "openrouter",
      response: { data: { total_credits: 175.5, total_usage: 250 } },
      metricKind: "remaining-balance",
      coverageKind: "evergreen",
      value: -74.5,
    });

    const missingUsage = normalize("openrouter", { data: { total_credits: 250 } });
    expect(missingUsage).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        displayState: "validation-drift",
        diagnostics: {
          boundary: "provider-adapters-balance-openrouter",
          reasonCode: "balance-openrouter-response-schema",
        },
      },
    });
    expect(missingUsage).not.toHaveProperty("snapshot");
  });

  it("normalizes OpenAI and Exa docs-shaped cost fields as upper-bound month-to-date spend snapshots", () => {
    expectNormalizedSnapshot({
      providerId: "openai-api",
      response: {
        data: [
          {
            results: [
              { amount: { currency: "usd", value: 12.25 }, line_item: "model-usage" },
              { amount: { currency: "usd", value: 3.5 }, line_item: "tool-usage" },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      },
      metricKind: "current-month-spend",
      coverageKind: "month-to-date",
      value: 15.75,
      currencyCode: "USD",
    });
    expectNormalizedSnapshot({
      providerId: "exa",
      response: {
        period: { start: "2026-07-01", end: "2026-07-05" },
        total_cost_usd: 4.2,
        cost_breakdown: [{ price_id: "fixture-price", price_name: "search", quantity: 10, amount_usd: 4.2 }],
        metadata: { generated_at: "2026-07-05T00:00:00Z" },
      },
      metricKind: "current-month-spend",
      coverageKind: "month-to-date",
      value: 4.2,
      currencyCode: "USD",
    });
  });

  it("rejects incomplete OpenAI cost pagination without emitting a trusted spend snapshot", () => {
    for (const response of [
      {
        data: [{ results: [{ amount: { currency: "usd", value: 12.25 } }] }],
        has_more: true,
        next_page: "fixture-next-page",
      },
      {
        data: [{ results: [{ amount: { currency: "usd", value: 12.25 } }] }],
        has_more: false,
        next_page: "fixture-next-page",
      },
    ]) {
      const result = normalize("openai-api", response);

      expect(result).toMatchObject({
        ok: false,
        failure: {
          category: "validation-drift",
          displayState: "validation-drift",
          retryClass: "rate-limit-backoff",
          provider: {
            failureClass: "validation",
            reasonCode: "balance-openai-pagination-incomplete",
          },
        },
      });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("normalizes Runpod billing history rows as current-period spend without a remaining-value path", () => {
    expectNormalizedSnapshot({
      providerId: "runpod",
      response: {
        pods: [{ amount: 2.25, diskSpaceBilledGb: 1, podId: "fixture-pod", gpuTypeId: "fixture-gpu", time: "2026-07-05", timeBilledMs: 1000 }],
        endpoints: [{ amount: 3.75, endpointId: "fixture-endpoint", time: "2026-07-05", timeBilledMs: 2000 }],
      },
      metricKind: "current-period-spend",
      coverageKind: "current-period",
      value: 6,
      currencyCode: "USD",
    });
  });

  it("rejects Runpod responses with absent billing collections while allowing explicit empty collections", () => {
    const missingCollections = normalize("runpod", {});

    expect(missingCollections).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        displayState: "validation-drift",
        retryClass: "rate-limit-backoff",
        provider: {
          failureClass: "validation",
          reasonCode: "balance-runpod-billing-collections-missing",
        },
      },
    });
    expect(missingCollections).not.toHaveProperty("snapshot");

    expectNormalizedSnapshot({
      providerId: "runpod",
      response: { pods: [], endpoints: [] },
      metricKind: "current-period-spend",
      coverageKind: "current-period",
      value: 0,
      currencyCode: "USD",
    });
  });

  it("normalizes Speechmatics duration_hrs as used-time decimal hours for display-boundary formatting", () => {
    expectNormalizedSnapshot({
      providerId: "speechmatics",
      response: {
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-05T00:00:00Z",
        summary: [
          {
            mode: "asr",
            type: "transcription",
            language: "en",
            operating_point: "enhanced",
            count: 2,
            duration_hrs: 0.8,
          },
          {
            mode: "asr",
            type: "transcription",
            language: "en",
            operating_point: "standard",
            count: 1,
            duration_hrs: 0.8,
          },
        ],
        details: [],
      },
      metricKind: "used-time",
      coverageKind: "current-period",
      value: 1.6,
    });
    expectNormalizedSnapshot({
      providerId: "speechmatics",
      response: {
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-05T00:00:00Z",
        summary: null,
        details: null,
      },
      metricKind: "used-time",
      coverageKind: "current-period",
      value: 0,
    });
  });

  it("normalizes Anthropic, Tavily, ElevenLabs, and Jina accepted live response shapes", () => {
    expectNormalizedSnapshot({
      providerId: "anthropic-api",
      response: {
        data: [
          {
            starting_at: "2026-07-01T00:00:00Z",
            ending_at: "2026-07-02T00:00:00Z",
            results: [
              { amount: "125", currency: "USD" },
              { amount: "50", currency: "USD" },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      },
      metricKind: "current-month-spend",
      coverageKind: "month-to-date",
      value: 1.75,
      currencyCode: "USD",
    });
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: {
          plan_usage: 40,
          plan_limit: 100,
          paygo_usage: 5,
          paygo_limit: 25,
        },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: 80,
    });
    // Plan exhausted (plan_usage 150 > plan_limit 100): the plan term is zero-capped
    // so its -50 deficit does not drag the number down (paygo already reports that
    // overflow); remaining is the paygo headroom 25 - 5 = 20.
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 150, plan_limit: 100, paygo_usage: 5, paygo_limit: 25 },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: 20,
    });
    // Paygo cap breached (paygo_usage 30 > paygo_limit 25): the paygo term is NOT
    // capped, so the genuine overage surfaces as remaining -5 instead of hiding at 0.
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 150, plan_limit: 100, paygo_usage: 30, paygo_limit: 25 },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: -5,
    });
    // Missing paygo ceiling (paygo_usage present, paygo_limit absent): the paygo pool is
    // unpriced, so its term contributes 0 instead of reading -paygo_usage as a spurious
    // overage; with the plan exhausted the deficit is zero-capped, so remaining is 0 (not -5).
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 150, plan_limit: 100, paygo_usage: 5 },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: 0,
    });
    // Plan-only account (no paygo fields at all): remaining is simply the plan headroom.
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 40, plan_limit: 100 },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: 60,
    });
    // Real zero paygo cap (paygo_limit 0, present not missing): a finite 0 IS a real
    // ceiling, so the term applies and usage past it surfaces negative (0 - 5 = -5) —
    // distinct from a missing limit, guarding against a refactor back to numberOrZero.
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 150, plan_limit: 100, paygo_usage: 5, paygo_limit: 0 },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: -5,
    });
    // Explicit null paygo_limit (schema is NullOr(Number)): no finite ceiling → term 0.
    expectNormalizedSnapshot({
      providerId: "tavily",
      response: {
        account: { plan_usage: 150, plan_limit: 100, paygo_usage: 5, paygo_limit: null },
        key: {},
      },
      metricKind: "remaining-credits",
      coverageKind: "evergreen",
      value: 0,
    });
    expectNormalizedSnapshot({
      providerId: "elevenlabs",
      response: {
        character_count: 200,
        character_limit: 1_000,
      },
      metricKind: "remaining-characters",
      coverageKind: "evergreen",
      value: 800,
    });
    expectNormalizedSnapshot({
      providerId: "jina",
      response: "Balance left: 12345",
      metricKind: "remaining-tokens",
      coverageKind: "evergreen",
      value: 12_345,
    });
  });

  it("maps malformed docs-shaped input to sanitized validation drift failures without schema detail echoes", () => {
    const result = normalize("fal", { credits: { current_balance: "not-a-number", currency: "USD" } });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        category: "validation-drift",
        displayState: "validation-drift",
        retryClass: "rate-limit-backoff",
        diagnostics: {
          boundary: "provider-adapters-balance-fal",
          reasonCode: "balance-fal-response-schema",
          issueCount: 1,
        },
        sanitized: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("not-a-number");
    expect(JSON.stringify(result)).not.toContain("current_balance");
  });
});

describe("UTC month-start helpers", () => {
  it("derives the first day of the current UTC calendar month from a mid-month instant", () => {
    const midMonth = Date.UTC(2026, 6, 9, 22, 0, 0);
    expect(monthStartEpochMs(midMonth)).toBe(Date.UTC(2026, 6, 1));
    expect(monthStartDateString(midMonth)).toBe("2026-07-01");
  });

  it("keeps a first-of-month instant on the same UTC month", () => {
    const firstOfMonth = Date.UTC(2026, 6, 1, 0, 0, 0);
    expect(monthStartEpochMs(firstOfMonth)).toBe(Date.UTC(2026, 6, 1));
    expect(monthStartDateString(firstOfMonth)).toBe("2026-07-01");
  });

  it("snaps a January instant to the first of January (year-boundary sanity)", () => {
    const january = Date.UTC(2026, 0, 20, 12, 30, 0);
    expect(monthStartEpochMs(january)).toBe(Date.UTC(2026, 0, 1));
    expect(monthStartDateString(january)).toBe("2026-01-01");
  });
});

// The straightforward single-request Balance adapters migrated to the
// Effect-native pattern (fal, deepseek, moonshot, tavily, speechmatics, elevenlabs decode
// JSON via requestJsonSchema; jina reads TEXT via requestTextBody). Each fetches + decodes
// at the source through the injected fake `HttpClient` layer (no live call), unwraps the
// credential with the SINGLE `Redacted.value` at its request builder, and never leaks the
// secret. The multi-call adapters (openai-api/deepgram/exa/runpod) are migrated to the same
// Effect-native pattern (see the multi-call suite below).
const MIGRATED_SECRET = "fixture-migrated-secret-value";

type MigratedEffectModule = {
  readonly createSourceFetchEffect?: (
    input: Parameters<typeof anthropicApiBalanceProviderModule.createSourceFetchEffect>[0],
  ) => Parameters<typeof bridgeEffectSchedulerFetch>[0];
};

function respondText(status: number, text: string, headers?: Readonly<Record<string, string>>): FakeExecute {
  return (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(text, { status, headers: { "content-type": "text/plain", ...(headers ?? {}) } }),
      ),
    );
}

function migratedEffectSourceFetch(
  module: MigratedEffectModule,
  providerId: BalanceProviderId,
  baseUrl: string,
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
  attemptContext?: ProviderAdapterAttemptContext,
) {
  const effectFetch = module.createSourceFetchEffect?.({
    providerId,    baseUrl,
    resolveCredential: async () => ({ ok: true, value: { value: Redacted.make(MIGRATED_SECRET) } }),
    now: () => Date.UTC(2026, 6, 15),
  });
  if (effectFetch === undefined) {
    throw new Error(`${providerId} must expose createSourceFetchEffect (Effect-native)`);
  }
  return bridgeEffectSchedulerFetch(
    attemptContext === undefined
      ? effectFetch
      : (request) => effectFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attemptContext)),
    recordingHttpClientLayer(captured, execute),
  );
}

const migratedJsonCases = [
  {
    providerId: "fal" as const,
    module: falBalanceProviderModule,
    baseUrl: "https://api.fal.ai",
    body: { credits: { current_balance: 42.25, currency: "USD" } },
    value: 42.25,
    metricKind: "remaining-balance",
    endpointContains: "/v1/account/billing",
    headerName: "authorization",
    headerValue: `Key ${MIGRATED_SECRET}`,
  },
  {
    providerId: "deepseek" as const,
    module: deepseekBalanceProviderModule,
    baseUrl: "https://api.deepseek.com",
    body: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "8.50" }] },
    value: 8.5,
    metricKind: "remaining-balance",
    endpointContains: "/user/balance",
    headerName: "authorization",
    headerValue: `Bearer ${MIGRATED_SECRET}`,
  },
  {
    providerId: "moonshot" as const,
    module: moonshotBalanceProviderModule,
    baseUrl: "https://api.moonshot.ai",
    body: { data: { available_balance: "7.75" } },
    value: 7.75,
    metricKind: "remaining-balance",
    endpointContains: "/v1/users/me/balance",
    headerName: "authorization",
    headerValue: `Bearer ${MIGRATED_SECRET}`,
  },
  {
    providerId: "openrouter" as const,
    module: openrouterBalanceProviderModule,
    baseUrl: "https://openrouter.ai",
    body: { data: { total_credits: 250, total_usage: 175.5 } },
    value: 74.5,
    metricKind: "remaining-balance",
    endpointContains: "/api/v1/credits",
    headerName: "authorization",
    headerValue: `Bearer ${MIGRATED_SECRET}`,
  },
  {
    providerId: "tavily" as const,
    module: tavilyBalanceProviderModule,
    baseUrl: "https://api.tavily.com",
    body: { account: { plan_usage: 40, plan_limit: 100, paygo_usage: 5, paygo_limit: 25 }, key: {} },
    value: 80,
    metricKind: "remaining-credits",
    endpointContains: "/usage",
    headerName: "authorization",
    headerValue: `Bearer ${MIGRATED_SECRET}`,
  },
  {
    providerId: "speechmatics" as const,
    module: speechmaticsBalanceProviderModule,
    baseUrl: "https://asr.api.speechmatics.com",
    body: {
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-05T00:00:00Z",
      summary: [
        { count: 2, duration_hrs: 0.8 },
        { count: 1, duration_hrs: 0.8 },
      ],
      details: [],
    },
    value: 1.6,
    metricKind: "used-time",
    endpointContains: "/v2/usage",
    headerName: "authorization",
    headerValue: `Bearer ${MIGRATED_SECRET}`,
  },
  {
    providerId: "elevenlabs" as const,
    module: elevenlabsBalanceProviderModule,
    baseUrl: "https://api.elevenlabs.io",
    body: { character_count: 200, character_limit: 1_000 },
    value: 800,
    metricKind: "remaining-characters",
    endpointContains: "/v1/user/subscription",
    // Raw key by vendor contract — no "Bearer" prefix (old working adapter).
    headerName: "xi-api-key",
    headerValue: MIGRATED_SECRET,
  },
] as const;

describe("migrated single-request Balance adapters", () => {
  it.each(migratedJsonCases)(
    "$providerId fetches + decodes the vendor JSON body at the source into a normalized snapshot",
    async ({ providerId, module, baseUrl, body, value, metricKind, endpointContains }) => {
      const captured: HttpClientRequest.HttpClientRequest[] = [];
      const runFetch = migratedEffectSourceFetch(module, providerId, baseUrl, captured, respondJson(200, body));

      const result = await runFetch(balanceRequest(providerId));

      expect(result).toMatchObject({ ok: true, snapshot: { familyId: "balance", providerId, metricKind, value } });
      // ONE HTTP attempt (no adapter retry — the scheduler owns retry).
      expect(captured).toHaveLength(1);
      expect(String(captured[0]?.url)).toContain(endpointContains);
    },
  );

  it("maps OpenRouter Management-key scope rejection and rate limiting through the central failure contract", async () => {
    const rejectedScope = await migratedEffectSourceFetch(
      openrouterBalanceProviderModule,
      "openrouter",
      "https://openrouter.ai",
      [],
      respondJson(403, { error: "insufficient scope" }),
    )(balanceRequest("openrouter"));
    expect(rejectedScope).toMatchObject({
      ok: false,
      failure: {
        category: "insufficient-credential-scope",
        displayState: "invalid-credentials",
        retryClass: "credential-settings-refresh",
      },
    });

    const rateLimited = await migratedEffectSourceFetch(
      openrouterBalanceProviderModule,
      "openrouter",
      "https://openrouter.ai",
      [],
      respondJson(429, { error: "rate limited" }, { "retry-after": "30" }),
    )(balanceRequest("openrouter"));
    expect(rateLimited).toMatchObject({
      ok: false,
      retry: { retryAfterSeconds: 30 },
      failure: {
        category: "rate-limited",
        displayState: "rate-limited",
        retryClass: "rate-limit-backoff",
      },
    });
  });

  it.each(migratedJsonCases)(
    "$providerId carries the raw key via the single Redacted.value unwrap and never leaks it on failure",
    async ({ providerId, module, baseUrl, body, headerName, headerValue }) => {
      // Type-level redaction: the credential material renders <redacted>, never the raw secret.
      const material = { value: Redacted.make(MIGRATED_SECRET) };
      expect(String(material.value)).toBe("<redacted>");
      expect(JSON.stringify(material)).not.toContain(MIGRATED_SECRET);

      const capturedOk: HttpClientRequest.HttpClientRequest[] = [];
      const okFetch = migratedEffectSourceFetch(module, providerId, baseUrl, capturedOk, respondJson(200, body));
      await okFetch(balanceRequest(providerId));
      expect(PlatformHeaders.get(capturedOk[0]!.headers, headerName)).toStrictEqual(Option.some(headerValue));

      const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
      const failFetch = migratedEffectSourceFetch(module, providerId, baseUrl, capturedFail, respondJson(401, { error: "unauthorized" }));
      const failed = await failFetch(balanceRequest(providerId));

      expect(failed.ok).toBe(false);
      expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
      if (!failed.ok) {
        expect(failed.failure.displayState).toBe("unauthorized-expired");
      }
    },
  );

  it("jina fetches + decodes the plain-text balance body via requestTextBody into a normalized snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(jinaBalanceProviderModule, "jina", "https://r.jina.ai", captured, respondText(200, "Balance left: 12345"));

    const result = await runFetch(balanceRequest("jina"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: { familyId: "balance", providerId: "jina", metricKind: "remaining-tokens", value: 12_345 },
    });
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.url)).toBe("https://r.jina.ai/");
  });

  it("jina carries the raw key via the single Redacted.value unwrap and never leaks it on failure", async () => {
    const capturedOk: HttpClientRequest.HttpClientRequest[] = [];
    const okFetch = migratedEffectSourceFetch(jinaBalanceProviderModule, "jina", "https://r.jina.ai", capturedOk, respondText(200, "Balance left: 12345"));
    await okFetch(balanceRequest("jina"));
    expect(PlatformHeaders.get(capturedOk[0]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${MIGRATED_SECRET}`));

    const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
    const failFetch = migratedEffectSourceFetch(jinaBalanceProviderModule, "jina", "https://r.jina.ai", capturedFail, respondText(503, "upstream down"));
    const failed = await failFetch(balanceRequest("jina"));

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
  });
});

// The multi-call Balance adapters migrated to the Effect-native pattern.
// openai-api paginates the cost report (the anthropic loop); deepgram (projects -> balances)
// and exa (api-keys -> usage) are two-step with a cached discovery id; runpod combines two
// billing calls. Each composes its steps in one `Effect.gen`, unwraps the credential with the
// SINGLE `Redacted.value` at its request builder and REUSES it across every step, runs ONE
// attempt per HTTP call (no adapter retry), and never leaks the secret. `respondJsonSequence`
// feeds the fake `HttpClient` layer one response per sequential call so the multi-step flow and
// the cached-id reuse/reset behavior are exercised at the source (no live call).
function respondJsonSequence(
  responses: readonly { readonly status?: number; readonly body: unknown }[],
): FakeExecute {
  const pending = [...responses];
  return (request) => {
    const next = pending.shift();
    if (next === undefined) {
      throw new Error(`Unexpected HTTP request to ${String(request.url)} (response sequence exhausted).`);
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(next.body), {
          status: next.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  };
}

function exaUsageBody(totalCostUsd: number): unknown {
  return {
    period: { start: "2026-07-01", end: "2026-07-05" },
    total_cost_usd: totalCostUsd,
    cost_breakdown: [{ price_id: "fixture-price", price_name: "search", quantity: 1, amount_usd: totalCostUsd }],
    metadata: { generated_at: "2026-07-05T00:00:00Z" },
  };
}

// Fixed-seam Runpod fetch: mirrors the anthropic-api fetch tests, which
// control the current-month range by pinning the scheduler-owned `fetchedAtEpochMs` seam through the
// adapter input's `now`. Runs through the shared Promise bridge + fake `HttpClient` so the outgoing
// month-range params and the aggregation are deterministic without any wall-clock or TestClock read.
// The pinned instant differs from the wall clock, proving the range is seam-derived.
function runpodFixedSeamFetch(
  captured: HttpClientRequest.HttpClientRequest[],
  execute: FakeExecute,
  nowMs: number,
  attemptContext?: ProviderAdapterAttemptContext,
) {
  const effectFetch = runpodBalanceProviderModule.createSourceFetchEffect({
    providerId: "runpod",
    baseUrl: "https://api.runpod.io",
    resolveCredential: async () => ({ ok: true, value: { value: Redacted.make(MIGRATED_SECRET) } }),
    now: () => nowMs,
  });
  return bridgeEffectSchedulerFetch(
    attemptContext === undefined
      ? effectFetch
      : (request) => effectFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attemptContext)),
    recordingHttpClientLayer(captured, execute),
  );
}

describe("migrated multi-call Balance adapters", () => {
  it("obtains one fresh permit per pagination, discovery, and dependent billing attempt", async () => {
    const permits: string[] = [];
    const attemptContext = {
      attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          permits.push("permit");
        }).pipe(Effect.zipRight(operation)),
      reportRateLimit: () => Effect.void,
    } satisfies ProviderAdapterAttemptContext;

    await anthropicEffectSourceFetch(
      [],
      respondJsonSequence([
        { body: anthropicCostReportBody({ has_more: true, next_page: "cursor-2" }) },
        { body: anthropicCostReportBody() },
      ]),
      attemptContext,
    )(balanceRequest("anthropic-api", "month-to-date"));

    await migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      [],
      respondJsonSequence([
        { body: { projects: [{ project_id: "proj-fixture" }] } },
        { body: { balances: [{ amount: 12.5, units: "usd" }] } },
      ]),
      attemptContext,
    )(balanceRequest("deepgram"));

    await runpodFixedSeamFetch(
      [],
      respondJsonSequence([{ body: [] }, { body: [] }]),
      Date.UTC(2026, 6, 9),
      attemptContext,
    )(balanceRequest("runpod"));

    expect(permits).toHaveLength(6);
  });

  it("openai-api paginates the cost report and decodes the accumulated pages into a month-to-date spend snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      openAiApiBalanceProviderModule,
      "openai-api",
      "https://api.openai.com",
      captured,
      respondJsonSequence([
        { body: { data: [{ results: [{ amount: { currency: "usd", value: "10.00" } }] }], has_more: true, next_page: "cursor-2" } },
        { body: { data: [{ results: [{ amount: { currency: "usd", value: "5.75" } }] }], has_more: false, next_page: null } },
      ]),
    );

    const result = await runFetch(balanceRequest("openai-api"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: { familyId: "balance", providerId: "openai-api", metricKind: "current-month-spend", value: 15.75 },
    });
    // ONE attempt per page (no adapter retry); the second request carried the next-page cursor.
    // `@effect/platform` parses the query into `urlParams` (the request `url` is query-less).
    expect(captured).toHaveLength(2);
    expect(String(captured[0]?.url)).toContain("/v1/organization/costs");
    expect(captured[0]?.urlParams).toContainEqual(["limit", "31"]);
    expect(captured[0]?.urlParams.some(([key]) => key === "page")).toBe(false);
    expect(captured[1]?.urlParams).toContainEqual(["page", "cursor-2"]);
  });

  it("openai-api carries the raw key via the single Redacted.value unwrap across pages and never leaks it on failure", async () => {
    const capturedOk: HttpClientRequest.HttpClientRequest[] = [];
    const okFetch = migratedEffectSourceFetch(
      openAiApiBalanceProviderModule,
      "openai-api",
      "https://api.openai.com",
      capturedOk,
      respondJsonSequence([{ body: { data: [{ results: [{ amount: { currency: "usd", value: "1.00" } }] }], has_more: false, next_page: null } }]),
    );
    await okFetch(balanceRequest("openai-api"));
    expect(PlatformHeaders.get(capturedOk[0]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${MIGRATED_SECRET}`));

    const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
    const failFetch = migratedEffectSourceFetch(
      openAiApiBalanceProviderModule,
      "openai-api",
      "https://api.openai.com",
      capturedFail,
      respondJson(401, { error: "unauthorized" }),
    );
    const failed = await failFetch(balanceRequest("openai-api"));

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
    if (!failed.ok) {
      expect(failed.failure.displayState).toBe("unauthorized-expired");
    }
  });

  it("deepgram fetches projects then balances and reuses the cached project id on the next call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      captured,
      respondJsonSequence([
        { body: { projects: [{ project_id: "proj-123" }] } },
        { body: { balances: [{ amount: 12.5, units: "usd" }] } },
        { body: { balances: [{ amount: 9.25, units: "usd" }] } },
      ]),
    );

    const first = await runFetch(balanceRequest("deepgram"));
    const second = await runFetch(balanceRequest("deepgram"));

    expect(first).toMatchObject({ ok: true, snapshot: { providerId: "deepgram", metricKind: "remaining-balance", value: 12.5 } });
    expect(second).toMatchObject({ ok: true, snapshot: { providerId: "deepgram", value: 9.25 } });
    const urls = captured.map((request) => String(request.url));
    // Discovery ran exactly ONCE; both calls hit balances with the cached project id.
    expect(urls.filter((url) => url.endsWith("/v1/projects"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("/v1/projects/proj-123/balances"))).toHaveLength(2);
  });

  it("deepgram re-discovers the project id after a 4xx on the balances call invalidates the cache", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      captured,
      respondJsonSequence([
        { body: { projects: [{ project_id: "proj-123" }] } }, // call 1: discovery
        { status: 404, body: { error: "not found" } }, // call 1: balances 4xx -> invalidates cache
        { body: { projects: [{ project_id: "proj-456" }] } }, // call 2: re-discovery
        { body: { balances: [{ amount: 3.5, units: "usd" }] } }, // call 2: balances ok
      ]),
    );

    const first = await runFetch(balanceRequest("deepgram"));
    const second = await runFetch(balanceRequest("deepgram"));

    expect(first.ok).toBe(false);
    expect(second).toMatchObject({ ok: true, snapshot: { providerId: "deepgram", value: 3.5 } });
    const urls = captured.map((request) => String(request.url));
    // The 4xx invalidated the cache, so discovery ran again and call 2 used the re-discovered id.
    expect(urls.filter((url) => url.endsWith("/v1/projects"))).toHaveLength(2);
    expect(String(captured[3]?.url)).toContain("/v1/projects/proj-456/balances");
  });

  it("deepgram carries the raw key via the single Redacted.value unwrap across both steps and never leaks it on failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      captured,
      respondJsonSequence([
        { body: { projects: [{ project_id: "proj-123" }] } },
        { body: { balances: [{ amount: 12.5, units: "usd" }] } },
      ]),
    );
    await runFetch(balanceRequest("deepgram"));
    // The discovery AND balances requests both carry the same single-unwrap Token header.
    expect(PlatformHeaders.get(captured[0]!.headers, "authorization")).toStrictEqual(Option.some(`Token ${MIGRATED_SECRET}`));
    expect(PlatformHeaders.get(captured[1]!.headers, "authorization")).toStrictEqual(Option.some(`Token ${MIGRATED_SECRET}`));

    const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
    const failFetch = migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      capturedFail,
      respondJson(401, { error: "unauthorized" }),
    );
    const failed = await failFetch(balanceRequest("deepgram"));

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
  });

  it("deepgram classifies a discovery-call 401 as unauthorized-expired and a 408 as a transient timeout", async () => {
    // 401 on the projects (discovery) call -> UnauthorizedExpired -> unauthorized-expired: an auth
    // failure on the credential-settings-refresh retry class, NOT a transient retry.
    const capturedUnauthorized: HttpClientRequest.HttpClientRequest[] = [];
    const unauthorized = await migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      capturedUnauthorized,
      respondJson(401, { error: "unauthorized" }),
    )(balanceRequest("deepgram"));

    expect(capturedUnauthorized).toHaveLength(1);
    expect(unauthorized.ok).toBe(false);
    expect(JSON.stringify(unauthorized)).not.toContain(MIGRATED_SECRET);
    if (!unauthorized.ok) {
      expect(unauthorized.failure.category).toBe("unauthorized-expired");
      expect(unauthorized.failure.displayState).toBe("unauthorized-expired");
      expect(unauthorized.failure.retryClass).toBe("credential-settings-refresh");
    }

    // 408 on the projects (discovery) call -> Timeout -> timeout: a transient-retryable failure.
    const capturedTimeout: HttpClientRequest.HttpClientRequest[] = [];
    const timedOut = await migratedEffectSourceFetch(
      deepgramBalanceProviderModule,
      "deepgram",
      "https://api.deepgram.com",
      capturedTimeout,
      respondJson(408, { error: "request timeout" }),
    )(balanceRequest("deepgram"));

    expect(capturedTimeout).toHaveLength(1);
    expect(timedOut.ok).toBe(false);
    expect(JSON.stringify(timedOut)).not.toContain(MIGRATED_SECRET);
    if (!timedOut.ok) {
      expect(timedOut.failure.category).toBe("timeout");
      expect(timedOut.failure.displayState).toBe("timeout");
      expect(timedOut.failure.retryClass).toBe("transient-retry");
    }
  });

  it("exa fetches api-keys then usage and reuses the cached api-key id on the next call", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      captured,
      respondJsonSequence([
        { body: { apiKeys: [{ id: "key-abc" }] } },
        { body: exaUsageBody(3.5) },
        { body: exaUsageBody(4.75) },
      ]),
    );

    const first = await runFetch(balanceRequest("exa"));
    const second = await runFetch(balanceRequest("exa"));

    expect(first).toMatchObject({ ok: true, snapshot: { providerId: "exa", metricKind: "current-month-spend", value: 3.5 } });
    expect(second).toMatchObject({ ok: true, snapshot: { providerId: "exa", value: 4.75 } });
    const urls = captured.map((request) => String(request.url));
    // Discovery ran exactly ONCE; both calls hit usage with the cached api-key id.
    expect(urls.filter((url) => url.endsWith("/team-management/api-keys"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("/team-management/api-keys/key-abc/usage"))).toHaveLength(2);
  });

  it("exa re-discovers the api-key id after a 4xx on the usage call invalidates the cache", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      captured,
      respondJsonSequence([
        { body: { apiKeys: [{ id: "key-abc" }] } }, // call 1: discovery
        { status: 404, body: { error: "not found" } }, // call 1: usage 4xx -> invalidates cache
        { body: { apiKeys: [{ id: "key-def" }] } }, // call 2: re-discovery
        { body: exaUsageBody(2.0) }, // call 2: usage ok
      ]),
    );

    const first = await runFetch(balanceRequest("exa"));
    const second = await runFetch(balanceRequest("exa"));

    expect(first.ok).toBe(false);
    expect(second).toMatchObject({ ok: true, snapshot: { providerId: "exa", value: 2.0 } });
    const urls = captured.map((request) => String(request.url));
    expect(urls.filter((url) => url.endsWith("/team-management/api-keys"))).toHaveLength(2);
    expect(String(captured[3]?.url)).toContain("/team-management/api-keys/key-def/usage");
  });

  it("exa carries the raw key via the single Redacted.value unwrap across both steps and never leaks it on failure", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      captured,
      respondJsonSequence([{ body: { apiKeys: [{ id: "key-abc" }] } }, { body: exaUsageBody(2.0) }]),
    );
    await runFetch(balanceRequest("exa"));
    // Exa carries the RAW key (no prefix) in x-api-key on both the discovery and usage requests.
    expect(PlatformHeaders.get(captured[0]!.headers, "x-api-key")).toStrictEqual(Option.some(MIGRATED_SECRET));
    expect(PlatformHeaders.get(captured[1]!.headers, "x-api-key")).toStrictEqual(Option.some(MIGRATED_SECRET));

    const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
    const failFetch = migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      capturedFail,
      respondJson(401, { error: "unauthorized" }),
    );
    const failed = await failFetch(balanceRequest("exa"));

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
  });

  it("exa classifies a discovery-call 401 as unauthorized-expired and a 408 as a transient timeout", async () => {
    // 401 on the api-keys (discovery) call -> UnauthorizedExpired -> unauthorized-expired (auth,
    // credential-settings-refresh retry class).
    const capturedUnauthorized: HttpClientRequest.HttpClientRequest[] = [];
    const unauthorized = await migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      capturedUnauthorized,
      respondJson(401, { error: "unauthorized" }),
    )(balanceRequest("exa"));

    expect(capturedUnauthorized).toHaveLength(1);
    expect(unauthorized.ok).toBe(false);
    expect(JSON.stringify(unauthorized)).not.toContain(MIGRATED_SECRET);
    if (!unauthorized.ok) {
      expect(unauthorized.failure.category).toBe("unauthorized-expired");
      expect(unauthorized.failure.displayState).toBe("unauthorized-expired");
      expect(unauthorized.failure.retryClass).toBe("credential-settings-refresh");
    }

    // 408 on the api-keys (discovery) call -> Timeout -> timeout (transient-retryable).
    const capturedTimeout: HttpClientRequest.HttpClientRequest[] = [];
    const timedOut = await migratedEffectSourceFetch(
      exaBalanceProviderModule,
      "exa",
      "https://api.exa.ai",
      capturedTimeout,
      respondJson(408, { error: "request timeout" }),
    )(balanceRequest("exa"));

    expect(capturedTimeout).toHaveLength(1);
    expect(timedOut.ok).toBe(false);
    expect(JSON.stringify(timedOut)).not.toContain(MIGRATED_SECRET);
    if (!timedOut.ok) {
      expect(timedOut.failure.category).toBe("timeout");
      expect(timedOut.failure.displayState).toBe("timeout");
      expect(timedOut.failure.retryClass).toBe("transient-retry");
    }
  });

  it("runpod fetches billing pods and endpoints and combines them into a current-period spend snapshot", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    const runFetch = migratedEffectSourceFetch(
      runpodBalanceProviderModule,
      "runpod",
      "https://api.runpod.io",
      captured,
      respondJsonSequence([
        { body: [{ amount: 2.25 }] }, // pods
        { body: [{ amount: 3.75 }] }, // endpoints
      ]),
    );

    const result = await runFetch(balanceRequest("runpod"));

    expect(result).toMatchObject({
      ok: true,
      snapshot: { providerId: "runpod", metricKind: "current-period-spend", value: 6 },
    });
    const urls = captured.map((request) => String(request.url));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/v1/billing/pods");
    expect(urls[1]).toContain("/v1/billing/endpoints");
  });

  it("runpod carries the raw key via the single Redacted.value unwrap, short-circuits a failed first call, and never leaks it", async () => {
    const capturedOk: HttpClientRequest.HttpClientRequest[] = [];
    const okFetch = migratedEffectSourceFetch(
      runpodBalanceProviderModule,
      "runpod",
      "https://api.runpod.io",
      capturedOk,
      respondJsonSequence([{ body: [{ amount: 1 }] }, { body: [{ amount: 1 }] }]),
    );
    await okFetch(balanceRequest("runpod"));
    expect(PlatformHeaders.get(capturedOk[0]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${MIGRATED_SECRET}`));
    expect(PlatformHeaders.get(capturedOk[1]!.headers, "authorization")).toStrictEqual(Option.some(`Bearer ${MIGRATED_SECRET}`));

    const capturedFail: HttpClientRequest.HttpClientRequest[] = [];
    const failFetch = migratedEffectSourceFetch(
      runpodBalanceProviderModule,
      "runpod",
      "https://api.runpod.io",
      capturedFail,
      respondJson(503, { error: "unavailable" }),
    );
    const failed = await failFetch(balanceRequest("runpod"));

    expect(failed.ok).toBe(false);
    // A failed pods call short-circuits before the endpoints call (only ONE request made).
    expect(capturedFail).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain(MIGRATED_SECRET);
  });

  it("runpod sends an explicit current-UTC-month startTime and endTime=now on BOTH billing calls (fetchedAtEpochMs seam)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // Pin the fetch seam to a mid-month instant (2026-07-09T22:00:00.000Z); startTime must snap to
    // the UTC month start. The instant differs from the wall clock, proving the range is seam-derived.
    const runFetch = runpodFixedSeamFetch(
      captured,
      respondJsonSequence([
        { body: [{ amount: 1.5 }] }, // pods
        { body: [{ amount: 2.25 }] }, // endpoints
      ]),
      Date.UTC(2026, 6, 9, 22, 0, 0, 0),
    );

    const result = await runFetch(balanceRequest("runpod"));

    // Both billing calls carry the SAME explicit month range. @effect/platform moves a URL's
    // searchParams into `urlParams` (decoded), so the RFC3339 bounds appear as decoded tuples and
    // the path in `.url` is query-stripped. This locks the UTC-month-start math and endTime=now.
    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(request.urlParams).toContainEqual(["startTime", "2026-07-01T00:00:00.000Z"]);
      expect(request.urlParams).toContainEqual(["endTime", "2026-07-09T22:00:00.000Z"]);
    }

    // Aggregation is unchanged: 1.5 + 2.25 = 3.75 current-period spend (USD asserted in the
    // normalize test; the Effect path yields the plain snapshot without the result-level currency).
    expect(result).toMatchObject({
      ok: true,
      snapshot: { providerId: "runpod", metricKind: "current-period-spend", value: 3.75 },
    });
    expect(JSON.stringify(result)).not.toContain(MIGRATED_SECRET);
  });

  it("runpod aggregates an empty-account month range to zero spend (fetchedAtEpochMs seam)", async () => {
    const captured: HttpClientRequest.HttpClientRequest[] = [];
    // Runpod returns [] for both collections when the account has no active pods/endpoints; the
    // explicit month range is still sent and the empty billing history sums to zero (not defaulted).
    const runFetch = runpodFixedSeamFetch(
      captured,
      respondJsonSequence([{ body: [] }, { body: [] }]),
      Date.UTC(2026, 6, 9, 22, 0, 0, 0),
    );

    const result = await runFetch(balanceRequest("runpod"));

    expect(captured).toHaveLength(2);
    expect(result).toMatchObject({
      ok: true,
      snapshot: { providerId: "runpod", metricKind: "current-period-spend", value: 0 },
    });
  });
});

// Builds a discovery adapter's Effect-native source fetch whose credential resolver REJECTS,
// driving the shared `Effect.tryPromise` catch -> `credentialResolutionFailure(providerId)`
// consolidation. Mirrors `migratedEffectSourceFetch` but with a rejecting resolver;
// the 200 stub is never reached because resolution fails before any request is built.
function rejectedCredentialSourceFetch(
  module: MigratedEffectModule,
  providerId: BalanceProviderId,
  baseUrl: string,
  captured: HttpClientRequest.HttpClientRequest[],
) {
  const effectFetch = module.createSourceFetchEffect?.({
    providerId,
    baseUrl,
    resolveCredential: async () => {
      throw new Error("credential store unavailable");
    },
    now: () => Date.UTC(2026, 6, 15),
  });
  if (effectFetch === undefined) {
    throw new Error(`${providerId} must expose createSourceFetchEffect (Effect-native)`);
  }
  return bridgeEffectSchedulerFetch(effectFetch, recordingHttpClientLayer(captured, respondJson(200, {})));
}

describe("consolidated credential-resolution boundary label", () => {
  it.each([
    { module: deepgramBalanceProviderModule, providerId: "deepgram" as const, baseUrl: "https://api.deepgram.com" },
    { module: exaBalanceProviderModule, providerId: "exa" as const, baseUrl: "https://api.exa.ai" },
  ])(
    "labels a rejected $providerId credential resolver with the provider-scoped boundary and makes no HTTP call",
    async ({ module, providerId, baseUrl }) => {
      const captured: HttpClientRequest.HttpClientRequest[] = [];
      const runFetch = rejectedCredentialSourceFetch(module, providerId, baseUrl, captured);

      const result = await runFetch(balanceRequest(providerId));

      expect(result.ok).toBe(false);
      // Resolution rejected before any request was built, so no HTTP call was made.
      expect(captured).toHaveLength(0);
      if (!result.ok) {
        // The consolidated credentialResolutionFailure(providerId) derives the boundary from the id,
        // byte-identical to each adapter's former local copy — this pins it against a label regression.
        expect(result.failure.diagnostics.boundary).toBe(`provider-adapters-${providerId}`);
        expect(result.failure.diagnostics.reasonCode).toBe("credential-resolution-failed");
      }
      // No raw cause crosses the boundary: the thrown resolver error never reaches the result.
      expect(JSON.stringify(result)).not.toContain("credential store unavailable");
    },
  );
});
