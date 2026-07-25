import { Clock, Duration, Effect, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  Headers as PlatformHeaders,
  HttpClient as PlatformHttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";

import {
  Abort,
  HttpStatusFailure,
  InsufficientCredentialScope,
  NetworkFailure,
  ProviderUnavailable,
  RateLimited,
  Timeout,
  UnauthorizedExpired,
  ValidationDrift,
  getResponseDiagnosticReceivedTypeSelector,
  httpStatusClassOf,
  normalizeResponseDiagnostic,
  type ResponseDiagnosticCode,
  type ResponseDiagnosticInput,
  type ResponseDiagnosticReceivedType,
  type SanitizedTaggedError,
} from "@ai-workbench/errors";

export const packageName = "@ai-workbench/http" as const;

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const MAX_RETRY_AFTER_SECONDS = 30 * 60;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpJsonRequest {
  readonly url: string | URL;
  readonly method?: HttpMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpRetryClassificationInput {
  readonly retryAfterSeconds?: number;
}

/**
 * A provider-owned, advisory classifier for a parsed JSON response. It may select
 * only a registered static response-diagnostic code; the shared JSON decoder
 * validates the result and Effect Schema remains the acceptance authority.
 */
export type JsonResponseClassifier = (parsed: unknown) => ResponseDiagnosticCode | undefined;

// ---------------------------------------------------------------------------
// Effect-native public surface.
//
// The Effect-native provider adapters consume THIS surface directly:
// they provide `fetchHttpClientLayer`, build a request with `buildHttpRequest`,
// run it once with `executeRequest` (deadline + interruption, NO retry),
// and decode the body at the source with `decodeJsonBody` (Effect Schema). The
// `requestJsonSchema` helper is the whole pipeline in one call. Every failure is
// the shared internal `Data.TaggedError` taxonomy, produced by a single
// shared core (`executeAndClassify` + `withTransportTimeoutAbort`) — no duplicated
// status/Retry-After/timeout/transport logic. This surface legitimately exposes Effect
// types (`HttpClient`, `Effect`, tagged errors) at the internal foundation seam;
// the OUTER product contracts (the plain `SanitizedFailure` the
// scheduler bridge maps to, display, action families) stay plain TypeScript. No raw
// body/header/secret/`Cause` crosses into a tagged error.
// ---------------------------------------------------------------------------

/**
 * The `HttpClient` layer adapters provide at the runtime root: `@effect/platform`
 * `FetchHttpClient` on Node 24 native `fetch` (no `@effect/platform-node`). Tests inject
 * a fake `HttpClient` layer instead so no live call occurs.
 */
export const fetchHttpClientLayer: Layer.Layer<PlatformHttpClient.HttpClient> = FetchHttpClient.layer;

export interface HttpExecuteOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Builds one `HttpClientRequest` from a method/url/headers/optional-JSON-body spec.
 * Pure and synchronous (the auth header value is just another header entry). Shares
 * the exact request construction the internal boundary core uses.
 */
export function buildHttpRequest(request: HttpJsonRequest): HttpClientRequest.HttpClientRequest {
  return buildRequest(request);
}

/**
 * Executes a built request EXACTLY ONCE under an `Effect.timeout` deadline with
 * interruption and optional caller-abort, then classifies the outcome: a 2xx yields
 * the `HttpClientResponse`; a non-2xx fails with the matching tagged error (status
 * table + parsed `Retry-After` for 429); a transport error fails with `NetworkFailure`;
 * the deadline fails with `Timeout`; a caller abort fails with `Abort`. It performs
 * NO retry — the scheduler is the single retry owner. Reuses the
 * shared `executeAndClassify` + `withTransportTimeoutAbort` core.
 *
 * Deadline/abort scope: the EXECUTE/HEADER phase ONLY. `@effect/platform` resolves
 * `execute` once the response headers arrive and reads the body LAZILY, so this
 * deadline and abort do NOT cover a later `decodeJsonBody` body read. An advanced
 * caller that composes `executeRequest` + `decodeJsonBody` as separate steps must
 * bound the body read itself; callers that want the FULL pipeline (execute + body
 * read + decode) under one deadline should use `requestJsonSchema`.
 */
export function executeRequest(
  request: HttpClientRequest.HttpClientRequest,
  options: HttpExecuteOptions = {},
): Effect.Effect<HttpClientResponse.HttpClientResponse, SanitizedTaggedError, PlatformHttpClient.HttpClient> {
  return withTransportTimeoutAbort(executeAndClassify(request), normalizeTimeout(options.timeoutMs), options.signal);
}

/**
 * Decodes a 2xx response through the central one-read JSON decoder, yielding the
 * typed schema value. The body is read once, parsed transiently, and accepted only
 * by Effect Schema; raw body text and parser/schema failures are discarded.
 */
export function decodeJsonBody<A, I, R>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Schema<A, I, R>,
  responseClassifier?: JsonResponseClassifier,
): Effect.Effect<A, ValidationDrift, R> {
  return response.text.pipe(
    Effect.mapError(() => responseValidationDrift("response-body-unreadable")),
    Effect.flatMap((body) => decodeJsonText(body, schema, responseClassifier)),
  );
}

/** Shared non-JSON-specific request options. */
export interface RequestTextBodyOptions {
  readonly defaultTimeoutMs?: number;
}

/**
 * Options honored only by the JSON request path. The `HttpClient` layer is provided
 * at the runtime root, not per call, and the per-request deadline override and
 * caller-abort signal travel on `HttpJsonRequest` (`timeoutMs` / `signal`).
 */
export interface RequestJsonSchemaOptions extends RequestTextBodyOptions {
  readonly responseClassifier?: JsonResponseClassifier;
}

/**
 * The whole Effect-native pipeline in one call: build → execute-once → central one-read
 * JSON decode, with the ENTIRE pipeline — execute AND the lazily-read response body +
 * decode — bounded by ONE `Effect.timeout` deadline and the optional caller-abort race
 * (decode inside the deadline). A standalone
 * caller with no outer deadline is therefore protected from a stalled response body:
 * `request.timeoutMs`/`request.signal` bound the body read, not merely the execute/header
 * phase. Yields the typed decoded value or fails with a tagged error from the shared
 * taxonomy. Reuses the shared `executeAndClassify` + `decodeJsonBody` +
 * `withTransportTimeoutAbort` core — no duplicated status/Retry-After/timeout/transport
 * logic. `HttpClient` is left in the context channel for the adapter to satisfy with
 * `fetchHttpClientLayer` at the runtime root. One attempt, NO retry.
 */
export function requestJsonSchema<A, I, R>(
  request: HttpJsonRequest,
  schema: Schema.Schema<A, I, R>,
  options: RequestJsonSchemaOptions = {},
): Effect.Effect<A, SanitizedTaggedError, PlatformHttpClient.HttpClient | R> {
  const timeoutMs = normalizeTimeout(request.timeoutMs ?? options.defaultTimeoutMs);
  const withBody = executeAndClassify(buildRequest(request)).pipe(
    Effect.flatMap((response) => decodeJsonBody(response, schema, options.responseClassifier)),
  );
  return withTransportTimeoutAbort(withBody, timeoutMs, request.signal);
}

/**
 * The Effect-native TEXT-body counterpart to `requestJsonSchema`, for providers whose
 * endpoint returns a plain-text body rather than JSON (e.g. jina's balance endpoint):
 * build → execute-once → read the response body as TEXT (the platform response's text
 * getter, via the shared `decodeText`), with the ENTIRE pipeline — execute AND the
 * lazily-read body — bounded by ONE `Effect.timeout` deadline and the optional
 * caller-abort race, EXACTLY as `requestJsonSchema` self-binds its body read: the body read
 * is NOT left outside the deadline. Yields the raw response text
 * or fails with a tagged error from the shared taxonomy. Reuses the shared
 * `executeAndClassify` + `decodeText` + `withTransportTimeoutAbort` core — no duplicated
 * status/Retry-After/timeout/transport logic. `HttpClient` is left in the context channel
 * for the adapter to satisfy with `fetchHttpClientLayer` at the runtime root. One attempt,
 * NO retry. Its options intentionally expose only `defaultTimeoutMs`; a JSON
 * response classifier is not meaningful for a text-body request.
 *
 * Named `requestTextBody` (the plain-text-body counterpart to `requestJsonSchema`).
 */
export function requestTextBody(
  request: HttpJsonRequest,
  options: RequestTextBodyOptions = {},
): Effect.Effect<string, SanitizedTaggedError, PlatformHttpClient.HttpClient> {
  const timeoutMs = normalizeTimeout(request.timeoutMs ?? options.defaultTimeoutMs);
  const withBody = executeAndClassify(buildRequest(request)).pipe(
    Effect.flatMap((response) => decodeText(response)),
  );
  return withTransportTimeoutAbort(withBody, timeoutMs, request.signal);
}

// ---------------------------------------------------------------------------
// Internal Effect boundary.
//
// The boundary builds one `HttpClientRequest`, executes it EXACTLY ONCE under an
// `Effect.timeout` deadline (deadline + interruption; not a retry), classifies non-2xx
// status, and maps every failure into the shared `Data.TaggedError` taxonomy. It performs
// NO retry — the scheduler is the single retry owner. No raw body,
// header, cause, or secret ever reaches a sanitized failure.
// ---------------------------------------------------------------------------

/**
 * Shared core (1/2): executes a built request EXACTLY ONCE and classifies the HTTP
 * outcome. A 2xx yields the response; a non-2xx fails with the status tagged error
 * (401→UnauthorizedExpired, 403→InsufficientCredentialScope, 408/504→Timeout,
 * 5xx→ProviderUnavailable, 429→RateLimited+Retry-After, else→HttpStatusFailure).
 * Transport errors from `execute` stay in the channel for `withTransportTimeoutAbort`
 * to map. NO retry.
 */
function executeAndClassify(
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError | SanitizedTaggedError,
  PlatformHttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const client = yield* PlatformHttpClient.HttpClient;
    const response = yield* client.execute(request);
    if (!isSuccessStatus(response.status)) {
      const tagged = yield* statusTaggedError(response);
      return yield* Effect.fail(tagged);
    }
    return response;
  });
}

/**
 * Shared core (2/2): maps transport errors to `NetworkFailure`, races an optional
 * caller abort (→ `Abort`), and enforces the one-shot `Effect.timeout` deadline
 * (→ `Timeout`), applied in the exact order. Consumes the `HttpClientError`
 * transport channel and yields only the sanitized tagged taxonomy. This is a
 * deadline + interruption, NOT a retry.
 */
function withTransportTimeoutAbort<A, R>(
  effect: Effect.Effect<A, HttpClientError.HttpClientError | SanitizedTaggedError, R>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Effect.Effect<A, SanitizedTaggedError, R> {
  return effect.pipe(
    Effect.catchTag("RequestError", () => Effect.fail(transportNetworkFailure("request-network-failed"))),
    Effect.catchTag("ResponseError", () => Effect.fail(transportNetworkFailure("response-network-failed"))),
    (inner) => withCallerAbort(signal, inner),
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () => new Timeout({ reasonCode: "request-timeout", providerFailureClass: "timeout" }),
    }),
  );
}

function buildRequest(request: HttpJsonRequest): HttpClientRequest.HttpClientRequest {
  const base = HttpClientRequest.make(request.method ?? "GET")(
    request.url,
    request.headers === undefined ? {} : { headers: request.headers },
  );
  return request.body === undefined ? base : HttpClientRequest.bodyUnsafeJson(base, request.body);
}

function decodeText(response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, ValidationDrift> {
  return response.text.pipe(Effect.mapError(() => bodyValidationDrift("http-response-text", "response-text-invalid")));
}

function decodeJsonText<A, I, R>(
  body: string,
  schema: Schema.Schema<A, I, R>,
  responseClassifier: JsonResponseClassifier | undefined,
): Effect.Effect<A, ValidationDrift, R> {
  if (body.trim().length === 0) {
    return Effect.fail(responseValidationDrift("response-body-empty"));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return Effect.fail(responseValidationDrift("response-body-not-json"));
  }

  return Schema.decodeUnknown(schema)(parsed).pipe(
    Effect.catchAll(() => Effect.fail(schemaValidationDrift(parsed, responseClassifier))),
  );
}

function schemaValidationDrift(parsed: unknown, responseClassifier: JsonResponseClassifier | undefined): ValidationDrift {
  const classified = classifierResponseDiagnostic(parsed, responseClassifier);
  return responseValidationDrift(classified?.code ?? "response-json-schema-mismatch", classified?.receivedType);
}

function classifierResponseDiagnostic(
  parsed: unknown,
  responseClassifier: JsonResponseClassifier | undefined,
): ResponseDiagnosticInput | undefined {
  if (responseClassifier === undefined) {
    return undefined;
  }

  try {
    const code = responseClassifier(parsed);
    const receivedType = responseDiagnosticReceivedType(parsed, code);
    if (receivedType === undefined) {
      return undefined;
    }
    const diagnostic = normalizeResponseDiagnostic({
      code,
      receivedType,
    });
    return diagnostic === undefined
      ? undefined
      : {
          code: diagnostic.code,
          ...(diagnostic.receivedType === undefined ? {} : { receivedType: diagnostic.receivedType }),
        };
  } catch {
    return undefined;
  }
}

function responseDiagnosticReceivedType(
  parsed: unknown,
  code: unknown,
): ResponseDiagnosticReceivedType | undefined {
  const receivedTypeSelector = getResponseDiagnosticReceivedTypeSelector(code);
  if (receivedTypeSelector === undefined) {
    return undefined;
  }

  let selected = parsed;
  for (const segment of receivedTypeSelector) {
    if (!isJsonObject(selected) || !Object.prototype.hasOwnProperty.call(selected, segment)) {
      return undefined;
    }
    selected = selected[segment];
  }
  return jsonTypeOf(selected);
}

function isJsonObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function jsonTypeOf(input: unknown): ResponseDiagnosticReceivedType {
  if (input === null) {
    return "null";
  }
  if (Array.isArray(input)) {
    return "array";
  }
  switch (typeof input) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

function responseValidationDrift(
  code: ResponseDiagnosticCode,
  receivedType?: ResponseDiagnosticReceivedType,
): ValidationDrift {
  return new ValidationDrift({
    reasonCode: code,
    responseDiagnostic: {
      code,
      ...(receivedType === undefined ? {} : { receivedType }),
    },
    providerFailureClass: "validation",
  });
}

function bodyValidationDrift(boundary: string, reasonCode: string): ValidationDrift {
  return new ValidationDrift({
    reasonCode,
    boundary,
    fieldPaths: ["<body>"],
    issueCount: 1,
    providerFailureClass: "validation",
  });
}

function transportNetworkFailure(reasonCode: string): NetworkFailure {
  return new NetworkFailure({ reasonCode, providerFailureClass: "network" });
}

/**
 * Non-2xx status classification. Maps each status onto the tagged error whose
 * category and retry class match the existing shared taxonomy: 401/403 route to
 * credential-refresh states (NOT transient retry), 408/504 to timeout, 5xx to
 * provider-unavailable, 429 to rate-limited with a parsed `Retry-After`, and any
 * other non-2xx to the generic `HttpStatusFailure` carrying the status class.
 */
function statusTaggedError(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<SanitizedTaggedError> {
  const status = response.status;
  if (status === 429) {
    return Clock.currentTimeMillis.pipe(
      Effect.map((nowMs) => {
        const retryAfterSeconds = parseRetryAfter(headerValue(response, "retry-after"), nowMs);
        return new RateLimited({
          reasonCode: "provider-http-status",
          providerFailureClass: "http-status",
          httpStatus: status,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        });
      }),
    );
  }
  return Effect.succeed(nonRateLimitStatusError(status));
}

function nonRateLimitStatusError(status: number): SanitizedTaggedError {
  const shared = {
    reasonCode: "provider-http-status",
    providerFailureClass: "http-status" as const,
    httpStatus: status,
  };
  if (status === 401) {
    return new UnauthorizedExpired(shared);
  }
  if (status === 403) {
    return new InsufficientCredentialScope(shared);
  }
  if (status === 408 || status === 504) {
    return new Timeout(shared);
  }
  if (status >= 500 && status <= 599) {
    return new ProviderUnavailable(shared);
  }
  return new HttpStatusFailure({ ...shared, statusClass: httpStatusClassOf(status) });
}

/**
 * Converts a caller abort signal into a typed `Abort` failure that also interrupts
 * the in-flight request. The listener is removed when the request settles first.
 */
function withCallerAbort<A, E, R>(
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Abort, R> {
  if (signal === undefined) {
    return effect;
  }

  const abortEffect = Effect.async<never, Abort>((resume) => {
    const fail = (): void => {
      resume(Effect.fail(new Abort({ reasonCode: "request-aborted", providerFailureClass: "abort" })));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", fail);
    });
  });

  return Effect.raceFirst(effect, abortEffect);
}

function headerValue(response: HttpClientResponse.HttpClientResponse, name: string): string | null {
  return Option.getOrNull(PlatformHeaders.get(response.headers, name));
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HTTP_TIMEOUT_MS;
  }
  return Math.trunc(value);
}

/**
 * Parses an HTTP `Retry-After` header into a bounded delay in seconds. Accepts the
 * delta-seconds and HTTP-date forms; `nowMs` is supplied by the Effect `Clock` at
 * the call site so this stays a pure, deterministically testable function. Values
 * are clamped to `MAX_RETRY_AFTER_SECONDS` (30 minutes). `Date.parse` here parses a header
 * string only — it is not a wall-clock read.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return clampRetryAfter(Number(trimmed));
  }

  const retryDateMs = Date.parse(trimmed);
  if (!Number.isFinite(retryDateMs)) {
    return undefined;
  }

  return clampRetryAfter(Math.max(0, Math.ceil((retryDateMs - nowMs) / 1000)));
}

function clampRetryAfter(seconds: number): number | undefined {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
