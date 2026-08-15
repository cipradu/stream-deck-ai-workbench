import { Effect, Schema } from "effect";

import {
  INCIDENT_IMPACTS,
  INCIDENT_LIFECYCLES,
  PROVIDER_STATUS_INDICATORS,
  type StatusProviderId,
  type StatusSnapshot,
} from "@ai-workbench/contracts";
import { DEFAULT_HTTP_TIMEOUT_MS, type HttpJsonRequest, type RequestJsonSchemaOptions } from "@ai-workbench/http";
import {
  resolveProviderCapability,
  type StatusProviderCapabilityMetadata,
} from "@ai-workbench/provider-registry";
import { normalizeStatusIncidents } from "@ai-workbench/action-status";

import { createStatusProviderAdapterBinding } from "../../binding-helpers.js";
import {
  isGovernorBlocked,
  schedulerFailureFromGovernorBlocked,
  schedulerFailureFromTagged,
  type EffectSchedulerFetch,
  type EffectStatusSchedulerFetch,
} from "../../effect-fetch.js";
import { ProviderAdapterAttemptContext, governedRequestJsonSchema } from "../../governed-request.js";
import { abortSignalForScheduler } from "../../live-http.js";
import { executeAdapterSource } from "../../source-flight-runtime.js";
import type {
  CreateStatusProviderSourceFetchInput,
  StatusProviderAdapterBinding,
} from "../../types.js";
import { anthropicApiStatusSourceDescriptor } from "./anthropic-api/index.js";
import { minimaxStatusSourceDescriptor } from "./minimax/index.js";
import { moonshotStatusSourceDescriptor } from "./moonshot/index.js";
import { openAiApiStatusSourceDescriptor } from "./openai-api/index.js";

export interface StatusSourceDescriptor {
  readonly providerId: StatusProviderId;
  readonly endpointUrl: string;
  readonly rateLimitDomain: string;
  readonly sourceIdentity: "public-status-summary";
}

export interface StatusProviderModule extends StatusSourceDescriptor {
  readonly createBinding: (capability: StatusProviderCapabilityMetadata) => StatusProviderAdapterBinding;
  readonly createSourceFetchEffect: () => EffectStatusSchedulerFetch;
}

const StatusIncidentArraySchema = Schema.Array(
  Schema.Struct({
    status: Schema.Literal(...INCIDENT_LIFECYCLES),
    impact: Schema.Literal(...INCIDENT_IMPACTS),
  }),
);

const StrictStatusSummarySchema = Schema.Struct({
  incidents: StatusIncidentArraySchema,
});

const OpenAIStatusSummarySchema = Schema.Struct({
  status: Schema.Struct({
    indicator: Schema.Literal(...PROVIDER_STATUS_INDICATORS),
  }),
  incidents: Schema.optionalWith(StatusIncidentArraySchema, { exact: true }),
});

export const statusProviderModules: readonly StatusProviderModule[] = [
  createStatusProviderModule(anthropicApiStatusSourceDescriptor),
  createStatusProviderModule(openAiApiStatusSourceDescriptor),
  createStatusProviderModule(moonshotStatusSourceDescriptor),
  createStatusProviderModule(minimaxStatusSourceDescriptor),
];

export function createStatusProviderSourceFetchEffect(
  input: CreateStatusProviderSourceFetchInput,
): EffectSchedulerFetch | undefined {
  const providerModule = statusProviderModules.find((candidate) => candidate.providerId === input.providerId);
  const resolvedCapability = resolveProviderCapability(input.providerId, "status")?.capability;
  if (providerModule === undefined || resolvedCapability === undefined || input.sourceFlightRuntime === undefined) {
    return undefined;
  }

  const sourceFlightRuntime = input.sourceFlightRuntime;
  const sourceFetch = providerModule.createSourceFetchEffect();

  return (request) =>
    executeAdapterSource(
      sourceFlightRuntime,
      {
        providerId: providerModule.providerId,
        credentialProfileId: "none",
        rateLimitDomain: resolvedCapability.coordinationPolicy.rateLimitDomain,
        sourceIdentity: providerModule.sourceIdentity,
        normalizedRequestVariant: "summary",
      },
      (attempts) => sourceFetch(request).pipe(Effect.provideService(ProviderAdapterAttemptContext, attempts)),
    ).pipe(
      Effect.mapError((failure) =>
        isGovernorBlocked(failure) ? schedulerFailureFromGovernorBlocked(failure) : failure,
      ),
    );
}

function createStatusProviderModule(descriptor: StatusSourceDescriptor): StatusProviderModule {
  return {
    ...descriptor,
    createBinding: (capability) => createStatusProviderAdapterBinding(descriptor.providerId, capability),
    createSourceFetchEffect: () => createStatusSourceFetchEffect(descriptor),
  };
}

function createStatusSourceFetchEffect(descriptor: StatusSourceDescriptor): EffectStatusSchedulerFetch {
  return (request) => {
    const providerId = descriptor.providerId;
    const requestInput = {
      url: descriptor.endpointUrl,
      method: "GET",
      signal: abortSignalForScheduler(request.signal),
    } satisfies HttpJsonRequest;
    const requestOptions = {
      defaultTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      responseBodyMode: "bounded",
      statusClassificationMode: "credential-free",
    } satisfies RequestJsonSchemaOptions;
    return providerId === "openai-api"
      ? governedStatusSummary(
          requestInput,
          OpenAIStatusSummarySchema,
          requestOptions,
          (summary) =>
            normalizeStatusIncidents({
              providerId,
              incidents: summary.incidents ?? [],
              providerStatusIndicator: summary.status.indicator,
              fetchedAtEpochMs: request.startedAtEpochMs,
            }),
        )
      : governedStatusSummary(
          requestInput,
          StrictStatusSummarySchema,
          requestOptions,
          (summary) =>
            normalizeStatusIncidents({
              providerId,
              incidents: summary.incidents,
              fetchedAtEpochMs: request.startedAtEpochMs,
            }),
        );
  };
}

function governedStatusSummary<A, I, R>(
  request: HttpJsonRequest,
  schema: Schema.Schema<A, I, R>,
  options: RequestJsonSchemaOptions,
  normalize: (summary: A) => StatusSnapshot,
) {
  return governedRequestJsonSchema(request, schema, options).pipe(
    Effect.map(normalize),
    Effect.mapError(schedulerFailureFromTagged),
  );
}
