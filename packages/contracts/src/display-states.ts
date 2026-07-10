/**
 * Display states: the complete honest key-state vocabulary from the approved
 * spec Data Concepts. A failing source must degrade into one of these; it
 * must never collapse into a silently frozen value.
 */
export const DISPLAY_STATES = [
  "fresh",
  "stale",
  "missing-credentials",
  "invalid-credentials",
  "unauthorized-expired",
  "rate-limited",
  "timeout",
  "network-failure",
  "provider-unavailable",
  "validation-drift",
  "unsupported-capability",
  "no-data-yet",
  "not-implemented",
  "settings-invalid",
  "unknown-sanitized-failure",
] as const;
export type DisplayState = (typeof DISPLAY_STATES)[number];
