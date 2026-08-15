import type { StatusSourceDescriptor } from "../index.js";

export const minimaxStatusSourceDescriptor = {
  providerId: "minimax",
  endpointUrl: "https://status.minimax.io/api/v2/summary.json",
  rateLimitDomain: "status.minimax.io",
  sourceIdentity: "public-status-summary",
} as const satisfies StatusSourceDescriptor;
