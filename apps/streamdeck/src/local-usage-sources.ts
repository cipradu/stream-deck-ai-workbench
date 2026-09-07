import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ResponseDiagnosticCode } from "@ai-workbench/errors";
import type {
  ClaudeCodeCredentialResult,
  CodexCredentialResult,
  CodexSessionSnapshot,
  KimiCodeCredentialResult,
  UsageProviderLocalSourceReaders,
} from "@ai-workbench/provider-adapters";

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_CLAUDE_CODE_EXECUTABLE = join(homedir(), ".local", "bin", "claude");
const DEFAULT_CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const DEFAULT_CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const DEFAULT_KIMI_CODE_HOME = join(homedir(), ".kimi-code");
const USAGE_CREDENTIAL_REFRESH_TIMEOUT_MS = 60_000;
const USAGE_CREDENTIAL_REFRESH_MAX_BUFFER_BYTES = 16 * 1024;
const USAGE_CREDENTIAL_REFRESH_PROMPT = "Reply exactly OK. Do not use tools.";
const SENSITIVE_ENVIRONMENT_NAME = /(account|auth|cookie|credential|key|org|password|project|secret|session|team|token)/i;
const CODEX_SESSION_TAIL_BYTES = 128 * 1024;
const CODEX_USAGE_WINDOW_DURATIONS = {
  "five-hour": { seconds: 18_000, minutes: 300 },
  "seven-day": { seconds: 604_800, minutes: 10_080 },
} as const;

type CodexSessionWindowId = keyof typeof CODEX_USAGE_WINDOW_DURATIONS;

interface SessionFileInfo {
  readonly path: string;
  readonly mtimeMs: number;
}

interface ParsedCodexSessionWindow {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAtEpochMs?: number;
}

export interface UsageCredentialRefreshCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
}

export type UsageCredentialRefreshCommandRunner = (command: UsageCredentialRefreshCommand) => Promise<void>;
export type KimiCodeRefreshCommand = UsageCredentialRefreshCommand;
export type KimiCodeRefreshCommandRunner = UsageCredentialRefreshCommandRunner;
export type ClaudeCodeRefreshCommand = UsageCredentialRefreshCommand;
export type ClaudeCodeRefreshCommandRunner = UsageCredentialRefreshCommandRunner;

export function createLocalUsageSourceReaders(): UsageProviderLocalSourceReaders {
  return {
    claudeCode: {
      readCredential: () => resolveClaudeCodeCredential(),
      refreshCredential: () => refreshClaudeCodeCredential(),
    },
    codex: {
      readCredential: () => readCodexAuthJsonCredential(),
      readSessionSnapshot: () => readNewestCodexSessionSnapshot(),
    },
    kimiCode: {
      readCredential: () => readKimiCodeCredential(),
      refreshCredential: () => refreshKimiCodeCredential(),
    },
  };
}

export async function readClaudeCodeKeychainCredential(
  service = DEFAULT_CLAUDE_KEYCHAIN_SERVICE,
): Promise<ClaudeCodeCredentialResult> {
  let stdout: string;
  try {
    stdout = await execFileText("security", ["find-generic-password", "-s", service, "-w"]);
  } catch {
    return {
      ok: false,
      reasonCode: "claude-code-keychain-denied",
    };
  }

  return parseClaudeCodeKeychainPayload(stdout);
}

/** Credential locations this plugin will read, in default order. Read-only, both of them. */
export type ClaudeCodeCredentialSource = "keychain" | "file";

/**
 * Failure codes that are BOTH declarable on the credential result AND registered in the central
 * diagnostic catalog. The intersection is load-bearing: a code outside the catalog would fail
 * normalization and collapse the emitted reason code to the literal "unknown".
 */
type ClaudeCodeCredentialFailureCode = Extract<ClaudeCodeCredentialResult, { readonly ok: false }>["reasonCode"] &
  ResponseDiagnosticCode;

/**
 * Last source that produced a usable credential. In-memory only, by design: persisting a
 * source pointer would put a credential-derived decision back into global settings, which is
 * the surface commit 32afdea had to repair. Resets on plugin restart, costing one extra read.
 *
 * It is a HINT, never authority — see `resolveClaudeCodeCredential`.
 */
let lastGoodClaudeCodeSource: ClaudeCodeCredentialSource | undefined;

/** Test seam. Production never calls this; the hint is owned by resolution. */
export function __resetClaudeCodeSourceHintForTests(): void {
  lastGoodClaudeCodeSource = undefined;
}

export function claudeCodeSourceHintForTests(): ClaudeCodeCredentialSource | undefined {
  return lastGoodClaudeCodeSource;
}

/** Honors the documented config-dir override, which relocates the credential file. */
function claudeCodeCredentialFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredDir = environment.CLAUDE_CONFIG_DIR?.trim();
  return configuredDir !== undefined && configuredDir.length > 0
    ? join(configuredDir, ".credentials.json")
    : join(homedir(), ".claude", ".credentials.json");
}

export async function readClaudeCodeFileCredential(
  filePath = claudeCodeCredentialFilePath(),
): Promise<ClaudeCodeCredentialResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // Absent or unreadable is an ordinary outcome here, not an error: the vendor only writes
    // this file when the Keychain rejects a write, so on many machines it legitimately does
    // not exist.
    return { ok: false, reasonCode: "claude-code-file-unreadable" };
  }

  return parseClaudeCodeCredentialPayload(raw, "file");
}

/**
 * Resolves a Claude Code credential across every authorized local source.
 *
 * TERMINATION — this function cannot loop:
 *   - the candidate list is fixed and finite (currently two entries);
 *   - each candidate is read AT MOST ONCE per call, by a single forward `for` loop;
 *   - there is no recursion, no retry, and no re-entry after a candidate fails;
 *   - once the list is exhausted the call returns a terminal failure.
 * A failing source is never revisited within a pass. Recovery across polls is the scheduler's
 * job (its existing backoff), and the adapter's credential refresh stays one-shot via its own
 * `recoveryAttempted` guard, which this function does not touch.
 *
 * SELECTION — a candidate wins only by being demonstrably usable, never by position:
 *   - a non-blank, unexpired token returns immediately and records the hint;
 *   - a non-blank but EXPIRED token does NOT terminate the search. It is retained as a
 *     last resort and the search continues. Returning it early would let a stale leftover
 *     pin the hint to a dead source and produce a permanent false "not signed in" — the
 *     failure class commit 32afdea exists to prevent;
 *   - if every candidate is exhausted, the latest-expiring retained credential is returned so
 *     the adapter's existing expiry/refresh handling still runs unchanged;
 *   - otherwise the first failure encountered is returned, so the log names the source that
 *     was tried first rather than whichever happened to be last.
 *
 * The hint is updated ONLY on success. A pass in which everything fails leaves it untouched,
 * so two failing sources cannot thrash the ordering between polls.
 */
export async function resolveClaudeCodeCredential(
  readers: {
    readonly keychain: () => Promise<ClaudeCodeCredentialResult>;
    readonly file: () => Promise<ClaudeCodeCredentialResult>;
  } = { keychain: () => readClaudeCodeKeychainCredential(), file: () => readClaudeCodeFileCredential() },
  now: () => number = () => Date.now(),
): Promise<ClaudeCodeCredentialResult> {
  const defaultOrder: readonly ClaudeCodeCredentialSource[] = ["keychain", "file"];
  const order =
    lastGoodClaudeCodeSource === undefined
      ? defaultOrder
      : [lastGoodClaudeCodeSource, ...defaultOrder.filter((source) => source !== lastGoodClaudeCodeSource)];

  let firstFailure: ClaudeCodeCredentialResult | undefined;
  let expiredFallback: { readonly source: ClaudeCodeCredentialSource; readonly result: ClaudeCodeCredentialResult } | undefined;

  for (const source of order) {
    const result = await (source === "keychain" ? readers.keychain() : readers.file());

    if (!result.ok) {
      firstFailure ??= result;
      continue;
    }

    if (result.expiresAt === undefined || result.expiresAt > now()) {
      lastGoodClaudeCodeSource = source;
      return result;
    }

    // Expired: keep the latest-expiring one, but keep looking.
    if (expiredFallback === undefined || (expiredFallback.result.ok && (expiredFallback.result.expiresAt ?? 0) < result.expiresAt)) {
      expiredFallback = { source, result };
    }
  }

  if (expiredFallback !== undefined) {
    // Deliberately does NOT set the hint: an expired credential is not a demonstrated success.
    return expiredFallback.result;
  }

  return firstFailure ?? { ok: false, reasonCode: "claude-code-file-unreadable" };
}

export async function refreshClaudeCodeCredential(
  runCommand: ClaudeCodeRefreshCommandRunner = runUsageCredentialRefreshCommand,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "ai-workbench-claude-refresh-"));
  try {
    await runCommand({
      command: DEFAULT_CLAUDE_CODE_EXECUTABLE,
      args: [
        "--safe-mode",
        "--print",
        USAGE_CREDENTIAL_REFRESH_PROMPT,
        "--tools",
        "",
        "--no-session-persistence",
        "--max-budget-usd",
        "0.05",
        "--model",
        "haiku",
        "--effort",
        "low",
        "--output-format",
        "text",
      ],
      cwd: isolatedRoot,
      env: sanitizedUsageRefreshEnvironment(sourceEnvironment),
      timeoutMs: USAGE_CREDENTIAL_REFRESH_TIMEOUT_MS,
      maxBufferBytes: USAGE_CREDENTIAL_REFRESH_MAX_BUFFER_BYTES,
    });
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

/**
 * Pure parse of the Keychain payload (`.claudeAiOauth.{accessToken, expiresAt}`); never logs contents.
 *
 * Each failure shape returns its own catalog code so the emitted log line names the actual cause.
 * A single collapsed code previously made "the store returned nothing", "the store returned
 * non-JSON", "the container is gone" and "the token is blank" indistinguishable from the log,
 * which is exactly the state that forced a live Keychain/filesystem investigation.
 * Codes are value-free: they name the static path, never the payload (ADR-0027).
 */
export function parseClaudeCodeKeychainPayload(stdout: string): ClaudeCodeCredentialResult {
  return parseClaudeCodeCredentialPayload(stdout, "keychain");
}

/**
 * One validated edge for both sources. The shape is the same, but the emitted code names the
 * SOURCE as well as the failure, because resolution reads both and "blank token" alone would
 * not tell an operator which store is degraded.
 *
 * The file payload is validated independently rather than trusted to match the Keychain's
 * shape: both are undocumented vendor internals with no stability commitment.
 */
export function parseClaudeCodeCredentialPayload(
  raw: string,
  source: ClaudeCodeCredentialSource,
): ClaudeCodeCredentialResult {
  const code = <S extends string>(suffix: S) => `claude-code-${source}-${suffix}` as ClaudeCodeCredentialFailureCode;

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // The file source reports an empty file as unreadable: an empty file and an absent file are
    // the same actionable condition there, whereas for the Keychain an empty read is distinct.
    return failedKeychainRead(source === "keychain" ? "claude-code-keychain-empty" : "claude-code-file-unreadable");
  }

  const root = parseJsonValue(trimmed);
  if (root === undefined) {
    return failedKeychainRead(code("not-json"));
  }
  if (!isPlainObject(root)) {
    return failedKeychainRead(code("root-not-object"), jsonTypeOf(root));
  }

  if (!Object.prototype.hasOwnProperty.call(root, "claudeAiOauth")) {
    return failedKeychainRead(code("record-missing"));
  }
  const oauth = (root as Record<string, unknown>).claudeAiOauth;
  if (!isPlainObject(oauth)) {
    return failedKeychainRead(code("record-not-object"), jsonTypeOf(oauth));
  }

  if (!Object.prototype.hasOwnProperty.call(oauth, "accessToken")) {
    return failedKeychainRead(code("credential-missing"));
  }
  const accessToken = (oauth as Record<string, unknown>).accessToken;
  if (typeof accessToken !== "string") {
    return failedKeychainRead(code("credential-invalid"), jsonTypeOf(accessToken));
  }
  if (accessToken.trim().length === 0) {
    return failedKeychainRead(code("credential-blank"));
  }

  const expiresAtRaw = (oauth as Record<string, unknown>).expiresAt;
  const expiresAt = typeof expiresAtRaw === "number" ? expiresAtRaw : undefined;
  return {
    ok: true,
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * Builds the failure result and its catalog diagnostic together, so a code that declares an
 * expected type can never be emitted without its received type. Emitting that pair mismatched
 * would make the central sanitizer reject the diagnostic and downgrade the logged reason code to
 * the literal "unknown" — strictly worse than the collapsed code this change removes.
 */
function failedKeychainRead(
  // Intersected with the catalog's own code union, so a reason code that has no catalog entry
  // (`-denied`, the legacy `-malformed`) cannot reach the diagnostic and be rejected at runtime.
  code: ClaudeCodeCredentialFailureCode,
  receivedType?: "array" | "boolean" | "null" | "number" | "object" | "string",
): ClaudeCodeCredentialResult {
  return {
    ok: false,
    reasonCode: code,
    responseDiagnostic: receivedType === undefined ? { code } : { code, receivedType },
  };
}

/** Parses any JSON value (not only an object); `undefined` means the text is not JSON at all. */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Closed JSON type label matching the central catalog's received-type set. */
function jsonTypeOf(value: unknown): "array" | "boolean" | "null" | "number" | "object" | "string" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "boolean" || t === "number" || t === "string" || t === "object" ? t : "string";
}

export async function readCodexAuthJsonCredential(authPath = DEFAULT_CODEX_AUTH_PATH): Promise<CodexCredentialResult> {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return {
      ok: false,
      reasonCode: "codex-auth-missing",
    };
  }

  return parseCodexAuthJsonPayload(raw);
}

/** Pure parse of `auth.json` (`auth_mode === "chatgpt"`, `.tokens.{access_token, account_id}`); never logs contents. */
export function parseCodexAuthJsonPayload(raw: string): CodexCredentialResult {
  const parsed = parseJsonRecord(raw);
  if (parsed === undefined) {
    return {
      ok: false,
      reasonCode: "codex-auth-malformed",
    };
  }

  if (parsed.auth_mode !== "chatgpt") {
    return {
      ok: false,
      reasonCode: "codex-auth-wrong-mode",
    };
  }

  const tokens = recordProperty(parsed, "tokens");
  const accessToken = tokens?.access_token;
  const accountId = tokens?.account_id;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0 || typeof accountId !== "string" || accountId.trim().length === 0) {
    return {
      ok: false,
      reasonCode: "codex-auth-malformed",
    };
  }

  return {
    ok: true,
    accessToken,
    accountId,
  };
}

export async function readKimiCodeCredential(): Promise<KimiCodeCredentialResult> {
  const kimiCodeHome = process.env.KIMI_CODE_HOME?.trim() || DEFAULT_KIMI_CODE_HOME;
  const credentialPath = join(kimiCodeHome, "credentials", "kimi-code.json");
  let raw: string;
  try {
    raw = await readFile(credentialPath, "utf8");
  } catch {
    return {
      ok: false,
      reasonCode: "kimi-code-auth-missing",
    };
  }

  return parseKimiCodeCredentialPayload(raw);
}

export async function refreshKimiCodeCredential(
  runCommand: KimiCodeRefreshCommandRunner = runUsageCredentialRefreshCommand,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const kimiCodeHome = sourceEnvironment.KIMI_CODE_HOME?.trim() || DEFAULT_KIMI_CODE_HOME;
  const isolatedRoot = await mkdtemp(join(tmpdir(), "ai-workbench-kimi-refresh-"));
  try {
    await runCommand({
      command: join(kimiCodeHome, "bin", "kimi"),
      args: [
        "--prompt",
        USAGE_CREDENTIAL_REFRESH_PROMPT,
        "--output-format",
        "text",
        "--skills-dir",
        isolatedRoot,
      ],
      cwd: isolatedRoot,
      env: sanitizedUsageRefreshEnvironment(sourceEnvironment, { KIMI_CODE_HOME: kimiCodeHome }),
      timeoutMs: USAGE_CREDENTIAL_REFRESH_TIMEOUT_MS,
      maxBufferBytes: USAGE_CREDENTIAL_REFRESH_MAX_BUFFER_BYTES,
    });
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function sanitizedUsageRefreshEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (value !== undefined && !SENSITIVE_ENVIRONMENT_NAME.test(name)) {
      sanitized[name] = value;
    }
  }
  sanitized.HOME = homedir();
  sanitized.NO_COLOR = "1";
  Object.assign(sanitized, additions);
  return sanitized;
}

/** Pure read-only parse of Kimi Code's local OAuth credential; refresh material is ignored. */
export function parseKimiCodeCredentialPayload(raw: string): KimiCodeCredentialResult {
  const parsed = parseJsonRecord(raw);
  if (parsed === undefined) {
    return {
      ok: false,
      reasonCode: "kimi-code-auth-malformed",
    };
  }

  const accessToken = parsed.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return {
      ok: false,
      reasonCode: "kimi-code-auth-malformed",
    };
  }

  const expiresAt = parsed.expires_at;
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0)) {
    return {
      ok: false,
      reasonCode: "kimi-code-auth-malformed",
    };
  }

  return {
    ok: true,
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAtEpochSeconds: expiresAt }),
  };
}

export async function readNewestCodexSessionSnapshot(
  sessionsRoot = DEFAULT_CODEX_SESSIONS_ROOT,
): Promise<CodexSessionSnapshot | undefined> {
  let files: readonly SessionFileInfo[];
  try {
    files = await listCodexSessionFiles(sessionsRoot);
  } catch {
    return undefined;
  }

  const newestFirst = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of newestFirst) {
    try {
      let { complete, content } = await readTail(file.path, CODEX_SESSION_TAIL_BYTES);
      let snapshot = parseLastRateLimitsLine(content, file.mtimeMs);
      if (snapshot === undefined && !complete) {
        ({ content } = await readTail(file.path, Number.MAX_SAFE_INTEGER));
        snapshot = parseLastRateLimitsLine(content, file.mtimeMs);
      }
      if (snapshot !== undefined) {
        return snapshot;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function execFileText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function runUsageCredentialRefreshCommand(input: UsageCredentialRefreshCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      input.command,
      [...input.args],
      {
        cwd: input.cwd,
        encoding: "utf8",
        env: input.env,
        maxBuffer: input.maxBufferBytes,
        timeout: input.timeoutMs,
      },
      (error) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve();
      },
    );

    // Close the child's stdin immediately. These refresh CLIs read stdin for piped input and block
    // waiting on it; `execFile` hands the child a pipe we never write to and never close, so the
    // CLI stalls the full wait before proceeding ("no stdin data received in 3s, proceeding
    // without it"). Measured on the Claude CLI: 4193ms with the pipe left open vs 1349/1384ms with
    // it closed, same exit code 0 and same stdout. Sending EOF cannot lose data because nothing
    // ever writes here. Note `execFile` ignores an `stdio` option — it owns its own pipes — so
    // ending the stream on the returned child is the only way to close it without giving up
    // `maxBuffer`/`timeout`/`encoding`.
    child.stdin?.end();
  });
}

async function listCodexSessionFiles(root: string): Promise<readonly SessionFileInfo[]> {
  const files: SessionFileInfo[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const fileStat = await stat(entryPath);
      files.push({
        path: entryPath,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  await walk(root);
  return files;
}

async function readTail(filePath: string, maxBytes: number): Promise<{ readonly content: string; readonly complete: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return {
      content: buffer.toString("utf8"),
      complete: start === 0,
    };
  } finally {
    await handle.close();
  }
}

/** Pure parse of a Codex session file tail: extracts the LAST `rate_limits` snapshot line (old fallback shape); never logs contents. */
export function parseLastRateLimitsLine(content: string, fetchedAtEpochMs: number): CodexSessionSnapshot | undefined {
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"rate_limits"')) {
      continue;
    }

    const parsed = parseJsonRecord(line);
    if (parsed === undefined) {
      continue;
    }

    const rateLimits = findRateLimits(parsed);
    if (rateLimits === undefined) {
      continue;
    }

    const fiveHourWindow = sessionWindowForRateLimits(rateLimits, "five-hour");
    const sevenDayWindow = sessionWindowForRateLimits(rateLimits, "seven-day");
    if (fiveHourWindow === undefined && sevenDayWindow === undefined) {
      continue;
    }

    return {
      fetchedAtEpochMs,
      ...(fiveHourWindow === undefined ? {} : { fiveHourPercent: fiveHourWindow.usedPercent }),
      ...(sevenDayWindow === undefined ? {} : { sevenDayPercent: sevenDayWindow.usedPercent }),
      ...(fiveHourWindow?.resetsAtEpochMs === undefined ? {} : { fiveHourResetsAtEpochMs: fiveHourWindow.resetsAtEpochMs }),
      ...(sevenDayWindow?.resetsAtEpochMs === undefined ? {} : { sevenDayResetsAtEpochMs: sevenDayWindow.resetsAtEpochMs }),
    };
  }

  return undefined;
}

function findRateLimits(value: unknown): { readonly primary?: unknown; readonly secondary?: unknown } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value.rate_limits;
  if (isRecord(candidate)) {
    return candidate;
  }

  for (const child of Object.values(value)) {
    const found = findRateLimits(child);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function sessionWindowForRateLimits(
  rateLimits: { readonly primary?: unknown; readonly secondary?: unknown },
  window: CodexSessionWindowId,
): ParsedCodexSessionWindow | undefined {
  const requestedMinutes = CODEX_USAGE_WINDOW_DURATIONS[window].minutes;
  const matches = [rateLimits.primary, rateLimits.secondary].flatMap((candidate) => {
    const parsed = parseSessionWindow(candidate);
    return parsed !== undefined && parsed.windowMinutes === requestedMinutes ? [parsed] : [];
  });

  if (matches.length !== 1) {
    return undefined;
  }

  return matches[0];
}

function parseSessionWindow(value: unknown): ParsedCodexSessionWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const windowMinutes = value.window_minutes;
  const usedPercent = value.used_percent;
  if (
    typeof windowMinutes !== "number" ||
    !Number.isFinite(windowMinutes) ||
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent)
  ) {
    return undefined;
  }

  const resetsAtEpochMs = sessionWindowResetsAtEpochMs(value);
  return {
    windowMinutes,
    usedPercent,
    ...(resetsAtEpochMs === undefined ? {} : { resetsAtEpochMs }),
  };
}

/** Session-file window reset: `resets_at` epoch SECONDS -> ms (old fallback shape); zero/absent -> none. */
function sessionWindowResetsAtEpochMs(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const resetsAt = value.resets_at;
  return typeof resetsAt === "number" && Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : undefined;
}

function parseJsonRecord(input: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function recordProperty(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
