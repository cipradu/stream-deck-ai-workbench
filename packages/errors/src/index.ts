import { Data, Effect } from "effect";

import type { DisplayState, ErrorCategory, RetryClass } from "@ai-workbench/contracts";

export const packageName = "@ai-workbench/errors" as const;

export const HTTP_STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"] as const;
export type HttpStatusClass = (typeof HTTP_STATUS_CLASSES)[number];

export const PROVIDER_FAILURE_CLASSES = [
  "credentials",
  "authorization",
  "insufficient-scope",
  "rate-limit",
  "timeout",
  "abort",
  "network",
  "http-status",
  "provider-unavailable",
  "validation",
  "unsupported",
  "no-data",
  "stale-cache",
  "not-implemented",
  "probe-required",
  "settings",
  "unknown",
] as const;
export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

export const ERROR_CATEGORY_DISPLAY_STATE = {
  "missing-credentials": "missing-credentials",
  "invalid-credentials": "invalid-credentials",
  "insufficient-credential-scope": "invalid-credentials",
  "unauthorized-expired": "unauthorized-expired",
  "rate-limited": "rate-limited",
  timeout: "timeout",
  abort: "provider-unavailable",
  "network-failure": "network-failure",
  "http-status-failure": "provider-unavailable",
  "provider-unavailable": "provider-unavailable",
  "validation-drift": "validation-drift",
  "unsupported-capability": "unsupported-capability",
  "no-data-yet": "no-data-yet",
  "stale-cached-value": "stale",
  "not-implemented": "not-implemented",
  "probe-required": "not-implemented",
  "settings-validation-failure": "settings-invalid",
  "unknown-sanitized-failure": "unknown-sanitized-failure",
} as const satisfies Readonly<Record<ErrorCategory, DisplayState>>;

export const ERROR_CATEGORY_RETRY_CLASS = {
  "missing-credentials": "credential-settings-refresh",
  "invalid-credentials": "credential-settings-refresh",
  "insufficient-credential-scope": "credential-settings-refresh",
  "unauthorized-expired": "credential-settings-refresh",
  "rate-limited": "rate-limit-backoff",
  timeout: "transient-retry",
  abort: "transient-retry",
  "network-failure": "transient-retry",
  "http-status-failure": "transient-retry",
  "provider-unavailable": "transient-retry",
  "validation-drift": "rate-limit-backoff",
  "unsupported-capability": "no-retry",
  "no-data-yet": "healthy-poll",
  "stale-cached-value": "healthy-poll",
  "not-implemented": "no-retry",
  "probe-required": "probe-gated",
  "settings-validation-failure": "credential-settings-refresh",
  "unknown-sanitized-failure": "transient-retry",
} as const satisfies Readonly<Record<ErrorCategory, RetryClass>>;

export const ERROR_CATEGORY_PUBLIC_MESSAGES = {
  "missing-credentials": "Provider credentials are missing.",
  "invalid-credentials": "Provider credentials are invalid.",
  "insufficient-credential-scope": "Provider credentials lack the required access or scope. Check access or scope.",
  "unauthorized-expired": "Provider authorization expired or was rejected. Reauthorize or update credentials.",
  "rate-limited": "Provider rate limit is active. Retry follows the current policy.",
  timeout: "Provider request timed out.",
  abort: "Provider request was aborted.",
  "network-failure": "Provider network request failed.",
  "http-status-failure": "Provider returned an unsupported HTTP status.",
  "provider-unavailable": "Provider is unavailable.",
  "validation-drift": "Provider response validation failed.",
  "unsupported-capability": "Provider capability is unsupported.",
  "no-data-yet": "No provider data is available yet.",
  "stale-cached-value": "Cached provider data is stale.",
  "not-implemented": "Provider capability is not implemented.",
  "probe-required": "Provider capability requires an approved probe before activation.",
  "settings-validation-failure": "Settings validation failed.",
  "unknown-sanitized-failure": "Unknown sanitized failure.",
} as const satisfies Readonly<Record<ErrorCategory, string>>;

export const RESPONSE_DIAGNOSTIC_RECEIVED_TYPES = [
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
] as const;
export type ResponseDiagnosticReceivedType = (typeof RESPONSE_DIAGNOSTIC_RECEIVED_TYPES)[number];

export const RESPONSE_DIAGNOSTIC_EXPECTED_TYPES = ["object", "string", "number", "number-or-null"] as const;
export type ResponseDiagnosticExpectedType = (typeof RESPONSE_DIAGNOSTIC_EXPECTED_TYPES)[number];

export const RESPONSE_DIAGNOSTIC_CODES = [
  "response-body-unreadable",
  "response-body-too-large",
  "response-body-empty",
  "response-body-not-json",
  "response-json-schema-mismatch",
  "claude-code-usage-root-not-object",
  "claude-code-usage-five-hour-not-object",
  "claude-code-usage-five-hour-utilization-invalid",
  "claude-code-usage-five-hour-resets-at-invalid",
  "claude-code-usage-seven-day-not-object",
  "claude-code-usage-seven-day-utilization-invalid",
  "claude-code-usage-seven-day-resets-at-invalid",
] as const;
export type ResponseDiagnosticCode = (typeof RESPONSE_DIAGNOSTIC_CODES)[number];

export interface ResponseDiagnosticCatalogEntry {
  readonly expectedType?: ResponseDiagnosticExpectedType;
  readonly receivedTypes?: readonly ResponseDiagnosticReceivedType[];
}

interface ResponseDiagnosticCatalogDefinition extends ResponseDiagnosticCatalogEntry {
  readonly receivedTypeSelector?: readonly string[];
}

const RESPONSE_DIAGNOSTIC_ENTRY_NONE = Object.freeze({});
const RESPONSE_DIAGNOSTIC_ENTRY_NOT_OBJECT = Object.freeze({
  expectedType: "object" as const,
  receivedTypes: Object.freeze(["array", "boolean", "null", "number", "string"] as const),
});
const RESPONSE_DIAGNOSTIC_ENTRY_UTILIZATION = Object.freeze({
  expectedType: "number-or-null" as const,
  receivedTypes: Object.freeze(["array", "boolean", "object", "string"] as const),
});
const RESPONSE_DIAGNOSTIC_ENTRY_RESETS_AT = Object.freeze({
  expectedType: "string" as const,
  receivedTypes: Object.freeze(["array", "boolean", "null", "number", "object"] as const),
});

const RESPONSE_DIAGNOSTIC_ROOT_SELECTOR = Object.freeze([] as const);
const RESPONSE_DIAGNOSTIC_FIVE_HOUR_SELECTOR = Object.freeze(["five_hour"] as const);
const RESPONSE_DIAGNOSTIC_FIVE_HOUR_UTILIZATION_SELECTOR = Object.freeze(["five_hour", "utilization"] as const);
const RESPONSE_DIAGNOSTIC_FIVE_HOUR_RESETS_AT_SELECTOR = Object.freeze(["five_hour", "resets_at"] as const);
const RESPONSE_DIAGNOSTIC_SEVEN_DAY_SELECTOR = Object.freeze(["seven_day"] as const);
const RESPONSE_DIAGNOSTIC_SEVEN_DAY_UTILIZATION_SELECTOR = Object.freeze(["seven_day", "utilization"] as const);
const RESPONSE_DIAGNOSTIC_SEVEN_DAY_RESETS_AT_SELECTOR = Object.freeze(["seven_day", "resets_at"] as const);

const RESPONSE_DIAGNOSTIC_CATALOG_DEFINITIONS: Readonly<
  Record<ResponseDiagnosticCode, ResponseDiagnosticCatalogDefinition>
> = Object.freeze({
  "response-body-unreadable": RESPONSE_DIAGNOSTIC_ENTRY_NONE,
  "response-body-too-large": RESPONSE_DIAGNOSTIC_ENTRY_NONE,
  "response-body-empty": RESPONSE_DIAGNOSTIC_ENTRY_NONE,
  "response-body-not-json": RESPONSE_DIAGNOSTIC_ENTRY_NONE,
  "response-json-schema-mismatch": RESPONSE_DIAGNOSTIC_ENTRY_NONE,
  "claude-code-usage-root-not-object": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_NOT_OBJECT,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_ROOT_SELECTOR,
  }),
  "claude-code-usage-five-hour-not-object": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_NOT_OBJECT,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_FIVE_HOUR_SELECTOR,
  }),
  "claude-code-usage-five-hour-utilization-invalid": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_UTILIZATION,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_FIVE_HOUR_UTILIZATION_SELECTOR,
  }),
  "claude-code-usage-five-hour-resets-at-invalid": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_RESETS_AT,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_FIVE_HOUR_RESETS_AT_SELECTOR,
  }),
  "claude-code-usage-seven-day-not-object": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_NOT_OBJECT,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_SEVEN_DAY_SELECTOR,
  }),
  "claude-code-usage-seven-day-utilization-invalid": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_UTILIZATION,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_SEVEN_DAY_UTILIZATION_SELECTOR,
  }),
  "claude-code-usage-seven-day-resets-at-invalid": Object.freeze({
    ...RESPONSE_DIAGNOSTIC_ENTRY_RESETS_AT,
    receivedTypeSelector: RESPONSE_DIAGNOSTIC_SEVEN_DAY_RESETS_AT_SELECTOR,
  }),
} satisfies Readonly<Record<ResponseDiagnosticCode, ResponseDiagnosticCatalogDefinition>>);

export const RESPONSE_DIAGNOSTIC_CATALOG: Readonly<Record<ResponseDiagnosticCode, ResponseDiagnosticCatalogEntry>> = Object.freeze(
  Object.fromEntries(
    RESPONSE_DIAGNOSTIC_CODES.map((code) => {
      const { receivedTypeSelector: _selector, ...entry } = RESPONSE_DIAGNOSTIC_CATALOG_DEFINITIONS[code];
      return [code, Object.freeze(entry)];
    }),
  ) as Record<ResponseDiagnosticCode, ResponseDiagnosticCatalogEntry>,
);

/** Returns only a finite catalog-owned static selector for a structural diagnostic. */
export function getResponseDiagnosticReceivedTypeSelector(code: unknown): readonly string[] | undefined {
  if (typeof code !== "string" || !hasOwn(RESPONSE_DIAGNOSTIC_CATALOG_DEFINITIONS, code)) {
    return undefined;
  }
  return RESPONSE_DIAGNOSTIC_CATALOG_DEFINITIONS[code as ResponseDiagnosticCode].receivedTypeSelector;
}

export interface ResponseDiagnosticInput {
  readonly code: ResponseDiagnosticCode;
  readonly receivedType?: ResponseDiagnosticReceivedType;
}

export interface SanitizedResponseDiagnostic {
  readonly code: ResponseDiagnosticCode;
  readonly expectedType?: ResponseDiagnosticExpectedType;
  readonly receivedType?: ResponseDiagnosticReceivedType;
}

/**
 * The only response-diagnostic admission point. It constructs a fresh, finite
 * shape and rejects any field that is not part of the catalog contract.
 */
export function normalizeResponseDiagnostic(input: unknown): SanitizedResponseDiagnostic | undefined {
  try {
    return normalizeResponseDiagnosticUnsafe(input);
  } catch {
    return undefined;
  }
}

function normalizeResponseDiagnosticUnsafe(input: unknown): SanitizedResponseDiagnostic | undefined {
  if (!isPlainRecord(input) || !hasOwn(input, "code") || typeof input.code !== "string") {
    return undefined;
  }

  const code = input.code;
  if (!hasOwn(RESPONSE_DIAGNOSTIC_CATALOG, code)) {
    return undefined;
  }

  const definition = RESPONSE_DIAGNOSTIC_CATALOG_DEFINITIONS[code as ResponseDiagnosticCode];
  if (definition.expectedType === undefined) {
    return hasOnlyKeys(input, ["code"]) ? { code: code as ResponseDiagnosticCode } : undefined;
  }

  if (
    !hasOnlyKeys(input, ["code", "receivedType"]) ||
    !hasOwn(input, "receivedType") ||
    !isResponseDiagnosticReceivedType(input.receivedType) ||
    !definition.receivedTypes?.includes(input.receivedType)
  ) {
    return undefined;
  }

  return {
    code: code as ResponseDiagnosticCode,
    expectedType: definition.expectedType,
    receivedType: input.receivedType,
  };
}

export interface SanitizedFailureDiagnosticsInput {
  readonly reasonCode: string;
  readonly boundary?: string;
  readonly fieldPaths?: readonly string[];
  readonly httpStatus?: number;
  readonly httpStatusClass?: HttpStatusClass;
  readonly issueCount?: number;
  readonly responseDiagnostic?: ResponseDiagnosticInput;
}

export interface SanitizedFailureDiagnostics {
  readonly reasonCode: string;
  readonly boundary?: string;
  readonly fieldPaths?: readonly string[];
  readonly httpStatus?: number;
  readonly httpStatusClass?: HttpStatusClass;
  readonly issueCount?: number;
  readonly responseDiagnostic?: SanitizedResponseDiagnostic;
}

export interface SanitizedProviderFailure {
  readonly failureClass: ProviderFailureClass;
  readonly reasonCode: string;
}

export interface SanitizedFailure {
  readonly category: ErrorCategory;
  readonly displayState: DisplayState;
  readonly retryClass: RetryClass;
  readonly safePublicMessage: string;
  readonly diagnostics: SanitizedFailureDiagnostics;
  readonly provider?: SanitizedProviderFailure;
  readonly sanitized: true;
}

export interface CreateSanitizedFailureInput {
  readonly category: ErrorCategory;
  readonly diagnostics: SanitizedFailureDiagnosticsInput;
  readonly provider?: SanitizedProviderFailure;
  readonly cause?: unknown;
}

export type ProviderFailureInput =
  | {
      readonly kind: "http-status";
      readonly httpStatus: number;
      readonly providerFailureClass?: ProviderFailureClass;
      readonly reasonCode?: string;
      readonly cause?: unknown;
    }
  | {
      readonly kind:
        | "network"
        | "timeout"
        | "abort"
        | "validation"
        | "unsupported"
        | "no-data"
        | "insufficient-scope"
        | "not-implemented"
        | "probe-required"
        | "unknown";
      readonly providerFailureClass?: ProviderFailureClass;
      readonly reasonCode?: string;
      readonly cause?: unknown;
    };

const privateCauses = new WeakMap<SanitizedFailure, unknown>();

export function createSanitizedFailure(input: CreateSanitizedFailureInput): SanitizedFailure {
  const failure: SanitizedFailure = {
    category: input.category,
    displayState: ERROR_CATEGORY_DISPLAY_STATE[input.category],
    retryClass: ERROR_CATEGORY_RETRY_CLASS[input.category],
    safePublicMessage: ERROR_CATEGORY_PUBLIC_MESSAGES[input.category],
    diagnostics: sanitizeDiagnostics(input.diagnostics),
    ...(input.provider === undefined
      ? {}
      : {
          provider: {
            failureClass: input.provider.failureClass,
            reasonCode: sanitizeReasonCode(input.provider.reasonCode, input.provider.failureClass),
          },
        }),
    sanitized: true,
  };

  if ("cause" in input) {
    privateCauses.set(failure, input.cause);
  }

  return failure;
}

export function mapProviderFailure(input: ProviderFailureInput): SanitizedFailure {
  const category = categoryForProviderFailure(input);
  const reasonCode = sanitizeReasonCode(input.reasonCode, input.kind);
  const failureClass = input.providerFailureClass ?? providerFailureClassForKind(input.kind);

  return createSanitizedFailure({
    category,
    diagnostics: {
      reasonCode,
      ...("httpStatus" in input ? { httpStatus: input.httpStatus } : {}),
    },
    provider: {
      failureClass,
      reasonCode,
    },
    ...("cause" in input ? { cause: input.cause } : {}),
  });
}

export function httpStatusClassOf(status: number): HttpStatusClass {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return "unknown";
  }

  return `${Math.trunc(status / 100)}xx` as HttpStatusClass;
}

function categoryForProviderFailure(input: ProviderFailureInput): ErrorCategory {
  switch (input.kind) {
    case "http-status":
      return categoryForHttpStatus(input.httpStatus);
    case "network":
      return "network-failure";
    case "timeout":
      return "timeout";
    case "abort":
      return "abort";
    case "validation":
      return "validation-drift";
    case "unsupported":
      return "unsupported-capability";
    case "no-data":
      return "no-data-yet";
    case "insufficient-scope":
      return "insufficient-credential-scope";
    case "not-implemented":
      return "not-implemented";
    case "probe-required":
      return "probe-required";
    case "unknown":
      return "unknown-sanitized-failure";
  }
}

function categoryForHttpStatus(status: number): ErrorCategory {
  if (status === 401) {
    return "unauthorized-expired";
  }
  if (status === 403) {
    return "insufficient-credential-scope";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500 && status <= 599) {
    return "provider-unavailable";
  }
  return "http-status-failure";
}

function providerFailureClassForKind(kind: ProviderFailureInput["kind"]): ProviderFailureClass {
  switch (kind) {
    case "http-status":
      return "http-status";
    case "network":
      return "network";
    case "timeout":
      return "timeout";
    case "abort":
      return "abort";
    case "validation":
      return "validation";
    case "unsupported":
      return "unsupported";
    case "no-data":
      return "no-data";
    case "insufficient-scope":
      return "insufficient-scope";
    case "not-implemented":
      return "not-implemented";
    case "probe-required":
      return "probe-required";
    case "unknown":
      return "unknown";
  }
}

function sanitizeDiagnostics(input: SanitizedFailureDiagnosticsInput): SanitizedFailureDiagnostics {
  const responseDiagnosticProvided = hasOwn(input, "responseDiagnostic");
  const responseDiagnostic = normalizeResponseDiagnostic(input.responseDiagnostic);
  const fieldPaths = responseDiagnosticProvided ? [] : sanitizeFieldPaths(input.fieldPaths);
  const httpStatus = safeHttpStatus(input.httpStatus);
  const explicitHttpStatusClass = isHttpStatusClass(input.httpStatusClass) ? input.httpStatusClass : undefined;
  const httpStatusClass = httpStatus === undefined ? explicitHttpStatusClass : httpStatusClassOf(httpStatus);
  const issueCount = input.issueCount === undefined ? undefined : Math.max(0, Math.trunc(input.issueCount));

  return {
    reasonCode: responseDiagnostic?.code ?? (responseDiagnosticProvided ? "unknown" : sanitizeReasonCode(input.reasonCode, "unknown")),
    ...(input.boundary === undefined ? {} : { boundary: sanitizeReasonCode(input.boundary, "boundary") }),
    ...(fieldPaths.length === 0 ? {} : { fieldPaths }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
    ...(issueCount === undefined ? {} : { issueCount }),
    ...(responseDiagnostic === undefined ? {} : { responseDiagnostic }),
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function isResponseDiagnosticReceivedType(input: unknown): input is ResponseDiagnosticReceivedType {
  return typeof input === "string" && (RESPONSE_DIAGNOSTIC_RECEIVED_TYPES as readonly string[]).includes(input);
}

function isHttpStatusClass(input: unknown): input is HttpStatusClass {
  return typeof input === "string" && (HTTP_STATUS_CLASSES as readonly string[]).includes(input);
}

function safeHttpStatus(input: unknown): number | undefined {
  return typeof input === "number" && Number.isInteger(input) && input >= 100 && input <= 599 ? input : undefined;
}

function sanitizeFieldPaths(paths: readonly string[] | undefined): readonly string[] {
  if (paths === undefined) {
    return [];
  }

  const sanitized = paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => path.replace(/[^a-zA-Z0-9_.[\]<>-]/g, "-"))
    .filter((path) => path.length > 0);

  return [...new Set(sanitized)];
}

function sanitizeReasonCode(input: string | undefined, fallback: string): string {
  const source = input?.trim() ?? "";
  if (source.length === 0) {
    return fallback;
  }

  if (/\b(api[-_\s]?key|authorization|bearer|password|secret|token)\b/i.test(source)) {
    return "redacted";
  }

  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return normalized.length === 0 ? fallback : normalized;
}

// ---------------------------------------------------------------------------
// Internal typed error channel.
//
// The taxonomy below is the INTERNAL typed error channel: one `Data.TaggedError`
// class per accepted `ErrorCategory`, handled with `Effect.catchTags` and mapped
// at a single boundary into the PRESERVED plain `SanitizedFailure` contract above.
// Public leaf contracts (display, action families) keep consuming the plain
// contract; the tagged classes never cross that boundary. Each tagged error
// carries only sanitized fields — never raw bodies or `Cause`. `internalCause` is
// retained privately and never reaches the plain contract or any serialized, log,
// or user surface.
// ---------------------------------------------------------------------------

/**
 * Shared sanitized fields carried by every internal tagged error. `reasonCode`
 * is the sanitized, provider-agnostic reason; the remaining fields are optional
 * sanitized diagnostic context. `internalCause` holds the raw underlying cause
 * for internal-only use — it is dropped into the module-private cause registry at
 * the boundary and never appears on the plain `SanitizedFailure`.
 */
export interface SanitizedErrorFields {
  readonly reasonCode: string;
  readonly boundary?: string;
  readonly fieldPaths?: readonly string[];
  readonly httpStatus?: number;
  readonly issueCount?: number;
  readonly providerFailureClass?: ProviderFailureClass;
  readonly internalCause?: unknown;
}

export interface ValidationDriftFields extends SanitizedErrorFields {
  readonly responseDiagnostic?: ResponseDiagnosticInput;
}

const MissingCredentialsBase = Data.TaggedError("MissingCredentials")<SanitizedErrorFields>;
export class MissingCredentials extends MissingCredentialsBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const InvalidCredentialsBase = Data.TaggedError("InvalidCredentials")<SanitizedErrorFields>;
export class InvalidCredentials extends InvalidCredentialsBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const InsufficientCredentialScopeBase = Data.TaggedError(
  "InsufficientCredentialScope",
)<SanitizedErrorFields>;
export class InsufficientCredentialScope extends InsufficientCredentialScopeBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const UnauthorizedExpiredBase = Data.TaggedError("UnauthorizedExpired")<SanitizedErrorFields>;
export class UnauthorizedExpired extends UnauthorizedExpiredBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
type RateLimitedFields = SanitizedErrorFields & { readonly retryAfterSeconds?: number };
const RateLimitedBase = Data.TaggedError("RateLimited")<RateLimitedFields>;
export class RateLimited extends RateLimitedBase {
  constructor(fields: RateLimitedFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const TimeoutBase = Data.TaggedError("Timeout")<SanitizedErrorFields>;
export class Timeout extends TimeoutBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const AbortBase = Data.TaggedError("Abort")<SanitizedErrorFields>;
export class Abort extends AbortBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const NetworkFailureBase = Data.TaggedError("NetworkFailure")<SanitizedErrorFields>;
export class NetworkFailure extends NetworkFailureBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
type HttpStatusFailureFields = SanitizedErrorFields & { readonly statusClass: HttpStatusClass };
const HttpStatusFailureBase = Data.TaggedError("HttpStatusFailure")<HttpStatusFailureFields>;
export class HttpStatusFailure extends HttpStatusFailureBase {
  constructor(fields: HttpStatusFailureFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const ProviderUnavailableBase = Data.TaggedError("ProviderUnavailable")<SanitizedErrorFields>;
export class ProviderUnavailable extends ProviderUnavailableBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const ValidationDriftBase = Data.TaggedError("ValidationDrift")<ValidationDriftFields>;
export class ValidationDrift extends ValidationDriftBase {
  constructor(fields: ValidationDriftFields) {
    super(sanitizeTaggedResponseDiagnostic(fields));
  }
}
const UnsupportedCapabilityBase = Data.TaggedError("UnsupportedCapability")<SanitizedErrorFields>;
export class UnsupportedCapability extends UnsupportedCapabilityBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const NoDataYetBase = Data.TaggedError("NoDataYet")<SanitizedErrorFields>;
export class NoDataYet extends NoDataYetBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const StaleCachedValueBase = Data.TaggedError("StaleCachedValue")<SanitizedErrorFields>;
export class StaleCachedValue extends StaleCachedValueBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const NotImplementedBase = Data.TaggedError("NotImplemented")<SanitizedErrorFields>;
export class NotImplemented extends NotImplementedBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const ProbeRequiredBase = Data.TaggedError("ProbeRequired")<SanitizedErrorFields>;
export class ProbeRequired extends ProbeRequiredBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const SettingsValidationFailureBase = Data.TaggedError("SettingsValidationFailure")<SanitizedErrorFields>;
export class SettingsValidationFailure extends SettingsValidationFailureBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}
const UnknownSanitizedBase = Data.TaggedError("UnknownSanitized")<SanitizedErrorFields>;
export class UnknownSanitized extends UnknownSanitizedBase {
  constructor(fields: SanitizedErrorFields) {
    super(stripUnsafeResponseDiagnostic(fields));
  }
}

/** Union of every internal tagged error; the channel `Effect.catchTags` handles. */
export type SanitizedTaggedError =
  | MissingCredentials
  | InvalidCredentials
  | InsufficientCredentialScope
  | UnauthorizedExpired
  | RateLimited
  | Timeout
  | Abort
  | NetworkFailure
  | HttpStatusFailure
  | ProviderUnavailable
  | ValidationDrift
  | UnsupportedCapability
  | NoDataYet
  | StaleCachedValue
  | NotImplemented
  | ProbeRequired
  | SettingsValidationFailure
  | UnknownSanitized;

export type SanitizedTaggedErrorTag = SanitizedTaggedError["_tag"];

/** Total tag → shared error category map; the boundary mapping's single source. */
export const TAGGED_ERROR_CATEGORY = {
  MissingCredentials: "missing-credentials",
  InvalidCredentials: "invalid-credentials",
  InsufficientCredentialScope: "insufficient-credential-scope",
  UnauthorizedExpired: "unauthorized-expired",
  RateLimited: "rate-limited",
  Timeout: "timeout",
  Abort: "abort",
  NetworkFailure: "network-failure",
  HttpStatusFailure: "http-status-failure",
  ProviderUnavailable: "provider-unavailable",
  ValidationDrift: "validation-drift",
  UnsupportedCapability: "unsupported-capability",
  NoDataYet: "no-data-yet",
  StaleCachedValue: "stale-cached-value",
  NotImplemented: "not-implemented",
  ProbeRequired: "probe-required",
  SettingsValidationFailure: "settings-validation-failure",
  UnknownSanitized: "unknown-sanitized-failure",
} as const satisfies Readonly<Record<SanitizedTaggedErrorTag, ErrorCategory>>;

/**
 * Boundary mapping: internal `Data.TaggedError` → the plain `SanitizedFailure`
 * contract display and action families consume. Delegates to
 * `createSanitizedFailure`, so the plain output shape is identical to every other
 * producer. `internalCause` is handed to the module-private cause registry (never
 * serialized onto the plain contract); `retryAfterSeconds` has no slot on the
 * plain contract and stays on the internal channel for the scheduler; exact safe
 * `httpStatus` and `statusClass` are surfaced as compatible diagnostics. Raw
 * `Cause` never crosses here.
 */
export function taggedFailureToSanitizedFailure(error: SanitizedTaggedError): SanitizedFailure {
  return createSanitizedFailure({
    category: TAGGED_ERROR_CATEGORY[error._tag],
    diagnostics: {
      reasonCode: error.reasonCode,
      ...(error.boundary === undefined ? {} : { boundary: error.boundary }),
      ...(error.fieldPaths === undefined ? {} : { fieldPaths: error.fieldPaths }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
      ...(error._tag === "HttpStatusFailure" ? { httpStatusClass: error.statusClass } : {}),
      ...(error._tag === "ValidationDrift" && error.responseDiagnostic !== undefined
        ? {
            responseDiagnostic: {
              code: error.responseDiagnostic.code,
              ...(error.responseDiagnostic.receivedType === undefined
                ? {}
                : { receivedType: error.responseDiagnostic.receivedType }),
            },
          }
        : {}),
    },
    ...(error.providerFailureClass === undefined
      ? {}
      : { provider: { failureClass: error.providerFailureClass, reasonCode: error.reasonCode } }),
    ...(error.internalCause === undefined ? {} : { cause: error.internalCause }),
  });
}

function stripUnsafeResponseDiagnostic<Fields extends SanitizedErrorFields>(fields: Fields): Fields {
  if (!hasOwn(fields, "responseDiagnostic")) {
    return fields;
  }

  const { responseDiagnostic: _raw, ...rest } = fields as Fields & { readonly responseDiagnostic?: unknown };
  return rest as Fields;
}

function sanitizeTaggedResponseDiagnostic(fields: ValidationDriftFields): ValidationDriftFields {
  if (!hasOwn(fields, "responseDiagnostic")) {
    return fields;
  }

  const responseDiagnostic = normalizeResponseDiagnostic(fields.responseDiagnostic);
  const { fieldPaths: _fieldPaths, internalCause: _internalCause, reasonCode: _reasonCode, responseDiagnostic: _raw, ...rest } =
    fields;

  return {
    ...rest,
    reasonCode: responseDiagnostic?.code ?? "unknown",
    ...(responseDiagnostic === undefined ? {} : { responseDiagnostic }),
  };
}

const failWithSanitizedFailure = (error: SanitizedTaggedError): Effect.Effect<never, SanitizedFailure> =>
  Effect.fail(taggedFailureToSanitizedFailure(error));

/**
 * The single `catchTags` boundary: handle every internal tagged error
 * and re-fail with the plain `SanitizedFailure` the display/action layers consume.
 * The explicit `SanitizedFailure` error return type keeps tag coverage exhaustive
 * at compile time — omitting a tag leaves a tagged error in the residual channel,
 * which no longer matches this signature.
 */
export function catchAllTaggedFailures<A, R>(
  effect: Effect.Effect<A, SanitizedTaggedError, R>,
): Effect.Effect<A, SanitizedFailure, R> {
  return effect.pipe(
    Effect.catchTags({
      MissingCredentials: failWithSanitizedFailure,
      InvalidCredentials: failWithSanitizedFailure,
      InsufficientCredentialScope: failWithSanitizedFailure,
      UnauthorizedExpired: failWithSanitizedFailure,
      RateLimited: failWithSanitizedFailure,
      Timeout: failWithSanitizedFailure,
      Abort: failWithSanitizedFailure,
      NetworkFailure: failWithSanitizedFailure,
      HttpStatusFailure: failWithSanitizedFailure,
      ProviderUnavailable: failWithSanitizedFailure,
      ValidationDrift: failWithSanitizedFailure,
      UnsupportedCapability: failWithSanitizedFailure,
      NoDataYet: failWithSanitizedFailure,
      StaleCachedValue: failWithSanitizedFailure,
      NotImplemented: failWithSanitizedFailure,
      ProbeRequired: failWithSanitizedFailure,
      SettingsValidationFailure: failWithSanitizedFailure,
      UnknownSanitized: failWithSanitizedFailure,
    }),
  );
}
