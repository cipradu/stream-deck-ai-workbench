import { Cause, Effect, Exit, Layer, Option } from "effect";
import { HttpClient as PlatformHttpClient } from "@effect/platform";

import { createSanitizedFailure, type SanitizedFailure } from "../../errors/src/index.js";
import { fetchHttpClientLayer } from "../../http/src/index.js";
import type { SchedulerFetch } from "../../scheduler/src/index.js";
import {
  isGovernorBlocked,
  schedulerFailureFromGovernorBlocked,
  type EffectProviderSourceFetch,
} from "../src/effect-fetch.js";
import { ProviderAdapterAttemptContext } from "../src/governed-request.js";

// ---------------------------------------------------------------------------
// Test-only Effect-adapter -> Promise-`SchedulerFetch` bridge.
//
// The production scheduler is Effect-native and consumes the adapter Effects DIRECTLY, so this
// bridge is NOT on the live path. It exists only so the adapter test suite can drive an
// `EffectSchedulerFetch` through the plain Promise `SchedulerFetch` shape: provide an `HttpClient`
// layer (a fake layer in tests), run exactly ONE attempt with `runPromiseExit`, and map the `Exit`
// to the plain `SchedulerFetchResult`. No retry is added here — the scheduler is the single retry
// owner. Relocated out of `packages/provider-adapters` `src` (was `effect-fetch.ts`) once
// the live scheduler became Effect-native and the bridge became test-only scaffolding.
// ---------------------------------------------------------------------------

/**
 * Bridges an Effect-native adapter fetch into a Promise `SchedulerFetch` for the tests: it
 * provides the `HttpClient` layer (production `fetchHttpClientLayer`; tests inject a fake
 * layer), runs exactly one attempt with `runPromiseExit`, and maps the `Exit` to the plain
 * `SchedulerFetchResult`. An unexpected defect maps to a sanitized unknown failure so no
 * raw `Cause` reaches the plain contract. No retry is added here — the scheduler
 * is the single retry owner.
 */
export function bridgeEffectSchedulerFetch(
  effectFetch: EffectProviderSourceFetch,
  httpClientLayer: Layer.Layer<PlatformHttpClient.HttpClient> = fetchHttpClientLayer,
): SchedulerFetch {
  return async (request) => {
    const exit = await Effect.runPromiseExit(
      effectFetch(request).pipe(
        Effect.mapError((failure) => (isGovernorBlocked(failure) ? schedulerFailureFromGovernorBlocked(failure) : failure)),
        Effect.provide(httpClientLayer),
        Effect.provideService(ProviderAdapterAttemptContext, testAttemptContext),
      ),
    );
    if (Exit.isSuccess(exit)) {
      return { ok: true, snapshot: exit.value };
    }

    const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
    if (failure === undefined) {
      return { ok: false, failure: adapterEffectDefectFailure() };
    }
    return { ok: false, ...failure };
  };
}

const testAttemptContext = {
  attempt: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
  reportRateLimit: () => Effect.void,
};

function adapterEffectDefectFailure(): SanitizedFailure {
  return createSanitizedFailure({
    category: "unknown-sanitized-failure",
    diagnostics: {
      boundary: "provider-adapters-effect-bridge",
      issueCount: 1,
      reasonCode: "adapter-effect-defect",
    },
    provider: {
      failureClass: "unknown",
      reasonCode: "adapter-effect-defect",
    },
  });
}
