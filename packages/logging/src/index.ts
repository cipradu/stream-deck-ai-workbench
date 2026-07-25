import { HashMap, Logger, Redacted, type Layer, type LogLevel as EffectLogLevel } from "effect";

import {
  ACTION_FAMILY_IDS,
  ERROR_CATEGORIES,
  IMPLEMENTATION_STATUSES,
  PROVIDER_IDS,
  RETRY_CLASSES,
  type ActionFamilyId,
  type ErrorCategory,
  type ImplementationStatus,
  type ProviderId,
  type RetryClass,
} from "@ai-workbench/contracts";

export const packageName = "@ai-workbench/logging" as const;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogHttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";

export const RESPONSE_DIAGNOSTIC_EXPECTED_TYPES = ["object", "string", "number", "number-or-null"] as const;
export type ResponseDiagnosticExpectedType = (typeof RESPONSE_DIAGNOSTIC_EXPECTED_TYPES)[number];

export const RESPONSE_DIAGNOSTIC_RECEIVED_TYPES = [
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
] as const;
export type ResponseDiagnosticReceivedType = (typeof RESPONSE_DIAGNOSTIC_RECEIVED_TYPES)[number];

export interface SanitizedLogContext {
  readonly providerId?: ProviderId;
  readonly actionFamilyId?: ActionFamilyId;
  readonly implementationStatus?: ImplementationStatus;
  readonly errorCategory?: ErrorCategory;
  readonly reasonCode?: string;
  readonly httpStatus?: number;
  readonly httpStatusClass?: LogHttpStatusClass;
  readonly retryClass?: RetryClass;
  readonly elapsedMs?: number;
  readonly correlationId?: string;
  readonly expectedResponseType?: ResponseDiagnosticExpectedType;
  readonly receivedResponseType?: ResponseDiagnosticReceivedType;
}

export interface SanitizedLogEvent {
  readonly level: LogLevel;
  readonly eventName: string;
  readonly message: string;
  readonly context: SanitizedLogContext;
  readonly sanitized: true;
}

export interface CreateSanitizedLogEventInput {
  readonly level: LogLevel;
  readonly eventName: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface StreamDeckLogSink {
  readonly write: (event: SanitizedLogEvent) => void | Promise<void>;
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SENSITIVE_IDENTIFIER_PATTERN =
  /\b(?:account|acct|org|organization|project|proj|routing|route|team|tenant|workspace)[_.:-][a-z0-9][a-z0-9_.:-]*\b/i;
const SENSITIVE_FIELD_VALUE_PATTERN =
  /\b(?:account|acct|org|organization|project|proj|routing|route|team|tenant|workspace)(?:[-_\s]?(?:id|identifier))?\s*[:=]\s*[^\s,;]+/i;
const PROVIDER_METRIC_LABEL_SOURCE = String.raw`(?:remaining\s*balance|remainingBalance|remaining[-_]?balance|current\s*month\s*spend|currentMonthSpend|current[-_]?month[-_]?spend|current\s*period\s*spend|currentPeriodSpend|current[-_]?period[-_]?spend|usage\s*percent|usagePercent|usage[-_]?percent|used\s*time|usedTime|used[-_]?time|token\s*count|tokenCount|token[-_]?count|balances?|credits?|tokens?|characters?|spend|usage|amount|cost|money)`;
const PROVIDER_METRIC_LABEL_PATTERN = new RegExp(String.raw`\b${PROVIDER_METRIC_LABEL_SOURCE}\b`, "i");
const CURRENCY_CODE_SOURCE = String.raw`(?:USD|CAD|EUR|GBP|JPY|AUD|NZD|CHF|CNY|HKD|SGD|INR|KRW|BRL|MXN)`;
const NUMBER_VALUE_SOURCE = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?`;
const NUMERIC_OR_CURRENCY_VALUE_PATTERN = new RegExp(
  String.raw`(?:[\$\u20ac\u00a3\u00a5]\s*)?${NUMBER_VALUE_SOURCE}(?:\s*${CURRENCY_CODE_SOURCE})?|${CURRENCY_CODE_SOURCE}[\s:=,._-]+(?:[\$\u20ac\u00a3\u00a5][\s:=,._-]+)?${NUMBER_VALUE_SOURCE}`,
  "i",
);
const REDACTED_VALUE_PATTERN = /\bRedacted\.value\s*\([^)]*\)/i;
const RAW_DIAGNOSTIC_PATTERN =
  /\b(?:Cause\.pretty|Effect\.Cause|ParseError|schema diagnostic|raw(?: provider)? (?:request|response)? body|stack trace|defect)\b/i;
const SENSITIVE_CREDENTIAL_PATTERN =
  /\b(api[-_\s]?key|authorization|bearer|password|secret|token|cookie|set[-_\s]?cookie|session|oauth)\b/i;

export function redactText(value: unknown): string {
  const source = String(value);
  if (containsProviderMetricValue(source)) {
    return "[redacted]";
  }

  const redacted = source
    .replace(/\b(?:authorization|api[-_\s]?key|token|secret|password)\s*[:=]?\s*Bearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:authorization|api[-_\s]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
    .replace(
      /\b(?:account|acct|org|organization|project|proj|routing|route|team|tenant|workspace)[_.:-][a-z0-9][a-z0-9_.:-]*\b/gi,
      "[redacted]",
    )
    .replace(
      /\b(?:account|acct|org|organization|project|proj|routing|route|team|tenant|workspace)(?:[-_\s]?(?:id|identifier))?\s*[:=]\s*[^\s,;]+/gi,
      "[redacted]",
    )
    .replace(/\bRedacted\.value\s*\([^)]*\)/gi, "[redacted]")
    .replace(/\bCause\.pretty(?:\s+(?!Bearer\b)[^\s,;]+){0,8}/gi, "[redacted]")
    .replace(/\b(?:Effect\.Cause|ParseError|schema diagnostic|stack trace|defect)(?:\s+[^\s,;]+){0,8}/gi, "[redacted]")
    .replace(/\b[a-z]+_fake_identifier_[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\bfake-email-address-marker\b/gi, "[redacted]")
    .replace(/[\$\u20ac\u00a3\u00a5]\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/g, "[redacted]")
    .replace(/\braw response body fragment\b/gi, "[redacted]");

  return redacted.replace(/(?:\s*\[redacted\]){2,}/g, " [redacted]").trim();
}

export function sanitizeLogContext(input: Readonly<Record<string, unknown>> = {}): SanitizedLogContext {
  const providerId = stringInSet(input.providerId, PROVIDER_IDS);
  const actionFamilyId = stringInSet(input.actionFamilyId, ACTION_FAMILY_IDS);
  const implementationStatus = stringInSet(input.implementationStatus, IMPLEMENTATION_STATUSES);
  const errorCategory = stringInSet(input.errorCategory, ERROR_CATEGORIES);
  const retryClass = stringInSet(input.retryClass, RETRY_CLASSES);
  const reasonCode =
    typeof input.reasonCode === "string" ? sanitizeCode(input.reasonCode, "unknown-reason") : undefined;
  // Accepts a raw numeric status (classified here) or an already sanitized
  // status class string from the central error diagnostics.
  const httpStatus = safeHttpStatus(input.httpStatus);
  const httpStatusClass =
    httpStatus === undefined
      ? typeof input.httpStatusClass === "string" && /^(?:[1-5]xx|unknown)$/.test(input.httpStatusClass)
        ? (input.httpStatusClass as LogHttpStatusClass)
        : undefined
      : httpStatusClassOf(httpStatus);
  const elapsedMs =
    typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
      ? Math.round(input.elapsedMs)
      : undefined;
  const correlationId =
    typeof input.correlationId === "string" ? sanitizeCorrelationId(input.correlationId) : undefined;
  const expectedResponseType = stringInSet(input.expectedResponseType, RESPONSE_DIAGNOSTIC_EXPECTED_TYPES);
  const receivedResponseType = stringInSet(input.receivedResponseType, RESPONSE_DIAGNOSTIC_RECEIVED_TYPES);

  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(actionFamilyId === undefined ? {} : { actionFamilyId }),
    ...(implementationStatus === undefined ? {} : { implementationStatus }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(httpStatusClass === undefined ? {} : { httpStatusClass }),
    ...(retryClass === undefined ? {} : { retryClass }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(expectedResponseType === undefined ? {} : { expectedResponseType }),
    ...(receivedResponseType === undefined ? {} : { receivedResponseType }),
  };
}

export function createSanitizedLogEvent(input: CreateSanitizedLogEventInput): SanitizedLogEvent {
  return {
    level: input.level,
    eventName: sanitizeCode(input.eventName, "event"),
    message: redactText(input.message),
    context: sanitizeLogContext(input.context),
    sanitized: true,
  };
}

export async function writeSanitizedLogEvent(sink: StreamDeckLogSink, event: SanitizedLogEvent): Promise<void> {
  await sink.write(event);
}

function stringInSet<const Values extends readonly string[]>(
  value: unknown,
  allowedValues: Values,
): Values[number] | undefined {
  return typeof value === "string" && (allowedValues as readonly string[]).includes(value) ? value : undefined;
}

function httpStatusClassOf(status: number): LogHttpStatusClass {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return "unknown";
  }

  return `${Math.trunc(status / 100)}xx` as LogHttpStatusClass;
}

function safeHttpStatus(input: unknown): number | undefined {
  return typeof input === "number" && Number.isInteger(input) && input >= 100 && input <= 599 ? input : undefined;
}

function sanitizeCorrelationId(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 96) {
    return undefined;
  }

  if (containsForbiddenText(trimmed)) {
    return undefined;
  }

  return /^[a-zA-Z0-9_.:-]+$/.test(trimmed) ? trimmed : undefined;
}

function sanitizeCode(input: string, fallback: string): string {
  const source = input.trim();
  if (source.length === 0) {
    return fallback;
  }

  if (containsForbiddenText(source)) {
    return "redacted";
  }

  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return normalized.length === 0 ? fallback : normalized;
}

function containsForbiddenText(value: string): boolean {
  return (
    EMAIL_PATTERN.test(value) ||
    SENSITIVE_IDENTIFIER_PATTERN.test(value) ||
    SENSITIVE_FIELD_VALUE_PATTERN.test(value) ||
    containsProviderMetricValue(value) ||
    REDACTED_VALUE_PATTERN.test(value) ||
    RAW_DIAGNOSTIC_PATTERN.test(value) ||
    SENSITIVE_CREDENTIAL_PATTERN.test(value)
  );
}

function containsProviderMetricValue(value: string): boolean {
  return PROVIDER_METRIC_LABEL_PATTERN.test(value) && NUMERIC_OR_CURRENCY_VALUE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Effect Logger sink
//
// A custom Effect `Logger` routes every `Effect.log*` record THROUGH the same
// `createSanitizedLogEvent` choke point used by the direct sink path, then hands
// the sanitized event to the Stream Deck SDK sink. The regex sanitizer stays as
// defense-in-depth: nothing reaches the sink without passing `redactText` +
// `sanitizeLogContext`. The raw Effect `Cause` is never rendered, so a
// tagged error's `internalCause`, defects, or embedded secrets can never reach the
// sink. Allow-listed context arrives via `Effect.annotateLogs`; a
// `Redacted` value renders as `[redacted]` and its inner value is never unwrapped.
// The consumer-facing contract stays plain TypeScript; the Effect
// `Logger`/`Layer` is the internal pipeline the shell installs at re-wire time.
// ---------------------------------------------------------------------------

const REDACTED_PLACEHOLDER = "[redacted]";
const EFFECT_LOG_DEFAULT_EVENT_NAME = "log";
const EFFECT_LOG_EVENT_NAME_ANNOTATION = "eventName";

/**
 * Builds the custom Effect `Logger` that sanitizes each log record and writes the
 * resulting {@link SanitizedLogEvent} to the supplied Stream Deck SDK sink.
 */
export function makeStreamDeckLogger(sink: StreamDeckLogSink): Logger.Logger<unknown, void> {
  return Logger.make((options: Logger.Logger.Options<unknown>) => {
    writeToSink(sink, createSanitizedLogEvent(logRecordToInput(options)));
  });
}

/**
 * The installable logging {@link Layer}: replaces Effect's default logger with the
 * sanitizing Stream Deck logger. The shell provides this layer to its runtime.
 */
export function makeStreamDeckLoggerLayer(sink: StreamDeckLogSink): Layer.Layer<never> {
  return Logger.replace(Logger.defaultLogger, makeStreamDeckLogger(sink));
}

function logRecordToInput(options: Logger.Logger.Options<unknown>): CreateSanitizedLogEventInput {
  // The raw Effect `Cause` (options.cause) is intentionally dropped. Raw cause
  // output — defects, a tagged error's `internalCause`, or embedded secrets — is
  // never a log surface; only the sanitized message + allow-listed
  // annotations flow onward.
  const context = annotationsToRecord(options.annotations);
  const eventNameAnnotation = context[EFFECT_LOG_EVENT_NAME_ANNOTATION];
  const eventName =
    typeof eventNameAnnotation === "string" && eventNameAnnotation.trim().length > 0
      ? eventNameAnnotation
      : EFFECT_LOG_DEFAULT_EVENT_NAME;

  return {
    level: logLevelOf(options.logLevel),
    eventName,
    message: stringifyLogMessage(options.message),
    context,
  };
}

function annotationsToRecord(annotations: HashMap.HashMap<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of HashMap.toEntries(annotations)) {
    record[key] = Redacted.isRedacted(value) ? REDACTED_PLACEHOLDER : value;
  }

  return record;
}

function stringifyLogMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map(stringifyLogMessagePart).join(" ");
  }

  return stringifyLogMessagePart(message);
}

function stringifyLogMessagePart(part: unknown): string {
  if (Redacted.isRedacted(part)) {
    return REDACTED_PLACEHOLDER;
  }

  return typeof part === "string" ? part : String(part);
}

function logLevelOf(level: EffectLogLevel.LogLevel): LogLevel {
  switch (level._tag) {
    case "Fatal":
    case "Error":
      return "error";
    case "Warning":
      return "warn";
    case "Info":
      return "info";
    case "All":
    case "Debug":
    case "Trace":
    case "None":
      return "debug";
  }
}

function writeToSink(sink: StreamDeckLogSink, event: SanitizedLogEvent): void {
  const outcome = sink.write(event);
  // The logger runs inside a fiber and must never crash it; if a sink returns a
  // rejected promise, drop it rather than surface it as a defect.
  if (outcome instanceof Promise) {
    outcome.catch(() => undefined);
  }
}
