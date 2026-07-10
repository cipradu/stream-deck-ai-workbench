import { Option, Redacted, Schema } from "effect";

import type { CredentialClass, ProviderId } from "@ai-workbench/contracts";
import { createSanitizedFailure } from "@ai-workbench/errors";
import type { ProviderCredentialResolution } from "@ai-workbench/provider-adapters";
import {
  CredentialMaterialSchema,
  isHeaderSafeCredentialValue,
  parseGlobalSettings,
  type NormalizedActionSettingsView,
} from "@ai-workbench/settings";

export function resolveCredentialMaterialFromGlobalSettings(input: {
  readonly actionSettings: NormalizedActionSettingsView;
  readonly globalSettings: unknown;
}): ProviderCredentialResolution {
  const credentialProfileRef = input.actionSettings.credentialProfileRef;
  if (credentialProfileRef === undefined) {
    return missingCredential("credential-profile-ref-missing");
  }

  const parsed = parseGlobalSettings(input.globalSettings);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: parsed.failure,
    };
  }

  const safeProfile = parsed.value.credentialProfiles.find(
    (profile) =>
      profile.actionFamilyId === input.actionSettings.familyId &&
      profile.providerId === input.actionSettings.providerId &&
      profile.credentialClass === credentialProfileRef.credentialClass &&
      profile.profileId === credentialProfileRef.profileId,
  );
  if (safeProfile === undefined) {
    return missingCredential("credential-profile-not-found");
  }
  if (!safeProfile.credentialPresent) {
    return missingCredential("credential-material-missing");
  }

  const rawProfile = findRawCredentialProfile(input.globalSettings, {
    credentialClass: credentialProfileRef.credentialClass,
    profileId: credentialProfileRef.profileId,
    providerId: input.actionSettings.providerId,
  });
  const decoded = decodeCredentialSecret(rawProfile);
  if (!decoded.ok) {
    return decoded.reason === "invalid-format"
      ? invalidCredential("credential-format-invalid")
      : missingCredential("credential-material-missing");
  }

  return {
    ok: true,
    value: {
      value: decoded.value,
    },
  };
}

function findRawCredentialProfile(
  globalSettings: unknown,
  identity: {
    readonly providerId: ProviderId;
    readonly credentialClass: CredentialClass;
    readonly profileId: string;
  },
): unknown {
  if (!isRecord(globalSettings) || !Array.isArray(globalSettings.credentialProfiles)) {
    return undefined;
  }

  return globalSettings.credentialProfiles.find(
    (profile) =>
      isRecord(profile) &&
      profile.providerId === identity.providerId &&
      profile.credentialClass === identity.credentialClass &&
      profile.profileId === identity.profileId,
  );
}

type DecodedCredentialSecret =
  | { readonly ok: true; readonly value: Redacted.Redacted<string> }
  | { readonly ok: false; readonly reason: "missing" | "invalid-format" };

// The credential secret is parsed from `unknown` THROUGH the settings
// `CredentialMaterialSchema` (a `Schema.Redacted(Schema.String)` value), replacing the
// previous hand-rolled `typeof value === "string"` bypass. It therefore leaves this
// boundary already wrapped as `Redacted<string>`, never as a raw string. The decode
// returns a discriminated result so the caller can distinguish a genuinely missing secret
// from a present-but-malformed one. A whitespace-only secret stays `missing`:
// the settings `credentialPresent` gate rejects only the exactly-empty value, so — matching
// the retired live-http trim — an all-whitespace key is treated as missing rather than sent
// to a provider. A present secret whose bytes are not valid in an HTTP header value (an
// internal line break or a non-Latin-1 char from a corrupted paste) is classified
// `invalid-format`; the caller maps that to the `invalid-credentials` state instead of
// letting the value throw synchronously inside the provider fetch and surface as a
// misleading network failure.
function decodeCredentialSecret(profile: unknown): DecodedCredentialSecret {
  if (!isRecord(profile)) {
    return { ok: false, reason: "missing" };
  }

  const material = Option.getOrUndefined(
    Schema.decodeUnknownOption(CredentialMaterialSchema)(profile.credentialMaterial),
  );
  const value = material?.value;
  if (value === undefined) {
    return { ok: false, reason: "missing" };
  }

  // Unwrap once, solely to run the boolean whitespace + header-safety tests, then discard
  // the raw read: it is never logged, stored, or returned as a raw string. An
  // all-whitespace secret stays `missing`. `isHeaderSafeCredentialValue` runs on the raw
  // value (Node keeps a leading BOM / control char that `String.prototype.trim` would hide)
  // and is `Schema.is`-backed, so no ParseError carrying the value is ever built.
  const raw = Redacted.value(value);
  if (raw.trim().length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (!isHeaderSafeCredentialValue(raw)) {
    return { ok: false, reason: "invalid-format" };
  }
  // Return the ORIGINAL Redacted value untrimmed: Node trims trailing header whitespace at
  // fetch time, and the single-unwrap-site invariant forwards the plain Redacted
  // onward unmodified.
  return { ok: true, value };
}

function missingCredential(reasonCode: string): ProviderCredentialResolution {
  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "missing-credentials",
      diagnostics: {
        boundary: "streamdeck-credentials",
        issueCount: 1,
        reasonCode,
      },
      provider: {
        failureClass: "credentials",
        reasonCode,
      },
    }),
  };
}

// A present credential whose material cannot be safely forwarded as an HTTP header value
// (header-unsafe bytes from a corrupted paste). Mirrors `missingCredential` but with the
// existing `invalid-credentials` category so the key shows the clear "Provider credentials
// are invalid." state and the credential-settings-refresh retry class. Diagnostics carry
// only the static `reasonCode` + boundary — never any credential content.
function invalidCredential(reasonCode: string): ProviderCredentialResolution {
  return {
    ok: false,
    failure: createSanitizedFailure({
      category: "invalid-credentials",
      diagnostics: {
        boundary: "streamdeck-credentials",
        issueCount: 1,
        reasonCode,
      },
      provider: {
        failureClass: "credentials",
        reasonCode,
      },
    }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
