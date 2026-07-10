import type { CoverageKind, UsageWindowId } from "./metrics.js";

/**
 * Action families: capability groups exposed as Stream Deck actions.
 * Usage and Balance are the first families, not the limit of the model.
 */
export const ACTION_FAMILY_IDS = ["usage", "balance"] as const;
export type ActionFamilyId = (typeof ACTION_FAMILY_IDS)[number];

/** Usage-family capability shape: which rolling windows a provider capability supports. */
export interface UsageCapability {
  readonly familyId: "usage";
  readonly supportedWindows: readonly UsageWindowId[];
}

/** Balance-family capability shape: which coverage span the provider truth describes. */
export interface BalanceCapability {
  readonly familyId: "balance";
  readonly coverageKind: CoverageKind;
}

/**
 * Extensibility seam: family-specific capability shapes are keyed by family
 * id. A future action family adds its id to ACTION_FAMILY_IDS and one key
 * here instead of rewriting shared contracts.
 */
export interface ActionFamilyCapabilityShapes {
  readonly usage: UsageCapability;
  readonly balance: BalanceCapability;
}

export type ActionFamilyCapability<F extends ActionFamilyId = ActionFamilyId> = ActionFamilyCapabilityShapes[F];

/** Compile-time guard: the capability seam must cover every declared family id. */
type AssertCoversFamilies<T extends Readonly<Record<ActionFamilyId, { readonly familyId: ActionFamilyId }>>> = T;
type _CapabilityShapesCoverFamilies = AssertCoversFamilies<ActionFamilyCapabilityShapes>;
