import { makeStreamDeckLoggerLayer, type StreamDeckLogSink } from "@ai-workbench/logging";
import { runManagedRuntimeTask, type RuntimeBridgeOutcome } from "@ai-workbench/runtime-foundation";
import { createScheduler, type Scheduler } from "@ai-workbench/scheduler";
import { Effect, ManagedRuntime } from "effect";

import { writeShellLog } from "./logging.js";

export interface RuntimeServices {
  /**
   * The single Effect `ManagedRuntime` composition root. Every part of the plugin runs on it:
   * the scheduler's per-key poll fibers, the render fiber, and the SDK lifecycle/action
   * callback dispatch. It is the one runtime for the whole plugin.
   */
  readonly managedRuntime: ManagedRuntime.ManagedRuntime<never, never>;
  readonly scheduler: Scheduler;
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
export function createAppManagedRuntime(logSink: StreamDeckLogSink): ManagedRuntime.ManagedRuntime<never, never> {
  return ManagedRuntime.make(makeStreamDeckLoggerLayer(logSink));
}

export function createRuntimeServices(logSink: StreamDeckLogSink): RuntimeServices {
  // The single ManagedRuntime is created once at startup, injected into the scheduler so its fibers share
  // this runtime's Logger + Clock, injected into the SDK-callback runner (createManagedRuntimeRunner) for
  // the same reason, held for the plugin lifetime, and disposed on shutdown.
  const managedRuntime = createAppManagedRuntime(logSink);
  return {
    managedRuntime,
    scheduler: createScheduler({ runtime: managedRuntime }),
  };
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
