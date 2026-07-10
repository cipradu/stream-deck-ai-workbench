import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_RETRY_AFTER_SECONDS, packageName, parseRetryAfter } from "../src/index.js";

// `@effect/platform` (FetchHttpClient) is the
// ADOPTED boundary; `@effect/platform-node`, `@effect/rpc`, `@effect/sql`,
// `@effect/cluster`, `undici`, and Axios remain rejected. The tokens are assembled
// so this guard file never itself contains the literal rejected strings.
const rejectedDependencyPattern = new RegExp(
  [
    ["@effect", "platform-node"].join("/"),
    ["@effect", "rpc"].join("/"),
    ["@effect", "sql"].join("/"),
    ["@effect", "cluster"].join("/"),
    ["ax", "ios"].join(""),
    `['"]${["un", "dici"].join("")}['"]`,
  ].join("|"),
);

const adoptedBoundaryDependency = `"${["@effect", "platform"].join("/")}"`;

describe("@ai-workbench/http package identity", () => {
  it("keeps the package identity export for workspace consumers", () => {
    expect(packageName).toBe("@ai-workbench/http");
  });
});

describe("@ai-workbench/http Retry-After parsing", () => {
  it("parses delta-seconds independent of the clock", () => {
    expect(parseRetryAfter("30", 0)).toBe(30);
  });

  it("parses an HTTP-date relative to the supplied now", () => {
    const now = Date.UTC(2026, 6, 5, 16, 0, 0);
    const retryDate = new Date(now + 125_000).toUTCString();
    expect(parseRetryAfter(retryDate, now)).toBe(125);
  });

  it("caps excessive values at the policy maximum", () => {
    expect(parseRetryAfter(String(MAX_RETRY_AFTER_SECONDS + 99), 0)).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("   ", 0)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", 0)).toBeUndefined();
  });
});

describe("@ai-workbench/http static guards", () => {
  it("does not declare or import rejected HTTP client dependencies", async () => {
    const [rootPackageJson, httpPackageJson, httpSource] = await Promise.all([
      readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
    ]);

    // Strip source comments so an explanatory reference to a rejected package
    // (e.g. documenting why `@effect/platform-node` is NOT used) is not mistaken
    // for a real import; package metadata is scanned raw.
    const scanned = `${rootPackageJson}\n${httpPackageJson}\n${stripComments(httpSource)}`;
    expect(scanned).not.toMatch(rejectedDependencyPattern);
  });

  it("declares the adopted @effect/platform FetchHttpClient boundary dependency", async () => {
    const httpPackageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
    expect(httpPackageJson).toContain(adoptedBoundaryDependency);
  });

  it("fails if provider-adapter source introduces raw fetch instead of the central HTTP boundary", async () => {
    const providerAdapterSourceRoot = new URL("../../provider-adapters/src/", import.meta.url);
    const files = await listTypeScriptFiles(providerAdapterSourceRoot);
    const offendingFiles: string[] = [];

    for (const file of files) {
      const source = stripComments(await readFile(file, "utf8"));
      if (/\bfetch\s*\(/.test(source)) {
        offendingFiles.push(fileURLToPath(file));
      }
    }

    expect(offendingFiles).toEqual([]);
  });
});

async function listTypeScriptFiles(root: URL): Promise<readonly URL[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(child);
      }
      return entry.name.endsWith(".ts") ? [child] : [];
    }),
  );

  return files.flat();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
