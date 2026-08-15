import type { StatusSourceDescriptor } from "../index.js";

export const openAiApiStatusSourceDescriptor = {
  providerId: "openai-api",
  endpointUrl: "https://status.openai.com/api/v2/summary.json",
  rateLimitDomain: "status.openai.com",
  sourceIdentity: "public-status-summary",
} as const satisfies StatusSourceDescriptor;
