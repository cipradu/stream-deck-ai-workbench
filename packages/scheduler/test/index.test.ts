import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { serializeSchedulerKey, type ErrorCategory, type NormalizedSnapshot, type SchedulerKeyParts } from "@ai-workbench/contracts";
import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";
import type { ActionSettingsChangeClassification, GlobalSettingsChangeClassification } from "@ai-workbench/settings";
import { Clock, Deferred, Duration, Effect, Layer, ManagedRuntime, Random, Ref, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import {
  SCHEDULER_BACKOFF_POLICY,
  createScheduler,
  packageName,
  type SchedulerEffectFetch,
  type SchedulerFetchFailure,
} from "../src/index.js";

const RAW_NEEDLES = {
  cause: ["raw scheduler provider body", "bearer", "fixture-secret"].join(" "),
  token: ["fixture", "secret", "token"].join("-"),
  account: ["fixture", "account", "identifier"].join("-"),
} as const;

const keyParts: SchedulerKeyParts = {
  familyId: "balance",
  providerId: "fal",
  windowOrPeriod: "evergreen",
  credentialProfileId: "profile-fal-primary",
  metricVariant: "remaining-balance",
};

const key = serializeSchedulerKey(keyParts);

/** A real event-loop macrotask: lets a freshly-forked poll fiber run its immediate poll and arm
 * its `Schedule.fixed` sleep BEFORE the first `TestClock.adjust` (the fork/adjust ordering seam). */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Tests inject a `ManagedRuntime` over `TestContext.TestContext` so `Clock`/`Schedule` run under
 * the deterministic core-`effect` `TestClock` (no `@effect/vitest`). */
const makeTestRuntime = (): ManagedRuntime.ManagedRuntime<never, never> => ManagedRuntime.make(TestContext.TestContext);

/**
 * Back-off tests additionally override the default Effect `Random` with a seeded PCG PRNG via
 * `Layer.setRandom`, so `Schedule.jittered` produces DETERMINISTIC jitter (the jitter reads
 * `Random.next` from the default-services fiber ref, which `Layer.setRandom` — not a plain
 * `Random.Random` service layer — overrides). `TestClock` still drives all time. Production uses the
 * live `Random` (real jitter); only tests pin the seed.
 */
const makeJitterRuntime = (seed: number): ManagedRuntime.ManagedRuntime<never, never> =>
  ManagedRuntime.make(Layer.merge(TestContext.TestContext, Layer.setRandom(Random.make(seed))));

function snapshot(input: { readonly fetchedAtEpochMs: number; readonly value?: number } = { fetchedAtEpochMs: 0 }): NormalizedSnapshot {
  return {
    familyId: "balance",
    providerId: "fal",
    metricKind: "remaining-balance",
    metricDirection: "lower-bound",
    unit: "money",
    coverage: { kind: "evergreen" },
    value: input.value ?? 42,
    fetchedAtEpochMs: input.fetchedAtEpochMs,
  };
}

function failure(category: ErrorCategory, reasonCode: string = category): SanitizedFailure {
  return createSanitizedFailure({
    category,
    diagnostics: {
      boundary: "scheduler-test",
      reasonCode,
    },
    cause: new Error(RAW_NEEDLES.cause),
  });
}

const okFetch = (produce: (request: { readonly startedAtEpochMs: number }) => NormalizedSnapshot): SchedulerEffectFetch => (request) =>
  Effect.sync(() => produce(request));

const failFetch = (failureValue: SchedulerFetchFailure): SchedulerEffectFetch => () => Effect.fail(failureValue);

/** A second, distinct scheduler key (different provider) for "affected keys only" refresh/settings tests. */
const otherKeyParts: SchedulerKeyParts = {
  familyId: "balance",
  providerId: "deepgram",
  windowOrPeriod: "evergreen",
  credentialProfileId: "profile-deepgram-primary",
  metricVariant: "remaining-balance",
};
const otherKey = serializeSchedulerKey(otherKeyParts);

/**
 * Advances the `TestClock` by EXACTLY the time remaining until the fiber's currently-armed healthy
 * poll. The healthy cadence is jittered 0-20%, so tests can no longer advance a hard-coded
 * interval; they read the actual jittered arm time (`SchedulerOutput.nextHealthyPollAtEpochMs`, set by
 * the fiber when it arms the sleep) and advance to it, firing exactly the next healthy poll.
 */
const advanceToNextHealthyPoll = async (
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  scheduler: { readonly getOutput: (key: string) => { readonly nextHealthyPollAtEpochMs?: number } },
  schedulerKey: string,
): Promise<void> => {
  const now = await runtime.runPromise(Clock.currentTimeMillis);
  const armed = scheduler.getOutput(schedulerKey).nextHealthyPollAtEpochMs;
  if (armed === undefined) {
    throw new Error("no healthy poll armed for key");
  }
  await runtime.runPromise(TestClock.adjust(Duration.millis(armed - now)));
};

// Settings/credential change classifications (as `packages/settings` produces them) the scheduler
// consumes. Only the fields the scheduler reads matter for behavior.
const sourceAffectingChange = (): ActionSettingsChangeClassification => ({
  kind: "provider-source-affecting",
  schedulerKeyChanged: true,
  providerRefetchRequired: true,
  bypassBackoffAllowed: true,
  refreshPolicyChanged: false,
  displayOnly: false,
  reasons: ["provider-source-changed"],
});
const refreshPolicyOnlyChange = (): ActionSettingsChangeClassification => ({
  kind: "refresh-policy-affecting",
  schedulerKeyChanged: false,
  providerRefetchRequired: false,
  bypassBackoffAllowed: false,
  refreshPolicyChanged: true,
  displayOnly: false,
  reasons: ["refresh-interval-changed"],
});
const displayOnlyChange = (): ActionSettingsChangeClassification => ({
  kind: "display-only",
  schedulerKeyChanged: false,
  providerRefetchRequired: false,
  bypassBackoffAllowed: false,
  refreshPolicyChanged: false,
  displayOnly: true,
  reasons: ["display-preference-changed"],
});
const globalSourceAffectingChange = (): GlobalSettingsChangeClassification => ({
  kind: "provider-source-affecting",
  providerRefetchRequired: true,
  bypassBackoffAllowed: true,
  displayOnly: false,
  reasons: ["credential-changed"],
  affectedCredentialProfiles: [],
});
const globalDisplayOnlyChange = (): GlobalSettingsChangeClassification => ({
  kind: "display-only",
  providerRefetchRequired: false,
  bypassBackoffAllowed: false,
  displayOnly: true,
  reasons: ["display-preference-changed"],
  affectedCredentialProfiles: [],
});

describe("@ai-workbench/scheduler public surface", () => {
  it("exposes the central scheduler policy surface with preserved staleness/expiry thresholds", () => {
    expect(packageName).toBe("@ai-workbench/scheduler");
    expect(typeof createScheduler).toBe("function");
    expect(SCHEDULER_BACKOFF_POLICY).toMatchObject({
      transient: { initialDelayMs: 30_000, maxDelayMs: 300_000 },
      rateLimit: { initialDelayMs: 60_000, maxDelayMs: 600_000, maxRetryAfterMs: 3_600_000 },
      stale: { ageMultiplier: 2, maxDisplayMs: 86_400_000 },
      jitter: { minRatio: 0, maxRatio: 0.2 },
    });
  });
});

describe("healthy polling (jittered cadence under TestClock)", () => {
  it("(a) fires a healthy poll immediately and then at each (jittered) refresh interval", async () => {
    const runtime = makeTestRuntime();
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 42 });
      }),
    });

    await macrotask();
    expect(calls).toBe(1);

    // The healthy cadence is jittered 0-20%, so advance to the actual armed next poll.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(calls).toBe(2);

    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(calls).toBe(3);

    expect(scheduler.getOutput(key)).toMatchObject({
      displayState: "fresh",
      snapshot: { value: 42 },
      activeRefCount: 1,
      inFlight: false,
    });

    await scheduler.shutdown();
  });

  it("does not fire a second poll before the (jittered) interval elapses", async () => {
    const runtime = makeTestRuntime();
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs });
      }),
    });

    await macrotask();
    // The jittered arm time is >= the 600s base; advancing to one ms before it fires nothing.
    const now = await runtime.runPromise(Clock.currentTimeMillis);
    const armed = scheduler.getOutput(key).nextHealthyPollAtEpochMs!;
    expect(armed - now).toBeGreaterThanOrEqual(600_000);
    await runtime.runPromise(TestClock.adjust(Duration.millis(armed - now - 1)));
    expect(calls).toBe(1);
    await runtime.runPromise(TestClock.adjust(Duration.millis(1)));
    expect(calls).toBe(2);

    await scheduler.shutdown();
  });
});

describe("per-key state: stale-at-read and expiry", () => {
  it("(b) marks a retained snapshot age-stale beyond 2x the interval and expired beyond 24h", async () => {
    const runtime = makeTestRuntime();
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 30 })),
    });

    await macrotask();
    // Stop polling so the retained snapshot ages instead of being refreshed by the fiber.
    scheduler.deactivate({ schedulerKey: key, instanceId: "instance-a" });
    await macrotask();

    await runtime.runPromise(TestClock.adjust(Duration.millis(1_200_001)));
    const ageStale = scheduler.getOutput(key);

    await runtime.runPromise(TestClock.adjust(Duration.millis(86_400_000 - 1_200_000)));
    const expired = scheduler.getOutput(key);

    expect(ageStale).toMatchObject({
      displayState: "stale",
      staleReason: "age-stale",
      snapshot: { value: 30 },
      failure: { category: "stale-cached-value", displayState: "stale" },
    });
    expect(expired).toMatchObject({
      displayState: "no-data-yet",
      failure: { category: "no-data-yet", diagnostics: { reasonCode: "stale-cache-expired" } },
    });
    expect(expired.snapshot).toBeUndefined();

    await scheduler.shutdown();
  });
});

describe("single-flight (structural: one fiber per key)", () => {
  it("(c) never runs two concurrent same-key fetches across re-activation and a slow fetch", async () => {
    const runtime = makeTestRuntime();
    const release = runtime.runSync(Deferred.make<void>());
    const inFlight = runtime.runSync(Ref.make(0));
    const maxConcurrent = runtime.runSync(Ref.make(0));
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const slowFetch: SchedulerEffectFetch = (request) =>
      Effect.gen(function* () {
        calls += 1;
        const current = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
        yield* Ref.update(maxConcurrent, (m) => Math.max(m, current));
        yield* Deferred.await(release);
        yield* Ref.update(inFlight, (n) => n - 1);
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs });
      });

    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: slowFetch });
    // Re-activation of the SAME key: attaches the instance, must NOT fork a second fiber.
    scheduler.activate({ instanceId: "instance-b", keyParts, refreshIntervalSeconds: 600, fetch: slowFetch });

    await macrotask();
    // Advancing the clock cannot double-run the blocked poll — the single fiber runs pollAttempt
    // (via pollWithBackoff) sequentially, and the in-flight fetch is still parked on `release`.
    await runtime.runPromise(TestClock.adjust(Duration.seconds(600)));
    await runtime.runPromise(TestClock.adjust(Duration.seconds(600)));

    expect(runtime.runSync(Ref.get(maxConcurrent))).toBe(1);
    expect(calls).toBe(1);
    expect(scheduler.getOutput(key)).toMatchObject({ activeRefCount: 2, inFlight: true });

    runtime.runSync(Deferred.succeed(release, undefined));
    await macrotask();
    await scheduler.shutdown();
  });
});

describe("interruption on deactivate", () => {
  it("(d) interrupts the poll fiber and its in-flight fetch when the last instance deactivates", async () => {
    const runtime = makeTestRuntime();
    const started = runtime.runSync(Deferred.make<void>());
    const interruptObserved = runtime.runSync(Deferred.make<void>());
    const never = runtime.runSync(Deferred.make<NormalizedSnapshot>());
    let interrupted = false;
    const scheduler = createScheduler({ runtime });
    const hangingFetch: SchedulerEffectFetch = () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Deferred.await(never);
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            interrupted = true;
            yield* Deferred.succeed(interruptObserved, undefined);
          }),
        ),
      );

    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: hangingFetch });
    await runtime.runPromise(Deferred.await(started));

    scheduler.deactivate({ schedulerKey: key, instanceId: "instance-a" });
    await runtime.runPromise(Deferred.await(interruptObserved));

    expect(interrupted).toBe(true);
    expect(scheduler.getOutput(key)).toMatchObject({ activeRefCount: 0, inFlight: false });

    await scheduler.shutdown();
  });
});

describe("cache arbitration (adopt strictly-newer)", () => {
  it("(e) adopts a strictly-newer snapshot and keeps the retained one on equal or older", async () => {
    const runtime = makeTestRuntime();
    const values: readonly NormalizedSnapshot[] = [
      snapshot({ fetchedAtEpochMs: 1_000, value: 10 }),
      snapshot({ fetchedAtEpochMs: 1_000, value: 20 }),
      snapshot({ fetchedAtEpochMs: 500, value: 30 }),
      snapshot({ fetchedAtEpochMs: 2_000, value: 40 }),
    ];
    let index = 0;
    const scheduler = createScheduler({ runtime });
    const arbitrationFetch: SchedulerEffectFetch = () =>
      Effect.sync(() => {
        const value = values[index] ?? values[values.length - 1]!;
        index += 1;
        return value;
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: arbitrationFetch });

    await macrotask();
    expect(scheduler.getOutput(key).snapshot).toMatchObject({ value: 10 });

    await advanceToNextHealthyPoll(runtime, scheduler, key); // equal fetchedAt -> keep 10
    expect(scheduler.getOutput(key).snapshot).toMatchObject({ value: 10 });

    await advanceToNextHealthyPoll(runtime, scheduler, key); // older fetchedAt -> keep 10
    expect(scheduler.getOutput(key).snapshot).toMatchObject({ value: 10 });

    await advanceToNextHealthyPoll(runtime, scheduler, key); // strictly-newer fetchedAt -> adopt 40
    expect(scheduler.getOutput(key).snapshot).toMatchObject({ value: 40 });

    await scheduler.shutdown();
  });
});

describe("failure back-off (Effect Schedule under TestClock)", () => {
  const TRANSIENT_BASE = SCHEDULER_BACKOFF_POLICY.transient.initialDelayMs;
  const TRANSIENT_CAP = SCHEDULER_BACKOFF_POLICY.transient.maxDelayMs;
  const RATE_LIMIT_BASE = SCHEDULER_BACKOFF_POLICY.rateLimit.initialDelayMs;
  const RATE_LIMIT_CAP = SCHEDULER_BACKOFF_POLICY.rateLimit.maxDelayMs;
  const JITTER_MAX = 1 + SCHEDULER_BACKOFF_POLICY.jitter.maxRatio; // 1.2

  it("(1) retains stale, surfaces the failure, backs off transiently with exponential growth, and caps at the transient max", async () => {
    const runtime = makeJitterRuntime(42);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    // First poll succeeds (retain a snapshot to prove stale-retention), then every poll fails transiently.
    const flakyFetch: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return calls === 1
          ? Effect.succeed(snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 50 }))
          : failFetch({ failure: failure("network-failure") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: flakyFetch });

    await macrotask();
    expect(calls).toBe(1);

    // Healthy (jittered) interval -> poll 2 fails -> first back-off attempt.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    const afterFailure = scheduler.getOutput(key);
    expect(afterFailure).toMatchObject({
      displayState: "stale",
      staleReason: "refresh-failed",
      snapshot: { value: 50 }, // stale value retained
      failure: { category: "network-failure", sanitized: true },
      backoff: { class: "transient", attempt: 1, baseDelayMs: TRANSIENT_BASE },
    });
    expect(afterFailure.backoff!.delayMs).toBeGreaterThanOrEqual(TRANSIENT_BASE);
    expect(afterFailure.backoff!.delayMs).toBeLessThanOrEqual(Math.ceil(TRANSIENT_BASE * JITTER_MAX));

    // Step through attempts by the reported delay until the delay reaches the cap.
    let current = afterFailure.backoff!;
    const seen: number[] = [current.delayMs];
    for (let i = 0; i < 8 && current.delayMs !== TRANSIENT_CAP; i += 1) {
      await runtime.runPromise(TestClock.adjust(Duration.millis(current.delayMs)));
      current = scheduler.getOutput(key).backoff!;
      seen.push(current.delayMs);
    }
    expect(current.delayMs).toBe(TRANSIENT_CAP); // capped after enough failures
    expect(current.attempt).toBeGreaterThanOrEqual(5);
    // Exponential growth before the cap (each attempt roughly doubles until clamped).
    expect(seen[0]).toBeLessThan(seen[1]);
    expect(seen[1]).toBeLessThan(seen[2]);

    await scheduler.shutdown();
  });

  it("(2) applies bounded 0-20% jitter (deterministic under a seed) and keeps the effective delay within the cap AFTER jitter", async () => {
    // Drive a purely-transient-failing key and collect the sequence of applied back-off delays.
    const collect = async (seed: number, n: number): Promise<number[]> => {
      const runtime = makeJitterRuntime(seed);
      const scheduler = createScheduler({ runtime });
      scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: failFetch({ failure: failure("network-failure") }) });
      await macrotask();
      const delays: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const backoff = scheduler.getOutput(key).backoff!;
        delays.push(backoff.delayMs);
        await runtime.runPromise(TestClock.adjust(Duration.millis(backoff.delayMs)));
      }
      await scheduler.shutdown();
      return delays;
    };

    const run1 = await collect(123, 8);
    const run2 = await collect(123, 8);
    expect(run1).toEqual(run2); // deterministic under a fixed seed

    run1.forEach((delayMs, attemptIndex) => {
      const uncapped = TRANSIENT_BASE * 2 ** attemptIndex;
      // Positive jitter only: never below the base exponential (and never below the cap once clamped).
      expect(delayMs).toBeGreaterThanOrEqual(Math.min(uncapped, TRANSIENT_CAP));
      // Bounded to +20% AND clamped by the cap — the effective delay stays within the cap AFTER jitter.
      expect(delayMs).toBeLessThanOrEqual(Math.min(Math.ceil(uncapped * JITTER_MAX), TRANSIENT_CAP));
      expect(delayMs).toBeLessThanOrEqual(TRANSIENT_CAP);
    });
    // The sequence actually reaches (and holds at) the cap — proving the cap is applied post-jitter.
    expect(run1).toContain(TRANSIENT_CAP);

    // A different seed yields a different (but equally in-bounds) sequence.
    const other = await collect(9999, 4);
    expect(other).not.toEqual(run1.slice(0, 4));

    // Determinism proof-point: with this exact seed the first delay is a stable value.
    expect(run1[0]).toBe(run2[0]);
  });

  it("(3) backs off at the rate-limit base->cap and honors a sanitized Retry-After (capped at 1h)", async () => {
    // (a) rate-limit WITHOUT Retry-After -> exponential from the 60s base.
    const runtimeA = makeJitterRuntime(7);
    const schedulerA = createScheduler({ runtime: runtimeA });
    schedulerA.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: failFetch({ failure: failure("rate-limited") }) });
    await macrotask();
    const rl1 = schedulerA.getOutput(key).backoff!;
    expect(rl1).toMatchObject({ class: "rate-limit", attempt: 1, baseDelayMs: RATE_LIMIT_BASE });
    expect(rl1.delayMs).toBeGreaterThanOrEqual(RATE_LIMIT_BASE);
    expect(rl1.delayMs).toBeLessThanOrEqual(Math.ceil(RATE_LIMIT_BASE * JITTER_MAX));
    expect(rl1.retryAfterApplied).toBeUndefined();
    // Advance a couple of attempts; the delay stays within the rate-limit cap.
    await runtimeA.runPromise(TestClock.adjust(Duration.millis(rl1.delayMs)));
    expect(schedulerA.getOutput(key).backoff!.delayMs).toBeLessThanOrEqual(RATE_LIMIT_CAP);
    await schedulerA.shutdown();

    // (b) rate-limit WITH Retry-After -> honored exactly (not the exponential value).
    const runtimeB = makeJitterRuntime(7);
    const schedulerB = createScheduler({ runtime: runtimeB });
    schedulerB.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: failFetch({ failure: failure("rate-limited"), retry: { retryAfterSeconds: 120 } }),
    });
    await macrotask();
    expect(schedulerB.getOutput(key).backoff).toMatchObject({
      class: "rate-limit",
      attempt: 1,
      delayMs: 120_000,
      retryAfterApplied: true,
    });
    await schedulerB.shutdown();

    // (c) a Retry-After beyond 1h is capped at the 1h maximum.
    const runtimeC = makeJitterRuntime(7);
    const schedulerC = createScheduler({ runtime: runtimeC });
    schedulerC.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: failFetch({ failure: failure("rate-limited"), retry: { retryAfterSeconds: 7_200 } }),
    });
    await macrotask();
    expect(schedulerC.getOutput(key).backoff).toMatchObject({
      delayMs: SCHEDULER_BACKOFF_POLICY.rateLimit.maxRetryAfterMs, // 3_600_000 (1h)
      retryAfterApplied: true,
    });
    await schedulerC.shutdown();
  });

  it("(4) resets to the healthy (jittered) cadence after a success following failures", async () => {
    const runtime = makeJitterRuntime(99);
    let calls = 0;
    const script: ReadonlyArray<"ok" | "fail"> = ["ok", "fail", "fail", "ok"];
    const scheduler = createScheduler({ runtime });
    const scriptedFetch: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        const kind = script[calls] ?? "ok";
        calls += 1;
        return kind === "ok"
          ? Effect.succeed(snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 60 }))
          : failFetch({ failure: failure("network-failure") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: scriptedFetch });

    await macrotask();
    expect(scheduler.getOutput(key).backoff).toBeUndefined(); // healthy after the first success

    await advanceToNextHealthyPoll(runtime, scheduler, key); // fail #1 -> attempt 1
    const b1 = scheduler.getOutput(key).backoff!;
    expect(b1).toMatchObject({ class: "transient", attempt: 1 });

    await runtime.runPromise(TestClock.adjust(Duration.millis(b1.delayMs))); // fail #2 -> attempt 2
    const b2 = scheduler.getOutput(key).backoff!;
    expect(b2.attempt).toBe(2);

    await runtime.runPromise(TestClock.adjust(Duration.millis(b2.delayMs))); // success -> reset
    const recovered = scheduler.getOutput(key);
    expect(recovered.backoff).toBeUndefined();
    expect(recovered.nextAllowedRetryAtEpochMs).toBeUndefined();
    expect(recovered.displayState).toBe("fresh");

    // Not looping at the short back-off cadence any more: a back-off-sized advance triggers no poll...
    const callsAfterRecovery = calls;
    await runtime.runPromise(TestClock.adjust(Duration.millis(40_000)));
    expect(calls).toBe(callsAfterRecovery);
    // ...but a full (jittered) healthy interval later, the healthy-cadence poll fires and stays healthy.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(calls).toBeGreaterThan(callsAfterRecovery);
    expect(scheduler.getOutput(key).backoff).toBeUndefined();

    await scheduler.shutdown();
  });

  it("survives a defecting adapter (a die) — sanitized failure, in-flight cleared, keeps polling", async () => {
    const runtime = makeJitterRuntime(5);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    // An Effect that DIES (throws) rather than failing in the typed channel — e.g. a `normalize` bug
    // escaping the adapter. Its message carries raw content that MUST NOT leak.
    const dyingFetch: SchedulerEffectFetch = () =>
      Effect.sync(() => {
        calls += 1;
        throw new Error(RAW_NEEDLES.cause);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: dyingFetch });

    await macrotask();
    const afterDie = scheduler.getOutput(key);
    // The loop SURVIVED the die: sanitized failure surfaced, in-flight cleared, transient back-off armed.
    expect(afterDie).toMatchObject({
      displayState: "unknown-sanitized-failure",
      inFlight: false,
      failure: {
        category: "unknown-sanitized-failure",
        sanitized: true,
        diagnostics: { boundary: "scheduler", reasonCode: "scheduler-poll-defect" },
      },
      backoff: { class: "transient", attempt: 1 },
    });
    expect(calls).toBe(1);
    // No raw cause/secret leaked from the die.
    const serialized = JSON.stringify(afterDie);
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.account);

    // NOT dead / NOT frozen: after the back-off delay it re-attempts (and dies again, backing off harder).
    await runtime.runPromise(TestClock.adjust(Duration.millis(afterDie.backoff!.delayMs)));
    expect(calls).toBe(2);
    expect(scheduler.getOutput(key).backoff).toMatchObject({ class: "transient", attempt: 2 });

    await scheduler.shutdown();
  });

  it("(6) populates backoff + nextAllowedRetryAtEpochMs during back-off and clears them on success", async () => {
    const runtime = makeJitterRuntime(11);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const recoverAfterTwo: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return calls >= 3
          ? Effect.succeed(snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 77 }))
          : failFetch({ failure: failure("network-failure") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: recoverAfterTwo });

    await macrotask();
    // First poll (t=0) fails immediately -> attempt 1 back-off is live and fully populated.
    const startNow = await runtime.runPromise(Clock.currentTimeMillis);
    const b1 = scheduler.getOutput(key).backoff!;
    expect(b1).toMatchObject({ class: "transient", attempt: 1 });
    expect(b1.nextRetryAtEpochMs).toBe(startNow + b1.delayMs);
    expect(scheduler.getOutput(key).nextAllowedRetryAtEpochMs).toBe(b1.nextRetryAtEpochMs);

    // PART-WAY through the back-off sleep it is still populated (visible DURING back-off, not just after).
    await runtime.runPromise(TestClock.adjust(Duration.millis(Math.floor(b1.delayMs / 2))));
    const mid = scheduler.getOutput(key);
    expect(mid.backoff).toMatchObject({ attempt: 1 });
    expect(mid.nextAllowedRetryAtEpochMs).toBe(b1.nextRetryAtEpochMs);
    expect(calls).toBe(1); // not re-attempted yet

    // Finish the sleep -> fail #2 -> attempt 2.
    await runtime.runPromise(TestClock.adjust(Duration.millis(b1.delayMs - Math.floor(b1.delayMs / 2))));
    const b2 = scheduler.getOutput(key).backoff!;
    expect(b2.attempt).toBe(2);

    // Next attempt succeeds -> back-off + next-allowed-retry cleared, fresh snapshot shown.
    await runtime.runPromise(TestClock.adjust(Duration.millis(b2.delayMs)));
    const recovered = scheduler.getOutput(key);
    expect(recovered.backoff).toBeUndefined();
    expect(recovered.nextAllowedRetryAtEpochMs).toBeUndefined();
    expect(recovered).toMatchObject({ displayState: "fresh", snapshot: { value: 77 } });

    await scheduler.shutdown();
  });

  it("does not back off a non-retryable failure: surfaces it and resumes the healthy cadence", async () => {
    const runtime = makeTestRuntime();
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const noCredsFetch: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return failFetch({ failure: failure("missing-credentials") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: noCredsFetch });

    await macrotask();
    const output = scheduler.getOutput(key);
    expect(output).toMatchObject({ displayState: "missing-credentials", failure: { category: "missing-credentials" } });
    expect(output.snapshot).toBeUndefined();
    // missing-credentials is `credential-settings-refresh`, not a failure back-off — no back-off armed.
    expect(output.backoff).toBeUndefined();
    expect(output.nextAllowedRetryAtEpochMs).toBeUndefined();

    // It resumes the healthy (jittered) cadence (polls again at the interval, not a short back-off).
    expect(calls).toBe(1);
    const now = await runtime.runPromise(Clock.currentTimeMillis);
    const armed = scheduler.getOutput(key).nextHealthyPollAtEpochMs!;
    expect(armed - now).toBeGreaterThanOrEqual(600_000); // not a short back-off cadence
    await runtime.runPromise(TestClock.adjust(Duration.millis(armed - now - 1)));
    expect(calls).toBe(1);
    await runtime.runPromise(TestClock.adjust(Duration.millis(1)));
    expect(calls).toBe(2);
    expect(scheduler.getOutput(key).backoff).toBeUndefined();

    await scheduler.shutdown();
  });
});

describe("manual refresh signalling (race the sleep, respect back-off)", () => {
  it("wakes the sleeping fiber to poll immediately on a manual refresh — no interval wait", async () => {
    const runtime = makeTestRuntime();
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 100 + calls });
      }),
    });

    await macrotask();
    expect(calls).toBe(1); // immediate first poll, then a healthy sleep

    // Manual refresh WHILE the fiber sleeps the healthy interval -> it polls NOW, with NO clock advance.
    await scheduler.refresh(key);
    await macrotask();
    expect(calls).toBe(2);

    await scheduler.refresh(key);
    await macrotask();
    expect(calls).toBe(3);

    expect(scheduler.getOutput(key)).toMatchObject({ displayState: "fresh", activeRefCount: 1, inFlight: false });

    await scheduler.shutdown();
  });

  it("a BARE manual refresh during an active back-off does NOT poll early (respects back-off)", async () => {
    const runtime = makeJitterRuntime(2);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const failingFetch: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return failFetch({ failure: failure("network-failure") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: failingFetch });

    await macrotask();
    const backedOff = scheduler.getOutput(key);
    expect(backedOff.backoff).toMatchObject({ class: "transient", attempt: 1 });
    expect(calls).toBe(1);

    // A bare manual refresh during the back-off must NOT trigger an early poll.
    await scheduler.refresh(key);
    await macrotask();
    expect(calls).toBe(1); // no early poll
    const stillBackedOff = scheduler.getOutput(key);
    expect(stillBackedOff.backoff).toMatchObject({ class: "transient", attempt: 1 });
    expect(stillBackedOff.nextAllowedRetryAtEpochMs).toBe(backedOff.nextAllowedRetryAtEpochMs);

    // The scheduled back-off retry still fires at its own boundary (attempt 2), not sooner.
    await runtime.runPromise(TestClock.adjust(Duration.millis(backedOff.backoff!.delayMs)));
    expect(calls).toBe(2);
    expect(scheduler.getOutput(key).backoff).toMatchObject({ class: "transient", attempt: 2 });

    await scheduler.shutdown();
  });

  it("does not fetch for a manual refresh on an unknown or deactivated key", async () => {
    const runtime = makeTestRuntime();
    const scheduler = createScheduler({ runtime });
    // Unknown key -> inert no-data output, no fetch.
    await expect(scheduler.refresh(key)).resolves.toMatchObject({ displayState: "no-data-yet", activeRefCount: 0 });
    await scheduler.shutdown();
  });
});

describe("credential / settings-change refresh", () => {
  it("a credential change bypasses + resets the active back-off and forces an immediate refetch", async () => {
    const runtime = makeJitterRuntime(3);
    const refetched = runtime.runSync(Deferred.make<void>());
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const fetch: SchedulerEffectFetch = (request) =>
      Effect.gen(function* () {
        calls += 1;
        if (calls === 1) {
          return yield* failFetch({ failure: failure("rate-limited") })(request); // fail -> rate-limit back-off
        }
        yield* Deferred.succeed(refetched, undefined);
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 33 });
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch });

    await macrotask();
    expect(scheduler.getOutput(key).backoff).toMatchObject({ class: "rate-limit", attempt: 1 });

    // Credential change -> forces a refetch that bypasses the active back-off. Crucially: NO clock
    // advance past the back-off delay, yet the refetch runs -> proves bypass (not "wait for retry").
    await scheduler.handleGlobalSettingsChange({ schedulerKeys: [key], change: globalSourceAffectingChange() });
    await runtime.runPromise(Deferred.await(refetched));
    await macrotask();

    expect(calls).toBe(2);
    const recovered = scheduler.getOutput(key);
    expect(recovered).toMatchObject({ displayState: "fresh", snapshot: { value: 33 } });
    expect(recovered.backoff).toBeUndefined(); // back-off reset
    expect(recovered.nextAllowedRetryAtEpochMs).toBeUndefined();

    await scheduler.shutdown();
  });

  it("drops a retained snapshot when a provider-source change refetch fails (no cross-source stale)", async () => {
    const runtime = makeJitterRuntime(4);
    const refetchFailed = runtime.runSync(Deferred.make<void>());
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const fetch: SchedulerEffectFetch = (request) =>
      Effect.gen(function* () {
        calls += 1;
        if (calls === 1) {
          return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 44 }); // retain a trusted value
        }
        yield* Deferred.succeed(refetchFailed, undefined);
        return yield* failFetch({ failure: failure("invalid-credentials") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch });

    await macrotask();
    expect(scheduler.getOutput(key)).toMatchObject({ displayState: "fresh", snapshot: { value: 44 } });

    // Provider-source action-settings change -> refetch fails; the retained value-44 (possibly a
    // different credential/scope) must NOT be shown, even as stale.
    await scheduler.handleActionSettingsChange({ schedulerKey: key, change: sourceAffectingChange() });
    await runtime.runPromise(Deferred.await(refetchFailed));
    await macrotask();

    const current = scheduler.getOutput(key);
    expect(current).toMatchObject({ displayState: "invalid-credentials", failure: { category: "invalid-credentials" } });
    expect(current.displayState).not.toBe("stale");
    expect(current.snapshot).toBeUndefined();
    expect(current.staleReason).toBeUndefined();

    await scheduler.shutdown();
  });

  it("bypasses back-off for the AFFECTED key only; unrelated keys stay backed off", async () => {
    const runtime = makeJitterRuntime(5);
    const refetchedA = runtime.runSync(Deferred.make<void>());
    let callsA = 0;
    let callsB = 0;
    const scheduler = createScheduler({ runtime });
    const fetchA: SchedulerEffectFetch = (request) =>
      Effect.gen(function* () {
        callsA += 1;
        if (callsA === 1) {
          return yield* failFetch({ failure: failure("rate-limited") })(request);
        }
        yield* Deferred.succeed(refetchedA, undefined);
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 10 });
      });
    const fetchB: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        callsB += 1;
        return failFetch({ failure: failure("rate-limited") })(request);
      });
    scheduler.activate({ instanceId: "a", keyParts, refreshIntervalSeconds: 600, fetch: fetchA });
    scheduler.activate({ instanceId: "b", keyParts: otherKeyParts, refreshIntervalSeconds: 600, fetch: fetchB });

    await macrotask();
    expect(scheduler.getOutput(key).backoff).toMatchObject({ class: "rate-limit" });
    expect(scheduler.getOutput(otherKey).backoff).toMatchObject({ class: "rate-limit" });
    expect(callsB).toBe(1);

    // Credential change affects keyA only.
    await scheduler.handleGlobalSettingsChange({ schedulerKeys: [key], change: globalSourceAffectingChange() });
    await runtime.runPromise(Deferred.await(refetchedA));
    await macrotask();

    expect(scheduler.getOutput(key)).toMatchObject({ displayState: "fresh", snapshot: { value: 10 } });
    // keyB never refetched or bypassed its back-off because another provider changed.
    expect(callsB).toBe(1);
    expect(scheduler.getOutput(otherKey).backoff).toMatchObject({ class: "rate-limit" });

    await scheduler.shutdown();
  });

  it("reschedules the RUNNING fiber's healthy cadence on a refresh-policy change (no poll)", async () => {
    const runtime = makeJitterRuntime(7);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs });
      }),
    });

    await macrotask();
    expect(calls).toBe(1);
    const nowBefore = await runtime.runPromise(Clock.currentTimeMillis);
    const armedOld = scheduler.getOutput(key).nextHealthyPollAtEpochMs!;
    expect(armedOld - nowBefore).toBeGreaterThanOrEqual(600_000); // ~600-720s (old cadence)

    // Refresh-policy-only change to 60s reschedules the RUNNING fiber, without polling.
    await scheduler.handleActionSettingsChange({ schedulerKey: key, change: refreshPolicyOnlyChange(), refreshIntervalSeconds: 60 });
    await macrotask();
    expect(calls).toBe(1); // reschedule did NOT poll

    const nowAfter = await runtime.runPromise(Clock.currentTimeMillis);
    const armedNew = scheduler.getOutput(key).nextHealthyPollAtEpochMs!;
    expect(armedNew - nowAfter).toBeGreaterThanOrEqual(60_000); // new cadence ~60-72s, not the old ~600s
    expect(armedNew - nowAfter).toBeLessThanOrEqual(72_000);
    expect(scheduler.getOutput(key).refreshIntervalSeconds).toBe(60);

    // The next healthy poll fires at the NEW cadence.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(calls).toBe(2);

    await scheduler.shutdown();
  });

  it("a display-only settings change neither fetches nor bypasses an active back-off", async () => {
    const runtime = makeJitterRuntime(8);
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const failingFetch: SchedulerEffectFetch = (request) =>
      Effect.suspend(() => {
        calls += 1;
        return failFetch({ failure: failure("rate-limited") })(request);
      });
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: failingFetch });

    await macrotask();
    const backedOff = scheduler.getOutput(key);
    expect(backedOff.backoff).toMatchObject({ class: "rate-limit", attempt: 1 });
    expect(calls).toBe(1);

    const changed = await scheduler.handleActionSettingsChange({ schedulerKey: key, change: displayOnlyChange() });
    const globalChanged = await scheduler.handleGlobalSettingsChange({ schedulerKeys: [key], change: globalDisplayOnlyChange() });
    await macrotask();

    expect(calls).toBe(1); // no refetch
    expect(changed.backoff).toMatchObject({ class: "rate-limit", attempt: 1 });
    expect(changed.nextAllowedRetryAtEpochMs).toBe(backedOff.nextAllowedRetryAtEpochMs);
    expect(globalChanged[0]?.backoff).toMatchObject({ class: "rate-limit", attempt: 1 });

    await scheduler.shutdown();
  });
});

describe("healthy-poll jitter", () => {
  it("jitters the healthy cadence within 0-20% and is deterministic under a seed", async () => {
    const INTERVAL_MS = 600_000;
    const collectHealthyDelays = async (seed: number, n: number): Promise<number[]> => {
      const runtime = makeJitterRuntime(seed);
      const scheduler = createScheduler({ runtime });
      scheduler.activate({
        instanceId: "instance-a",
        keyParts,
        refreshIntervalSeconds: 600,
        fetch: okFetch((request) => snapshot({ fetchedAtEpochMs: request.startedAtEpochMs })),
      });
      await macrotask();
      const delays: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const now = await runtime.runPromise(Clock.currentTimeMillis);
        const armed = scheduler.getOutput(key).nextHealthyPollAtEpochMs!;
        delays.push(armed - now);
        await runtime.runPromise(TestClock.adjust(Duration.millis(armed - now)));
        await macrotask();
      }
      await scheduler.shutdown();
      return delays;
    };

    const run1 = await collectHealthyDelays(55, 5);
    const run2 = await collectHealthyDelays(55, 5);
    expect(run1).toEqual(run2); // deterministic under a fixed seed

    for (const delayMs of run1) {
      expect(delayMs).toBeGreaterThanOrEqual(INTERVAL_MS); // positive-only: never below the base interval
      expect(delayMs).toBeLessThanOrEqual(Math.ceil(INTERVAL_MS * 1.2)); // bounded to +20%
    }
    // Jitter is actually applied (not a constant base delay).
    expect(run1.some((delayMs) => delayMs > INTERVAL_MS)).toBe(true);

    // A different seed yields a different (but equally in-bounds) sequence.
    const other = await collectHealthyDelays(9999, 5);
    expect(other).not.toEqual(run1);
  });
});

describe("post-shutdown guard", () => {
  it("every public method is inert after shutdown — no throw from the disposed runtime", async () => {
    const runtime = makeTestRuntime();
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => snapshot({ fetchedAtEpochMs: request.startedAtEpochMs })),
    });

    await macrotask();
    await scheduler.shutdown();
    // Dispose the injected runtime too. Production owns + disposes its runtime on shutdown; here we
    // prove the shutdown guards prevent ANY post-shutdown runtime access (which would otherwise throw
    // "ManagedRuntime disposed").
    await runtime.dispose();

    expect(() => scheduler.getOutput(key)).not.toThrow();
    expect(() =>
      scheduler.activate({
        instanceId: "instance-late",
        keyParts,
        refreshIntervalSeconds: 600,
        fetch: okFetch((request) => snapshot({ fetchedAtEpochMs: request.startedAtEpochMs })),
      }),
    ).not.toThrow();
    expect(() => scheduler.deactivate({ schedulerKey: key, instanceId: "instance-a" })).not.toThrow();

    await expect(scheduler.refresh(key)).resolves.toMatchObject({ displayState: "no-data-yet", activeRefCount: 0 });
    await expect(
      scheduler.handleActionSettingsChange({ schedulerKey: key, change: sourceAffectingChange(), refreshIntervalSeconds: 300 }),
    ).resolves.toMatchObject({ displayState: "no-data-yet" });
    await expect(
      scheduler.handleGlobalSettingsChange({ schedulerKeys: [key], change: globalSourceAffectingChange() }),
    ).resolves.toEqual([]);
    await expect(scheduler.runDue()).resolves.toEqual([]);

    expect(scheduler.getOutput(key)).toMatchObject({ displayState: "no-data-yet", activeRefCount: 0, inFlight: false });
  });
});

describe("serialized fiber replacement", () => {
  it("deactivate(last)->reactivate-same-key never runs two concurrent same-key fetches", async () => {
    const runtime = makeTestRuntime();
    const inFlight = runtime.runSync(Ref.make(0));
    const maxConcurrent = runtime.runSync(Ref.make(0));
    const release = runtime.runSync(Deferred.make<void>());
    const secondStarted = runtime.runSync(Deferred.make<void>());
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    const slowFetch: SchedulerEffectFetch = (request) =>
      Effect.gen(function* () {
        calls += 1;
        const mine = calls;
        const current = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
        yield* Ref.update(maxConcurrent, (m) => Math.max(m, current));
        if (mine === 2) {
          yield* Deferred.succeed(secondStarted, undefined);
        }
        yield* Deferred.await(release);
        yield* Ref.update(inFlight, (n) => n - 1);
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs });
      }).pipe(Effect.onInterrupt(() => Ref.update(inFlight, (n) => Math.max(0, n - 1))));

    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: slowFetch });
    await macrotask();
    expect(calls).toBe(1);
    expect(runtime.runSync(Ref.get(inFlight))).toBe(1);

    // Deactivate the LAST instance (interrupts the in-flight poll) then IMMEDIATELY reactivate the same key.
    scheduler.deactivate({ schedulerKey: key, instanceId: "instance-a" });
    scheduler.activate({ instanceId: "instance-b", keyParts, refreshIntervalSeconds: 600, fetch: slowFetch });

    // The re-forked fiber must wait for the prior interrupt to complete before polling; when it finally
    // polls, the old fetch has already been aborted -> at most one same-key fetch is ever in flight.
    await runtime.runPromise(Deferred.await(secondStarted));
    expect(calls).toBe(2);
    expect(runtime.runSync(Ref.get(maxConcurrent))).toBe(1);
    expect(runtime.runSync(Ref.get(inFlight))).toBe(1);

    runtime.runSync(Deferred.succeed(release, undefined));
    await macrotask();
    await scheduler.shutdown();
  });
});

describe("runDue reports active-key state, deactivate stops polling", () => {
  it("reports current output for active keys and stops future polls after deactivate", async () => {
    const runtime = makeTestRuntime();
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs });
      }),
    });

    await macrotask();
    const dueWhileActive = await scheduler.runDue();
    expect(dueWhileActive).toHaveLength(1);
    expect(dueWhileActive[0]).toMatchObject({ schedulerKey: key, displayState: "fresh" });

    scheduler.deactivate({ schedulerKey: key, instanceId: "instance-a" });
    await macrotask();
    await runtime.runPromise(TestClock.adjust(Duration.seconds(600)));
    expect(calls).toBe(1);
    expect(await scheduler.runDue()).toEqual([]);

    await scheduler.shutdown();
  });
});

describe("output-change notification (prompt re-render on poll settle)", () => {
  it("fires the listener with the key the moment a background poll settles — on completion, not on a render tick", async () => {
    const runtime = makeTestRuntime();
    const changed: string[] = [];
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    // Register BEFORE activate to prove the lazy listener slot is picked up regardless of order.
    const unsubscribe = scheduler.onOutputChanged((schedulerKey) => changed.push(schedulerKey));
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 42 });
      }),
    });

    // The immediate first poll settles on the first macrotask with NO clock advance: the value is
    // available now and the listener has already fired for this key (not waiting for a 30s render tick).
    await macrotask();
    expect(calls).toBe(1);
    expect(changed).toEqual([key]);

    // Each subsequent background (jittered) healthy poll settle fires the listener again, keyed to the key.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(calls).toBe(2);
    expect(changed).toEqual([key, key]);

    unsubscribe();
    await scheduler.shutdown();
  });

  it("fires when a manual-refresh poll settles, so the fetched value surfaces within a poll round-trip", async () => {
    const runtime = makeTestRuntime();
    const changed: string[] = [];
    let calls = 0;
    const scheduler = createScheduler({ runtime });
    scheduler.onOutputChanged((schedulerKey) => changed.push(schedulerKey));
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => {
        calls += 1;
        return snapshot({ fetchedAtEpochMs: request.startedAtEpochMs, value: 100 + calls });
      }),
    });

    await macrotask();
    expect(changed).toEqual([key]); // immediate first poll settle (retains value 101)

    // Advance a little (well under the 600s healthy interval, so no background poll fires) so the
    // manual-refresh poll's snapshot is strictly newer than the retained one — cache arbitration adopts
    // strictly-newer. Manual refresh then polls NOW and the settle fires the notification: the freshly
    // fetched value surfaces within one poll round-trip, not on a 30s render tick.
    await runtime.runPromise(TestClock.adjust(Duration.millis(1_000)));
    const before = changed.length;
    expect(before).toBe(1); // the clock nudge did not itself fire a poll/notification
    await scheduler.refresh(key);
    await macrotask();
    expect(calls).toBe(2);
    expect(changed.length).toBe(before + 1);
    expect(changed.at(-1)).toBe(key);
    expect(scheduler.getOutput(key)).toMatchObject({ displayState: "fresh", snapshot: { value: 102 } });

    await scheduler.shutdown();
  });

  it("fires on a failure->back-off settle and the notification carries ONLY the key (no secret / raw Cause)", async () => {
    const runtime = makeJitterRuntime(42);
    const changed: unknown[] = [];
    const scheduler = createScheduler({ runtime });
    scheduler.onOutputChanged((schedulerKey) => changed.push(schedulerKey));
    // failure(...) embeds RAW_NEEDLES.cause in the underlying cause; the notification must never carry it.
    scheduler.activate({ instanceId: "instance-a", keyParts, refreshIntervalSeconds: 600, fetch: failFetch({ failure: failure("network-failure") }) });

    await macrotask();
    // The failing first poll settled AND armed a back-off: the listener fired for this key.
    expect(changed.length).toBeGreaterThan(0);
    for (const arg of changed) {
      expect(arg).toBe(key);
    }
    // The listener only ever receives the plain key string — no snapshot/failure/Cause crosses the boundary.
    const serialized = JSON.stringify(changed);
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.account);
    expect(scheduler.getOutput(key).backoff).toMatchObject({ class: "transient", attempt: 1 });

    await scheduler.shutdown();
  });

  it("stops notifying after unsubscribe", async () => {
    const runtime = makeTestRuntime();
    const changed: string[] = [];
    const scheduler = createScheduler({ runtime });
    const unsubscribe = scheduler.onOutputChanged((schedulerKey) => changed.push(schedulerKey));
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: okFetch((request) => snapshot({ fetchedAtEpochMs: request.startedAtEpochMs })),
    });

    await macrotask();
    expect(changed.length).toBe(1);

    unsubscribe();
    const afterUnsub = changed.length;
    // Further background polls no longer notify.
    await advanceToNextHealthyPoll(runtime, scheduler, key);
    expect(changed.length).toBe(afterUnsub);

    await scheduler.shutdown();
  });
});

describe("leak and forbidden-boundary guards", () => {
  it("does not serialize raw sensitive synthetic needles from a failed provider fetch", async () => {
    const runtime = makeTestRuntime();
    const scheduler = createScheduler({ runtime });
    scheduler.activate({
      instanceId: "instance-a",
      keyParts,
      refreshIntervalSeconds: 600,
      fetch: failFetch({ failure: failure("unknown-sanitized-failure") }),
    });

    await macrotask();
    const output = scheduler.getOutput(key);
    const serialized = JSON.stringify(output);

    expect(output).toMatchObject({ displayState: "unknown-sanitized-failure", failure: { sanitized: true } });
    expect(serialized).not.toContain(RAW_NEEDLES.cause);
    expect(serialized).not.toContain(RAW_NEEDLES.token);
    expect(serialized).not.toContain(RAW_NEEDLES.account);

    await scheduler.shutdown();
  });

  it("(g) keeps scheduler source free of raw timers, Date.now, manual backoff math, and forbidden imports", async () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files = (await readdir(root)).filter((file) => file.endsWith(".ts"));
    const source = (await Promise.all(files.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")))).join("\n");
    // NOTE: `Schedule.exponential` is INTENTIONALLY allowed — it is the sanctioned
    // Effect back-off primitive. The manual-math (`2 ** `), raw-timer, Date.now, raw-global-fetch,
    // and cross-boundary-import prohibitions remain in force.
    const forbiddenPatterns = [
      ["set", "Timeout"].join(""),
      ["set", "Interval"].join(""),
      ["set", "Immediate"].join(""),
      ["Date", "\\.", "now"].join(""),
      ["globalThis", "\\.", "fetch"].join(""),
      // Raw global fetch() only — the injected `entry.fetch(...)` dependency (a property) is allowed.
      ["(?<![.\\w])", "fe", "tch\\("].join(""),
      ["2 ", "\\*\\* "].join(""),
      ["@elgato", "/", "streamdeck"].join(""),
      ["provider", "-", "adapters"].join(""),
      ["@ai-workbench", "/", "display"].join(""),
      ["@ai-workbench", "/", "action-usage"].join(""),
      ["@ai-workbench", "/", "action-balance"].join(""),
    ];

    expect(root).toContain("packages/scheduler/src");
    for (const pattern of forbiddenPatterns) {
      expect(source).not.toMatch(new RegExp(pattern));
    }
  });
});
