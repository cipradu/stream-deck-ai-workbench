import {
  serializeSourceRequestIdentity,
  type ProviderId,
  type SourceRequestIdentityInput,
} from "@ai-workbench/contracts";
import {
  type GovernorBlocked,
  type GovernorSourceSettlement,
  ProviderRequestGovernor,
  type ProviderRequestGovernorService,
} from "@ai-workbench/scheduler";
import type { HttpClient as PlatformHttpClient } from "@effect/platform";
import { Cause, Context, Deferred, Effect, ExecutionStrategy, Exit, Layer, Ref, Scope } from "effect";

import type { AdapterFetchFailure } from "./effect-fetch.js";
import { makeGovernorBackedAttemptContext, type GovernorBackedAttemptContext } from "./governed-request.js";
import type { ClaudeCodeUsageResponse } from "./providers/usage/claude-code/index.js";
import type { KimiCodeUsageResponse } from "./providers/usage/kimi-code/index.js";

/**
 * Adapter-local operation executed by one source flight. Each registry is
 * homogeneous in its result, error, and environment channels, so flight state
 * never needs an erased global result store.
 */
export type AdapterSourceFlightOperation<A, E, R> = (
  attempts: GovernorBackedAttemptContext,
) => Effect.Effect<A, E, R>;

/**
 * Safe source-coordination values passed from the app/dispatch seam. Credential
 * generation is deliberately absent: the adapter runtime asks the governor for
 * the opaque current generation at source start, before it serializes identity.
 */
export interface AdapterSourceRequestIdentity {
  readonly providerId: ProviderId;
  readonly credentialProfileId: string;
  readonly rateLimitDomain: string;
  readonly sourceIdentity: string;
  readonly normalizedRequestVariant: string;
}

/** A homogeneous adapter-local registry for one source result contract. */
export interface AdapterSourceFlightRegistry<A, E, R> {
  readonly run: (
    identity: SourceRequestIdentityInput,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ) => Effect.Effect<A, E | GovernorBlocked, R | Scope.Scope>;
}

const adapterSourceFlightCapabilityInternals = Symbol("adapter-source-flight-capability-internals");

interface AdapterSourceFlightCapabilityInternals {
  readonly executeSource: <A, E, R>(
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ) => Effect.Effect<A, E | GovernorBlocked, R>;
  readonly runClaudeCodeUsageSource: (
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<
      ClaudeCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
  ) => Effect.Effect<ClaudeCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient>;
  readonly runKimiCodeUsageSource: (
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<
      KimiCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
  ) => Effect.Effect<KimiCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient>;
  readonly advanceCredentialGeneration: (credentialProfileId: string) => Effect.Effect<number>;
  readonly shutdown: () => Effect.Effect<void>;
}

/**
 * App-facing opaque token. Its non-exported symbol prevents the app from
 * accessing typed source/registry state; only adapter-local helpers below can
 * execute source work through it.
 */
export interface AdapterSourceFlightRuntimeCapability {
  readonly [adapterSourceFlightCapabilityInternals]: AdapterSourceFlightCapabilityInternals;
}

/**
 * Adapter-internal lifetime. It creates separately typed registries rather
 * than a heterogeneous map and closes every child flight scope at shutdown.
 */
export interface AdapterSourceFlightRuntime {
  readonly capability: AdapterSourceFlightRuntimeCapability;
  readonly runSource: <A, E, R>(
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ) => Effect.Effect<A, E | GovernorBlocked, R>;
  readonly createRegistry: <A, E, R>() => Effect.Effect<AdapterSourceFlightRegistry<A, E, R>>;
  readonly advanceCredentialGeneration: (credentialProfileId: string) => Effect.Effect<number>;
  readonly shutdown: () => Effect.Effect<void>;
}

/**
 * Test-only safe observation at the Claude homogeneous-flight subscription seam.
 * It deliberately carries no identity or typed-flight data and is never reachable
 * through the opaque runtime capability used by normal app code.
 */
export interface AdapterSourceFlightRuntimeTestObserver {
  readonly onClaudeCodeUsageSubscriberRegistered?: () => void;
}

/** Opaque plugin-scoped capability installed by app composition. */
export const AdapterSourceFlightRuntimeCapability = Context.GenericTag<AdapterSourceFlightRuntimeCapability>(
  "@ai-workbench/provider-adapters/AdapterSourceFlightRuntimeCapability",
);

/** Adapter-only bridge from the opaque token to its typed source runtime. */
export function executeAdapterSource<A, E, R>(
  capability: AdapterSourceFlightRuntimeCapability,
  identity: AdapterSourceRequestIdentity,
  operation: AdapterSourceFlightOperation<A, E, R>,
): Effect.Effect<A, E | GovernorBlocked, R> {
  return capability[adapterSourceFlightCapabilityInternals].executeSource(identity, operation);
}

/** Adapter-only Claude bridge to the plugin-scoped homogeneous OAuth-response registry. */
export function runClaudeCodeUsageSource(
  capability: AdapterSourceFlightRuntimeCapability,
  identity: AdapterSourceRequestIdentity,
  operation: AdapterSourceFlightOperation<
    ClaudeCodeUsageResponse,
    AdapterFetchFailure | GovernorBlocked,
    PlatformHttpClient.HttpClient
  >,
): Effect.Effect<ClaudeCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient> {
  return capability[adapterSourceFlightCapabilityInternals].runClaudeCodeUsageSource(identity, operation);
}

/** Adapter-only Kimi bridge to the plugin-scoped homogeneous managed-usage registry. */
export function runKimiCodeUsageSource(
  capability: AdapterSourceFlightRuntimeCapability,
  identity: AdapterSourceRequestIdentity,
  operation: AdapterSourceFlightOperation<
    KimiCodeUsageResponse,
    AdapterFetchFailure | GovernorBlocked,
    PlatformHttpClient.HttpClient
  >,
): Effect.Effect<KimiCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient> {
  return capability[adapterSourceFlightCapabilityInternals].runKimiCodeUsageSource(identity, operation);
}

/** Safe lifecycle bridge used by the app composition root. */
export function advanceAdapterSourceCredentialGeneration(
  capability: AdapterSourceFlightRuntimeCapability,
  credentialProfileId: string,
): Effect.Effect<number> {
  return capability[adapterSourceFlightCapabilityInternals].advanceCredentialGeneration(credentialProfileId);
}

/** Safe lifecycle bridge used after scheduler shutdown. */
export function shutdownAdapterSourceFlightRuntime(capability: AdapterSourceFlightRuntimeCapability): Effect.Effect<void> {
  return capability[adapterSourceFlightCapabilityInternals].shutdown();
}

interface SourceFlight<A, E> {
  readonly result: Deferred.Deferred<A, E | GovernorBlocked>;
  readonly scope: Scope.CloseableScope;
  subscribers: number;
}

type FlightSelection<A, E> =
  | { readonly kind: "start"; readonly flight: SourceFlight<A, E> }
  | { readonly kind: "join"; readonly flight: SourceFlight<A, E> };

/**
 * Creates a scoped adapter runtime. The runtime is intentionally package-local:
 * it owns typed result Deferreds, worker fibers, child scopes, and subscriber
 * cleanup, while the scheduler receives only source-lease lifecycle signals.
 */
export function makeAdapterSourceFlightRuntime(
  governor: ProviderRequestGovernorService,
  observer: AdapterSourceFlightRuntimeTestObserver = {},
): Effect.Effect<AdapterSourceFlightRuntime, never, Scope.Scope> {
  return Effect.gen(function* () {
    const lifetime = yield* Scope.make(ExecutionStrategy.sequential);
    const claudeCodeUsageFlights = yield* Ref.make<
      ReadonlyMap<string, SourceFlight<ClaudeCodeUsageResponse, AdapterFetchFailure | GovernorBlocked>>
    >(
      new Map(),
    );
    const claudeCodeUsageRegistry = new HomogeneousSourceFlightRegistry<
      ClaudeCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >(lifetime, governor, claudeCodeUsageFlights, observer.onClaudeCodeUsageSubscriberRegistered);
    const kimiCodeUsageFlights = yield* Ref.make<
      ReadonlyMap<string, SourceFlight<KimiCodeUsageResponse, AdapterFetchFailure | GovernorBlocked>>
    >(new Map());
    const kimiCodeUsageRegistry = new HomogeneousSourceFlightRegistry<
      KimiCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >(lifetime, governor, kimiCodeUsageFlights);
    const runtime = new RuntimeAdapterSourceFlightRuntime(
      lifetime,
      governor,
      claudeCodeUsageRegistry,
      kimiCodeUsageRegistry,
    );
    yield* Effect.addFinalizer(() => runtime.shutdown());
    return runtime;
  });
}

/** Test-configurable app layer; normal construction leaves the observer absent. */
export function makeAdapterSourceFlightRuntimeLive(
  observer: AdapterSourceFlightRuntimeTestObserver = {},
) {
  return Layer.scoped(
    AdapterSourceFlightRuntimeCapability,
    Effect.map(
      Effect.flatMap(ProviderRequestGovernor, (governor) => makeAdapterSourceFlightRuntime(governor, observer)),
      (runtime) => runtime.capability,
    ),
  );
}

/** App-layer constructor: one adapter-owned runtime per normal plugin composition. */
export const AdapterSourceFlightRuntimeLive = makeAdapterSourceFlightRuntimeLive();

class RuntimeAdapterSourceFlightRuntime implements AdapterSourceFlightRuntime {
  readonly capability: AdapterSourceFlightRuntimeCapability;

  constructor(
    private readonly lifetime: Scope.CloseableScope,
    private readonly governor: ProviderRequestGovernorService,
    private readonly claudeCodeUsageRegistry: AdapterSourceFlightRegistry<
      ClaudeCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
    private readonly kimiCodeUsageRegistry: AdapterSourceFlightRegistry<
      KimiCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
  ) {
    this.capability = {
      [adapterSourceFlightCapabilityInternals]: {
        executeSource: (identity, operation) => this.runSource(identity, operation),
        runClaudeCodeUsageSource: (identity, operation) => this.runClaudeCodeUsageSource(identity, operation),
        runKimiCodeUsageSource: (identity, operation) => this.runKimiCodeUsageSource(identity, operation),
        advanceCredentialGeneration: (credentialProfileId) => this.advanceCredentialGeneration(credentialProfileId),
        shutdown: () => this.shutdown(),
      },
    };
  }

  createRegistry = <A, E, R>(): Effect.Effect<AdapterSourceFlightRegistry<A, E, R>> =>
    Ref.make<ReadonlyMap<string, SourceFlight<A, E>>>(new Map()).pipe(
      Effect.map((flights) => new HomogeneousSourceFlightRegistry<A, E, R>(this.lifetime, this.governor, flights)),
    );

  runSource = <A, E, R>(
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ): Effect.Effect<A, E | GovernorBlocked, R> =>
    Effect.scoped(
      Effect.gen(this, function* () {
        const credentialGeneration = yield* this.governor.credentialGenerationFor({
          credentialProfileId: identity.credentialProfileId,
        });
        const sourceIdentity: SourceRequestIdentityInput = {
          rateLimitScope: {
            providerId: identity.providerId,
            credentialProfileId: identity.credentialProfileId,
            credentialGeneration,
            rateLimitDomain: identity.rateLimitDomain,
          },
          sourceIdentity: identity.sourceIdentity,
          normalizedRequestVariant: identity.normalizedRequestVariant,
        };
        const lease = yield* this.governor.acquireSource(sourceIdentity);
        return yield* operation(makeGovernorBackedAttemptContext(lease)).pipe(
          Effect.onExit((exit) => lease.settle(settlementFor(exit))),
        );
      }),
    );

  runClaudeCodeUsageSource = (
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<
      ClaudeCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
  ): Effect.Effect<ClaudeCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient> =>
    Effect.scoped(
      Effect.gen(this, function* () {
        const credentialGeneration = yield* this.governor.credentialGenerationFor({
          credentialProfileId: identity.credentialProfileId,
        });
        const sourceIdentity: SourceRequestIdentityInput = {
          rateLimitScope: {
            providerId: identity.providerId,
            credentialProfileId: identity.credentialProfileId,
            credentialGeneration,
            rateLimitDomain: identity.rateLimitDomain,
          },
          sourceIdentity: identity.sourceIdentity,
          normalizedRequestVariant: identity.normalizedRequestVariant,
        };
        return yield* this.claudeCodeUsageRegistry.run(sourceIdentity, operation);
      }),
    );

  runKimiCodeUsageSource = (
    identity: AdapterSourceRequestIdentity,
    operation: AdapterSourceFlightOperation<
      KimiCodeUsageResponse,
      AdapterFetchFailure | GovernorBlocked,
      PlatformHttpClient.HttpClient
    >,
  ): Effect.Effect<KimiCodeUsageResponse, AdapterFetchFailure | GovernorBlocked, PlatformHttpClient.HttpClient> =>
    Effect.scoped(
      Effect.gen(this, function* () {
        const credentialGeneration = yield* this.governor.credentialGenerationFor({
          credentialProfileId: identity.credentialProfileId,
        });
        const sourceIdentity: SourceRequestIdentityInput = {
          rateLimitScope: {
            providerId: identity.providerId,
            credentialProfileId: identity.credentialProfileId,
            credentialGeneration,
            rateLimitDomain: identity.rateLimitDomain,
          },
          sourceIdentity: identity.sourceIdentity,
          normalizedRequestVariant: identity.normalizedRequestVariant,
        };
        return yield* this.kimiCodeUsageRegistry.run(sourceIdentity, operation);
      }),
    );

  advanceCredentialGeneration = (credentialProfileId: string): Effect.Effect<number> =>
    this.governor.advanceCredentialGeneration({ credentialProfileId });

  shutdown = (): Effect.Effect<void> => Scope.close(this.lifetime, Exit.void);
}

class HomogeneousSourceFlightRegistry<A, E, R> implements AdapterSourceFlightRegistry<A, E, R> {
  constructor(
    private readonly lifetime: Scope.CloseableScope,
    private readonly governor: ProviderRequestGovernorService,
    private readonly flights: Ref.Ref<ReadonlyMap<string, SourceFlight<A, E>>>,
    private readonly onSubscriberRegistered?: () => void,
  ) {}

  run = (
    identity: SourceRequestIdentityInput,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ): Effect.Effect<A, E | GovernorBlocked, R | Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const key = serializeSourceRequestIdentity(identity);
        const candidate: SourceFlight<A, E> = {
          result: yield* Deferred.make<A, E | GovernorBlocked>(),
          scope: yield* Scope.fork(this.lifetime, ExecutionStrategy.sequential),
          subscribers: 1,
        };
        const selection = yield* Ref.modify(this.flights, (flights): readonly [FlightSelection<A, E>, ReadonlyMap<string, SourceFlight<A, E>>] => {
          const existing = flights.get(key);
          if (existing !== undefined) {
            existing.subscribers += 1;
            return [{ kind: "join", flight: existing }, flights];
          }
          const next = new Map(flights);
          next.set(key, candidate);
          return [{ kind: "start", flight: candidate }, next];
        });

        notifySubscriberRegistered(this.onSubscriberRegistered);

        if (selection.kind === "join") {
          yield* Scope.close(candidate.scope, Exit.void);
        } else {
          yield* Effect.forkIn(restore(this.runWorker(key, identity, selection.flight, operation)), selection.flight.scope);
        }

        return yield* restore(Deferred.await(selection.flight.result)).pipe(
          Effect.ensuring(this.detach(key, selection.flight)),
        );
      }),
    );

  private runWorker(
    key: string,
    identity: SourceRequestIdentityInput,
    flight: SourceFlight<A, E>,
    operation: AdapterSourceFlightOperation<A, E, R>,
  ): Effect.Effect<void, never, R> {
    const governor = this.governor;
    const source = Scope.extend(
      Effect.gen(function* () {
        const lease = yield* governor.acquireSource(identity);
        return yield* operation(makeGovernorBackedAttemptContext(lease)).pipe(
          Effect.onExit((exit) => lease.settle(settlementFor(exit))),
        );
      }),
      flight.scope,
    );

    return Effect.exit(source).pipe(
      Effect.flatMap((exit) =>
        this.removeCompletedFlight(key, flight).pipe(
          Effect.zipRight(Deferred.done(flight.result, exit)),
          Effect.zipRight(Scope.close(flight.scope, Exit.void)),
          Effect.asVoid,
        ),
      ),
    );
  }

  private detach(key: string, flight: SourceFlight<A, E>): Effect.Effect<void> {
    return Ref.modify(this.flights, (flights): readonly [Scope.CloseableScope | undefined, ReadonlyMap<string, SourceFlight<A, E>>] => {
      if (flights.get(key) !== flight) {
        return [undefined, flights];
      }
      if (flight.subscribers > 1) {
        flight.subscribers -= 1;
        return [undefined, flights];
      }
      const next = new Map(flights);
      next.delete(key);
      return [flight.scope, next];
    }).pipe(
      Effect.flatMap((scope) => (scope === undefined ? Effect.void : Scope.close(scope, Exit.void))),
    );
  }

  private removeCompletedFlight(key: string, flight: SourceFlight<A, E>): Effect.Effect<void> {
    return Ref.update(this.flights, (flights) => {
      if (flights.get(key) !== flight) {
        return flights;
      }
      const next = new Map(flights);
      next.delete(key);
      return next;
    });
  }
}

function notifySubscriberRegistered(observer: (() => void) | undefined): void {
  try {
    observer?.();
  } catch {
    // Test observation cannot affect flight selection, lifetime, or errors.
  }
}

function settlementFor<A, E>(exit: Exit.Exit<A, E>): GovernorSourceSettlement {
  if (Exit.isSuccess(exit)) {
    return { kind: "succeeded" };
  }
  return Cause.isInterruptedOnly(exit.cause) ? { kind: "cancelled" } : { kind: "failed" };
}
