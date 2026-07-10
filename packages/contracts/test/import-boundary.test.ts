import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The contracts package is dependency-free. Every module
 * specifier imported or re-exported from packages/contracts/src must be a
 * relative path; no Effect, Schema, Stream Deck SDK, node builtin, or
 * workspace package may appear in the public source surface.
 */

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function listSourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function importSpecifiersOf(filePath: string): readonly string[] {
  const source = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  const fromClauses = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?\bfrom\s+['"]([^'"]+)['"]/g;
  const bareImports = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  const dynamicImports = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requires = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [fromClauses, bareImports, dynamicImports, requires]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1] as string);
    }
  }
  return specifiers;
}

describe("contracts import boundary", () => {
  const files = listSourceFiles(srcDir);

  it("scans a non-empty contracts source tree", () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it("imports nothing except relative contracts modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiersOf(file)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never references effect, @effect/*, the Stream Deck SDK, or workspace packages", () => {
    const forbidden = [/^effect$/, /^effect\//, /^@effect\//, /^@elgato\/streamdeck/, /^@ai-workbench\//];
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importSpecifiersOf(file)) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
