import { Data, Deferred, Effect, Either, Exit, Fiber, Option, Ref, Scope } from "effect";
import { describe, expect, it } from "vitest";

import type { SourceRequestIdentityInput } from "../../contracts/src/index.js";
import type {
  GovernorSourceLease,
  GovernorSourceSettlement,
  ProviderRequestGovernorService,
} from "../../scheduler/src/index.js";

import { makeAdapterSourceFlightRuntime } from "../src/source-flight-runtime.js";

const baseIdentity: SourceRequestIdentityInput = {
  rateLimitScope: {
    providerId: "claude-code",
    credentialProfileId: "profile-a",
    credentialGeneration: 1,
    rateLimitDomain: "local-source",
  },
  sourceIdentity: "claude-code-rollup",
  normalizedRequestVariant: "five-hour",
};

function sourceIdentity(overrides: Partial<SourceRequestIdentityInput> = {}): SourceRequestIdentityInput {
  return {
    ...baseIdentity,
    ...overrides,
    rateLimitScope: {
      ...baseIdentity.rateLimitScope,
      ...overrides.rateLimitScope,
    },
  };
}

function testGovernor(settlements: GovernorSourceSettlement[]): ProviderRequestGovernorService {
  return {
    acquireSource: () => {
      let settled = false;
      const lease: GovernorSourceLease = {
        acquireAttempt: () => Effect.succeed({ release: () => Effect.void }),
        reportRateLimit: () => Effect.void,
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
    advanceCredentialGeneration: () => Effect.succeed(0),
    diagnostics: () =>
      Effect.succeed({
        stopped: false,
        activeSourceCount: 0,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      }),
    shutdown: () => Effect.void,
  };
}

class TypedSourceFailure extends Data.TaggedError("TypedSourceFailure")<{
  readonly reasonCode: string;
}> {}

describe("adapter source-flight runtime", () => {
  it("shares one typed source worker for compatible duplicates and removes completed flights", async () => {
    const settlements: GovernorSourceSettlement[] = [];

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const registry = yield* runtime.createRegistry<number, never, never>();
          const starts = yield* Ref.make(0);
          const gate = yield* Deferred.make<void>();
          const source = () =>
            Ref.update(starts, (count) => count + 1).pipe(
              Effect.zipRight(Deferred.await(gate)),
              Effect.as(7),
            );

          const first = yield* Effect.fork(registry.run(baseIdentity, source));
          const second = yield* Effect.fork(registry.run(baseIdentity, source));
          yield* Effect.yieldNow();

          const startsWhileShared = yield* Ref.get(starts);
          yield* Deferred.succeed(gate, undefined);
          const values = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);

          const afterCompletion = yield* registry.run(baseIdentity, () =>
            Ref.update(starts, (count) => count + 1).pipe(Effect.as(8)),
          );

          return { startsWhileShared, values, afterCompletion, starts: yield* Ref.get(starts) };
        }),
      ),
    );

    expect(result).toEqual({
      startsWhileShared: 1,
      values: [7, 7],
      afterCompletion: 8,
      starts: 2,
    });
    expect(settlements).toEqual([{ kind: "succeeded" }, { kind: "succeeded" }]);
  });

  it("does not join flights with an incompatible source identity, request variant, generation, or result registry", async () => {
    const settlements: GovernorSourceSettlement[] = [];

    const starts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const numericRegistry = yield* runtime.createRegistry<number, never, never>();
          const stringRegistry = yield* runtime.createRegistry<string, never, never>();
          const count = yield* Ref.make(0);
          const gate = yield* Deferred.make<void>();
          const numericSource = () =>
            Ref.update(count, (value) => value + 1).pipe(
              Effect.zipRight(Deferred.await(gate)),
              Effect.as(1),
            );
          const stringSource = () =>
            Ref.update(count, (value) => value + 1).pipe(
              Effect.zipRight(Deferred.await(gate)),
              Effect.as("one"),
            );

          const compatibleIdentity = yield* Effect.fork(numericRegistry.run(baseIdentity, numericSource));
          const differentIdentity = yield* Effect.fork(
            numericRegistry.run(sourceIdentity({ sourceIdentity: "claude-code-weekly" }), numericSource),
          );
          const differentVariant = yield* Effect.fork(
            numericRegistry.run(sourceIdentity({ normalizedRequestVariant: "seven-day" }), numericSource),
          );
          const differentGeneration = yield* Effect.fork(
            numericRegistry.run(
              sourceIdentity({
                rateLimitScope: { ...baseIdentity.rateLimitScope, credentialGeneration: 2 },
              }),
              numericSource,
            ),
          );
          const differentResultRegistry = yield* Effect.fork(stringRegistry.run(baseIdentity, stringSource));
          yield* Effect.yieldNow();

          const started = yield* Ref.get(count);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(compatibleIdentity);
          yield* Fiber.join(differentIdentity);
          yield* Fiber.join(differentVariant);
          yield* Fiber.join(differentGeneration);
          yield* Fiber.join(differentResultRegistry);
          return started;
        }),
      ),
    );

    expect(starts).toBe(5);
    expect(settlements).toHaveLength(5);
  });

  it("closes the adapter-owned flight scope when its last subscriber leaves", async () => {
    const settlements: GovernorSourceSettlement[] = [];

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const registry = yield* runtime.createRegistry<number, never, never>();
          const started = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const subscriber = yield* Effect.fork(
            registry.run(baseIdentity, () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.zipRight(Effect.never),
                Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.asVoid)),
              ),
            ),
          );

          yield* Deferred.await(started);
          yield* Fiber.interrupt(subscriber);
          yield* Deferred.await(closed);
          return true;
        }),
      ),
    );

    expect(observed).toBe(true);
    expect(settlements).toEqual([{ kind: "cancelled" }]);
  });

  it("keeps the shared worker alive after one of two subscribers leaves and closes it only after the final detach", async () => {
    const settlements: GovernorSourceSettlement[] = [];

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const registry = yield* runtime.createRegistry<number, never, never>();
          const started = yield* Deferred.make<void>();
          const sourceGate = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const source = () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.zipRight(Deferred.await(sourceGate)),
              Effect.as(9),
              Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.asVoid)),
            );

          const first = yield* Effect.fork(Effect.scoped(registry.run(baseIdentity, source)));
          const second = yield* Effect.fork(Effect.scoped(registry.run(baseIdentity, source)));
          yield* Deferred.await(started);
          yield* Fiber.interrupt(first);
          yield* Effect.yieldNow();

          const secondBeforeSourceCompletion = yield* Fiber.poll(second);
          const closedBeforeSourceCompletion = yield* Deferred.poll(closed);
          yield* Deferred.succeed(sourceGate, undefined);
          const secondExit = yield* Fiber.await(second);

          return { secondBeforeSourceCompletion, closedBeforeSourceCompletion, secondExit };
        }),
      ),
    );

    expect(Option.isNone(observed.secondBeforeSourceCompletion)).toBe(true);
    expect(Option.isNone(observed.closedBeforeSourceCompletion)).toBe(true);
    expect(Exit.isSuccess(observed.secondExit)).toBe(true);
    if (Exit.isSuccess(observed.secondExit)) {
      expect(observed.secondExit.value).toBe(9);
    }
    expect(settlements).toEqual([{ kind: "succeeded" }]);
  });

  it("delivers normal completion before closing its adapter-owned flight scope", async () => {
    const settlements: GovernorSourceSettlement[] = [];

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const registry = yield* runtime.createRegistry<number, never, Scope.Scope>();
          const closeGate = yield* Deferred.make<void>();
          const closeStarted = yield* Deferred.make<void>();
          const subscriber = yield* Effect.fork(
            registry.run(baseIdentity, () =>
              Effect.addFinalizer(() =>
                Deferred.succeed(closeStarted, undefined).pipe(
                  Effect.zipRight(Deferred.await(closeGate)),
                ),
              ).pipe(Effect.as(11)),
            ),
          );

          yield* Deferred.await(closeStarted);
          yield* Effect.yieldNow();
          const subscriberBeforeScopeCloseCompletes = yield* Fiber.poll(subscriber);
          yield* Deferred.succeed(closeGate, undefined);
          const subscriberExit = yield* Fiber.await(subscriber);

          return { subscriberBeforeScopeCloseCompletes, subscriberExit };
        }),
      ),
    );

    expect(Option.isSome(observed.subscriberBeforeScopeCloseCompletes)).toBe(true);
    expect(Exit.isSuccess(observed.subscriberExit)).toBe(true);
    if (Exit.isSuccess(observed.subscriberExit)) {
      expect(observed.subscriberExit.value).toBe(11);
    }
    expect(settlements).toEqual([{ kind: "succeeded" }]);
  });

  it("propagates one typed source failure unchanged to compatible duplicate subscribers", async () => {
    const settlements: GovernorSourceSettlement[] = [];
    const failure = new TypedSourceFailure({ reasonCode: "test-shared-source-failure" });

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeAdapterSourceFlightRuntime(testGovernor(settlements));
          const registry = yield* runtime.createRegistry<number, TypedSourceFailure, never>();
          const gate = yield* Deferred.make<void>();
          const source = () => Deferred.await(gate).pipe(Effect.zipRight(Effect.fail(failure)));

          const first = yield* Effect.fork(registry.run(baseIdentity, source));
          const second = yield* Effect.fork(registry.run(baseIdentity, source));
          yield* Effect.yieldNow();
          yield* Deferred.succeed(gate, undefined);

          return {
            first: yield* Effect.either(Fiber.join(first)),
            second: yield* Effect.either(Fiber.join(second)),
          };
        }),
      ),
    );

    expect(Either.isLeft(observed.first)).toBe(true);
    expect(Either.isLeft(observed.second)).toBe(true);
    if (Either.isLeft(observed.first)) {
      expect(observed.first.left).toBe(failure);
    }
    if (Either.isLeft(observed.second)) {
      expect(observed.second.left).toBe(failure);
    }
    expect(settlements).toEqual([{ kind: "failed" }]);
  });
});
