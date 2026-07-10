/**
 * Registry implementation status (spec-verbatim terms): prevents stale or
 * broken provider selections by making unproven capabilities honest.
 */
export const IMPLEMENTATION_STATUSES = [
  "implemented",
  "probeRequired",
  "docsOnly",
  "unsupported",
  "notImplemented",
] as const;
export type ImplementationStatus = (typeof IMPLEMENTATION_STATUSES)[number];
