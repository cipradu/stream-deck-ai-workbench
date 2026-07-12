import {
  serializeRateLimitScope,
  serializeSourceRequestIdentity,
  type SourceRequestIdentityInput,
} from "@ai-workbench/contracts";
import { createSanitizedFailure, type SanitizedFailure } from "@ai-workbench/errors";
import { Context, Deferred, Duration, Effect, Layer, Ref, Schedule, Scope } from "effect";

import { RATE_LIMIT_DELAY_SCHEDULE, retryAfterDelayMs } from "./scheduler-policy.js";

export interface GovernorBlocked {
  readonly _tag: "GovernorBlocked";
  readonly failure: SanitizedFailure;
  readonly retryAfterSeconds?: number;
}

export interface GovernorRateLimitNotice {
  readonly retryAfterSeconds?: number;
}

export type GovernorSourceSettlement =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed" }
  | { readonly kind: "cancelled" };

export interface GovernorAttemptPermit {
  readonly release: () => Effect.Effect<void>;
}

export interface GovernorSourceLease {
  readonly acquireAttempt: () => Effect.Effect<GovernorAttemptPermit, GovernorBlocked, Scope.Scope>;
  readonly reportRateLimit: (notice: GovernorRateLimitNotice) => Effect.Effect<void>;
  readonly settle: (settlement: GovernorSourceSettlement) => Effect.Effect<void>;
}

export interface CredentialProfileReference {
  readonly credentialProfileId: string;
}

export interface ProviderRequestGovernorDiagnostics {
  readonly stopped: boolean;
  readonly activeSourceCount: number;
  readonly queuedSourceCount: number;
  readonly activeAttemptCount: number;
}

export interface ProviderRequestGovernorService {
  readonly acquireSource: (identity: SourceRequestIdentityInput) => Effect.Effect<GovernorSourceLease, GovernorBlocked, Scope.Scope>;
  readonly credentialGenerationFor: (profile: CredentialProfileReference) => Effect.Effect<number>;
  readonly advanceCredentialGeneration: (profile: CredentialProfileReference) => Effect.Effect<number>;
  readonly diagnostics: () => Effect.Effect<ProviderRequestGovernorDiagnostics>;
  readonly shutdown: () => Effect.Effect<void>;
}

export const ProviderRequestGovernor = Context.GenericTag<ProviderRequestGovernorService>("@ai-workbench/scheduler/ProviderRequestGovernor");

interface GovernorRecord {
  readonly scopeKey: string;
  attemptInFlight: boolean;
  rateLimitReported: boolean;
  settled: boolean;
  attemptWake: Deferred.Deferred<void>;
}

interface ScopeState {
  readonly queue: readonly GovernorRecord[];
  readonly wake: Deferred.Deferred<void>;
  readonly active: GovernorRecord | undefined;
  readonly blockedUntilEpochMs?: number;
  readonly lastAttemptStartedAtEpochMs?: number;
  readonly rateLimitDelayDriver?: Schedule.ScheduleDriver<Duration.Duration>;
}

interface GovernorState {
  readonly stopped: boolean;
  readonly credentialGenerations: ReadonlyMap<string, number>;
  readonly scopes: ReadonlyMap<string, ScopeState>;
}

type SourceAdmissionDecision =
  | { readonly kind: "start" }
  | { readonly kind: "wait"; readonly wake: Deferred.Deferred<void> }
  | { readonly kind: "stopped" };

type EnqueueDecision =
  | { readonly kind: "accepted" }
  | { readonly kind: "queue-full" }
  | { readonly kind: "stopped" };

type AttemptDecision =
  | { readonly kind: "start" }
  | { readonly kind: "wait"; readonly wake: Deferred.Deferred<void>; readonly delayMs?: number }
  | { readonly kind: "cooldown"; readonly retryAfterSeconds: number }
  | { readonly kind: "stopped" };

interface SettlementDecision {
  readonly sourceWake: Deferred.Deferred<void> | undefined;
  readonly attemptWake: Deferred.Deferred<void> | undefined;
  readonly rateLimitDelayDriver: Schedule.ScheduleDriver<Duration.Duration> | undefined;
}

const MINIMUM_INTER_START_MS = 1_000;
const MAXIMUM_QUEUED_DISTINCT_RECORDS = 16;

const governorStoppedFailure = (): GovernorBlocked => ({
  _tag: "GovernorBlocked",
  failure: createSanitizedFailure({
    category: "abort",
    diagnostics: {
      boundary: "provider-request-governor",
      reasonCode: "governor-shut-down",
    },
  }),
});

const governorQueueFullFailure = (): GovernorBlocked => ({
  _tag: "GovernorBlocked",
  failure: createSanitizedFailure({
    category: "provider-unavailable",
    diagnostics: {
      boundary: "provider-request-governor",
      reasonCode: "governor-queue-full",
    },
    provider: {
      failureClass: "provider-unavailable",
      reasonCode: "governor-queue-full",
    },
  }),
});

const governorCooldownFailure = (retryAfterSeconds: number): GovernorBlocked => ({
  _tag: "GovernorBlocked",
  failure: createSanitizedFailure({
    category: "rate-limited",
    diagnostics: {
      boundary: "provider-request-governor",
      reasonCode: "governor-cooldown",
    },
  }),
  retryAfterSeconds,
});

export const makeProviderRequestGovernor: Effect.Effect<ProviderRequestGovernorService, never, Scope.Scope> = Effect.gen(function* () {
  const state = yield* Ref.make<GovernorState>({
    stopped: false,
    credentialGenerations: new Map(),
    scopes: new Map(),
  });
  const service = new RuntimeProviderRequestGovernor(state);
  yield* Effect.addFinalizer(() => service.shutdown());
  return service;
});

export const ProviderRequestGovernorLive = Layer.scoped(ProviderRequestGovernor, makeProviderRequestGovernor);

class RuntimeProviderRequestGovernor implements ProviderRequestGovernorService {
  constructor(private readonly state: Ref.Ref<GovernorState>) {}

  acquireSource = (identity: SourceRequestIdentityInput): Effect.Effect<GovernorSourceLease, GovernorBlocked, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const scopeKey = serializeRateLimitScope(identity.rateLimitScope);
        serializeSourceRequestIdentity(identity);
        const record: GovernorRecord = {
          scopeKey,
          attemptInFlight: false,
          rateLimitReported: false,
          settled: false,
          attemptWake: yield* Deferred.make<void>(),
        };
        const admission = yield* this.enqueue(record);
        if (admission.kind === "queue-full") {
          return yield* Effect.fail(governorQueueFullFailure());
        }
        if (admission.kind === "stopped") {
          return yield* Effect.fail(governorStoppedFailure());
        }
        yield* restore(this.awaitSourceStart(record)).pipe(Effect.onInterrupt(() => this.settle(record, { kind: "cancelled" })));
        yield* Effect.addFinalizer(() => this.settle(record, { kind: "cancelled" }));
        return this.makeLease(record);
      }),
    );

  credentialGenerationFor = (profile: CredentialProfileReference): Effect.Effect<number> =>
    Ref.modify(this.state, (state) => {
      const generation = state.credentialGenerations.get(profile.credentialProfileId) ?? 0;
      return [generation, state];
    });

  advanceCredentialGeneration = (profile: CredentialProfileReference): Effect.Effect<number> =>
    Ref.modify(this.state, (state) => {
      const generations = new Map(state.credentialGenerations);
      const nextGeneration = (generations.get(profile.credentialProfileId) ?? 0) + 1;
      generations.set(profile.credentialProfileId, nextGeneration);
      return [nextGeneration, { ...state, credentialGenerations: generations }];
    });

  diagnostics = (): Effect.Effect<ProviderRequestGovernorDiagnostics> =>
    Ref.get(this.state).pipe(
      Effect.map((state) => ({
        stopped: state.stopped,
        activeSourceCount: [...state.scopes.values()].reduce((count, scope) => count + (scope.active === undefined ? 0 : 1), 0),
        queuedSourceCount: [...state.scopes.values()].reduce((count, scope) => count + scope.queue.length, 0),
        activeAttemptCount: [...state.scopes.values()].reduce((count, scope) => count + (scope.active?.attemptInFlight === true ? 1 : 0), 0),
      })),
    );

  shutdown = (): Effect.Effect<void> =>
    Effect.gen(this, function* () {
      const wakes = yield* Ref.modify(this.state, (state): readonly [readonly Deferred.Deferred<void>[], GovernorState] => {
        if (state.stopped) {
          return [[], state];
        }
        const wakes = [...state.scopes.values()].flatMap((scope) => [
          scope.wake,
          ...(scope.active === undefined ? [] : [scope.active.attemptWake]),
        ]);
        return [wakes, { ...state, stopped: true, scopes: new Map() }];
      });
      for (const wake of wakes) {
        yield* Deferred.succeed(wake, undefined);
      }
    });

  private makeLease(record: GovernorRecord): GovernorSourceLease {
    return {
      acquireAttempt: () => this.acquireAttempt(record),
      reportRateLimit: (notice) => this.reportRateLimit(record, notice),
      settle: (settlement) => this.settle(record, settlement),
    };
  }

  private enqueue(record: GovernorRecord): Effect.Effect<EnqueueDecision> {
    return Effect.gen(this, function* () {
      const wake = yield* Deferred.make<void>();
      return yield* Ref.modify(this.state, (state): readonly [EnqueueDecision, GovernorState] => {
        if (state.stopped) {
          return [{ kind: "stopped" }, state];
        }
        const scopes = new Map(state.scopes);
        const current = scopes.get(record.scopeKey);
        const scope: ScopeState = current ?? { active: undefined, queue: [], wake };
        const queuedCount = scope.active === undefined ? Math.max(0, scope.queue.length - 1) : scope.queue.length;
        if (queuedCount >= MAXIMUM_QUEUED_DISTINCT_RECORDS) {
          return [{ kind: "queue-full" }, state];
        }
        scopes.set(record.scopeKey, { ...scope, queue: [...scope.queue, record] });
        return [{ kind: "accepted" }, { ...state, scopes }];
      });
    });
  }

  private awaitSourceStart(record: GovernorRecord): Effect.Effect<void, GovernorBlocked> {
    const waitForStart = (): Effect.Effect<void, GovernorBlocked> =>
      Effect.gen(this, function* () {
        const decision = yield* Ref.modify(this.state, (state): readonly [SourceAdmissionDecision, GovernorState] => {
          const scope = state.scopes.get(record.scopeKey);
          if (state.stopped || scope === undefined || !scope.queue.includes(record)) {
            return [{ kind: "stopped" }, state];
          }
          if (scope.active !== undefined || scope.queue[0] !== record) {
            return [{ kind: "wait", wake: scope.wake }, state];
          }
          const scopes = new Map(state.scopes);
          scopes.set(record.scopeKey, { ...scope, active: record, queue: scope.queue.slice(1) });
          return [{ kind: "start" }, { ...state, scopes }];
        });
        if (decision.kind === "start") {
          return;
        }
        if (decision.kind === "stopped") {
          return yield* Effect.fail(governorStoppedFailure());
        }
        yield* Deferred.await(decision.wake);
        return yield* waitForStart();
      });
    return waitForStart();
  }

  private acquireAttempt(record: GovernorRecord): Effect.Effect<GovernorAttemptPermit, GovernorBlocked, Scope.Scope> {
    const acquire = (): Effect.Effect<GovernorAttemptPermit, GovernorBlocked, Scope.Scope> =>
      Effect.gen(this, function* () {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const decision = yield* Ref.modify(this.state, (state): readonly [AttemptDecision, GovernorState] => {
          const scope = state.scopes.get(record.scopeKey);
          if (state.stopped || scope?.active !== record || record.settled) {
            return [{ kind: "stopped" }, state];
          }
          if (record.rateLimitReported || (scope.blockedUntilEpochMs ?? 0) > now) {
            const blockedUntilEpochMs = scope.blockedUntilEpochMs ?? now;
            return [{ kind: "cooldown", retryAfterSeconds: Math.max(1, Math.ceil((blockedUntilEpochMs - now) / 1_000)) }, state];
          }
          if (record.attemptInFlight) {
            return [{ kind: "wait", wake: record.attemptWake }, state];
          }
          const spacingAllowedAt = (scope.lastAttemptStartedAtEpochMs ?? now - MINIMUM_INTER_START_MS) + MINIMUM_INTER_START_MS;
          if (now < spacingAllowedAt) {
            return [{ kind: "wait", wake: scope.wake, delayMs: spacingAllowedAt - now }, state];
          }
          record.attemptInFlight = true;
          const scopes = new Map(state.scopes);
          scopes.set(record.scopeKey, { ...scope, lastAttemptStartedAtEpochMs: now });
          return [{ kind: "start" }, { ...state, scopes }];
        });
        if (decision.kind === "start") {
          yield* Effect.addFinalizer(() => this.releaseAttempt(record));
          return { release: () => this.releaseAttempt(record) };
        }
        if (decision.kind === "stopped") {
          return yield* Effect.fail(governorStoppedFailure());
        }
        if (decision.kind === "cooldown") {
          return yield* Effect.fail(governorCooldownFailure(decision.retryAfterSeconds));
        }
        if (decision.delayMs === undefined) {
          yield* Deferred.await(decision.wake);
        } else {
          yield* Effect.sleep(Duration.millis(decision.delayMs));
        }
        return yield* acquire();
      });
    return acquire();
  }

  private releaseAttempt(record: GovernorRecord): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const nextWake = yield* Deferred.make<void>();
      const wake = yield* Ref.modify(this.state, (state): readonly [Deferred.Deferred<void> | undefined, GovernorState] => {
        const scope = state.scopes.get(record.scopeKey);
        if (scope?.active !== record || !record.attemptInFlight) {
          return [undefined, state];
        }
        const currentWake = record.attemptWake;
        record.attemptInFlight = false;
        record.attemptWake = nextWake;
        return [currentWake, state];
      });
      if (wake !== undefined) {
        yield* Deferred.succeed(wake, undefined);
      }
    });
  }

  private reportRateLimit(record: GovernorRecord, notice: GovernorRateLimitNotice): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const shouldApply = yield* Ref.modify(this.state, (state): readonly [boolean, GovernorState] => {
        const scope = state.scopes.get(record.scopeKey);
        if (state.stopped || scope?.active !== record || record.settled || record.rateLimitReported) {
          return [false, state];
        }
        record.rateLimitReported = true;
        return [true, state];
      });
      if (!shouldApply) {
        return;
      }
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const retryAfterMs = retryAfterDelayMs(notice.retryAfterSeconds);
      const scope = yield* Ref.get(this.state).pipe(Effect.map((state) => state.scopes.get(record.scopeKey)));
      if (scope === undefined || scope.active !== record) {
        return;
      }
      let rateLimitDelayDriver = scope.rateLimitDelayDriver;
      const delayMs = retryAfterMs ?? Math.round(Duration.toMillis(yield* Effect.orDie((rateLimitDelayDriver ??= yield* Schedule.driver(RATE_LIMIT_DELAY_SCHEDULE)).next(undefined))));
      yield* Ref.update(this.state, (state) => {
        const current = state.scopes.get(record.scopeKey);
        if (state.stopped || current?.active !== record) {
          return state;
        }
        const scopes = new Map(state.scopes);
        scopes.set(record.scopeKey, {
          ...current,
          blockedUntilEpochMs: Math.max(current.blockedUntilEpochMs ?? 0, now + delayMs),
          ...(retryAfterMs === undefined && current.rateLimitDelayDriver === undefined && rateLimitDelayDriver !== undefined
            ? { rateLimitDelayDriver }
            : {}),
        });
        return { ...state, scopes };
      });
    });
  }

  private settle(record: GovernorRecord, settlement: GovernorSourceSettlement): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const nextWake = yield* Deferred.make<void>();
      const settled = yield* Ref.modify(this.state, (state): readonly [SettlementDecision, GovernorState] => {
        if (record.settled) {
          return [{ sourceWake: undefined, attemptWake: undefined, rateLimitDelayDriver: undefined }, state];
        }
        record.settled = true;
        const scope = state.scopes.get(record.scopeKey);
        if (scope === undefined) {
          return [{ sourceWake: undefined, attemptWake: undefined, rateLimitDelayDriver: undefined }, state];
        }
        const wasActive = scope.active === record;
        const active = wasActive ? undefined : scope.active;
        const queue = scope.queue.filter((candidate) => candidate !== record);
        const sourceWake = scope.wake;
        const attemptWake = record.attemptInFlight ? record.attemptWake : undefined;
        record.attemptInFlight = false;
        record.attemptWake = nextWake;
        const scopes = new Map(state.scopes);
        if (settlement.kind === "succeeded" && wasActive && !record.rateLimitReported) {
          const { blockedUntilEpochMs: _blockedUntilEpochMs, rateLimitDelayDriver, ...withoutCooldown } = scope;
          scopes.set(record.scopeKey, { ...withoutCooldown, active, queue, wake: nextWake });
          return [{ sourceWake, attemptWake, rateLimitDelayDriver }, { ...state, scopes }];
        }
        scopes.set(record.scopeKey, { ...scope, active, queue, wake: nextWake });
        return [{ sourceWake, attemptWake, rateLimitDelayDriver: undefined }, { ...state, scopes }];
      });
      if (settled.rateLimitDelayDriver !== undefined) {
        yield* settled.rateLimitDelayDriver.reset;
      }
      if (settled.sourceWake !== undefined) {
        yield* Deferred.succeed(settled.sourceWake, undefined);
      }
      if (settled.attemptWake !== undefined) {
        yield* Deferred.succeed(settled.attemptWake, undefined);
      }
    });
  }
}

export const PROVIDER_REQUEST_GOVERNOR_POLICY = {
  minimumInterStartMs: MINIMUM_INTER_START_MS,
  maximumQueuedDistinctRecords: MAXIMUM_QUEUED_DISTINCT_RECORDS,
} as const;
