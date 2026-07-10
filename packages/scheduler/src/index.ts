import {
  REFRESH_INTERVAL_DEFAULT_SECONDS,
  serializeSchedulerKey,
  type DisplayState,
  type NormalizedSnapshot,
  type SchedulerKey,
  type SchedulerKeyParts,
} from "@ai-workbench/contracts";
import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";
import type { HttpRetryClassificationInput } from "@ai-workbench/http";
import type { ActionSettingsChangeClassification, GlobalSettingsChangeClassification } from "@ai-workbench/settings";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, ManagedRuntime, Random, Ref, Schedule } from "effect";

export const packageName = "@ai-workbench/scheduler" as const;

// Central scheduler policy constants: shape + values preserved across the
// Effect-native rebuild. The `stale.*` block covers staleness/expiry; the
// `transient`/`rateLimit`/`jitter` blocks are the frozen basis for the Effect `Schedule`
// failure back-off below. NO hand-rolled exponential backoff math lives here — Effect `Schedule`
// owns the exponential growth, jitter, and cap.
export const SCHEDULER_BACKOFF_POLICY = {
  transient: {
    initialDelayMs: 30_000,
    maxDelayMs: 300_000,
  },
  rateLimit: {
    initialDelayMs: 60_000,
    maxDelayMs: 600_000,
    maxRetryAfterMs: 3_600_000,
  },
  stale: {
    ageMultiplier: 2,
    maxDisplayMs: 86_400_000,
  },
  jitter: {
    minRatio: 0,
    maxRatio: 0.2,
  },
} as const;

export type SchedulerBackoffClass = "transient" | "rate-limit";
export type SchedulerJitterClass = SchedulerBackoffClass | "healthy-poll";
/**
 * The provenance a scheduler fetch runs under (narrowed to the value the Effect-native
 * engine actually emits). The per-key poll fiber issues EVERY fetch as a `"healthy-poll"` request
 * (see the `pollAttempt` request) — the former `"manual-refresh"`/`"retry"`/`"settings-change"`
 * members were unreachable: manual refresh and refresh-policy changes wake the SAME fiber (which then
 * polls as a healthy poll), a source/credential change re-forks the fiber (whose first poll is again a
 * healthy poll), and failure retries are the fiber's own back-off loop — none produce a distinct
 * trigger value. The sole consumer, the fetch-started log `reasonCode` (apps/streamdeck
 * scheduler-fetch), reads it as a plain string and is unaffected by the narrow.
 */
export type SchedulerFetchTrigger = "healthy-poll";
export type SchedulerStaleReason = "refresh-failed" | "age-stale";

export interface SchedulerAbortSignal {
  readonly aborted: boolean;
  readonly addEventListener: (type: "abort", listener: () => void, options?: { readonly once?: boolean }) => void;
}

export interface SchedulerFetchRequest {
  readonly schedulerKey: SchedulerKey;
  readonly key: SchedulerKey;
  readonly keyParts: SchedulerKeyParts;
  readonly trigger: SchedulerFetchTrigger;
  readonly startedAtEpochMs: number;
  readonly signal: SchedulerAbortSignal;
  /**
   * The currently retained trusted snapshot for this key, when one exists.
   * Local-fallback arbitration input only (a fallback source may be adopted
   * only when it is strictly newer); providers must not treat it as data.
   */
  readonly previousSnapshot?: NormalizedSnapshot;
}

export type SchedulerFetchResult =
  | {
      readonly ok: true;
      readonly snapshot: NormalizedSnapshot;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedFailure;
      readonly retry?: HttpRetryClassificationInput;
    };

/**
 * The legacy Promise-based fetch contract (frozen export). The Effect-native
 * scheduler no longer consumes this internally — it consumes {@link SchedulerEffectFetch} —
 * but the type is retained for any remaining Promise-boundary consumers.
 */
export type SchedulerFetch = (request: SchedulerFetchRequest) => SchedulerFetchResult | Promise<SchedulerFetchResult>;

/**
 * The failure an Effect-native fetch fails with: the plain sanitized failure plus the
 * optional rate-limit retry hint (the `SchedulerFetchResult` failure minus its `ok`
 * discriminant). Structurally identical to a migrated adapter's `AdapterFetchFailure`,
 * so the adapter Effect is assignable to {@link SchedulerEffectFetch} directly.
 */
export interface SchedulerFetchFailure {
  readonly failure: SanitizedFailure;
  readonly retry?: HttpRetryClassificationInput;
}

/**
 * The Effect-native per-key fetch the fiber engine runs directly: one HTTP
 * attempt as an `Effect` that yields the normalized snapshot or fails with a
 * {@link SchedulerFetchFailure}. The `HttpClient` layer is provided by the caller
 * (the shell's scheduler-fetch dispatch) BEFORE the effect reaches the scheduler, so the
 * requirement channel is `never` and the scheduler stays platform-agnostic. This replaces
 * the temporary `runPromiseExit` bridge — the scheduler consumes the adapter Effect directly.
 */
export type SchedulerEffectFetch = (request: SchedulerFetchRequest) => Effect.Effect<NormalizedSnapshot, SchedulerFetchFailure, never>;

export interface SchedulerBackoffOutput {
  readonly class: SchedulerBackoffClass;
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly delayMs: number;
  readonly nextRetryAtEpochMs: number;
  readonly retryAfterApplied?: true;
}

export interface SchedulerOutput {
  readonly schedulerKey: SchedulerKey;
  readonly displayState: DisplayState;
  readonly refreshIntervalSeconds: number;
  readonly activeRefCount: number;
  readonly inFlight: boolean;
  readonly snapshot?: NormalizedSnapshot;
  readonly failure?: SanitizedFailure;
  readonly staleReason?: SchedulerStaleReason;
  readonly backoff?: SchedulerBackoffOutput;
  readonly nextAllowedRetryAtEpochMs?: number;
  readonly nextHealthyPollAtEpochMs?: number;
}

export interface SchedulerActivateInput {
  readonly instanceId: string;
  readonly keyParts: SchedulerKeyParts;
  readonly refreshIntervalSeconds: number;
  readonly fetch: SchedulerEffectFetch;
}

export interface SchedulerDeactivateInput {
  readonly schedulerKey: SchedulerKey;
  readonly instanceId: string;
}

export interface SchedulerSettingsChangeInput {
  readonly schedulerKey: SchedulerKey;
  readonly change: ActionSettingsChangeClassification;
  readonly refreshIntervalSeconds?: number;
}

export interface SchedulerGlobalSettingsChangeInput {
  readonly schedulerKeys: readonly SchedulerKey[];
  readonly change: GlobalSettingsChangeClassification;
}

export interface Scheduler {
  readonly activate: (input: SchedulerActivateInput) => SchedulerOutput;
  readonly deactivate: (input: SchedulerDeactivateInput) => SchedulerOutput;
  readonly refresh: (schedulerKey: SchedulerKey) => Promise<SchedulerOutput>;
  readonly runDue: () => Promise<readonly SchedulerOutput[]>;
  readonly getOutput: (schedulerKey: SchedulerKey) => SchedulerOutput;
  readonly handleActionSettingsChange: (input: SchedulerSettingsChangeInput) => Promise<SchedulerOutput>;
  readonly handleGlobalSettingsChange: (input: SchedulerGlobalSettingsChangeInput) => Promise<readonly SchedulerOutput[]>;
  /**
   * Registers a fire-and-forget listener invoked with a key the INSTANT that key's output changes
   * because a poll settled — a background healthy poll, a manual-refresh poll, a failure back-off
   * arming/clearing, or a source-change refetch. It lets the shell re-render that key
   * within one poll round-trip instead of waiting for the periodic render tick (the regression:
   * a fetched value only surfaced on the next 30s tick). The listener receives ONLY the plain
   * `SchedulerKey` — no snapshot, failure, or `Cause` crosses this boundary; read the
   * already-sanitized state via {@link getOutput}. It fires from the poll fiber via `Effect.sync`, so
   * the listener MUST be fire-and-forget (schedule the render, do not block or synchronously re-enter
   * the scheduler runtime). Returns an unsubscribe; inert after {@link shutdown} (no fiber writes
   * remain to notify). A later registration replaces the prior listener (single-consumer model).
   */
  readonly onOutputChanged: (listener: (schedulerKey: SchedulerKey) => void) => () => void;
  readonly shutdown: () => Promise<void>;
}

export interface CreateSchedulerOptions {
  /**
   * The Effect runtime the per-key fibers are forked into. Production omits this and a
   * `ManagedRuntime` over `Layer.empty` (real Effect `Clock`) is created and owned by the
   * scheduler. Tests inject `ManagedRuntime.make(TestContext.TestContext)` so `Clock`/
   * `Schedule` run under the deterministic `TestClock`. The shell re-wire can inject the
   * composed appLayer runtime here.
   */
  readonly runtime?: ManagedRuntime.ManagedRuntime<never, never>;
}

interface KeyPollState {
  readonly inFlight: boolean;
  readonly trustedSnapshot?: NormalizedSnapshot;
  readonly lastFailure?: SanitizedFailure;
  readonly lastPollAtEpochMs?: number;
  /** The failure back-off currently governing this key's retry cadence. Set while a
   * transient/rate-limit back-off is active, cleared on a successful or non-retryable poll. */
  readonly activeBackoff?: SchedulerBackoffOutput;
}

interface KeyEntry {
  readonly schedulerKey: SchedulerKey;
  readonly keyParts: SchedulerKeyParts;
  readonly activeInstances: Set<string>;
  readonly fetch: SchedulerEffectFetch;
  readonly state: Ref.Ref<KeyPollState>;
  /** Fires the scheduler's output-change listener for THIS key. The poll fiber invokes it
   * (via {@link fireOutputChanged}, guarded) after each `Ref` write that changes this key's
   * `SchedulerOutput`, so the shell re-renders promptly. It reads the scheduler's listener slot lazily,
   * so registration order relative to `activate` does not matter; it is a no-op while no listener is set. */
  readonly notifyOutputChanged: () => void;
  refreshIntervalSeconds: number;
  fiber?: Fiber.RuntimeFiber<void, never>;
  /** The wake `Deferred` the poll fiber is racing its healthy sleep against. Set ONLY
   * while the fiber sits in a healthy sleep; unset during a poll or a failure back-off. `refresh`/
   * settings-change complete it to wake the sleep. Its absence is why a bare manual refresh during a
   * back-off or an in-flight fetch is a natural no-op (respects back-off / joins the in-flight poll). */
  healthyWake?: Deferred.Deferred<HealthyWake>;
  /** The fiber running the interrupt of a superseded poll fiber. A re-fork waits on
   * this so the old in-flight fetch is fully aborted before the new fiber polls (serialized single-flight). */
  interruptFiber?: Fiber.RuntimeFiber<unknown, never>;
  /** The actual (jittered) epoch-ms the next healthy poll is armed for. Set when the fiber
   * arms a healthy sleep, cleared when it starts a poll; surfaced as `SchedulerOutput.nextHealthyPollAtEpochMs`
   * so the countdown reflects the real jittered cadence rather than an un-jittered estimate. */
  nextHealthyPollAtEpochMs?: number;
}

const DEFAULT_NO_DATA_REASON = "scheduler-entry-not-active";
const SHUTDOWN_NO_DATA_REASON = "scheduler-shut-down";

const INITIAL_POLL_STATE: KeyPollState = { inFlight: false };

// The Effect-native adapters cancel via Effect fiber interruption, not this signal; an inert
// signal satisfies the frozen `SchedulerFetchRequest` contract without a live AbortController.
const INERT_ABORT_SIGNAL: SchedulerAbortSignal = {
  aborted: false,
  addEventListener: () => undefined,
};

// Positive-only jitter multipliers derived from the frozen policy ratios:
// `1 + ratio`, so the effective multiplier lands in [1.0, 1.2] (0-20% added), never below the base.
const JITTER_MIN_MULTIPLIER = 1 + SCHEDULER_BACKOFF_POLICY.jitter.minRatio;
const JITTER_MAX_MULTIPLIER = 1 + SCHEDULER_BACKOFF_POLICY.jitter.maxRatio;

/**
 * The Effect `Schedule` that produces the sequence of failure back-off delays for one class.
 * Effect `Schedule` owns all of the math — there is no hand-rolled exponentiation:
 *   exponential growth (factor 2 from the frozen base)
 *     -> `jitteredWith` positive 0-20% jitter (`d * (1 + 0.2 * random)`)
 *     -> `either(spaced(cap))` unions with a constant `cap`, and a union takes the SHORTER delay,
 *        so the cap clamps the delay AFTER jitter (the effective delay never exceeds the class cap).
 * `delays` re-projects the applied delay as the schedule Output, and `delayed(() => zero)` drops the
 * schedule's own sleep. So driving this yields the exact next delay WITHOUT sleeping: the fiber reads
 * that delay (to populate `SchedulerOutput.backoff`), then sleeps it itself on the Effect `Clock`
 * (deterministic under `TestClock`). Jitter draws from the Effect `Random` service (real randomness in
 * production; tests inject a seeded `Random` via `Layer.setRandom` for determinism).
 */
function backoffDelaySchedule(initialDelayMs: number, maxDelayMs: number): Schedule.Schedule<Duration.Duration> {
  return Schedule.exponential(Duration.millis(initialDelayMs), 2).pipe(
    Schedule.jitteredWith({ min: JITTER_MIN_MULTIPLIER, max: JITTER_MAX_MULTIPLIER }),
    Schedule.either(Schedule.spaced(Duration.millis(maxDelayMs))),
    Schedule.delays,
    Schedule.delayed(() => Duration.zero),
  );
}

const TRANSIENT_DELAY_SCHEDULE = backoffDelaySchedule(
  SCHEDULER_BACKOFF_POLICY.transient.initialDelayMs,
  SCHEDULER_BACKOFF_POLICY.transient.maxDelayMs,
);
const RATE_LIMIT_DELAY_SCHEDULE = backoffDelaySchedule(
  SCHEDULER_BACKOFF_POLICY.rateLimit.initialDelayMs,
  SCHEDULER_BACKOFF_POLICY.rateLimit.maxDelayMs,
);

/**
 * The Effect `Schedule` that produces ONE jittered healthy-poll delay for the current refresh
 * interval (healthy poll AND retry schedules apply bounded 0-20% jitter — thundering-herd
 * avoidance). It applies the SAME sanctioned Effect jitter
 * primitive as the failure back-off (`Schedule.jitteredWith` with the frozen positive-only [1.0,1.2]
 * multipliers) — NO hand-rolled jitter math. `delays`+`delayed(() => zero)` re-project the
 * jittered delay as the schedule Output and drop the schedule's own sleep, so the fiber reads the
 * jittered delay WITHOUT sleeping, then sleeps it itself on the Effect `Clock` (deterministic under
 * `TestClock`). A FRESH schedule is built each healthy cycle from the current `entry.refreshIntervalSeconds`,
 * so a settings reschedule takes effect without re-forking. No cap union is needed: the interval is
 * already bounded by settings validation (60-3600s) and positive jitter adds at most 20%.
 */
function healthyDelaySchedule(intervalMs: number): Schedule.Schedule<Duration.Duration> {
  return Schedule.fixed(Duration.millis(intervalMs)).pipe(
    Schedule.jitteredWith({ min: JITTER_MIN_MULTIPLIER, max: JITTER_MAX_MULTIPLIER }),
    Schedule.delays,
    Schedule.delayed(() => Duration.zero),
  );
}

/**
 * How a sleeping healthy-poll fiber is woken mid-sleep. A manual `refresh` completes the
 * per-cycle wake `Deferred` with `poll` (poll NOW); a refresh-policy settings change completes it with
 * `reschedule` (re-arm the sleep at the new interval WITHOUT polling). If the wake `Deferred` fires
 * before the sleep, the fiber acts on the reason; otherwise the sleep elapses and the fiber polls at
 * the healthy cadence.
 */
type HealthyWake = "poll" | "reschedule";

/** The outcome of one poll attempt: a fresh snapshot, or a sanitized failure (typed OR a sanitized defect). */
type FetchOutcome =
  | { readonly ok: true; readonly snapshot: NormalizedSnapshot }
  | { readonly ok: false; readonly failure: SanitizedFailure; readonly retry?: HttpRetryClassificationInput };

/** What the poll loop does next after one attempt: resume the healthy cadence, or back off by class. */
type PollDecision =
  | { readonly kind: "success" }
  | { readonly kind: "no-backoff" }
  | { readonly kind: "backoff"; readonly backoffClass: SchedulerBackoffClass; readonly retryAfterSeconds?: number };

export function createScheduler(options: CreateSchedulerOptions = {}): Scheduler {
  return new CentralScheduler(options);
}

class CentralScheduler implements Scheduler {
  private readonly entries = new Map<SchedulerKey, KeyEntry>();
  private readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
  private readonly ownsRuntime: boolean;
  private shutdownRequested = false;
  /** The single output-change listener, set by {@link onOutputChanged}. One consumer (the
   * shell), so a single slot — not a listener list. Read lazily by each entry's `notifyOutputChanged`.
   * Typed `| undefined` (not `?`) so unsubscribe can clear it under `exactOptionalPropertyTypes`. */
  private outputChangedListener: ((schedulerKey: SchedulerKey) => void) | undefined;

  constructor(options: CreateSchedulerOptions) {
    if (options.runtime !== undefined) {
      this.runtime = options.runtime;
      this.ownsRuntime = false;
    } else {
      this.runtime = ManagedRuntime.make(Layer.empty);
      this.ownsRuntime = true;
    }
  }

  activate(input: SchedulerActivateInput): SchedulerOutput {
    const schedulerKey = serializeSchedulerKey(input.keyParts);
    // After shutdown the (owned) runtime is disposed; touching it throws. Return inert.
    if (this.shutdownRequested) {
      return this.noDataOutput(schedulerKey, SHUTDOWN_NO_DATA_REASON);
    }
    const existing = this.entries.get(schedulerKey);

    if (existing !== undefined) {
      existing.activeInstances.add(input.instanceId);
      // Structural single-flight: one fiber per key. A re-activation attaches the
      // instance to the existing fiber and never forks a second poll loop.
      this.ensureFiber(existing);
      return this.outputForEntry(existing);
    }

    const entry: KeyEntry = {
      schedulerKey,
      keyParts: input.keyParts,
      activeInstances: new Set([input.instanceId]),
      fetch: input.fetch,
      state: this.runtime.runSync(Ref.make<KeyPollState>(INITIAL_POLL_STATE)),
      // Reads the listener slot lazily so a listener registered before OR after activation both work.
      notifyOutputChanged: () => this.outputChangedListener?.(schedulerKey),
      refreshIntervalSeconds: input.refreshIntervalSeconds,
    };
    this.entries.set(schedulerKey, entry);
    this.ensureFiber(entry);
    return this.outputForEntry(entry);
  }

  deactivate(input: SchedulerDeactivateInput): SchedulerOutput {
    // Inert after shutdown (disposed runtime must not be touched).
    if (this.shutdownRequested) {
      return this.noDataOutput(input.schedulerKey, SHUTDOWN_NO_DATA_REASON);
    }
    const entry = this.entries.get(input.schedulerKey);
    if (entry === undefined) {
      return this.noDataOutput(input.schedulerKey, DEFAULT_NO_DATA_REASON);
    }

    entry.activeInstances.delete(input.instanceId);
    if (entry.activeInstances.size === 0) {
      this.interruptFiber(entry);
    }
    return this.outputForEntry(entry);
  }

  async refresh(schedulerKey: SchedulerKey): Promise<SchedulerOutput> {
    // Inert after shutdown.
    if (this.shutdownRequested) {
      return this.noDataOutput(schedulerKey, SHUTDOWN_NO_DATA_REASON);
    }
    const entry = this.entries.get(schedulerKey);
    if (entry === undefined) {
      return this.noDataOutput(schedulerKey, DEFAULT_NO_DATA_REASON);
    }
    // Manual refresh: wake the fiber to poll NOW by
    // completing its per-cycle healthy-sleep wake `Deferred` — the fiber `Effect.race`s the sleep
    // against it, so the race resolves and it polls immediately WITHOUT waiting for the interval.
    // It never spawns a parallel fetch. The wake `Deferred` exists ONLY while the fiber is in a
    // healthy sleep; if the fiber is polling (in-flight) or in a failure back-off, `healthyWake` is
    // unset and this is a no-op — so a BARE manual refresh RESPECTS the active back-off (it does not
    // hammer the provider) and JOINS an in-flight fetch. A true credential/source/settings change
    // bypasses back-off through the settings-change handlers, not here.
    const wake = entry.healthyWake;
    if (wake !== undefined) {
      this.runtime.runSync(Deferred.succeed(wake, "poll"));
    }
    return this.outputForEntry(entry);
  }

  async runDue(): Promise<readonly SchedulerOutput[]> {
    // The external timer-driven `runDue` SCAN is retired — per-key fibers
    // self-schedule their healthy polling. `runDue` is now a pure state report the shell's
    // render tick consumes to reflect background-poll results, until the push-render fiber.
    if (this.shutdownRequested) {
      return [];
    }
    const outputs: SchedulerOutput[] = [];
    for (const entry of this.entries.values()) {
      if (entry.activeInstances.size > 0) {
        outputs.push(this.outputForEntry(entry));
      }
    }
    return outputs;
  }

  getOutput(schedulerKey: SchedulerKey): SchedulerOutput {
    // Inert after shutdown (the disposed runtime must not be read).
    if (this.shutdownRequested) {
      return this.noDataOutput(schedulerKey, SHUTDOWN_NO_DATA_REASON);
    }
    const entry = this.entries.get(schedulerKey);
    if (entry === undefined) {
      return this.noDataOutput(schedulerKey, DEFAULT_NO_DATA_REASON);
    }
    return this.outputForEntry(entry);
  }

  async handleActionSettingsChange(input: SchedulerSettingsChangeInput): Promise<SchedulerOutput> {
    // Inert after shutdown.
    if (this.shutdownRequested) {
      return this.noDataOutput(input.schedulerKey, SHUTDOWN_NO_DATA_REASON);
    }
    const entry = this.entries.get(input.schedulerKey);
    if (entry === undefined) {
      return this.noDataOutput(input.schedulerKey, DEFAULT_NO_DATA_REASON);
    }
    // Record the new refresh interval first so a reschedule/refetch below uses it.
    if (input.refreshIntervalSeconds !== undefined) {
      entry.refreshIntervalSeconds = input.refreshIntervalSeconds;
    }
    const change = input.change;
    if (change.providerRefetchRequired) {
      // Provider-source change: bypass + reset the active
      // back-off, drop the retained snapshot (may belong to a superseded credential/profile/source),
      // and force an immediate refetch for THIS key only.
      this.forceRefetch(entry);
    } else if (change.refreshPolicyChanged) {
      // Refresh-policy-only change: reschedule the RUNNING fiber's healthy cadence to the new
      // interval without a fetch and without bypassing any active back-off.
      this.signalReschedule(entry);
    }
    // display-only / unchanged: no provider request; an in-flight fetch is joined (single-flight).
    return this.outputForEntry(entry);
  }

  async handleGlobalSettingsChange(input: SchedulerGlobalSettingsChangeInput): Promise<readonly SchedulerOutput[]> {
    // Inert after shutdown.
    if (this.shutdownRequested) {
      return [];
    }
    // A credential/global-source change forces a refetch (bypass + reset back-off) for the AFFECTED
    // keys only: unrelated keys are not in `schedulerKeys` and never refetch
    // or bypass back-off because another provider changed. Display-only global changes just report.
    const change = input.change;
    const schedulerKeys = [...new Set(input.schedulerKeys)];
    const outputs: SchedulerOutput[] = [];
    for (const schedulerKey of schedulerKeys) {
      const entry = this.entries.get(schedulerKey);
      if (entry === undefined) {
        outputs.push(this.noDataOutput(schedulerKey, DEFAULT_NO_DATA_REASON));
        continue;
      }
      if (change.providerRefetchRequired) {
        this.forceRefetch(entry);
      }
      outputs.push(this.outputForEntry(entry));
    }
    return outputs;
  }

  onOutputChanged(listener: (schedulerKey: SchedulerKey) => void): () => void {
    // Single-consumer model (the shell): a later registration replaces the prior listener. The entries'
    // `notifyOutputChanged` closures read this slot lazily, so this works before or after `activate`.
    this.outputChangedListener = listener;
    return () => {
      if (this.outputChangedListener === listener) {
        this.outputChangedListener = undefined;
      }
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    const fibers: Fiber.RuntimeFiber<void, never>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.fiber !== undefined) {
        fibers.push(entry.fiber);
        delete entry.fiber;
      }
      entry.activeInstances.clear();
    }
    if (fibers.length > 0) {
      await this.runtime.runPromise(Fiber.interruptAll(fibers));
    }
    if (this.ownsRuntime) {
      await this.runtime.dispose();
    }
  }

  /** Ensures exactly one supervised poll fiber runs for an active key (structural single-flight). */
  private ensureFiber(entry: KeyEntry): void {
    if (this.shutdownRequested || entry.fiber !== undefined || entry.activeInstances.size === 0) {
      return;
    }
    // Serialization: capture any pending interrupt of a superseded fiber (from a deactivate or a
    // source-change re-fork) so the NEW fiber waits for it to COMPLETE before its first poll.
    const priorInterrupt = entry.interruptFiber;
    // The fiber owns two per-class back-off `Schedule` drivers for its whole lifetime.
    // Explicit loop: `pollWithBackoff` runs one poll and internally retries with
    // exponential/jittered/capped back-off while it keeps failing (resetting the drivers on recovery);
    // `healthyWait` then owns the healthy-cadence sleep — jittered (0-20%), rescheduling on a settings
    // change, and racing a manual-refresh wake. The external `Schedule.fixed` is retired.
    const loop = Effect.gen(function* () {
      // Block the first poll on the prior fiber's interrupt fully completing (its in-flight
      // fetch aborted, finalizers run), so a deactivate(last)->reactivate-same-key transition — or a
      // source-change re-fork — never runs two concurrent same-key fetches (<=1 in-flight always).
      if (priorInterrupt !== undefined) {
        yield* Fiber.await(priorInterrupt);
        if (entry.interruptFiber === priorInterrupt) {
          delete entry.interruptFiber;
        }
      }
      const transientDriver = yield* Schedule.driver(TRANSIENT_DELAY_SCHEDULE);
      const rateLimitDriver = yield* Schedule.driver(RATE_LIMIT_DELAY_SCHEDULE);
      while (true) {
        // A poll is starting: no healthy sleep is armed.
        delete entry.nextHealthyPollAtEpochMs;
        yield* pollWithBackoff(entry, transientDriver, rateLimitDriver);
        yield* healthyWait(entry);
      }
    });
    entry.fiber = this.runtime.runFork(Effect.asVoid(loop));
  }

  private interruptFiber(entry: KeyEntry): void {
    const fiber = entry.fiber;
    // A superseded fiber leaves no armed healthy sleep / next-poll behind.
    if (entry.healthyWake !== undefined) {
      delete entry.healthyWake;
    }
    if (entry.nextHealthyPollAtEpochMs !== undefined) {
      delete entry.nextHealthyPollAtEpochMs;
    }
    if (fiber === undefined) {
      return;
    }
    delete entry.fiber;
    // Track the interrupt fiber. `Fiber.interrupt` cancels the fiber's in-flight fetch (the
    // adapter Effect is interruptible) AND completes only after all finalizers run — so a re-fork that
    // awaits this is guaranteed the old fetch is fully torn down before it polls. Forking keeps the
    // caller (deactivate / settings-change) synchronous.
    entry.interruptFiber = this.runtime.runFork(Fiber.interrupt(fiber));
  }

  /**
   * Forces an immediate refetch for a key on a true credential/source/settings change. Drops the
   * retained snapshot + last failure + active
   * back-off (a retained value may belong to a superseded credential/profile/source and must not be
   * shown), then interrupts and re-forks the fiber: a fresh fiber has fresh back-off drivers (RESET)
   * and polls immediately (BYPASS the active back-off). The re-fork is serialized on the interrupt,
   * preserving single-flight across the transition.
   */
  private forceRefetch(entry: KeyEntry): void {
    this.runtime.runSync(Ref.update(entry.state, clearForSourceChange));
    this.interruptFiber(entry);
    this.ensureFiber(entry);
  }

  /**
   * Reschedules the running fiber's healthy cadence to the new interval WITHOUT polling.
   * If the fiber is currently in a healthy sleep, completing its wake with `reschedule` re-arms that
   * sleep at the (already-updated) `entry.refreshIntervalSeconds`. If it is polling or backing off,
   * this is a no-op and the next healthy sleep reads the new interval — either way the cadence
   * changes without a provider fetch and without bypassing any active back-off.
   */
  private signalReschedule(entry: KeyEntry): void {
    const wake = entry.healthyWake;
    if (wake !== undefined) {
      this.runtime.runSync(Deferred.succeed(wake, "reschedule"));
    }
  }

  private outputForEntry(entry: KeyEntry): SchedulerOutput {
    const poll = this.runtime.runSync(Ref.get(entry.state));
    const now = this.runtime.runSync(Clock.currentTimeMillis);
    return deriveOutput(entry, poll, now);
  }

  private noDataOutput(schedulerKey: SchedulerKey, reasonCode: string): SchedulerOutput {
    return {
      schedulerKey,
      displayState: "no-data-yet",
      refreshIntervalSeconds: REFRESH_INTERVAL_DEFAULT_SECONDS,
      activeRefCount: 0,
      inFlight: false,
      failure: createNoDataFailure(reasonCode),
    };
  }
}

/**
 * Runs one poll attempt for a key: marks the key in-flight, runs the Effect fetch, and
 * applies the outcome to the per-key `Ref`. It catches BOTH the typed failure channel AND a DEFECT
 * (a die, e.g. a throwing `normalize` escaping the adapter Effect): a die is sanitized to an unknown
 * failure at the scheduler boundary, with NO raw `Cause`/secret — so a defect is handled
 * exactly like a failure (retain stale +
 * surface + back off + keep polling) and can NEVER strand the key at `inFlight:true`/dead fiber.
 * Interruption (deactivate) is NOT caught — it propagates so the fiber stops —
 * and the `onInterrupt` handler clears the in-flight flag. Returns the loop's next {@link PollDecision}.
 */
/**
 * Fires the fire-and-forget output-change notification for a key from inside the poll fiber.
 * Runs as an `Effect.sync` step so it is non-blocking and never suspends the fiber; the listener MUST NOT
 * do synchronous scheduler-runtime work (the shell defers its render one microtask so no re-entrancy
 * occurs on the fiber's stack). A listener throw is swallowed so a misbehaving consumer can never turn
 * into a poll-fiber defect and strand the key. The listener receives only the plain key — no snapshot,
 * failure, or `Cause`.
 */
function fireOutputChanged(entry: KeyEntry): Effect.Effect<void, never, never> {
  return Effect.sync(() => {
    try {
      entry.notifyOutputChanged();
    } catch {
      // A listener error must never break the poll loop.
    }
  });
}

function pollAttempt(entry: KeyEntry): Effect.Effect<PollDecision, never, never> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(entry.state);
    yield* Ref.update(entry.state, (state) => ({ ...state, inFlight: true, lastPollAtEpochMs: now }));
    const request: SchedulerFetchRequest = {
      schedulerKey: entry.schedulerKey,
      key: entry.schedulerKey,
      keyParts: entry.keyParts,
      trigger: "healthy-poll",
      startedAtEpochMs: now,
      signal: INERT_ABORT_SIGNAL,
      ...(previous.trustedSnapshot === undefined ? {} : { previousSnapshot: previous.trustedSnapshot }),
    };
    const outcome: FetchOutcome = yield* entry.fetch(request).pipe(
      Effect.map((snapshot): FetchOutcome => ({ ok: true as const, snapshot })),
      Effect.catchAll((failure): Effect.Effect<FetchOutcome> => Effect.succeed({ ok: false as const, ...failure })),
      Effect.catchAllDefect((): Effect.Effect<FetchOutcome> => Effect.succeed({ ok: false as const, failure: schedulerDefectFailure() })),
    );
    yield* Ref.update(entry.state, (state) => applyPollOutcome(state, outcome));
    // The poll SETTLED (success value, failure, or sanitized defect): notify so the shell re-renders this
    // key the instant the fetch resolves — a background poll OR a manual-refresh poll — instead of waiting
    // for the periodic render tick.
    yield* fireOutputChanged(entry);
    return decisionFor(outcome);
  }).pipe(
    // On interruption (deactivate) the post-fetch Ref update never runs; clear the in-flight
    // flag so a later read (e.g. a retained-but-deactivated key) does not report a phantom fetch.
    Effect.onInterrupt(() => Ref.update(entry.state, (state) => (state.inFlight ? { ...state, inFlight: false } : state))),
  );
}

/**
 * The per-key poll loop body. Runs one {@link pollAttempt}; on a successful or
 * non-retryable poll it resets the back-off drivers and returns, letting the outer
 * `Schedule.fixed(interval)` space the next poll at the healthy cadence. On a transient/rate-limit
 * failure it computes the next back-off delay from that class's `Schedule` driver, sleeps it on the
 * Effect `Clock`, and re-attempts — so a persistently failing key keeps backing off (30s->...->cap)
 * instead of hammering at the healthy interval, and the FIRST poll after recovery resets to the base.
 */
function pollWithBackoff(
  entry: KeyEntry,
  transientDriver: Schedule.ScheduleDriver<Duration.Duration>,
  rateLimitDriver: Schedule.ScheduleDriver<Duration.Duration>,
): Effect.Effect<void, never, never> {
  const step = (attempt: number): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const decision = yield* pollAttempt(entry);
      if (decision.kind === "success") {
        // Recovery: reset back-off to the base delay for the next failure cycle.
        yield* transientDriver.reset;
        yield* rateLimitDriver.reset;
        return;
      }
      if (decision.kind === "no-backoff") {
        // A non-retryable failure (e.g. missing credentials): surface it and resume healthy cadence.
        yield* transientDriver.reset;
        yield* rateLimitDriver.reset;
        yield* Ref.update(entry.state, clearActiveBackoff);
        // If a prior back-off was showing, it just cleared — notify so the shell drops the backing-off
        // detail promptly (the poll-settle notify above already surfaced the failure).
        yield* fireOutputChanged(entry);
        return;
      }
      const nextAttempt = attempt + 1;
      const delayMs = yield* computeBackoffDelay(entry, decision, nextAttempt, transientDriver, rateLimitDriver);
      yield* Effect.sleep(Duration.millis(delayMs));
      yield* step(nextAttempt);
    });
  return step(0);
}

/**
 * The healthy-cadence wait between successful polls. Publishes a per-cycle wake `Deferred`
 * on the entry, computes ONE jittered healthy delay from the CURRENT `entry.refreshIntervalSeconds`
 * (so a settings reschedule is picked up without re-forking), records the actual armed next-poll time,
 * and `Effect.race`s the sleep against the wake:
 *   - the sleep elapses  -> resume the healthy cadence (return to the poll loop);
 *   - `refresh` completes it with `poll`      -> poll NOW (return to the poll loop early);
 *   - a settings change completes it with `reschedule` -> re-arm the sleep at the new interval WITHOUT
 *     polling (recurse), so a refresh-policy change reschedules the running fiber.
 * The wake `Deferred` is published ONLY for the duration of this sleep, so a bare manual refresh that
 * arrives during a poll or a failure back-off finds no wake and is a no-op (respects back-off / joins
 * the in-flight poll). Jitter draws from the Effect `Random` service (live in production; seeded in
 * tests), and the sleep runs on the Effect `Clock` (deterministic under `TestClock`).
 */
function healthyWait(entry: KeyEntry): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const wake = yield* Deferred.make<HealthyWake>();
    entry.healthyWake = wake;
    const intervalMs = entry.refreshIntervalSeconds * 1_000;
    const driver = yield* Schedule.driver(healthyDelaySchedule(intervalMs));
    // The back-off schedules are finite-free; the healthy schedule likewise never legitimately halts.
    const delay = yield* Effect.orDie(driver.next(undefined));
    const delayMs = Math.round(Duration.toMillis(delay));
    const now = yield* Clock.currentTimeMillis;
    entry.nextHealthyPollAtEpochMs = now + delayMs;
    const outcome = yield* Effect.race(
      Effect.as(Effect.sleep(Duration.millis(delayMs)), "elapsed" as const),
      Deferred.await(wake),
    );
    if (outcome === "reschedule") {
      // Re-arm at the (already-updated) interval without polling; the recursion re-publishes the wake.
      yield* healthyWait(entry);
      return;
    }
    // `poll` (manual refresh) or `elapsed` (interval fired): resume polling; unpublish the spent wake.
    if (entry.healthyWake === wake) {
      delete entry.healthyWake;
    }
  });
}

/**
 * Computes and records the next back-off delay for a failing poll. The delay comes from
 * the failure class's Effect `Schedule` driver (exponential -> jitter -> cap); a rate-limit failure
 * carrying a sanitized `Retry-After` uses that value instead (capped at the 1h policy maximum),
 * overriding the exponential for that attempt. The delay is read WITHOUT sleeping (the driver's own
 * sleep is dropped) and rounded so the reported `delayMs` equals the delay the loop then sleeps.
 * Writes `activeBackoff` to the `Ref` BEFORE the sleep so a read during back-off surfaces it.
 */
function computeBackoffDelay(
  entry: KeyEntry,
  decision: Extract<PollDecision, { readonly kind: "backoff" }>,
  attempt: number,
  transientDriver: Schedule.ScheduleDriver<Duration.Duration>,
  rateLimitDriver: Schedule.ScheduleDriver<Duration.Duration>,
): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const isRateLimit = decision.backoffClass === "rate-limit";
    const baseDelayMs = isRateLimit
      ? SCHEDULER_BACKOFF_POLICY.rateLimit.initialDelayMs
      : SCHEDULER_BACKOFF_POLICY.transient.initialDelayMs;
    const retryAfterMs = isRateLimit ? retryAfterDelayMs(decision.retryAfterSeconds) : undefined;

    let delayMs: number;
    let retryAfterApplied = false;
    if (retryAfterMs !== undefined) {
      delayMs = retryAfterMs;
      retryAfterApplied = true;
    } else {
      // `Effect.orDie`: the back-off schedules are infinite, so the driver never legitimately halts;
      // a halt would be a defect, not a normal outcome.
      const delay = yield* Effect.orDie((isRateLimit ? rateLimitDriver : transientDriver).next(undefined));
      delayMs = Math.round(Duration.toMillis(delay));
    }

    const backoff: SchedulerBackoffOutput = {
      class: decision.backoffClass,
      attempt,
      baseDelayMs,
      delayMs,
      nextRetryAtEpochMs: now + delayMs,
      ...(retryAfterApplied ? { retryAfterApplied: true } : {}),
    };
    yield* Ref.update(entry.state, (state) => ({ ...state, activeBackoff: backoff }));
    // The back-off detail (class/attempt/next-retry) just entered the output; notify so the shell shows
    // the backing-off state promptly rather than on the next render tick.
    yield* fireOutputChanged(entry);
    return delayMs;
  });
}

/** Maps a poll outcome to the loop's next action, consuming the shared error taxonomy's retry class. */
function decisionFor(outcome: FetchOutcome): PollDecision {
  if (outcome.ok) {
    return { kind: "success" };
  }
  const backoffClass = backoffClassForFailure(outcome.failure);
  if (backoffClass === undefined) {
    return { kind: "no-backoff" };
  }
  return {
    kind: "backoff",
    backoffClass,
    ...(backoffClass === "rate-limit" && outcome.retry?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: outcome.retry.retryAfterSeconds }
      : {}),
  };
}

/**
 * Classifies a sanitized failure into a back-off class by REUSING the shared error taxonomy's
 * `retryClass` (no scheduler-local taxonomy): `transient-retry` -> transient, `rate-limit-backoff`
 * -> rate-limit (validation-drift already maps to `rate-limit-backoff` in `@ai-workbench/errors`).
 * Every other class (credential/settings refresh, no-retry, healthy-poll, probe-gated) is not a
 * failure back-off and returns `undefined`, so the key resumes the healthy poll cadence.
 */
function backoffClassForFailure(failure: SanitizedFailure): SchedulerBackoffClass | undefined {
  switch (failure.retryClass) {
    case "transient-retry":
      return "transient";
    case "rate-limit-backoff":
      return "rate-limit";
    default:
      return undefined;
  }
}

/** A sanitized provider `Retry-After` in milliseconds, capped at the 1h policy maximum; `undefined`
 * when absent or not a positive finite value (so the exponential back-off applies instead). */
function retryAfterDelayMs(retryAfterSeconds: number | undefined): number | undefined {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return undefined;
  }
  return Math.min(Math.trunc(retryAfterSeconds * 1_000), SCHEDULER_BACKOFF_POLICY.rateLimit.maxRetryAfterMs);
}

/**
 * The sanitized failure a poll DEFECT (a die) maps to: an unknown sanitized
 * failure at the scheduler boundary with NO raw `Cause`/secret. Its
 * `unknown-sanitized-failure` category classifies as a transient
 * retry, so a defecting adapter backs off and keeps polling rather than killing the key's fiber.
 */
function schedulerDefectFailure(): SanitizedFailure {
  return createSanitizedFailure({
    category: "unknown-sanitized-failure",
    diagnostics: {
      boundary: "scheduler",
      issueCount: 1,
      reasonCode: "scheduler-poll-defect",
    },
    provider: {
      failureClass: "unknown",
      reasonCode: "scheduler-poll-defect",
    },
  });
}

/** Drops the active back-off from the state (exactOptionalPropertyTypes-safe) when it no longer applies. */
function clearActiveBackoff(state: KeyPollState): KeyPollState {
  if (state.activeBackoff === undefined) {
    return state;
  }
  const { activeBackoff: _removed, ...rest } = state;
  return rest;
}

/**
 * Resets a key's state for a credential/source change. Drops the
 * retained trusted snapshot, the last failure, the active back-off, and the last-poll timestamp so a
 * value from a superseded credential/profile/source is never rendered (even as stale) and the forced
 * refetch starts from a clean slate. Preserves nothing but the not-in-flight marker.
 */
function clearForSourceChange(_state: KeyPollState): KeyPollState {
  return { inFlight: false };
}

/**
 * Applies a poll outcome to the per-key state. On success, adopts the new snapshot ONLY when it
 * is strictly newer than the retained snapshot (cache arbitration preserved), clears the last
 * failure, and clears any active back-off (recovery). On failure, retains the last snapshot,
 * surfaces the sanitized failure, and preserves the active back-off (the loop's
 * `computeBackoffDelay` overwrites it with the new delay for a retryable failure).
 */
function applyPollOutcome(state: KeyPollState, outcome: FetchOutcome): KeyPollState {
  if (outcome.ok) {
    const incoming = outcome.snapshot;
    const retained = state.trustedSnapshot;
    const adopted = retained === undefined || incoming.fetchedAtEpochMs > retained.fetchedAtEpochMs ? incoming : retained;
    return {
      inFlight: false,
      trustedSnapshot: adopted,
      ...(state.lastPollAtEpochMs === undefined ? {} : { lastPollAtEpochMs: state.lastPollAtEpochMs }),
    };
  }
  return {
    inFlight: false,
    lastFailure: outcome.failure,
    ...(state.trustedSnapshot === undefined ? {} : { trustedSnapshot: state.trustedSnapshot }),
    ...(state.lastPollAtEpochMs === undefined ? {} : { lastPollAtEpochMs: state.lastPollAtEpochMs }),
    ...(state.activeBackoff === undefined ? {} : { activeBackoff: state.activeBackoff }),
  };
}

/**
 * Derives the public `SchedulerOutput` from per-key state at read time. Staleness/expiry/display
 * arbitration is preserved EXACTLY: retained-then-expired at 24h, refresh-failed
 * stale when a failure is retained over a snapshot, age-stale beyond 2x the refresh interval, then
 * fresh; failure-only and no-data states otherwise.
 */
function deriveOutput(entry: KeyEntry, poll: KeyPollState, now: number): SchedulerOutput {
  const common = {
    schedulerKey: entry.schedulerKey,
    refreshIntervalSeconds: entry.refreshIntervalSeconds,
    activeRefCount: entry.activeInstances.size,
    inFlight: poll.inFlight,
  };
  const scheduling = schedulingOutput(entry, poll);
  const snapshot = poll.trustedSnapshot;

  if (snapshot !== undefined) {
    const ageMs = now - snapshot.fetchedAtEpochMs;
    if (ageMs > SCHEDULER_BACKOFF_POLICY.stale.maxDisplayMs) {
      return {
        ...common,
        displayState: "no-data-yet",
        failure: createNoDataFailure("stale-cache-expired"),
        ...scheduling,
      };
    }

    if (poll.lastFailure !== undefined) {
      return {
        ...common,
        displayState: "stale",
        snapshot,
        failure: poll.lastFailure,
        staleReason: "refresh-failed",
        ...scheduling,
      };
    }

    if (ageMs > entry.refreshIntervalSeconds * 1_000 * SCHEDULER_BACKOFF_POLICY.stale.ageMultiplier) {
      return {
        ...common,
        displayState: "stale",
        snapshot,
        failure: createStaleFailure("snapshot-age-stale"),
        staleReason: "age-stale",
        ...scheduling,
      };
    }

    return {
      ...common,
      displayState: "fresh",
      snapshot,
      ...scheduling,
    };
  }

  if (poll.lastFailure !== undefined) {
    return {
      ...common,
      displayState: poll.lastFailure.displayState,
      failure: poll.lastFailure,
      ...scheduling,
    };
  }

  return {
    ...common,
    displayState: "no-data-yet",
    failure: createNoDataFailure("no-current-data"),
    ...scheduling,
  };
}

/**
 * Scheduling output for a key. While a failure back-off is active it surfaces the
 * back-off detail and the next allowed retry time (the display shows the back-off, not a healthy
 * poll). Otherwise it reports the next healthy poll time for an actively-polling key.
 */
function schedulingOutput(
  entry: KeyEntry,
  poll: KeyPollState,
): {
  readonly backoff?: SchedulerBackoffOutput;
  readonly nextAllowedRetryAtEpochMs?: number;
  readonly nextHealthyPollAtEpochMs?: number;
} {
  if (poll.activeBackoff !== undefined) {
    return { backoff: poll.activeBackoff, nextAllowedRetryAtEpochMs: poll.activeBackoff.nextRetryAtEpochMs };
  }
  // The actual jittered next-poll time recorded by the fiber when it armed the healthy sleep —
  // reported only while a healthy sleep is armed for an actively-polling key, so a poll
  // in progress or a deactivated key reports no upcoming healthy poll.
  if (entry.fiber !== undefined && entry.activeInstances.size > 0 && entry.nextHealthyPollAtEpochMs !== undefined) {
    return { nextHealthyPollAtEpochMs: entry.nextHealthyPollAtEpochMs };
  }
  return {};
}

function createNoDataFailure(reasonCode: string): SanitizedFailure {
  return createSanitizedFailure({
    category: "no-data-yet",
    diagnostics: {
      boundary: "scheduler",
      reasonCode,
    },
  });
}

function createStaleFailure(reasonCode: string): SanitizedFailure {
  return createSanitizedFailure({
    category: "stale-cached-value",
    diagnostics: {
      boundary: "scheduler",
      reasonCode,
    },
  });
}
