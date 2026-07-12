import { makeStreamDeckLoggerLayer, type StreamDeckLogSink } from "@ai-workbench/logging";
import {
  AdapterSourceFlightRuntimeCapability,
  AdapterSourceFlightRuntimeLive,
  advanceAdapterSourceCredentialGeneration,
  makeAdapterSourceFlightRuntimeLive,
  shutdownAdapterSourceFlightRuntime,
  type AdapterSourceFlightRuntimeCapability as AdapterSourceFlightRuntimeCapabilityService,
} from "@ai-workbench/provider-adapters";
import { runManagedRuntimeTask, type RuntimeBridgeOutcome } from "@ai-workbench/runtime-foundation";
import {
  createScheduler,
  ProviderRequestGovernor,
  ProviderRequestGovernorLive,
  type ProviderRequestGovernorService,
  type Scheduler,
} from "@ai-workbench/scheduler";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import { writeShellLog } from "./logging.js";

export interface RuntimeServices {
  /**
   * The single Effect `ManagedRuntime` composition root. Every part of the plugin runs on it:
   * the scheduler's per-key poll fibers, the render fiber, and the SDK lifecycle/action
   * callback dispatch. It is the one runtime for the whole plugin.
   */
  readonly managedRuntime: ManagedRuntime.ManagedRuntime<never, never>;
  readonly scheduler: Scheduler;
  readonly providerRequestRuntime: ProviderRequestRuntime;
  readonly shutdown: () => Promise<void>;
}

/** Test-only safe lifecycle observation; it never exposes adapter flight state or outcomes. */
export interface CreateRuntimeServicesOptions {
  readonly onShutdownPhase?: (phase: "adapter-source-flights" | "governor" | "managed-runtime") => void;
  readonly onCredentialGenerationAdvanced?: (credentialProfileId: string) => void;
  /** Test-only safe observer; production construction leaves this absent. */
  readonly onClaudeCodeUsageSubscriberRegistered?: () => void;
}

/** Opaque lifecycle capability the shell passes to scheduler-fetch factories. */
export interface ProviderRequestRuntime {
  readonly sourceFlightRuntime: AdapterSourceFlightRuntimeCapabilityService;
  readonly advanceCredentialGeneration: (credentialProfileId: string) => Promise<void>;
}

export type RuntimeRunner = (taskName: string, task: () => void | Promise<void>) => Promise<void>;

/**
 * Builds the plugin's Effect `ManagedRuntime` composition root. The app
 * `Layer` installs the sanitizing Effect `Logger` via `Logger.replace` (`makeStreamDeckLoggerLayer`),
 * so EVERY effect that runs on this runtime — the scheduler's per-key poll fibers, the render fiber, and
 * the SDK-callback dispatch — logs through the sanitizer sink and NEVER Effect's default
 * console logger (which would render a raw `Cause`). The runtime provides Effect `Clock`
 * automatically; there is no `Date.now`/`setTimeout`.
 */
export function createAppManagedRuntime(
  logSink: StreamDeckLogSink,
  options: Pick<CreateRuntimeServicesOptions, "onClaudeCodeUsageSubscriberRegistered"> = {},
): ManagedRuntime.ManagedRuntime<never, never> {
  const adapterSourceFlightRuntimeLayer =
    options.onClaudeCodeUsageSubscriberRegistered === undefined
      ? AdapterSourceFlightRuntimeLive
      : makeAdapterSourceFlightRuntimeLive({
          onClaudeCodeUsageSubscriberRegistered: options.onClaudeCodeUsageSubscriberRegistered,
        });
  return ManagedRuntime.make(
    Layer.merge(
      makeStreamDeckLoggerLayer(logSink),
      Layer.provideMerge(adapterSourceFlightRuntimeLayer, ProviderRequestGovernorLive),
    ),
  );
}

export function createRuntimeServices(logSink: StreamDeckLogSink, options: CreateRuntimeServicesOptions = {}): RuntimeServices {
  // The single ManagedRuntime is created once at startup, injected into the scheduler so its fibers share
  // this runtime's Logger + Clock, injected into the SDK-callback runner (createManagedRuntimeRunner) for
  // the same reason, held for the plugin lifetime, and disposed on shutdown.
  const managedRuntime = createAppManagedRuntime(logSink, options);
  const governor = managedRuntime.runSync(Effect.map(Effect.serviceOption(ProviderRequestGovernor), Option.getOrThrow));
  const sourceFlightRuntime = managedRuntime.runSync(
    Effect.map(Effect.serviceOption(AdapterSourceFlightRuntimeCapability), Option.getOrThrow),
  );
  return {
    managedRuntime,
    scheduler: createScheduler({ runtime: managedRuntime }),
    providerRequestRuntime: {
      sourceFlightRuntime,
      advanceCredentialGeneration: async (credentialProfileId) => {
        await managedRuntime.runPromise(advanceAdapterSourceCredentialGeneration(sourceFlightRuntime, credentialProfileId));
        options.onCredentialGenerationAdvanced?.(credentialProfileId);
      },
    },
    shutdown: () => shutdownRuntimeServices(managedRuntime, sourceFlightRuntime, governor, options.onShutdownPhase),
  };
}

/** Scheduler work is stopped by the shell before this ordered resource release. */
async function shutdownRuntimeServices(
  managedRuntime: ManagedRuntime.ManagedRuntime<never, never>,
  sourceFlightRuntime: AdapterSourceFlightRuntimeCapabilityService,
  governor: ProviderRequestGovernorService,
  onShutdownPhase: CreateRuntimeServicesOptions["onShutdownPhase"],
): Promise<void> {
  onShutdownPhase?.("adapter-source-flights");
  await managedRuntime.runPromise(shutdownAdapterSourceFlightRuntime(sourceFlightRuntime));
  onShutdownPhase?.("governor");
  await managedRuntime.runPromise(governor.shutdown());
  onShutdownPhase?.("managed-runtime");
  await managedRuntime.dispose();
}

/**
 * Builds the SDK-callback runner. Every Stream Deck lifecycle/action callback's work runs on
 * the single shared `ManagedRuntime` through the runtime-foundation sanitized bridge
 * (`runManagedRuntimeTask` -> `runPromiseExit`), so callbacks share the runtime's sanitizing `Logger` and
 * Effect `Clock` exactly like the scheduler and render fibers. A callback failure surfaces as a sanitized
 * outcome (no raw `Cause`/secret) and is logged through the same `writeShellLog` sink the retired
 * legacy Promise-task runner used.
 */
export function createManagedRuntimeRunner(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  logSink: StreamDeckLogSink,
): RuntimeRunner {
  return async (taskName, task) => {
    void taskName;
    const outcome: RuntimeBridgeOutcome<void> = await runManagedRuntimeTask(
      runtime,
      Effect.promise(() => Promise.resolve(task())),
    );
    if (!outcome.ok) {
      await writeShellLog(logSink, {
        context: {
          reasonCode: outcome.failure.code,
        },
        eventName: "streamdeck-runtime-task-failed",
        level: "error",
        message: outcome.failure.safeMessage,
      });
    }
  };
}
