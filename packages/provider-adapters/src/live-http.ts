import type { SchedulerAbortSignal } from "@ai-workbench/scheduler";

/**
 * Adapts the scheduler's abort signal to a Web `AbortSignal` for the `@effect/platform`
 * request builders. This is the sole surviving export after the dead Promise HTTP/credential
 * path was removed: every Effect-native adapter uses it so its one HTTP attempt is
 * cancellable when the scheduler fiber aborts the key.
 */
export function abortSignalForScheduler(signal: SchedulerAbortSignal): AbortSignal {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return controller.signal;
  }

  signal.addEventListener(
    "abort",
    () => {
      controller.abort();
    },
    { once: true },
  );
  return controller.signal;
}
