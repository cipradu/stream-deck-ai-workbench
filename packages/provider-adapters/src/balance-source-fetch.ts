import { Effect } from "effect";
import { HttpClient as PlatformHttpClient } from "@effect/platform";

import type { SanitizedTaggedError } from "@ai-workbench/errors";

import {
  schedulerFailureFromTagged,
  type AdapterFetchFailure,
  type EffectBalanceSchedulerFetch,
} from "./effect-fetch.js";
import { abortSignalForScheduler } from "./live-http.js";
import { credentialResolutionFailure } from "./provider-failures.js";
import type {
  BalanceProviderNormalizationResult,
  CreateBalanceProviderSourceFetchInput,
  NormalizeBalanceProviderResponseInput,
  ProviderCredentialMaterial,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared Balance source-fetch skeleton (DRY consolidation).
//
// Every discovery-free Balance adapter's `createSourceFetchEffect` is the SAME
// `Effect` pipeline around a provider-specific HTTP interaction: resolve the
// `Redacted` credential (mapping a rejected resolver to a sanitized failure),
// derive the scheduler abort signal + the pre-fetch timestamp, run the provider's
// `fetchBody` and map its tagged failure to the plain adapter failure, then
// normalize the decoded body into the plain snapshot. This helper factors that
// invariant wrapper ONCE; the VARIABLE parts — endpoint, auth-header format,
// response schema, JSON-vs-text decode, and single/paginated/multi-call shape —
// stay in the provider's `fetchBody`.
//
// Unwrap invariant: the helper hands `fetchBody` the still-`Redacted`
// credential material and NEVER unwraps it, so the SINGLE `Redacted.value` unwrap
// stays at each adapter's own request builder inside `fetchBody` (unchanged from
// the per-adapter site). `fetchBody` runs ONE HTTP attempt per
// call and no retry is added here — the scheduler is the single retry owner.
//
// Scope: the discovery-free single-call adapters AND the multi-call adapters whose
// loop/sequence lives inside `fetchBody` and fails only with the shared tagged
// taxonomy (anthropic-api/openai-api pagination, runpod two-call). The discovery
// adapters (exa/deepgram — interleaved cache-invalidation + a mixed tagged/plain
// failure flow) and the hybrid local-credential Usage adapters stay bespoke.
// ---------------------------------------------------------------------------

/**
 * The provider-specific HTTP interaction: given the still-`Redacted` credential
 * material and the shared fetch context, produce the decoded vendor body (via one
 * or more `requestJsonSchema`/`requestTextBody` attempts) or fail with the shared
 * tagged taxonomy. The SINGLE `Redacted.value` unwrap for the adapter lives HERE,
 * at its request builder; the skeleton never unwraps the credential.
 */
export type BalanceSourceFetchBody = (
  credential: ProviderCredentialMaterial,
  context: BalanceSourceFetchContext,
) => Effect.Effect<unknown, SanitizedTaggedError, PlatformHttpClient.HttpClient>;

export interface BalanceSourceFetchContext {
  readonly baseUrl: string;
  readonly signal: AbortSignal;
  readonly fetchedAtEpochMs: number;
}

export interface BalanceSourceFetchSpec {
  readonly fetchBody: BalanceSourceFetchBody;
  readonly normalize: (input: NormalizeBalanceProviderResponseInput) => BalanceProviderNormalizationResult;
}

/**
 * Builds a Balance adapter's Effect-native source fetch from the shared wrapper +
 * the provider's `fetchBody`/`normalize`. Behavior is identical to the former
 * per-adapter `createSourceFetchEffect` bodies (inlining this helper reproduces
 * them verbatim): the credential resolution, abort/timestamp derivation, tagged→
 * plain error mapping, and normalize dispatch are the invariant that was copied
 * across every adapter; only `fetchBody` and `normalize` vary.
 */
export function createBalanceSourceFetchEffect(
  input: CreateBalanceProviderSourceFetchInput,
  spec: BalanceSourceFetchSpec,
): EffectBalanceSchedulerFetch {
  return (request) =>
    Effect.gen(function* () {
      const resolution = yield* Effect.tryPromise({
        try: async () => input.resolveCredential(),
        catch: (): AdapterFetchFailure => ({ failure: credentialResolutionFailure(input.providerId) }),
      });
      if (!resolution.ok) {
        return yield* Effect.fail<AdapterFetchFailure>({ failure: resolution.failure });
      }

      const signal = abortSignalForScheduler(request.signal);
      const fetchedAtEpochMs = input.now?.() ?? request.startedAtEpochMs;

      const body = yield* spec
        .fetchBody(resolution.value, { baseUrl: input.baseUrl, signal, fetchedAtEpochMs })
        .pipe(Effect.mapError(schedulerFailureFromTagged));

      const normalized = spec.normalize({ providerId: input.providerId, response: body, fetchedAtEpochMs });
      if (!normalized.ok) {
        return yield* Effect.fail<AdapterFetchFailure>({ failure: normalized.failure });
      }

      return normalized.snapshot;
    });
}
