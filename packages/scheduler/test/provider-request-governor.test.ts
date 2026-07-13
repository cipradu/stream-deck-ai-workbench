import type { SourceRequestIdentityInput } from "@ai-workbench/contracts";
import { Deferred, Duration, Effect, Fiber, Layer, ManagedRuntime, Random, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderRequestGovernor,
  ProviderRequestGovernorLive,
  type ProviderRequestGovernorService,
} from "../src/index.js";

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const sameScope = {
  providerId: "fal",
  credentialProfileId: "profile-primary",
  credentialGeneration: 0,
  rateLimitDomain: "provider-profile",
} as const;

const otherScope = {
  providerId: "deepgram",
  credentialProfileId: "profile-primary",
  credentialGeneration: 0,
  rateLimitDomain: "provider-profile",
} as const;

function identity(rateLimitScope: SourceRequestIdentityInput["rateLimitScope"], sourceIdentity: string): SourceRequestIdentityInput {
  return {
    rateLimitScope,
    sourceIdentity,
    normalizedRequestVariant: "current",
  };
}

function acquireAndSettle(
  governor: ProviderRequestGovernorService,
  sourceIdentity: SourceRequestIdentityInput,
  onPermit: () => void,
): Effect.Effect<void, never, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* governor.acquireSource(sourceIdentity);
      const permit = yield* lease.acquireAttempt();
      onPermit();
      yield* permit.release();
      yield* lease.settle({ kind: "succeeded" });
    }),
  ).pipe(Effect.orDie);
}

describe("provider request governor", () => {
  it("exposes only a safe source lease, attempt permit, terminal signal, and counter diagnostics", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);

    try {
      const observed = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "safe-lease-source"));
            const active = yield* governor.diagnostics();
            const permit = yield* lease.acquireAttempt();
            const withPermit = yield* governor.diagnostics();
            yield* permit.release();
            yield* lease.settle({ kind: "succeeded" });
            return {
              leaseKeys: Object.keys(lease).sort(),
              permitKeys: Object.keys(permit).sort(),
              active,
              withPermit,
            };
          }),
        ),
      );

      expect(observed.leaseKeys).toEqual(["acquireAttempt", "reportRateLimit", "settle"]);
      expect(observed.permitKeys).toEqual(["release"]);
      expect(observed.active).toEqual({ stopped: false, activeSourceCount: 1, queuedSourceCount: 0, activeAttemptCount: 0 });
      expect(observed.withPermit).toEqual({ stopped: false, activeSourceCount: 1, queuedSourceCount: 0, activeAttemptCount: 1 });
      expect(await runtime.runPromise(governor.diagnostics())).toEqual({
        stopped: false,
        activeSourceCount: 0,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("admits one logical source FIFO per scope while an unrelated scope remains eligible and spacing applies to permits", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    const releaseFirst = runtime.runSync(Deferred.make<void>());
    const starts: string[] = [];

    const first = Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* governor.acquireSource(identity(sameScope, "first-source"));
        const permit = yield* lease.acquireAttempt();
        starts.push("first");
        yield* Deferred.await(releaseFirst);
        yield* permit.release();
        yield* lease.settle({ kind: "succeeded" });
      }),
    );
    const second = acquireAndSettle(governor, identity(sameScope, "second-source"), () => starts.push("second"));
    const independent = acquireAndSettle(governor, identity(otherScope, "other-source"), () => starts.push("other"));

    try {
      const firstResult = runtime.runPromise(first);
      await macrotask();
      const secondResult = runtime.runPromise(second);
      const independentResult = runtime.runPromise(independent);
      await macrotask();

      expect(starts).toContain("first");
      expect(starts).toContain("other");
      expect(starts).not.toContain("second");

      runtime.runSync(Deferred.succeed(releaseFirst, undefined));
      await firstResult;
      await macrotask();
      await runtime.runPromise(TestClock.adjust(Duration.millis(999)));
      expect(starts).not.toContain("second");
      await runtime.runPromise(TestClock.adjust(Duration.millis(1)));
      await secondResult;
      await independentResult;

      expect(starts).toEqual(["first", "other", "second"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("admits one active source plus sixteen queued operations and rejects the seventeenth without source work", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    const releaseActive = runtime.runSync(Deferred.make<void>());

    const active = Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* governor.acquireSource(identity(sameScope, "queue-active-source"));
        yield* Deferred.await(releaseActive);
        yield* lease.settle({ kind: "cancelled" });
      }),
    );

    try {
      const activeResult = runtime.runPromise(active);
      await macrotask();
      const queued = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          runtime.runPromise(Effect.forkDaemon(Effect.scoped(governor.acquireSource(identity(sameScope, `queued-source-${index}`))))),
        ),
      );
      await macrotask();

      const overflow = await runtime.runPromise(Effect.either(Effect.scoped(governor.acquireSource(identity(sameScope, "overflow-source")))));
      expect(overflow).toMatchObject({
        _tag: "Left",
        left: { failure: { diagnostics: { reasonCode: "governor-queue-full" } } },
      });
      expect(await runtime.runPromise(governor.diagnostics())).toEqual({
        stopped: false,
        activeSourceCount: 1,
        queuedSourceCount: 16,
        activeAttemptCount: 0,
      });

      for (const queuedFiber of queued) {
        await runtime.runPromise(Fiber.interrupt(queuedFiber));
      }
      runtime.runSync(Deferred.succeed(releaseActive, undefined));
      await activeResult;
    } finally {
      await runtime.dispose();
    }
  });

  it("records a safe rate-limit notice before blocking a later same-scope permit without observing an adapter error", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    let laterAttemptStarts = 0;

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "reported-rate-limit-source"));
            const permit = yield* lease.acquireAttempt();
            yield* permit.release();
            yield* lease.reportRateLimit({ retryAfterSeconds: 120 });
            yield* lease.settle({ kind: "failed" });
          }),
        ),
      );

      const later = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "blocked-later-source"));
            const blocked = yield* Effect.either(lease.acquireAttempt());
            yield* lease.settle({ kind: "failed" });
            return blocked;
          }),
        ),
      );

      expect(laterAttemptStarts).toBe(0);
      expect(later).toMatchObject({
        _tag: "Left",
        left: {
          failure: {
            category: "rate-limited",
            diagnostics: { reasonCode: "governor-cooldown" },
          },
          retryAfterSeconds: 120,
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("retains a reported cooldown after successful settlement until the exact retry duration expires", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    let attemptStartsAfterExpiry = 0;

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "successful-rate-limit-source"));
            const permit = yield* lease.acquireAttempt();
            yield* permit.release();
            yield* lease.reportRateLimit({ retryAfterSeconds: 120 });
            yield* lease.settle({ kind: "succeeded" });
          }),
        ),
      );

      await runtime.runPromise(TestClock.adjust(Duration.millis(1_000)));
      const beforeExpiry = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "successful-rate-limit-blocked-source"));
            const outcome = yield* Effect.either(lease.acquireAttempt());
            yield* lease.settle({ kind: "failed" });
            return outcome;
          }),
        ),
      );

      expect(beforeExpiry).toMatchObject({
        _tag: "Left",
        left: {
          failure: {
            category: "rate-limited",
            diagnostics: { reasonCode: "governor-cooldown" },
          },
          retryAfterSeconds: 119,
        },
      });

      await runtime.runPromise(TestClock.adjust(Duration.millis(119_000)));
      await runtime.runPromise(
        acquireAndSettle(governor, identity(sameScope, "successful-rate-limit-after-expiry-source"), () => {
          attemptStartsAfterExpiry += 1;
        }),
      );
      expect(attemptStartsAfterExpiry).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the existing bounded fallback and keeps a later credential generation isolated from cooldown", async () => {
    const runtime = ManagedRuntime.make(
      Layer.merge(Layer.merge(TestContext.TestContext, Layer.setRandom(Random.make(7))), ProviderRequestGovernorLive),
    );
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    const profile = { credentialProfileId: "profile-primary" } as const;
    let nextGenerationStarted = 0;

    try {
      const fallbackBlocked = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(sameScope, "fallback-rate-limit-source"));
            yield* lease.reportRateLimit({ retryAfterSeconds: -1 });
            yield* lease.settle({ kind: "failed" });
            const blockedLease = yield* governor.acquireSource(identity(sameScope, "fallback-blocked-source"));
            const blocked = yield* Effect.either(blockedLease.acquireAttempt());
            yield* blockedLease.settle({ kind: "failed" });
            return blocked;
          }),
        ),
      );

      expect(fallbackBlocked).toMatchObject({ _tag: "Left", left: { failure: { category: "rate-limited" } } });
      if (fallbackBlocked._tag === "Left") {
        expect(fallbackBlocked.left.retryAfterSeconds).toBeGreaterThanOrEqual(60);
        expect(fallbackBlocked.left.retryAfterSeconds).toBeLessThanOrEqual(72);
      }

      expect(await runtime.runPromise(governor.credentialGenerationFor(profile))).toBe(0);
      expect(await runtime.runPromise(governor.advanceCredentialGeneration(profile))).toBe(1);
      await runtime.runPromise(
        acquireAndSettle(
          governor,
          identity({ ...sameScope, credentialGeneration: 1 }, "next-generation-source"),
          () => {
            nextGenerationStarted += 1;
          },
        ),
      );
      expect(nextGenerationStarted).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it.each([
    { retryAfterSeconds: 1_799, expectedRetryAfterSeconds: 1_799 },
    { retryAfterSeconds: 1_800, expectedRetryAfterSeconds: 1_800 },
    { retryAfterSeconds: 1_801, expectedRetryAfterSeconds: 1_800 },
  ])(
    "bounds a safe retry hint at $expectedRetryAfterSeconds seconds for $retryAfterSeconds seconds and admits exactly at expiry",
    async ({ retryAfterSeconds, expectedRetryAfterSeconds }) => {
      const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
      const governor = await runtime.runPromise(ProviderRequestGovernor);
      let attemptStarts = 0;

      try {
        await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* governor.acquireSource(identity(sameScope, `bounded-rate-limit-source-${retryAfterSeconds}`));
              const permit = yield* lease.acquireAttempt();
              yield* permit.release();
              yield* lease.reportRateLimit({ retryAfterSeconds });
              yield* lease.settle({ kind: "failed" });
            }),
          ),
        );

        await runtime.runPromise(TestClock.adjust(Duration.millis(expectedRetryAfterSeconds * 1_000 - 1)));
        const beforeExpiry = await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const lease = yield* governor.acquireSource(identity(sameScope, `bounded-blocked-source-${retryAfterSeconds}`));
              const outcome = yield* Effect.either(lease.acquireAttempt());
              yield* lease.settle({ kind: "failed" });
              return outcome;
            }),
          ),
        );

        expect(attemptStarts).toBe(0);
        expect(beforeExpiry).toMatchObject({
          _tag: "Left",
          left: { failure: { category: "rate-limited" }, retryAfterSeconds: 1 },
        });

        await runtime.runPromise(TestClock.adjust(Duration.millis(1)));
        await runtime.runPromise(
          acquireAndSettle(governor, identity(sameScope, `bounded-admitted-source-${retryAfterSeconds}`), () => {
            attemptStarts += 1;
          }),
        );
        expect(attemptStarts).toBe(1);
      } finally {
        await runtime.dispose();
      }
    },
  );

  it("does not manufacture cooldown from ordinary failure, defect, interruption, or cancellation", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    let startedAfterTerminalSignals = 0;

    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(otherScope, "ordinary-failure-source"));
            yield* lease.settle({ kind: "failed" });
          }),
        ),
      );
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* governor.acquireSource(identity(otherScope, "defect-source"));
            yield* Effect.die("synthetic-test-defect");
            yield* lease.settle({ kind: "failed" });
          }).pipe(Effect.exit),
        ),
      );
      const interrupted = await runtime.runPromise(
        Effect.forkDaemon(Effect.scoped(governor.acquireSource(identity(otherScope, "interrupted-source")))),
      );
      await runtime.runPromise(Fiber.interrupt(interrupted));
      await runtime.runPromise(
        acquireAndSettle(governor, identity(otherScope, "after-terminal-signals-source"), () => {
          startedAfterTerminalSignals += 1;
        }),
      );

      expect(startedAfterTerminalSignals).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("removes an interrupted queued lease without starting provider work or manufacturing cooldown", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    const releaseActive = runtime.runSync(Deferred.make<void>());
    let nextSourceStarts = 0;

    const active = Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* governor.acquireSource(identity(sameScope, "cancellation-active-source"));
        yield* Deferred.await(releaseActive);
        yield* lease.settle({ kind: "cancelled" });
      }),
    );

    try {
      const activeResult = runtime.runPromise(active);
      await macrotask();
      const cancelled = await runtime.runPromise(
        Effect.forkDaemon(Effect.scoped(governor.acquireSource(identity(sameScope, "cancelled-queued-source")))),
      );
      await macrotask();
      await runtime.runPromise(Fiber.interrupt(cancelled));
      expect(await runtime.runPromise(governor.diagnostics())).toEqual({
        stopped: false,
        activeSourceCount: 1,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      });

      runtime.runSync(Deferred.succeed(releaseActive, undefined));
      await activeResult;
      await runtime.runPromise(TestClock.adjust(Duration.millis(1_000)));
      await runtime.runPromise(acquireAndSettle(governor, identity(sameScope, "after-cancel-source"), () => { nextSourceStarts += 1; }));
      expect(nextSourceStarts).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("shuts down active and queued leases without starting queued provider work", async () => {
    const runtime = ManagedRuntime.make(Layer.merge(TestContext.TestContext, ProviderRequestGovernorLive));
    const governor = await runtime.runPromise(ProviderRequestGovernor);
    const active = await runtime.runPromise(
      Effect.forkDaemon(
        Effect.scoped(
          Effect.gen(function* () {
            yield* governor.acquireSource(identity(sameScope, "shutdown-active-source"));
            yield* Effect.never;
          }),
        ),
      ),
    );
    await macrotask();
    const queuedLease = runtime.runPromise(Effect.either(Effect.scoped(governor.acquireSource(identity(sameScope, "shutdown-queued-source")))));
    await macrotask();

    try {
      await runtime.runPromise(governor.shutdown());
      await expect(queuedLease).resolves.toMatchObject({
        _tag: "Left",
        left: { failure: { diagnostics: { reasonCode: "governor-shut-down" } } },
      });
      expect(await runtime.runPromise(governor.diagnostics())).toEqual({
        stopped: true,
        activeSourceCount: 0,
        queuedSourceCount: 0,
        activeAttemptCount: 0,
      });
    } finally {
      await runtime.runPromise(Fiber.interrupt(active));
      await runtime.dispose();
    }
  });
});
