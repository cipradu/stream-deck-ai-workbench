import type { StatusSourceDescriptor } from "../index.js";

export const moonshotStatusSourceDescriptor = {
  providerId: "moonshot",
  endpointUrl: "https://status.moonshot.cn/api/v2/summary.json",
  rateLimitDomain: "status.moonshot.cn",
  sourceIdentity: "public-status-summary",
} as const satisfies StatusSourceDescriptor;
