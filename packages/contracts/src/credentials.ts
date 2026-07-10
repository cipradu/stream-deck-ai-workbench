/**
 * Credential classes: distinct typed classes, never one generic
 * API-key string.
 *
 * - `plugin-api-key`: plugin-owned provider API key held behind the global
 *   settings boundary.
 * - `admin-api-credential`: admin/organization-scoped API credential (for
 *   example Anthropic/OpenAI admin usage credentials).
 * - `local-read-only-source`: read-only local credential source (for example
 *   coding-tool credential stores); monitoring must never write to it.
 * - `mcp-mediated-source`: credential/quota truth mediated through an
 *   MCP/plugin surface rather than a direct key.
 * - `sensitive-routing-selector`: sensitive routing/account selector stored
 *   behind global settings and referenced by class, never by value.
 * - `none`: the capability needs no credential.
 */
export const CREDENTIAL_CLASSES = [
  "plugin-api-key",
  "admin-api-credential",
  "local-read-only-source",
  "mcp-mediated-source",
  "sensitive-routing-selector",
  "none",
] as const;
export type CredentialClass = (typeof CREDENTIAL_CLASSES)[number];

/**
 * Opaque, non-secret reference to a credential profile owned by the central
 * settings boundary. `profileId` is a plugin-generated reference; it must
 * never be a key, token, email, or account/team/project/organization/routing
 * identifier.
 */
export interface CredentialProfileReference {
  readonly kind: "credential-profile";
  readonly credentialClass: CredentialClass;
  readonly profileId: string;
}
