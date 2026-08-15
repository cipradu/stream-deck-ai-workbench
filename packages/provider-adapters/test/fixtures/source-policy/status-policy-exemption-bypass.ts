// A comment or copied declaration name must not authorize this non-production path.
const anthropicApiStatusSourceDescriptor = {
  providerId: "anthropic-api",
  endpointUrl: "https://status.claude.com/api/v2/summary.json",
} as const;

export function createStatusSourceFetchEffect(): Readonly<Record<string, unknown>> {
  const descriptor = anthropicApiStatusSourceDescriptor;
  return { url: descriptor.endpointUrl };
}
