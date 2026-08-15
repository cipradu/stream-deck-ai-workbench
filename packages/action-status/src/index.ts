import type {
  ActiveIncidentLifecycle,
  ImplementationStatus,
  IncidentImpact,
  IncidentLifecycle,
  ProviderStatusIndicator,
  StrictStatusProviderId,
  StatusIncidentImpact,
  StatusProviderId,
  StatusSnapshot,
  StatusTone,
} from "@ai-workbench/contracts";
import { ACTIVE_INCIDENT_LIFECYCLES, STATUS_PROVIDER_IDS } from "@ai-workbench/contracts";
import {
  buildStatusRendererInput as buildDisplayStatusRendererInput,
  type BuildStatusRendererInputOptions as BuildDisplayStatusRendererInputOptions,
  type StatusDisplayRendererInput,
} from "@ai-workbench/display";
import {
  IMPLEMENTATION_STATUS_BEHAVIOR,
  listProviderCapabilitiesForFamily,
  resolveProviderCapability,
  type ResolvedProviderCapability,
  type SourceProofStatus,
} from "@ai-workbench/provider-registry";

export const packageName = "@ai-workbench/action-status" as const;

export interface StatusProviderOption {
  readonly providerId: StatusProviderId;
  readonly productLabel: string;
  readonly pickerLabel: string;
  readonly actionFamilyId: "status";
  readonly adapterBindingId: string;
  readonly credentialClass: "none";
  readonly implementationStatus: ImplementationStatus;
  readonly sourceProofStatus: SourceProofStatus;
  readonly fetchAllowed: boolean;
  readonly selectionEligible: boolean;
}

export interface DecodedStatusIncident {
  readonly status: IncidentLifecycle;
  readonly impact: IncidentImpact;
}

interface NormalizeStatusIncidentsInputBase {
  readonly incidents: readonly DecodedStatusIncident[];
  readonly fetchedAtEpochMs: number;
}

export type NormalizeStatusIncidentsInput = NormalizeStatusIncidentsInputBase &
  (
    | {
        readonly providerId: "openai-api";
        readonly providerStatusIndicator: ProviderStatusIndicator;
      }
    | {
        readonly providerId: StrictStatusProviderId;
        readonly providerStatusIndicator?: never;
      }
  );

export interface StatusDisplayInput {
  readonly actionFamilyId: "status";
  readonly providerId: StatusProviderId;
  readonly activeIncidentCount: number;
  readonly highestImpact?: StatusIncidentImpact;
  readonly providerStatusIndicator?: ProviderStatusIndicator;
  readonly tone: StatusTone;
  readonly valueText: string;
  readonly fetchedAtEpochMs: number;
}

export interface StatusDisplaySnapshotInput {
  readonly familyId: "status";
  readonly providerId: StatusProviderId;
  readonly activeIncidentCount: number;
  readonly highestImpact?: StatusIncidentImpact;
  readonly providerStatusIndicator?: ProviderStatusIndicator;
  readonly fetchedAtEpochMs: number;
}

export interface BuildStatusRendererInputOptions {
  readonly providerId: StatusProviderId;
  readonly schedulerOutput: BuildDisplayStatusRendererInputOptions["schedulerOutput"];
}

export type StatusPolicyResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid-status-snapshot";
    };

export function listStatusProviderOptions(): readonly StatusProviderOption[] {
  return listProviderCapabilitiesForFamily("status").flatMap((resolved) => {
    const option = statusProviderOption(resolved);
    return option === undefined ? [] : [option];
  });
}

export function resolveStatusProviderOption(providerId: string): StatusProviderOption | undefined {
  const resolved = resolveProviderCapability(providerId, "status");
  return resolved === undefined ? undefined : statusProviderOption(resolved);
}

export function normalizeStatusIncidents(input: NormalizeStatusIncidentsInput): StatusSnapshot {
  let activeIncidentCount = 0;
  let highestImpact: StatusIncidentImpact | undefined;

  for (const incident of input.incidents) {
    if (!activeIncidentLifecycles.has(incident.status) || !isStatusIncidentImpact(incident.impact)) {
      continue;
    }

    activeIncidentCount += 1;
    if (highestImpact === undefined || impactOrder[incident.impact] > impactOrder[highestImpact]) {
      highestImpact = incident.impact;
    }
  }

  if (highestImpact !== undefined) {
    const incidentSnapshot = {
      familyId: "status",
      activeIncidentCount,
      highestImpact,
      fetchedAtEpochMs: input.fetchedAtEpochMs,
    } as const;
    return input.providerId === "openai-api"
      ? {
          ...incidentSnapshot,
          providerId: input.providerId,
          providerStatusIndicator: input.providerStatusIndicator,
        }
      : { ...incidentSnapshot, providerId: input.providerId };
  }

  const operationalSnapshot = {
    familyId: "status",
    activeIncidentCount: 0,
    fetchedAtEpochMs: input.fetchedAtEpochMs,
  } as const;
  return input.providerId === "openai-api"
    ? {
        ...operationalSnapshot,
        providerId: input.providerId,
        providerStatusIndicator: input.providerStatusIndicator,
      }
    : { ...operationalSnapshot, providerId: input.providerId };
}

export function buildStatusDisplayInput(snapshot: StatusDisplaySnapshotInput): StatusPolicyResult<StatusDisplayInput> {
  if (!Number.isSafeInteger(snapshot.activeIncidentCount) || snapshot.activeIncidentCount < 0) {
    return { ok: false, reason: "invalid-status-snapshot" };
  }

  const isOpenAI = snapshot.providerId === "openai-api";
  if ((isOpenAI && snapshot.providerStatusIndicator === undefined) || (!isOpenAI && snapshot.providerStatusIndicator !== undefined)) {
    return { ok: false, reason: "invalid-status-snapshot" };
  }

  if (snapshot.activeIncidentCount > 0) {
    if (snapshot.highestImpact === undefined) {
      return { ok: false, reason: "invalid-status-snapshot" };
    }

    const incidentTone = statusToneByImpact[snapshot.highestImpact];
    const providerTone = snapshot.providerStatusIndicator === undefined
      ? "operational"
      : statusToneByIndicator[snapshot.providerStatusIndicator];

    return {
      ok: true,
      value: {
        actionFamilyId: "status",
        providerId: snapshot.providerId,
        activeIncidentCount: snapshot.activeIncidentCount,
        highestImpact: snapshot.highestImpact,
        ...(snapshot.providerStatusIndicator === undefined
          ? {}
          : { providerStatusIndicator: snapshot.providerStatusIndicator }),
        tone: worseStatusTone(incidentTone, providerTone),
        valueText: String(snapshot.activeIncidentCount),
        fetchedAtEpochMs: snapshot.fetchedAtEpochMs,
      },
    };
  }

  if (snapshot.highestImpact !== undefined) {
    return { ok: false, reason: "invalid-status-snapshot" };
  }

  return {
    ok: true,
    value: {
      actionFamilyId: "status",
      providerId: snapshot.providerId,
      activeIncidentCount: 0,
      ...(snapshot.providerStatusIndicator === undefined
        ? {}
        : { providerStatusIndicator: snapshot.providerStatusIndicator }),
      tone: snapshot.providerStatusIndicator === undefined
        ? "operational"
        : statusToneByIndicator[snapshot.providerStatusIndicator],
      valueText: "0",
      fetchedAtEpochMs: snapshot.fetchedAtEpochMs,
    },
  };
}

export function buildStatusRendererInput(input: BuildStatusRendererInputOptions): StatusDisplayRendererInput {
  const snapshot = input.schedulerOutput.snapshot;
  const displayInput =
    snapshot?.familyId === "status" && snapshot.providerId === input.providerId ? buildStatusDisplayInput(snapshot) : undefined;
  const option = resolveStatusProviderOption(input.providerId);

  return buildDisplayStatusRendererInput({
    schedulerOutput: input.schedulerOutput,
    providerId: input.providerId,
    headerLabel: option?.pickerLabel ?? input.providerId,
    ...(displayInput?.ok === true ? { statusDisplayInput: displayInput.value } : {}),
  });
}

const activeIncidentLifecycles: ReadonlySet<IncidentLifecycle> = new Set<ActiveIncidentLifecycle>(
  ACTIVE_INCIDENT_LIFECYCLES,
);

function isStatusIncidentImpact(impact: IncidentImpact): impact is StatusIncidentImpact {
  return impact !== "maintenance";
}

const impactOrder = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
} as const satisfies Readonly<Record<StatusIncidentImpact, number>>;

const statusToneByImpact = {
  none: "informational",
  minor: "warning",
  major: "critical",
  critical: "critical",
} as const satisfies Readonly<Record<StatusIncidentImpact, StatusTone>>;

const statusToneByIndicator = {
  none: "operational",
  maintenance: "informational",
  minor: "warning",
  major: "critical",
  critical: "critical",
} as const satisfies Readonly<Record<ProviderStatusIndicator, StatusTone>>;

const statusToneOrder = {
  operational: 0,
  informational: 1,
  warning: 2,
  critical: 3,
} as const satisfies Readonly<Record<StatusTone, number>>;

function worseStatusTone(first: StatusTone, second: StatusTone): StatusTone {
  return statusToneOrder[first] >= statusToneOrder[second] ? first : second;
}

function statusProviderOption(resolved: ResolvedProviderCapability<"status">): StatusProviderOption | undefined {
  if (!isStatusProviderId(resolved.providerId)) {
    return undefined;
  }

  const behavior = IMPLEMENTATION_STATUS_BEHAVIOR[resolved.capability.implementationStatus];

  return {
    providerId: resolved.providerId,
    productLabel: resolved.productLabel,
    pickerLabel: resolved.pickerLabel,
    actionFamilyId: "status",
    adapterBindingId: resolved.capability.adapterBindingId,
    credentialClass: resolved.capability.credentialClass,
    implementationStatus: resolved.capability.implementationStatus,
    sourceProofStatus: resolved.capability.sourceProofStatus,
    fetchAllowed: behavior.fetchAllowed,
    selectionEligible: behavior.selectionEligible,
  };
}

const statusProviderIds: ReadonlySet<string> = new Set(STATUS_PROVIDER_IDS);

function isStatusProviderId(providerId: string): providerId is StatusProviderId {
  return statusProviderIds.has(providerId);
}
