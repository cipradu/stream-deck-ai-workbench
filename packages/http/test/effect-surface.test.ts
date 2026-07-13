import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Schema, TestClock, TestContext } from "effect";
import {
  HttpClient as PlatformHttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { describe, expect, it } from "vitest";

import { taggedFailureToSanitizedFailure, type SanitizedTaggedError } from "@ai-workbench/errors";

import {
  buildHttpRequest,
  decodeJsonBody,
  executeRequest,
  fetchHttpClientLayer,
  MAX_RETRY_AFTER_SECONDS,
  requestJsonSchema,
  requestTextBody,
} from "../src/index.js";

// The Effect-native surface is exercised against an INJECTED fake `HttpClient`
// layer (identical seam to the Promise-helper tests) so no live network call
// occurs. The same raw needles prove no secret/body/header crosses into a tagged
// error or its sanitized mapping.
const RAW_NEEDLES = {
  requestUrl: "https://provider.example/balance?api_key=fake-token&account_id=account_hidden",
  requestHeader: "Bearer fake-token",
  responseBody: "raw response body secret",
} as const;

const THIRTY_MINUTE_RETRY_AFTER_SECONDS = 1_800;

const RemainingSchema = Schema.Struct({ remaining: Schema.Number });

type ExecuteFake = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

function fakeHttpClientLayer(execute: ExecuteFake): Layer.Layer<PlatformHttpClient.HttpClient> {
  return Layer.succeed(
    PlatformHttpClient.HttpClient,
    PlatformHttpClient.make((request) => execute(request)),
  );
}

function respond(status: number, body: string, headers?: Readonly<Record<string, string>>): ExecuteFake {
  return (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, ...(headers === undefined ? {} : { headers }) }),
      ),
    );
}

/** Wraps a fake so tests can assert `execute` ran EXACTLY ONCE (no retry). */
function countingRespond(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): { readonly execute: ExecuteFake; readonly calls: () => number } {
  let calls = 0;
  const inner = respond(status, body, headers);
  return {
    execute: (request) => {
      calls += 1;
      return inner(request);
    },
    calls: () => calls,
  };
}

function transportFailure(): ExecuteFake {
  return (request) =>
    Effect.fail(
      new HttpClientError.RequestError({
        request,
        reason: "Transport",
        cause: new Error("network failed with Bearer fake-token account_hidden"),
      }),
    );
}

function neverResponds(): ExecuteFake {
  return () => Effect.never;
}

/**
 * A fake whose response HEADERS arrive immediately (execute succeeds with a 2xx) but
 * whose BODY read hangs forever: the web `ReadableStream` never enqueues and never
 * closes, so the platform body read behind `schemaBodyJson` (`source.text()`) never
 * resolves. `onBodyRead` fires when that body read actually begins (the stream is first
 * pulled), letting a test act — advance `TestClock`, or abort — ONLY after the pipeline
 * has ENTERED the body-read phase. That phase is exactly what the fix brings
 * under the one-shot deadline + caller-abort race.
 */
function stalledBodyResponse(onBodyRead: () => void): ExecuteFake {
  return (request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              onBodyRead();
              // Never enqueue, never close, never resolve: the body read stalls until the
              // deadline fires or the caller aborts.
              return new Promise<void>(() => {});
            },
          }),
          { status: 200 },
        ),
      ),
    );
}

async function runSurface<A>(
  effect: Effect.Effect<A, SanitizedTaggedError, PlatformHttpClient.HttpClient>,
  execute: ExecuteFake,
): Promise<Exit.Exit<A, SanitizedTaggedError>> {
  return Effect.runPromiseExit(Effect.provide(effect, fakeHttpClientLayer(execute)));
}

function taggedFailure<A>(exit: Exit.Exit<A, SanitizedTaggedError>): SanitizedTaggedError {
  if (Exit.isSuccess(exit)) {
    throw new Error("expected a failure exit, received a success");
  }
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure === undefined) {
    throw new Error("expected an expected (typed) failure in the cause");
  }
  return failure;
}

const baseRequest = { url: RAW_NEEDLES.requestUrl, headers: { authorization: RAW_NEEDLES.requestHeader } } as const;

describe("@ai-workbench/http Effect-native surface", () => {
  it("exposes the FetchHttpClient layer adapters provide at the runtime root", () => {
    // Same layer type as the injected fake; existence + type identity is the contract.
    const layer: Layer.Layer<PlatformHttpClient.HttpClient> = fetchHttpClientLayer;
    expect(layer).toBeDefined();
  });

  it("builds a request through the shared builder without executing it", () => {
    const request = buildHttpRequest({ url: RAW_NEEDLES.requestUrl, method: "POST", headers: { a: "b" }, body: { x: 1 } });
    expect(request.method).toBe("POST");
    expect(request.url).toBe(RAW_NEEDLES.requestUrl);
  });

  it("decodes a valid 2xx body to the typed schema value via schemaBodyJson", async () => {
    const exit = await runSurface(requestJsonSchema(baseRequest, RemainingSchema), respond(200, '{"remaining":12}'));
    expect(exit).toStrictEqual(Exit.succeed({ remaining: 12 }));
  });

  it("executeRequest yields the raw 2xx response for adapter-side composition", async () => {
    const exit = await runSurface(executeRequest(buildHttpRequest(baseRequest)), respond(200, '{"remaining":5}'));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.status).toBe(200);
    }
  });

  it("maps a malformed (non-JSON) body to ValidationDrift without leaking the raw body", async () => {
    const exit = await runSurface(
      requestJsonSchema(baseRequest, RemainingSchema),
      respond(200, `{"remaining": "${RAW_NEEDLES.responseBody}"`),
    );
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("ValidationDrift");
    expect(taggedFailureToSanitizedFailure(tagged).category).toBe("validation-drift");
    const serialized = JSON.stringify(tagged) + JSON.stringify(taggedFailureToSanitizedFailure(tagged));
    expect(serialized).not.toContain(RAW_NEEDLES.responseBody);
  });

  it("maps a schema-mismatch (valid JSON, wrong shape) to ValidationDrift", async () => {
    const exit = await runSurface(
      requestJsonSchema(baseRequest, RemainingSchema),
      respond(200, `{"remaining":"${RAW_NEEDLES.responseBody}"}`),
    );
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("ValidationDrift");
    // The ParseError carries the raw value; it must be discarded, not surfaced.
    const serialized = JSON.stringify(tagged) + JSON.stringify(taggedFailureToSanitizedFailure(tagged));
    expect(serialized).not.toContain(RAW_NEEDLES.responseBody);
  });

  it("decodeJsonBody maps a body-read/parse failure to ValidationDrift in isolation", async () => {
    const request = buildHttpRequest(baseRequest);
    const response = HttpClientResponse.fromWeb(request, new Response("not json at all", { status: 200 }));
    const exit = await Effect.runPromiseExit(decodeJsonBody(response, RemainingSchema));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
      expect(failure?._tag).toBe("ValidationDrift");
    }
  });

  it.each([
    [401, "UnauthorizedExpired"],
    [403, "InsufficientCredentialScope"],
    [408, "Timeout"],
    [418, "HttpStatusFailure"],
    [500, "ProviderUnavailable"],
    [504, "Timeout"],
  ] as const)("classifies HTTP %i as the %s tagged error", async (status, tag) => {
    const exit = await runSurface(executeRequest(buildHttpRequest(baseRequest)), respond(status, RAW_NEEDLES.responseBody));
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe(tag);
    const serialized = JSON.stringify(tagged);
    expect(serialized).not.toContain(RAW_NEEDLES.responseBody);
    expect(serialized).not.toContain("fake-token");
  });

  it("classifies 429 + numeric Retry-After as RateLimited carrying the parsed delay", async () => {
    const exit = await runSurface(
      executeRequest(buildHttpRequest(baseRequest)),
      respond(429, "", { "retry-after": "30" }),
    );
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("RateLimited");
    if (tagged._tag === "RateLimited") {
      expect(tagged.retryAfterSeconds).toBe(30);
    }
  });

  it("caps an excessive Retry-After to the policy maximum", async () => {
    const exit = await runSurface(
      executeRequest(buildHttpRequest(baseRequest)),
      respond(429, "", { "retry-after": String(MAX_RETRY_AFTER_SECONDS + 500) }),
    );
    const tagged = taggedFailure(exit);
    if (tagged._tag === "RateLimited") {
      expect(tagged.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
    }
  });

  it.each([
    [1_799, 1_799],
    [1_800, 1_800],
    [1_801, THIRTY_MINUTE_RETRY_AFTER_SECONDS],
  ] as const)("classifies fake 429 Retry-After %i as bounded sanitized %i", async (inputSeconds, expectedSeconds) => {
    const exit = await runSurface(
      executeRequest(buildHttpRequest(baseRequest)),
      respond(429, RAW_NEEDLES.responseBody, { "retry-after": String(inputSeconds) }),
    );
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("RateLimited");
    if (tagged._tag === "RateLimited") {
      expect(tagged.retryAfterSeconds).toBe(expectedSeconds);
    }
    const serialized = JSON.stringify(tagged) + JSON.stringify(taggedFailureToSanitizedFailure(tagged));
    expect(serialized).not.toContain(RAW_NEEDLES.responseBody);
    expect(serialized).not.toContain("fake-token");
  });

  it("maps a deadline breach to Timeout via the one-shot Effect.timeout", async () => {
    const exit = await runSurface(executeRequest(buildHttpRequest(baseRequest), { timeoutMs: 10 }), neverResponds());
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("Timeout");
    expect(tagged.reasonCode).toBe("request-timeout");
  });

  it("maps a caller abort to Abort distinctly from a timeout and interrupts the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const exit = await runSurface(
      executeRequest(buildHttpRequest(baseRequest), { signal: controller.signal }),
      neverResponds(),
    );
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("Abort");
    expect(tagged.reasonCode).toBe("request-aborted");
  });

  it("maps a transport failure to NetworkFailure without leaking the lower-level cause", async () => {
    const exit = await runSurface(executeRequest(buildHttpRequest(baseRequest)), transportFailure());
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("NetworkFailure");
    expect(tagged.reasonCode).toBe("request-network-failed");
    const serialized = JSON.stringify(tagged);
    expect(serialized).not.toContain("fake-token");
    expect(serialized).not.toContain("account_hidden");
  });

  it("executes EXACTLY ONCE on failure — the boundary never retries", async () => {
    const counter = countingRespond(500, RAW_NEEDLES.responseBody);
    const exit = await runSurface(executeRequest(buildHttpRequest(baseRequest)), counter.execute);
    expect(taggedFailure(exit)._tag).toBe("ProviderUnavailable");
    expect(counter.calls()).toBe(1);
  });
});

// requestJsonSchema self-binds the FULL pipeline (execute + the lazily
// read response body + decode) under ONE deadline + caller-abort race — mirroring the
// Promise helper's coreRequestEffect. These tests prove the deadline/abort now cover the
// BODY read (the review's gap), deterministically — TestClock for the deadline and an
// event-driven abort, never a wall-clock sleep — and pin executeRequest as the
// execute/header-phase-only split helper (unchanged behavior).
describe("@ai-workbench/http requestJsonSchema full-pipeline deadline + abort", () => {
  it("bounds the lazily-read body by the deadline — a stalled body fails with Timeout, not a hang", async () => {
    let bodyReadBegan!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyReadBegan = resolve;
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(requestJsonSchema({ ...baseRequest, timeoutMs: 1_000 }, RemainingSchema));
      // Advance the clock ONLY after the body read has begun: the headers have arrived and
      // the deadline is armed, so firing it provably bounds the BODY read — not merely the
      // execute/header phase. Gating on this event also removes the fork/adjust ordering
      // race (the 1_000ms sleep is registered before we adjust).
      yield* Effect.promise(() => started);
      yield* TestClock.adjust(Duration.millis(1_000));
      return yield* Fiber.join(fiber);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(fakeHttpClientLayer(stalledBodyResponse(() => bodyReadBegan()))),
        Effect.provide(TestContext.TestContext),
      ),
    );

    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("Timeout");
    expect(tagged.reasonCode).toBe("request-timeout");
  });

  it("cancels an in-flight body read — a caller signal aborted during the body read fails with Abort", async () => {
    const controller = new AbortController();
    let bodyReadBegan!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyReadBegan = resolve;
    });

    const exitPromise = runSurface(
      requestJsonSchema({ ...baseRequest, signal: controller.signal }, RemainingSchema),
      stalledBodyResponse(() => bodyReadBegan()),
    );

    // Abort ONLY after the body read has begun, proving the caller-abort race now covers
    // the body read, not just the execute/header phase. Event-driven — no wall-clock wait.
    await started;
    controller.abort();

    const tagged = taggedFailure(await exitPromise);
    expect(tagged._tag).toBe("Abort");
    expect(tagged.reasonCode).toBe("request-aborted");
  });

  it("leaves executeRequest bounding only the execute/header phase — it resolves on headers without reading the stalled body", async () => {
    // The SAME stalled-body response that drives requestJsonSchema to its deadline is
    // returned SUCCESSFULLY by executeRequest, because executeRequest never reads the body.
    // This pins the intended split (executeRequest = header phase; requestJsonSchema = full
    // pipeline) and confirms executeRequest's behavior is unchanged by the fix.
    const exit = await runSurface(
      executeRequest(buildHttpRequest(baseRequest), { timeoutMs: 10 }),
      stalledBodyResponse(() => {}),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.status).toBe(200);
    }
  });
});

// requestTextBody is the Effect-native TEXT-body counterpart to
// requestJsonSchema (the jina balance endpoint returns a plain-text body). It self-binds
// the FULL pipeline (execute + the lazily-read TEXT body) under one deadline + caller-abort,
// exactly like the requestJsonSchema fix — proven deterministically via TestClock
// (stalled body -> Timeout) and an event-driven abort (aborted body read -> Abort).
describe("@ai-workbench/http requestTextBody", () => {
  it("reads a 2xx body as plain text (the text-body path requestJsonSchema cannot serve)", async () => {
    const exit = await runSurface(requestTextBody(baseRequest), respond(200, "Balance left: 4210 tokens"));
    expect(exit).toStrictEqual(Exit.succeed("Balance left: 4210 tokens"));
  });

  it.each([
    [401, "UnauthorizedExpired"],
    [403, "InsufficientCredentialScope"],
    [429, "RateLimited"],
    [500, "ProviderUnavailable"],
  ] as const)(
    "classifies a non-2xx (%i) as the %s tagged error without leaking the body or secret",
    async (status, tag) => {
      const exit = await runSurface(requestTextBody(baseRequest), respond(status, RAW_NEEDLES.responseBody));
      const tagged = taggedFailure(exit);
      expect(tagged._tag).toBe(tag);
      const serialized = JSON.stringify(tagged);
      expect(serialized).not.toContain(RAW_NEEDLES.responseBody);
      expect(serialized).not.toContain("fake-token");
    },
  );

  it("maps a transport failure to NetworkFailure without leaking the lower-level cause", async () => {
    const exit = await runSurface(requestTextBody(baseRequest), transportFailure());
    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("NetworkFailure");
    const serialized = JSON.stringify(tagged);
    expect(serialized).not.toContain("fake-token");
    expect(serialized).not.toContain("account_hidden");
  });

  it("bounds the lazily-read TEXT body by the deadline — a stalled body fails with Timeout, not a hang", async () => {
    let bodyReadBegan!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyReadBegan = resolve;
    });

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(requestTextBody({ ...baseRequest, timeoutMs: 1_000 }));
      // Advance the clock ONLY after the body read has begun, proving the deadline bounds
      // the BODY read (not merely the execute/header phase) and removing the fork/adjust race.
      yield* Effect.promise(() => started);
      yield* TestClock.adjust(Duration.millis(1_000));
      return yield* Fiber.join(fiber);
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.provide(fakeHttpClientLayer(stalledBodyResponse(() => bodyReadBegan()))),
        Effect.provide(TestContext.TestContext),
      ),
    );

    const tagged = taggedFailure(exit);
    expect(tagged._tag).toBe("Timeout");
    expect(tagged.reasonCode).toBe("request-timeout");
  });

  it("cancels an in-flight TEXT body read — a caller signal aborted during the body read fails with Abort", async () => {
    const controller = new AbortController();
    let bodyReadBegan!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyReadBegan = resolve;
    });

    const exitPromise = runSurface(
      requestTextBody({ ...baseRequest, signal: controller.signal }),
      stalledBodyResponse(() => bodyReadBegan()),
    );

    await started;
    controller.abort();

    const tagged = taggedFailure(await exitPromise);
    expect(tagged._tag).toBe("Abort");
    expect(tagged.reasonCode).toBe("request-aborted");
  });
});
