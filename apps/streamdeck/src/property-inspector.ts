import { listBalanceProviderOptions, type BalanceProviderOption } from "@ai-workbench/action-balance";
import { listUsageProviderOptions, type UsageProviderOption } from "@ai-workbench/action-usage";
import type { ActionFamilyId, CredentialClass } from "@ai-workbench/contracts";

/**
 * Registry-derived Property Inspector vocabulary. The live panels are static
 * sdpi documents; these
 * option views exist so parity-guard tests can assert the static panels stay
 * in lockstep with the provider registry — labels, ordering, supported
 * windows, credential copy, and guidance all have one catalog source.
 */

type ProviderOptionPresentation = NonNullable<UsageProviderOption["presentation"]>;

export type PropertyInspectorProviderOption =
  | {
      readonly providerId: UsageProviderOption["providerId"];
      readonly productLabel: string;
      readonly actionFamilyId: "usage";
      readonly supportedWindows: UsageProviderOption["supportedWindows"];
      readonly credentialClass?: CredentialClass;
      readonly credentialLabel?: string;
      readonly credentialPlaceholder?: string;
      readonly presentation?: PropertyInspectorPresentation;
      readonly selectionEligible: boolean;
    }
  | {
      readonly providerId: BalanceProviderOption["providerId"];
      readonly productLabel: string;
      readonly actionFamilyId: "balance";
      readonly metricKind: BalanceProviderOption["metricKind"];
      readonly metricDirection: BalanceProviderOption["metricDirection"];
      readonly unit: BalanceProviderOption["unit"];
      readonly displayBasis: BalanceProviderOption["displayBasis"];
      readonly coverageKind: BalanceProviderOption["coverageKind"];
      readonly credentialClass?: CredentialClass;
      readonly credentialLabel?: string;
      readonly credentialPlaceholder?: string;
      readonly presentation?: PropertyInspectorPresentation;
      readonly selectionEligible: boolean;
    };

/** Non-secret provider presentation copy mirrored by the static panels. */
export interface PropertyInspectorPresentation {
  readonly guidance?: string;
  readonly unitShortLabel?: string;
}

export function listProviderOptionsForFamily(familyId: ActionFamilyId): readonly PropertyInspectorProviderOption[] {
  return familyId === "usage"
    ? listUsageProviderOptions().map(toPropertyInspectorProviderOption)
    : listBalanceProviderOptions().map(toPropertyInspectorProviderOption);
}

function toPropertyInspectorProviderOption(option: UsageProviderOption): PropertyInspectorProviderOption;
function toPropertyInspectorProviderOption(option: BalanceProviderOption): PropertyInspectorProviderOption;
function toPropertyInspectorProviderOption(option: UsageProviderOption | BalanceProviderOption): PropertyInspectorProviderOption {
  const credential = credentialPresentationForOption(option);
  const presentation = presentationForOption(option.presentation);

  if (option.actionFamilyId === "usage") {
    return {
      providerId: option.providerId,
      productLabel: option.productLabel,
      actionFamilyId: option.actionFamilyId,
      supportedWindows: option.supportedWindows,
      selectionEligible: option.selectionEligible,
      ...credential,
      ...(presentation === undefined ? {} : { presentation }),
    };
  }

  return {
    providerId: option.providerId,
    productLabel: option.productLabel,
    actionFamilyId: option.actionFamilyId,
    metricKind: option.metricKind,
    metricDirection: option.metricDirection,
    unit: option.unit,
    displayBasis: option.displayBasis,
    coverageKind: option.coverageKind,
    selectionEligible: option.selectionEligible,
    ...credential,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

function presentationForOption(presentation: ProviderOptionPresentation | undefined): PropertyInspectorPresentation | undefined {
  if (presentation === undefined) {
    return undefined;
  }

  const guidance = presentation.guidance;
  const unitShortLabel = presentation.unitShortLabel;
  if (guidance === undefined && unitShortLabel === undefined) {
    return undefined;
  }
  return {
    ...(guidance === undefined ? {} : { guidance }),
    ...(unitShortLabel === undefined ? {} : { unitShortLabel }),
  };
}

function credentialPresentationForOption(option: UsageProviderOption | BalanceProviderOption):
  | {
      readonly credentialClass: CredentialClass;
      readonly credentialLabel: string;
      readonly credentialPlaceholder: string;
    }
  | Record<string, never> {
  const credentialClass = option.credentialClasses.find(
    (candidate) => candidate === "plugin-api-key" || candidate === "admin-api-credential",
  );
  if (credentialClass === undefined) {
    return {};
  }

  // Provider-specific labels/placeholders come from the catalog presentation
  // metadata (old working plugin copy); the generic form is the fallback.
  return {
    credentialClass,
    credentialLabel: option.presentation?.credentialLabel ?? credentialLabelForOption(option.productLabel, credentialClass),
    credentialPlaceholder: option.presentation?.credentialPlaceholder ?? credentialPlaceholderForClass(credentialClass),
  };
}

function credentialLabelForOption(productLabel: string, credentialClass: CredentialClass): string {
  return credentialClass === "admin-api-credential" ? `${productLabel} Admin Key` : `${productLabel} API Key`;
}

function credentialPlaceholderForClass(credentialClass: CredentialClass): string {
  return credentialClass === "admin-api-credential" ? "Admin API key" : "API key";
}
