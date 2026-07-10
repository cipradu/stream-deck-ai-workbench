import type { ActionFamilyId } from "./action-family.js";
import type { CredentialProfileReference } from "./credentials.js";
import type { ProviderId } from "./providers.js";

/**
 * Refresh interval policy constants (approved spec retry/refresh defaults).
 * Intervals are expressed in seconds; values outside the bounds are settings
 * validation failures. Enforcement lives in the central settings boundary.
 */
export const REFRESH_INTERVAL_DEFAULT_SECONDS = 600;
export const REFRESH_INTERVAL_MIN_SECONDS = 60;
export const REFRESH_INTERVAL_MAX_SECONDS = 3600;

/**
 * Usage numeric display mode: `remaining` shows 100 - percentUsed as the
 * center value; the progress bar fill and severity basis stay percent used.
 */
export const USAGE_DISPLAY_MODES = ["used", "remaining"] as const;
export type UsageDisplayMode = (typeof USAGE_DISPLAY_MODES)[number];

/** Non-secret display preferences held in per-action settings. */
export interface DisplayPreferences {
  readonly usageDisplayMode?: UsageDisplayMode;
  readonly label?: string;
}

/**
 * Opaque, non-secret reference to a severity threshold profile owned by the
 * central settings boundary.
 */
export interface SeverityProfileReference {
  readonly kind: "severity-profile";
  readonly profileId: string;
}

/**
 * Validated per-action settings view supplied by the central settings
 * boundary to downstream code. Views carry selection references and
 * non-secret preferences only — never secret material. Where each field is
 * stored is the settings boundary's concern; this is the consumed shape.
 */
export interface ActionSettingsView {
  readonly familyId: ActionFamilyId;
  readonly providerId: ProviderId;
  /** Validated against REFRESH_INTERVAL_MIN/MAX; defaulted to REFRESH_INTERVAL_DEFAULT_SECONDS when unset. */
  readonly refreshIntervalSeconds: number;
  readonly displayPreferences: DisplayPreferences;
  readonly credentialProfileRef?: CredentialProfileReference;
  readonly severityProfileRef?: SeverityProfileReference;
}
