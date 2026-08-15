import type { StatusSourceDescriptor } from "../index.js";

export const anthropicApiStatusSourceDescriptor = {
  providerId: "anthropic-api",
  endpointUrl: "https://status.claude.com/api/v2/summary.json",
  rateLimitDomain: "status.claude.com",
  sourceIdentity: "public-status-summary",
} as const satisfies StatusSourceDescriptor;
