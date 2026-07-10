import { Cause, Data, Effect, Exit, ManagedRuntime, Option } from "effect";

export const packageName = "@ai-workbench/runtime-foundation" as const;

export type RuntimeFailureKind = "expected" | "unexpected" | "cancelled";

export interface SanitizedRuntimeFailure {
  readonly kind: RuntimeFailureKind;
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly sanitized: true;
}

export type RuntimeBridgeOutcome<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly failure: SanitizedRuntimeFailure;
    };

const cancelledFailure: SanitizedRuntimeFailure = {
  kind: "cancelled",
  code: "runtime-task-cancelled",
  safeMessage: "Runtime task was cancelled.",
  retryable: false,
  sanitized: true,
};

const unknownFailure: SanitizedRuntimeFailure = {
  kind: "unexpected",
  code: "unknown-sanitized-failure",
  safeMessage: "Unexpected runtime failure.",
  retryable: true,
  sanitized: true,
};

export interface RuntimeFailureInput {
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly internalCause?: unknown;
}

/**
 * Internal typed runtime failure: the runtime foundation's own expected failure,
 * modeled as a `Data.TaggedError`. It is mapped at the bridge into the plain `SanitizedRuntimeFailure`
 * contract; the tagged value and its `internalCause` never cross that boundary. The full error taxonomy
 * lives in `packages/errors`.
 */
class RuntimeFailure extends Data.TaggedError("RuntimeFailure")<{
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly internalCause?: unknown;
}> {}

export type { RuntimeFailure };

export function makeRuntimeFailure(input: RuntimeFailureInput): RuntimeFailure {
  return new RuntimeFailure(input);
}

/**
 * The single SDK bridge onto the plugin's one Effect `ManagedRuntime`. The legacy Promise-task
 * runtime and hand-rolled clock this bridge was added alongside (expand/contract) were retired,
 * so this is now the only runtime bridge.
 *
 * Runs `effect` on the passed runtime via `runPromiseExit` and maps its `Exit` to the plain sanitized
 * outcome: success -> `ok`; an expected `RuntimeFailure` -> a sanitized `expected` failure; interruption
 * -> `cancelled`; any other defect -> a sanitized `unexpected` failure. The raw Effect `Cause` and any
 * `internalCause` never cross this boundary. Because the effect runs on the passed runtime, it
 * shares that runtime's sanitizing `Logger` and Effect `Clock`.
 */
export function runManagedRuntimeTask<Value, E>(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  effect: Effect.Effect<Value, E>,
): Promise<RuntimeBridgeOutcome<Value>> {
  return runtime.runPromiseExit(effect).then((exit) => sanitizeRuntimeExit(exit));
}

function sanitizeRuntimeExit<Value>(exit: Exit.Exit<Value, unknown>): RuntimeBridgeOutcome<Value> {
  return Exit.match(exit, {
    onFailure: (cause) => failureOutcome(sanitizeRuntimeFailureCause(cause)),
    onSuccess: (value) => ({
      ok: true,
      value,
    }),
  });
}

function sanitizeRuntimeFailureCause(cause: Cause.Cause<unknown>): SanitizedRuntimeFailure {
  if (Cause.isInterrupted(cause)) {
    return cancelledFailure;
  }

  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure) && failure.value instanceof RuntimeFailure) {
    return {
      kind: "expected",
      code: failure.value.code,
      safeMessage: failure.value.safeMessage,
      retryable: failure.value.retryable,
      sanitized: true,
    };
  }

  return unknownFailure;
}

function failureOutcome<Value = never>(failure: SanitizedRuntimeFailure): RuntimeBridgeOutcome<Value> {
  return {
    ok: false,
    failure,
  };
}
