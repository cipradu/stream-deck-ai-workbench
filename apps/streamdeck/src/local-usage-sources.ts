import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ClaudeCodeCredentialResult,
  CodexCredentialResult,
  CodexSessionSnapshot,
  UsageProviderLocalSourceReaders,
} from "@ai-workbench/provider-adapters";

const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_CODEX_AUTH_PATH = join(homedir(), ".codex", "auth.json");
const DEFAULT_CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const CODEX_SESSION_TAIL_BYTES = 128 * 1024;

interface SessionFileInfo {
  readonly path: string;
  readonly mtimeMs: number;
}

export function createLocalUsageSourceReaders(): UsageProviderLocalSourceReaders {
  return {
    claudeCode: {
      readCredential: () => readClaudeCodeKeychainCredential(),
    },
    codex: {
      readCredential: () => readCodexAuthJsonCredential(),
      readSessionSnapshot: () => readNewestCodexSessionSnapshot(),
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

/** Pure parse of the Keychain payload (`.claudeAiOauth.{accessToken, expiresAt}`); never logs contents. */
export function parseClaudeCodeKeychainPayload(stdout: string): ClaudeCodeCredentialResult {
  const parsed = parseJsonRecord(stdout.trim());
  const oauth = parsed === undefined ? undefined : recordProperty(parsed, "claudeAiOauth");
  const accessToken = oauth === undefined ? undefined : oauth.accessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return {
      ok: false,
      reasonCode: "claude-code-keychain-malformed",
    };
  }

  const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
  return {
    ok: true,
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
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

    const fiveHourPercent = sessionWindowPercent(rateLimits.primary);
    const sevenDayPercent = sessionWindowPercent(rateLimits.secondary);
    if (fiveHourPercent === undefined && sevenDayPercent === undefined) {
      continue;
    }

    const fiveHourResetsAtEpochMs = sessionWindowResetsAtEpochMs(rateLimits.primary);
    const sevenDayResetsAtEpochMs = sessionWindowResetsAtEpochMs(rateLimits.secondary);

    return {
      fetchedAtEpochMs,
      ...(fiveHourPercent === undefined ? {} : { fiveHourPercent }),
      ...(sevenDayPercent === undefined ? {} : { sevenDayPercent }),
      ...(fiveHourResetsAtEpochMs === undefined ? {} : { fiveHourResetsAtEpochMs }),
      ...(sevenDayResetsAtEpochMs === undefined ? {} : { sevenDayResetsAtEpochMs }),
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

function sessionWindowPercent(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usedPercent = value.used_percent;
  return typeof usedPercent === "number" && Number.isFinite(usedPercent) ? usedPercent : undefined;
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
