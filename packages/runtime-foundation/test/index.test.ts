import { Clock, Effect, Fiber, Layer, ManagedRuntime, Ref, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { makeRuntimeFailure, runManagedRuntimeTask } from "../src/index.js";

describe("@ai-workbench/runtime-foundation ManagedRuntime sanitized bridge", () => {
  it("runs an effect on the shared runtime and returns a sanitized success outcome", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const outcome = await runManagedRuntimeTask(runtime, Effect.succeed({ status: "ready" as const }));

      expect(outcome).toEqual({ ok: true, value: { status: "ready" } });
    } finally {
      await runtime.dispose();
    }
  });

  it("maps an expected RuntimeFailure to a sanitized failure outcome with no raw cause", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const outcome = await runManagedRuntimeTask(
        runtime,
        Effect.fail(
          makeRuntimeFailure({
            code: "fake-service-unavailable",
            safeMessage: "Fake service is unavailable.",
            retryable: false,
            internalCause: new Error("raw internal cause with token-should-not-leak"),
          }),
        ),
      );

      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "expected",
          code: "fake-service-unavailable",
          safeMessage: "Fake service is unavailable.",
          retryable: false,
          sanitized: true,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain("token-should-not-leak");
    } finally {
      await runtime.dispose();
    }
  });

  it("maps an unexpected defect to a sanitized unknown failure without raw cause text", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const outcome = await runManagedRuntimeTask(
        runtime,
        Effect.sync(() => {
          throw new Error("raw defect cause with token-should-not-leak");
        }),
      );

      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "unexpected",
          code: "unknown-sanitized-failure",
          safeMessage: "Unexpected runtime failure.",
          retryable: true,
          sanitized: true,
        },
      });
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain("token-should-not-leak");
      expect(serialized).not.toContain("raw defect cause");
    } finally {
      await runtime.dispose();
    }
  });

  it("maps interruption to a sanitized cancelled failure", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const outcome = await runManagedRuntimeTask(runtime, Effect.interrupt);

      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: "cancelled",
          code: "runtime-task-cancelled",
          safeMessage: "Runtime task was cancelled.",
          retryable: false,
          sanitized: true,
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("drives a Clock-dependent effect deterministically under TestClock.adjust", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);

    try {
      const program = Effect.gen(function* () {
        const recorded = yield* Ref.make(-1);
        const worker = yield* Effect.fork(
          Effect.gen(function* () {
            yield* Effect.sleep("1 minute");
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.set(recorded, now);
          }),
        );

        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(worker);
        return yield* Ref.get(recorded);
      });

      const outcome = await runManagedRuntimeTask(runtime, program.pipe(Effect.provide(TestContext.TestContext)));

      expect(outcome).toEqual({ ok: true, value: 60_000 });
    } finally {
      await runtime.dispose();
    }
  });
});
