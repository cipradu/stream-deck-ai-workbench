import { Clock, Deferred, Duration, Effect, Ref, Scope } from "effect";

import type { UsageProviderLocalSourceReaders } from "../../../types.js";

type ClaudeLocalSource = NonNullable<UsageProviderLocalSourceReaders["claudeCode"]>;

export type ClaudeCredentialMaintenanceOutcome = "armed" | "renewed" | "not-advanced" | "refresh-failed" | "read-failed";

export interface ClaudeCredentialMaintenanceSubscription {
  readonly nextCheckAtEpochMs: number;
  readonly source: ClaudeLocalSource;
  readonly onOutcome?: (outcome: ClaudeCredentialMaintenanceOutcome) => Effect.Effect<void>;
}

interface MaintenanceState {
  readonly subscriptions: ReadonlyMap<symbol, ClaudeCredentialMaintenanceSubscription>;
  readonly wake: Deferred.Deferred<void>;
  readonly attemptedThroughExpiry: number;
  readonly running: Deferred.Deferred<void> | undefined;
}

/** One credential deadline shared by all Claude categories, outside transient HTTP source flights. */
export function makeClaudeCredentialMaintenance(lifetime: Scope.Scope) {
  return Effect.gen(function* () {
    const state = yield* Ref.make<MaintenanceState>({
      subscriptions: new Map(),
      wake: yield* Deferred.make<void>(),
      attemptedThroughExpiry: 0,
      running: undefined,
    });
    let lastArmedExpiry: number | undefined;

    const change = (update: (current: MaintenanceState) => MaintenanceState) => Effect.gen(function* () {
      const wake = yield* Deferred.make<void>();
      const previousWake = yield* Ref.modify(state, (current) => [current.wake, { ...update(current), wake }] as const);
      yield* Deferred.succeed(previousWake, undefined);
    });

    const renew = (expectedExpiry: number, subscription: ClaudeCredentialMaintenanceSubscription) =>
      readExpiry(subscription.source).pipe(Effect.flatMap((before) => Effect.uninterruptible(Effect.gen(function* () {
        // A peer CLI or a manual poll may have renewed since the deadline was armed.
        const now = yield* Clock.currentTimeMillis;
        const refresh = subscription.source.refreshCredential;
        if (before === undefined) {
          yield* notify(subscription, "read-failed");
          return false;
        }
        if (
          before !== expectedExpiry || before <= now || before - EARLY_RENEWAL_LEAD_MS > now || refresh === undefined
        ) {
          return true;
        }
        const running = yield* Deferred.make<void>();
        const claimed = yield* Ref.modify(state, (value) =>
          before <= value.attemptedThroughExpiry || ![...value.subscriptions.values()].some((entry) => entry.nextCheckAtEpochMs > now)
            ? [false, value] as const
            : [true, { ...value, attemptedThroughExpiry: before, running }] as const,
        );
        if (!claimed) {
          return false;
        }
        yield* Effect.gen(function* () {
          const completed = yield* Effect.tryPromise({
            try: () => refresh(),
            catch: () => undefined,
          }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
          const after = yield* readExpiry(subscription.source);
          const checkedAt = yield* Clock.currentTimeMillis;
          const outcome: ClaudeCredentialMaintenanceOutcome = after !== undefined && after > before && after > checkedAt
            ? "renewed"
            : !completed ? "refresh-failed"
            : after === undefined ? "read-failed" : "not-advanced";
          yield* notify(subscription, outcome);
        }).pipe(
          // Child output/errors never enter the Effect defect/log channel. The shell owns its bounded command and cleanup.
          Effect.catchAllDefect(() => Effect.void),
          Effect.ensuring(Ref.update(state, (value) => ({ ...value, running: undefined })).pipe(
            Effect.zipRight(Deferred.succeed(running, undefined)),
          )),
        );
        return true;
      }))));

    const cycle = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const subscriptions = [...current.subscriptions.values()];
      const subscription = subscriptions[0];
      if (subscription === undefined) {
        return yield* Deferred.await(current.wake);
      }
      const expiry = yield* readExpiry(subscription.source);
      const now = yield* Clock.currentTimeMillis;
      const nextCheck = Math.min(...subscriptions.map((entry) => entry.nextCheckAtEpochMs));
      if (
        expiry === undefined || expiry <= now || expiry <= current.attemptedThroughExpiry || nextCheck <= now ||
        nextCheck <= expiry - EARLY_RENEWAL_LEAD_MS
      ) {
        return yield* Deferred.await(current.wake);
      }
      const delay = expiry - EARLY_RENEWAL_LEAD_MS - now;
      if (lastArmedExpiry !== expiry) {
        lastArmedExpiry = expiry;
        yield* notify(subscription, "armed");
      }
      if (delay > 0) {
        return yield* Effect.race(Effect.sleep(Duration.millis(delay)), Deferred.await(current.wake));
      }
      if (!(yield* renew(expiry, subscription))) {
        yield* Deferred.await(current.wake);
      }
    });

    yield* Effect.forkIn(Effect.forever(cycle), lifetime);

    return (subscription: ClaudeCredentialMaintenanceSubscription): Effect.Effect<void, never, Scope.Scope> => {
      if (subscription.source.refreshCredential === undefined || !Number.isFinite(subscription.nextCheckAtEpochMs)) {
        return Effect.void;
      }
      return Effect.acquireRelease(
        Effect.gen(function* () {
          const id = Symbol();
          yield* change((current) => ({ ...current, subscriptions: new Map(current.subscriptions).set(id, subscription) }));
          return id;
        }),
        (id) => Effect.gen(function* () {
          let running: Deferred.Deferred<void> | undefined;
          yield* change((current) => {
            const subscriptions = new Map(current.subscriptions);
            subscriptions.delete(id);
            if (subscriptions.size === 0) {
              running = current.running;
            }
            return { ...current, subscriptions };
          });
          // Do not interrupt a vendor exchange between grant and persistence. Final detach joins its cleanup/readback.
          if (running !== undefined) {
            yield* Deferred.await(running);
          }
        }),
      ).pipe(Effect.asVoid);
    };
  });
}

const EARLY_RENEWAL_LEAD_MS = 4 * 60_000;

function notify(subscription: ClaudeCredentialMaintenanceSubscription, outcome: ClaudeCredentialMaintenanceOutcome): Effect.Effect<void> {
  return Effect.suspend(() => subscription.onOutcome?.(outcome) ?? Effect.void).pipe(Effect.catchAllDefect(() => Effect.void));
}

/** Retain only safe expiry metadata; access tokens never enter maintenance state. */
function readExpiry(source: ClaudeLocalSource): Effect.Effect<number | undefined> {
  return Effect.tryPromise({ try: () => source.readCredential(), catch: () => undefined }).pipe(
    Effect.map((credential) => credential.ok && typeof credential.accessToken === "string" && credential.accessToken.trim().length > 0 && Number.isFinite(credential.expiresAt)
      ? credential.expiresAt : undefined),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );
}
