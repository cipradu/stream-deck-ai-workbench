import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execute }));

import { readClaudeCodeKeychainCredential, resolveClaudeCodeCredential, __resetClaudeCodeSourceHintForTests } from "../src/local-usage-sources.js";

describe("bounded Claude Keychain read", () => {
  beforeEach(() => { execute.mockReset(); __resetClaudeCodeSourceHintForTests(); });

  it("bounds the exact service-only query and maps a timeout to the existing failure so file fallback remains available", async () => {
    execute.mockImplementation((_command, _args, options, callback) => {
      expect(options).toEqual({ encoding: "utf8", timeout: 10_000 });
      callback(new Error("fixture-credential-bearing-timeout"), "fixture-secret-partial-output");
    });
    const keychain = await readClaudeCodeKeychainCredential();
    expect(execute.mock.calls[0]?.slice(0, 2)).toEqual(["security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]]);
    expect(keychain).toEqual({ ok: false, reasonCode: "claude-code-keychain-denied" });
    const result = await resolveClaudeCodeCredential({
      keychain: async () => keychain,
      file: async () => ({ ok: true, accessToken: "fixture-file-access", expiresAt: 20_000 }),
    }, () => 10_000);
    expect(result).toMatchObject({ ok: true, expiresAt: 20_000 });
    expect(JSON.stringify(keychain)).not.toContain("fixture-");
  });
});
