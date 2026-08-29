import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const failures = [];
const staticOnly = process.argv.includes("--static-only");

const expectedWorkspacePackageNames = new Set([
  "@ai-workbench/action-balance",
  "@ai-workbench/action-status",
  "@ai-workbench/action-usage",
  "@ai-workbench/contracts",
  "@ai-workbench/display",
  "@ai-workbench/errors",
  "@ai-workbench/http",
  "@ai-workbench/logging",
  "@ai-workbench/provider-adapters",
  "@ai-workbench/provider-registry",
  "@ai-workbench/runtime-foundation",
  "@ai-workbench/scheduler",
  "@ai-workbench/settings",
  "@ai-workbench/streamdeck",
  "@ai-workbench/typescript-config",
  "@ai-workbench/validation",
]);

const allowedExternalDependencies = new Map([
  [
    "ai-workbench",
    new Set([
      "@elgato/cli",
      "@rollup/plugin-commonjs",
      "@rollup/plugin-node-resolve",
      "@rollup/plugin-terser",
      "@rollup/plugin-typescript",
      "@types/node",
      "rollup",
      "tslib",
      "typescript",
      "vitest",
    ]),
  ],
  // Effect-owning packages per ADR-0024 (runtime primitives: runtime-foundation, scheduler, errors,
  // logging, and the apps/streamdeck shell wiring), ADR-0016/0024 (Effect-native adapters), and
  // ADR-0021 (@ai-workbench/http owns the @effect/platform FetchHttpClient boundary + effect). Each
  // Set mirrors the ACTUAL direct external deps declared in that package's package.json — no more.
  ["@ai-workbench/errors", new Set(["effect"])],
  ["@ai-workbench/http", new Set(["@effect/platform", "effect"])],
  ["@ai-workbench/logging", new Set(["effect"])],
  ["@ai-workbench/provider-adapters", new Set(["@effect/platform", "effect"])],
  ["@ai-workbench/runtime-foundation", new Set(["effect"])],
  ["@ai-workbench/scheduler", new Set(["effect"])],
  ["@ai-workbench/settings", new Set(["effect"])],
  ["@ai-workbench/streamdeck", new Set(["@elgato/streamdeck", "effect"])],
  ["@ai-workbench/validation", new Set(["effect"])],
]);

const effectAllowedPackagePrefixes = [
  // Packages/apps an approved authority sanctions to OWN Effect AND that actually import it:
  // ADR-0024 (errors, logging, scheduler, runtime-foundation, apps/streamdeck shell wiring),
  // ADR-0021 (http HttpClient boundary), ADR-0016/0024 (provider-adapters), plus settings/validation
  // (Effect Schema at the edge). packages/contracts stays effect-free (kept dependency-free below).
  "apps/streamdeck/",
  "packages/errors/",
  "packages/http/",
  "packages/logging/",
  "packages/provider-adapters/",
  "packages/runtime-foundation/",
  "packages/scheduler/",
  "packages/settings/",
  "packages/validation/",
];

const streamDeckSdkAllowedFiles = new Set(["apps/streamdeck/src/index.ts", "apps/streamdeck/src/logging.ts"]);

const sourceScanRoots = ["apps", "packages"];
const strictEqualityScanRoots = ["apps/streamdeck/src", "apps/streamdeck/test", "packages", "tooling"];
const strictEqualityAdditionalFiles = [];
const strictEqualityExcludedFiles = new Set([
  "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/sdpi-components.js",
  "tooling/verification/unit016-verify.mjs",
]);
const providerLiveScanRoots = [
  "packages/action-balance/src",
  "packages/action-status/src",
  "packages/action-usage/src",
  "packages/provider-adapters/src",
];

const allowedLiteralLiveUrlsByFile = new Map([
  [
    "packages/provider-adapters/src/providers/status/anthropic-api/index.ts",
    new Set(["https://status.claude.com/api/v2/summary.json"]),
  ],
  [
    "packages/provider-adapters/src/providers/status/openai-api/index.ts",
    new Set(["https://status.openai.com/api/v2/summary.json"]),
  ],
  [
    "packages/provider-adapters/src/providers/status/moonshot/index.ts",
    new Set(["https://status.moonshot.cn/api/v2/summary.json"]),
  ],
  [
    "packages/provider-adapters/src/providers/status/minimax/index.ts",
    new Set(["https://status.minimax.io/api/v2/summary.json"]),
  ],
]);

const rawGlobalFetchFixtureExemptions = new Map([
  [
    "packages/provider-adapters/test/fixtures/source-policy/status-local-owner-bypass.ts",
    { bareCalls: 1, objectQualifiedCalls: 0 },
  ],
]);

const forbiddenSensitiveNeedles = [
  "UNIT016_FORBIDDEN_SECRET_NEEDLE",
  "UNIT016_FORBIDDEN_ACCOUNT_IDENTIFIER",
  "UNIT016_FORBIDDEN_PROVIDER_RAW_BODY",
  "UNIT016_FORBIDDEN_EFFECT_CAUSE",
  "UNIT016_FORBIDDEN_VENDOR_VALUE_12345",
];

const piVisibleCopyScanFiles = [
  "apps/streamdeck/src/property-inspector.ts",
  "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/usage-display.html",
  "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/balance-display.html",
  "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/status-display.html",
];

const piRawStatusTokens = [
  "action-settings-schema",
  "property-inspector-payload-schema",
  "source-proof-required",
  "probe-required",
  "decision-gated",
];

const piInternalProofPhrases = [
  "Adapter source proof",
  "Docs-backed metric truth",
  "Owner-gated proof",
  "Owner decision",
];

const expectedActionFamilyIds = ["usage", "balance", "status"];
const expectedUsageProviders = ["claude-code", "codex", "kimi-code", "zai-coding-plan", "minimax"];
const expectedBalanceProviders = [
  "anthropic-api",
  "openai-api",
  "moonshot",
  "deepseek",
  "tavily",
  "exa",
  "deepgram",
  "jina",
  "fal",
  "elevenlabs",
  "runpod",
  "speechmatics",
  "openrouter",
];
const expectedStatusProviders = ["anthropic-api", "openai-api", "moonshot", "minimax"];
const expectedStatusProviderOptions = [
  { providerId: "anthropic-api", label: "Anthropic" },
  { providerId: "openai-api", label: "OpenAI" },
  { providerId: "moonshot", label: "Moonshot AI" },
  { providerId: "minimax", label: "MiniMax" },
];
const expectedProviderIds = new Set([...expectedUsageProviders, ...expectedBalanceProviders]);

const expectedManifestActions = [
  {
    uuid: "com.blackice.ai-workbench.usage-display",
    name: "Usage",
    propertyInspectorPath: "ui/usage-display.html",
  },
  {
    uuid: "com.blackice.ai-workbench.balance-display",
    name: "Balance",
    propertyInspectorPath: "ui/balance-display.html",
  },
  {
    uuid: "com.blackice.ai-workbench.status-display",
    name: "Status",
    propertyInspectorPath: "ui/status-display.html",
  },
];

const expectedProviderStatus = new Map(
  [...expectedProviderIds].map((providerId) => [
    providerId,
    { implementationStatus: "implemented", sourceProofStatus: "probeAccepted" },
  ]),
);

const expectedImplementationStatusBehavior = new Map([
  ["implemented", { selectionEligible: true, fetchAllowed: true }],
  ["probeRequired", { selectionEligible: false, fetchAllowed: false }],
  ["docsOnly", { selectionEligible: false, fetchAllowed: false }],
  ["unsupported", { selectionEligible: false, fetchAllowed: false }],
  ["notImplemented", { selectionEligible: false, fetchAllowed: false }],
]);

const rejectedDependencySpecifiers = ["axios", "pino", "undici", "zod"];
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Raw GLOBAL fetch guard (REQ-030/ADR-0021: only packages/http owns the HTTP boundary). The negative
// lookbehind (?<![.\w]) matches a bare global `fetch(` while NOT matching a `.fetch(` method/property
// call (e.g. the scheduler's injected `entry.fetch(...)`) or an identifier ending in `fetch(` (e.g.
// `prefetch(`). Mirrors the accepted scheduler self-guard in packages/scheduler/test/index.test.ts.
const rawGlobalFetchCallPattern = /(?<![.\w])fetch\s*\(/;
// Companion guard (GOV-R11b) for OBJECT-QUALIFIED global fetch: `globalThis.fetch(`, `self.fetch(`, and
// `window.fetch(` reach the SAME global boundary but through a global object, which the pattern above
// deliberately misses because its `.fetch(` exclusion (needed for injected clients like `entry.fetch(`) also
// swallows the qualified global. The leading (?<![.\w]) still rejects a member access such as
// `foo.globalThis.fetch(` and matches only the true globals; an injected `entry.fetch(`/`client.fetch(` is not
// one of these names, so the `.fetch(` false positive is NOT reintroduced.
const objectQualifiedGlobalFetchCallPattern = /(?<![.\w])(?:globalThis|self|window)\s*\.\s*fetch\s*\(/;

if (staticOnly) {
  console.log("[unit016] static-only mode: skipping pnpm test/typecheck/build");
} else {
  runPnpm(["test"]);
  runPnpm(["run", "typecheck"]);
  runPnpm(["run", "build"]);
}

runStaticChecks();
if (staticOnly) {
  checkProviderRegistrySourceTruth();
} else {
  await checkProviderRegistryBuildOutput();
}

if (failures.length > 0) {
  console.error("");
  console.error(`[unit016] failed ${failures.length} static check(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("");
console.log("[unit016] verification gate passed");

function runPnpm(args) {
  console.log("");
  console.log(`[unit016] run: pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`[unit016] pnpm ${args.join(" ")} failed to start: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[unit016] pnpm ${args.join(" ")} failed with exit ${result.status ?? "unknown"}`);
    process.exit(result.status ?? 1);
  }

  console.log(`[unit016] pass: pnpm ${args.join(" ")}`);
}

function runStaticChecks() {
  console.log("");
  console.log("[unit016] static scans");

  checkPackageMetadata();
  checkPnpmHardening();
  checkManifest();
  checkImportBoundaries();
  checkAuthoredStrictEquality();
  checkProviderLiveBoundaries();
  checkForbiddenNeedles();
  checkPiVisibleCopyGate();
  checkDocsAlignment();
  checkScannerSelfTest();

  if (failures.length === 0) {
    console.log("[unit016] pass: static scans");
  }
}

function checkPackageMetadata() {
  const rootPackage = readJson("package.json");
  assert(rootPackage.name === "ai-workbench", "root package name is ai-workbench");
  assert(rootPackage.private === true, "root package remains private");
  assert(rootPackage.packageManager === "pnpm@11.10.0", "root packageManager pins pnpm@11.10.0");
  assert(rootPackage.engines?.node === ">=24.0.0", "root Node engine is >=24.0.0");
  assert(rootPackage.scripts?.test === "vitest run", "root test script remains wired");
  assert(rootPackage.scripts?.typecheck === "pnpm -r run typecheck", "root typecheck script remains wired");
  assert(rootPackage.scripts?.build === "pnpm -r run build", "root build script remains wired");
  assert(
    rootPackage.scripts?.["verify:unit016"] === "node tooling/verification/unit016-verify.mjs",
    "root verify:unit016 script is wired",
  );

  const packageJsonFiles = findPackageJsonFiles().filter((file) => relativePath(file) !== "package.json");
  const observedNames = new Set();

  for (const file of packageJsonFiles) {
    const packageJson = readJson(relativePath(file));
    observedNames.add(packageJson.name);
    assert(packageJson.private === true, `${relativePath(file)} remains private`);

    if (packageJson.name !== "@ai-workbench/typescript-config") {
      assert(packageJson.type === "module", `${packageJson.name} is an ESM package`);
      assert(packageJson.scripts?.typecheck === "tsc -p tsconfig.json", `${packageJson.name} has typecheck script`);
      if (packageJson.name === "@ai-workbench/streamdeck") {
        assert(packageJson.scripts?.build?.includes("rollup -c"), `${packageJson.name} bundles the Stream Deck plugin`);
      } else {
        assert(packageJson.scripts?.build === "tsc -p tsconfig.build.json", `${packageJson.name} has build script`);
      }
    }

    checkDependencyPolicy(packageJson, relativePath(file));
  }

  assert(setEquals(observedNames, expectedWorkspacePackageNames), "workspace package set matches ADR-0020 ownership list");
  checkDependencyPolicy(rootPackage, "package.json");
  console.log("[unit016] pass: package metadata and direct dependency policy");
}

function checkDependencyPolicy(packageJson, packagePath) {
  const allowedExternal = allowedExternalDependencies.get(packageJson.name) ?? new Set();

  for (const field of dependencyFields) {
    for (const dependencyName of Object.keys(packageJson[field] ?? {})) {
      assert(!isRejectedDependency(dependencyName), `${packagePath} does not declare rejected dependency ${dependencyName}`);

      if (dependencyName.startsWith("@ai-workbench/")) {
        continue;
      }

      assert(
        allowedExternal.has(dependencyName),
        `${packagePath} external dependency ${dependencyName} is explicitly allowed for ${packageJson.name}`,
      );
    }
  }
}

function checkPnpmHardening() {
  const workspaceText = readText("pnpm-workspace.yaml");
  assert(workspaceText.includes("engineStrict: true"), "pnpm workspace enables engineStrict");
  assert(workspaceText.includes("strictDepBuilds: true"), "pnpm workspace enables strictDepBuilds");
  assert(workspaceText.includes("minimumReleaseAge: 10080"), "pnpm workspace sets one-week minimumReleaseAge");
  assert(workspaceText.includes("trustPolicy: no-downgrade"), "pnpm workspace sets no-downgrade trustPolicy");
  assert(workspaceText.includes("blockExoticSubdeps: true"), "pnpm workspace blocks exotic subdeps");
  assert(workspaceText.includes("esbuild: true"), "pnpm workspace allowBuilds remains esbuild-only");
  assert(!workspaceText.includes("shamefullyHoist: true"), "pnpm workspace does not enable shamefullyHoist");
  assert(!workspaceText.includes("nodeLinker: hoisted"), "pnpm workspace does not enable hoisted node linker");

  const configResult = spawnSync("pnpm", ["config", "list", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(configResult.status === 0, "pnpm config list --json exits 0");

  if (configResult.status === 0) {
    const config = JSON.parse(configResult.stdout);
    assert(config.engineStrict === true, "pnpm config readback engineStrict=true");
    assert(config.strictDepBuilds === true, "pnpm config readback strictDepBuilds=true");
    assert(config.allowBuilds?.esbuild === true, "pnpm config readback allowBuilds.esbuild=true");
    assert(config.minimumReleaseAge === 10080, "pnpm config readback minimumReleaseAge=10080");
    assert(config.trustPolicy === "no-downgrade", "pnpm config readback trustPolicy=no-downgrade");
    assert(config.blockExoticSubdeps === true, "pnpm config readback blockExoticSubdeps=true");
    console.log(
      `[unit016] pnpm readback: engineStrict=${config.engineStrict}, strictDepBuilds=${config.strictDepBuilds}, minimumReleaseAge=${config.minimumReleaseAge}, trustPolicy=${config.trustPolicy}, blockExoticSubdeps=${config.blockExoticSubdeps}, node=${process.version}`,
    );
  }

  console.log("[unit016] pass: pnpm hardening readback");
}

function checkManifest() {
  const manifestPath = "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/manifest.json";
  const manifest = readJson(manifestPath);

  assert(manifest.UUID === "com.blackice.ai-workbench", "manifest plugin UUID is stable");
  assert(manifest.CodePath === "bin/plugin.js", "manifest CodePath targets bundled plugin entry");
  assert(manifest.SDKVersion === 2, "manifest SDKVersion is 2");
  assert(manifest.Nodejs?.Version === "24", "manifest targets Stream Deck Node 24");
  assert(manifest.Software?.MinimumVersion === "7.1", "manifest requires Stream Deck 7.1");
  assert(manifest.OS?.some((entry) => entry.Platform === "mac" && entry.MinimumVersion === "14.0"), "manifest macOS target is present");

  const observedActions = (manifest.Actions ?? []).map((action) => ({
    uuid: action.UUID,
    name: action.Name,
    propertyInspectorPath: action.PropertyInspectorPath,
  }));
  assert(
    arraysEqual(observedActions, expectedManifestActions),
    "manifest has exactly the Usage, Balance, and Status action UUID/name/PI inventory",
  );

  assert(
    existsSync(path.join(repoRoot, "apps/streamdeck/com.blackice.ai-workbench.sdPlugin", `${manifest.Icon}.png`)),
    `manifest plugin PNG asset exists: ${manifest.Icon}.png`,
  );

  for (const assetPath of [
    manifest.CategoryIcon,
    ...(manifest.Actions ?? []).flatMap((action) => [action.Icon, ...(action.States ?? []).map((state) => state.Image)]),
  ]) {
    assert(
      existsSync(path.join(repoRoot, "apps/streamdeck/com.blackice.ai-workbench.sdPlugin", `${assetPath}.svg`)) ||
        existsSync(path.join(repoRoot, "apps/streamdeck/com.blackice.ai-workbench.sdPlugin", `${assetPath}.png`)),
      `manifest asset exists as SVG or PNG: ${assetPath}`,
    );
  }

  for (const action of manifest.Actions ?? []) {
    assert(
      typeof action.PropertyInspectorPath === "string" && action.PropertyInspectorPath.startsWith("ui/"),
      `${action.UUID} property inspector uses the plugin ui/ directory`,
    );
    assert(
      existsSync(path.join(repoRoot, "apps/streamdeck/com.blackice.ai-workbench.sdPlugin", action.PropertyInspectorPath)),
      `${action.UUID} property inspector path exists`,
    );
  }

  const uiFiles = [
    "ui/usage-display.html",
    "ui/balance-display.html",
    "ui/status-display.html",
    "ui/sdpi-components.js",
  ];
  for (const file of uiFiles) {
    assert(existsSync(path.join(repoRoot, "apps/streamdeck/com.blackice.ai-workbench.sdPlugin", file)), `plugin UI file exists: ${file}`);
  }

  const combinedPiSource = ["ui/usage-display.html", "ui/balance-display.html", "ui/status-display.html"]
    .map((file) => readText(path.join("apps/streamdeck/com.blackice.ai-workbench.sdPlugin", file)))
    .join("\n");
  assert(combinedPiSource.includes("sdpi-components.js"), "property inspectors load sdpi-components");
  assert(combinedPiSource.includes("<sdpi-item"), "property inspectors use sdpi native rows");
  assert(!combinedPiSource.includes("property-inspector.css"), "property inspectors do not use custom chrome stylesheet");

  const statusPiSource = readText(
    "apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/status-display.html",
  );
  const statusPiOptions = [...statusPiSource.matchAll(/<option\s+value="([^"]+)">([^<]+)<\/option>/g)].map(
    (match) => ({ providerId: match[1], label: match[2] }),
  );
  const statusPiSettingNames = [...statusPiSource.matchAll(/\bsetting="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    arraysEqual(statusPiOptions, expectedStatusProviderOptions),
    "Status PI has the exact registry-derived provider option inventory",
  );
  assert(
    arraysEqual(statusPiSettingNames, ["providerId", "intervalSeconds"]),
    "Status PI exposes exactly the Provider setting",
  );
  console.log("[unit016] pass: manifest sanity");
}

function checkImportBoundaries() {
  const files = sourceScanRoots.flatMap((root) => walk(root)).filter((file) => file.endsWith(".ts"));

  for (const file of files) {
    const rel = relativePath(file);
    if (rel.includes("/dist/") || rel.includes(".sdPlugin/bin/")) {
      continue;
    }

    const source = stripComments(readFileSync(file, "utf8"));
    const imports = extractImportSpecifiers(source);

    for (const specifier of imports) {
      assert(!isRejectedDependency(specifier), `${rel} does not import rejected dependency ${specifier}`);

      if (rel.startsWith("packages/contracts/src/") && !specifier.startsWith(".")) {
        fail(`${rel} imports ${specifier}; contracts public source must remain dependency-free`);
      }

      if (isEffectSpecifier(specifier)) {
        assert(
          effectAllowedPackagePrefixes.some((prefix) => rel.startsWith(prefix)),
          `${rel} imports ${specifier} only from approved Effect-owning packages`,
        );
      }

      if (isStreamDeckSdkSpecifier(specifier)) {
        assert(streamDeckSdkAllowedFiles.has(rel), `${rel} imports Stream Deck SDK only from app shell/logging adapter surface`);
      }

      if (specifier.startsWith("@ai-workbench/")) {
        const packageRoot = findNearestPackageRoot(file);
        if (packageRoot !== undefined) {
          const packageJson = readJson(relativePath(path.join(packageRoot, "package.json")));
          if (packageJson.name !== specifier) {
            assert(dependencyNames(packageJson).has(specifier), `${packageJson.name} declares workspace dependency ${specifier}`);
          }
        }
      }
    }

    // Product AND test source must not call raw global fetch outside packages/http (REQ-030/ADR-0021): the
    // bare-global pattern plus the object-qualified companion (globalThis/self/window.fetch). Test files are
    // FULLY scanned again (GOV-R11b restored the test-file scan the earlier GOV-R11a deviation removed) — the
    // provider-adapters test's local `const fetch = <provider>EffectSourceFetch(...)` bindings were renamed to
    // `runFetch`, so the injected source fetch no longer shares the global's spelling and the exclusion is gone.
    if (!rel.startsWith("packages/http/src/")) {
      const bareCalls = countPatternMatches(source, rawGlobalFetchCallPattern);
      const objectQualifiedCalls = countPatternMatches(source, objectQualifiedGlobalFetchCallPattern);
      const fixtureExemption = rawGlobalFetchFixtureExemptions.get(rel);
      if (fixtureExemption === undefined) {
        if (bareCalls > 0 || objectQualifiedCalls > 0) {
          fail(`${rel} calls raw global fetch outside packages/http boundary`);
        }
      } else {
        assert(
          bareCalls === fixtureExemption.bareCalls &&
            objectQualifiedCalls === fixtureExemption.objectQualifiedCalls,
          `${rel} contains only its exact adversarial raw-fetch declaration count`,
        );
      }
    }
  }

  for (const exemptFile of rawGlobalFetchFixtureExemptions.keys()) {
    assert(existsSync(path.join(repoRoot, exemptFile)), `raw-fetch fixture exemption target exists: ${exemptFile}`);
  }

  console.log("[unit016] pass: import ownership and raw fetch boundary");
}

function checkProviderLiveBoundaries() {
  const forbiddenPatterns = [
    [/process\.env\b/, "process.env"],
    [/Deno\.env\b/, "Deno.env"],
    [/\.env\b/, ".env"],
    [/auth\.json\b/, "auth.json"],
    [/browser-session-token\b/, "browser-session-token"],
    [/node:fs\b/, "node:fs"],
    [/node:os\b/, "node:os"],
    [/node:child_process\b/, "node:child_process"],
    [/fs\/promises\b/, "fs/promises"],
    [/child_process\b/, "child_process"],
    [/\breadFile(?:Sync)?\s*\(/, "readFile"],
    [/\breaddir\s*\(/, "readdir"],
    [/\bhomedir\s*\(/, "homedir"],
    [/\bexecFile\s*\(/, "execFile"],
    [/\bspawn\s*\(/, "spawn"],
    [/\bcurl\b/, "curl"],
    [/\bfile:\/\//, "file URL"],
    [rawGlobalFetchCallPattern, "raw global fetch"],
    [objectQualifiedGlobalFetchCallPattern, "raw global fetch"],
    [/\bset(?:Timeout|Interval)\s*\(/, "provider-local timer"],
  ];

  for (const file of providerLiveScanRoots.flatMap((root) => walk(root)).filter((file) => file.endsWith(".ts"))) {
    const rel = relativePath(file);
    const source = stripComments(readFileSync(file, "utf8"));
    const observedLiveUrls = collectLiteralHttpUrls(source);
    const allowedLiveUrls = allowedLiteralLiveUrlsByFile.get(rel) ?? new Set();
    assert(
      setEquals(observedLiveUrls, allowedLiveUrls),
      `${rel} literal live URLs match its exact sanctioned Status source declaration set`,
    );
    for (const [pattern, label] of forbiddenPatterns) {
      if (pattern.test(source)) {
        fail(`${rel} contains ${label}; provider/action source must not perform live, env, auth, local-source, or retry/timer work`);
      }
    }
  }


  for (const sanctionedFile of allowedLiteralLiveUrlsByFile.keys()) {
    assert(existsSync(path.join(repoRoot, sanctionedFile)), `sanctioned Status source declaration exists: ${sanctionedFile}`);
  }

  console.log("[unit016] pass: provider/action live-source boundary scan");
}

function checkAuthoredStrictEquality() {
  const files = [
    ...strictEqualityScanRoots.flatMap((root) => walk(root)),
    ...strictEqualityAdditionalFiles.map((file) => path.join(repoRoot, file)),
  ].filter((file) => /\.(?:js|mjs|ts)$/.test(relativePath(file)));

  for (const file of files) {
    const rel = relativePath(file);
    if (strictEqualityExcludedFiles.has(rel) || rel.includes("/dist/") || rel.includes(".sdPlugin/bin/")) {
      continue;
    }

    const violations = collectLooseEqualityViolations(readFileSync(file, "utf8"));
    for (const violation of violations) {
      fail(`${rel} contains loose equality ${violation.operator} at offset ${violation.index}; generated bundle and vendored UI assets are excluded explicitly`);
    }
  }

  console.log("[unit016] pass: authored source strict-equality scan");
}

function checkForbiddenNeedles() {
  const files = ["apps", "docs", "packages", "tooling", "README.md", "package.json", "pnpm-workspace.yaml"].flatMap((entry) =>
    existsSync(path.join(repoRoot, entry)) && lstatSync(path.join(repoRoot, entry)).isDirectory()
      ? walk(entry, { includeBuildOutput: true })
      : [path.join(repoRoot, entry)],
  );

  for (const file of files) {
    const rel = relativePath(file);
    if (rel === "tooling/verification/unit016-verify.mjs" || lstatSync(file).isDirectory()) {
      continue;
    }

    if (!/\.(?:cjs|css|d\.ts|html|js|json|md|mjs|svg|ts|yaml|yml)$/.test(rel)) {
      continue;
    }

    const text = readFileSync(file, "utf8");
    for (const needle of forbiddenSensitiveNeedles) {
      if (text.includes(needle)) {
        fail(`${rel} contains forbidden UNIT-016 synthetic sensitive needle ${needle}`);
      }
    }
  }

  console.log("[unit016] pass: forbidden sensitive synthetic needle scan");
}

function checkPiVisibleCopyGate() {
  let violationCount = 0;

  for (const file of piVisibleCopyScanFiles) {
    assert(existsSync(path.join(repoRoot, file)), `PI visible-copy scan target exists: ${file}`);
    if (!existsSync(path.join(repoRoot, file))) {
      continue;
    }

    const violations = collectPiVisibleCopyViolations(file, readText(file));
    violationCount += violations.length;
    for (const violation of violations) {
      fail(`${file} contains PI visible-copy leak pattern: ${violation}`);
    }
  }

  if (violationCount === 0) {
    console.log("[unit016] pass: PI visible-copy static gate");
  }
}

function checkDocsAlignment() {
  const readme = readText("README.md");
  for (const staleText of [
    "not a runnable plugin tree",
    "No package metadata, dependency install, Stream Deck manifest, source tree, implementation execution",
    "documentation and control-surface definition for the new Effect runtime foundation, not implementation",
  ]) {
    assert(!readme.includes(staleText), `README no longer contains stale reset-baseline text: ${staleText}`);
  }

  // The README is now a public product front door (not the internal UNIT-status doc), so it no
  // longer needs to enumerate UNIT-001..016. It must still document the verification gate command
  // and the workspace layout so build/dev instructions stay accurate.
  for (const requiredText of [
    "pnpm run verify:unit016",
    "apps/streamdeck",
    "packages/",
    "**Actions:** Usage, Balance, and Status",
    "### Status",
    "public no-credential status source",
    "60 to 3600 seconds (default 600)",
    "OpenAI keeps the active-incident count as the primary value",
    "worse independently mapped value of highest active incident impact and aggregate provider status",
    "OpenAI aggregate `none` is green, `maintenance` is blue, `minor` is amber, and `major` or `critical` is red",
    "Anthropic, Moonshot AI, and MiniMax color comes from highest active incident impact",
    "not a component, model, or customer-specific availability claim",
  ]) {
    assert(readme.includes(requiredText), `README contains ${requiredText}`);
  }
  for (const staleStatusText of [
    "Status — the count of provider-reported active incidents, colored by the highest reported impact",
    "Resolved and postmortem incidents, scheduled maintenance, components, and page-wide summary status are excluded",
    "Their green, blue, amber, or red color comes from the highest included provider-reported impact",
  ]) {
    assert(!readme.includes(staleStatusText), `README no longer contains stale Status copy: ${staleStatusText}`);
  }

  const manifest = readJson("apps/streamdeck/com.blackice.ai-workbench.sdPlugin/manifest.json");
  const readmeVersion = /\*\*Plugin version:\*\* `([^`]+)`/.exec(readme)?.[1];
  assert(readmeVersion === manifest.Version, "README plugin version matches the manifest version");
  const statusAction = (manifest.Actions ?? []).find(
    (action) => action.UUID === "com.blackice.ai-workbench.status-display",
  );
  for (const requiredStatusTooltipText of [
    "active incident count",
    "public no-credential feeds",
    "OpenAI color reflects the worse of highest active incident impact and aggregate provider status",
    "other providers use incident impact only",
  ]) {
    assert(
      statusAction?.Tooltip?.includes(requiredStatusTooltipText) === true,
      `Status manifest tooltip contains ${requiredStatusTooltipText}`,
    );
  }
  for (const requiredDescriptionText of [
    "public provider active-incident counts",
    "Status color uses incident impact; OpenAI also uses aggregate provider status",
    "Provider-wide only",
    "no component, model, or customer-specific health claim",
  ]) {
    assert(
      manifest.Description?.includes(requiredDescriptionText) === true,
      `manifest Description contains ${requiredDescriptionText}`,
    );
  }

  const packetPath = "docs/verification/unit-016-review-packet.md";
  assert(existsSync(path.join(repoRoot, packetPath)), "UNIT-016 review packet exists");

  if (existsSync(path.join(repoRoot, packetPath))) {
    const packet = readText(packetPath);
    for (let index = 1; index <= 27; index += 1) {
      const id = `VE-${String(index).padStart(3, "0")}`;
      assert(packet.includes(id), `review packet maps ${id}`);
    }
    assert(packet.includes("pnpm run verify:unit016"), "review packet references UNIT-016 verification command");
    assert(packet.includes("UNIT-015"), "review packet records owner-gated UNIT-015 checks");
  }

  console.log("[unit016] pass: docs alignment and review packet shape");
}

async function checkProviderRegistryBuildOutput() {
  const registryModulePath = path.join(repoRoot, "packages/provider-registry/dist/index.js");
  const registry = await import(`${pathToFileURL(registryModulePath).href}?unit016=${Date.now()}`);
  const providerIds = new Set(registry.PROVIDER_REGISTRY.map((entry) => entry.providerId));

  assert(setEquals(providerIds, expectedProviderIds), "registry provider identity set matches exact current catalog");
  for (const [actionFamilyId, expectedProviderIdsForFamily] of [
    ["usage", expectedUsageProviders],
    ["balance", expectedBalanceProviders],
    ["status", expectedStatusProviders],
  ]) {
    const observedProviderIdsForFamily = registry
      .listProviderCapabilitiesForFamily(actionFamilyId)
      .map((entry) => entry.providerId);
    assert(
      arraysEqual(observedProviderIdsForFamily, expectedProviderIdsForFamily),
      `${actionFamilyId} provider capability inventory matches its exact current ordered set`,
    );
  }

  for (const entry of registry.PROVIDER_REGISTRY) {
    const expected = expectedProviderStatus.get(entry.providerId);
    assert(expected !== undefined, `${entry.providerId} has an expected provider status contract`);

    for (const capability of entry.capabilities) {
      if (expected !== undefined) {
        assert(capability.implementationStatus === expected.implementationStatus, `${entry.providerId} implementationStatus is ${expected.implementationStatus}`);
        assert(capability.sourceProofStatus === expected.sourceProofStatus, `${entry.providerId} sourceProofStatus is ${expected.sourceProofStatus}`);
      }

      const behavior = registry.IMPLEMENTATION_STATUS_BEHAVIOR[capability.implementationStatus];
      const expectedBehavior = expectedImplementationStatusBehavior.get(capability.implementationStatus);
      assert(behavior?.fetchAllowed === expectedBehavior?.fetchAllowed, `${entry.providerId} fetchAllowed matches ${capability.implementationStatus}`);
      assert(
        behavior?.selectionEligible === expectedBehavior?.selectionEligible,
        `${entry.providerId} selectionEligible matches ${capability.implementationStatus}`,
      );
    }
  }

  // Codex "credits" category (UNIT-USAGE-CODEX-CREDITS): the built registry must offer it as a Codex
  // usage window and resolve it to the lower-bound usage-credits metric with a no-default
  // (requires-user-profile) severity strategy — and ONLY for Codex.
  const codexUsage = registry.findProviderEntry("codex")?.capabilities.find((capability) => capability.actionFamilyId === "usage");
  assert(codexUsage?.supportedWindows?.includes("credits") === true, "codex usage capability offers the credits category");
  if (codexUsage !== undefined) {
    const creditsMetric = registry.resolveCapabilityMetricForWindow(codexUsage, "credits");
    assert(creditsMetric.metricKind === "usage-credits", "codex credits category resolves to the usage-credits metric");
    assert(creditsMetric.metricDirection === "lower-bound", "codex credits metric is lower-bound");
    assert(creditsMetric.displayUnit === "credits", "codex credits metric unit is credits");
    assert(creditsMetric.coverageKind === "evergreen", "codex credits metric coverage is evergreen");
    assert(
      creditsMetric.severityStrategy.kind === "requires-user-profile",
      "codex credits metric has a no-default (requires-user-profile) severity strategy",
    );
  }
  for (const otherUsageProvider of ["claude-code", "kimi-code", "zai-coding-plan", "minimax"]) {
    const capability = registry.findProviderEntry(otherUsageProvider)?.capabilities.find((entry) => entry.actionFamilyId === "usage");
    assert(
      capability?.supportedWindows?.includes("credits") !== true,
      `${otherUsageProvider} does not offer the credits category (Codex only)`,
    );
  }

  // Codex "resets" category (UNIT-USAGE-CODEX-RESETS): the built registry must offer it as a Codex
  // usage window and resolve it to the lower-bound usage-resets count metric whose severity is a
  // registry-default keyed to the reset-credit-runway (days) threshold set — and ONLY for Codex.
  assert(codexUsage?.supportedWindows?.includes("resets") === true, "codex usage capability offers the resets category");
  if (codexUsage !== undefined) {
    const resetsMetric = registry.resolveCapabilityMetricForWindow(codexUsage, "resets");
    assert(resetsMetric.metricKind === "usage-resets", "codex resets category resolves to the usage-resets metric");
    assert(resetsMetric.metricDirection === "lower-bound", "codex resets metric is lower-bound");
    assert(resetsMetric.displayUnit === "count", "codex resets metric unit is count");
    assert(resetsMetric.coverageKind === "evergreen", "codex resets metric coverage is evergreen");
    assert(
      resetsMetric.severityStrategy.kind === "registry-default",
      "codex resets metric has a registry-default severity strategy",
    );
    assert(
      resetsMetric.severityStrategy.reference === "lower-bound-resets-days-default",
      "codex resets default references the lower-bound-resets-days-default threshold set",
    );

    // Registry↔display parity for the resets default: the referenced threshold set (owned by the
    // display boundary) must be the approved lower-bound days runway — warn at 7 days, crit at 3.
    const displayModulePath = path.join(repoRoot, "packages/display/dist/index.js");
    const display = await import(`${pathToFileURL(displayModulePath).href}?unit016=${Date.now()}`);
    const resetsDefault = display.DEFAULT_SEVERITY_THRESHOLDS[resetsMetric.severityStrategy.reference];
    assert(resetsDefault !== undefined, "display exposes the resets-days default threshold set");
    assert(
      resetsDefault?.direction === "lower-bound" && resetsDefault?.basis === "absolute",
      "resets-days default is a lower-bound absolute threshold set",
    );
    assert(
      resetsDefault?.warningAt === 7 && resetsDefault?.criticalAt === 3,
      "resets-days default warns at 7 days and crits at 3 days",
    );
  }
  for (const otherUsageProvider of ["claude-code", "zai-coding-plan", "minimax"]) {
    const capability = registry.findProviderEntry(otherUsageProvider)?.capabilities.find((entry) => entry.actionFamilyId === "usage");
    assert(
      capability?.supportedWindows?.includes("resets") !== true,
      `${otherUsageProvider} does not offer the resets category (Codex only)`,
    );
  }

  // MiniMax usage provider (owner in-thread 2026-07-10): the built registry must offer it as a
  // keyed usage provider with the five-hour + seven-day rolling windows, both resolving to the
  // standard upper-bound usage-percent metric with the registry-default usage-percent severity —
  // identical class to z.ai/Codex percentage windows, with NO per-category override.
  const minimaxEntry = registry.findProviderEntry("minimax");
  assert(minimaxEntry?.productLabel === "MiniMax", "minimax registry entry carries the MiniMax product label");
  const minimaxUsage = minimaxEntry?.capabilities.find((capability) => capability.actionFamilyId === "usage");
  assert(minimaxUsage !== undefined, "minimax exposes a usage capability");
  if (minimaxUsage !== undefined) {
    assert(
      JSON.stringify(minimaxUsage.supportedWindows) === JSON.stringify(["five-hour", "seven-day"]),
      "minimax usage capability offers exactly the five-hour and seven-day windows",
    );
    assert(
      JSON.stringify(minimaxUsage.credentialClasses) === JSON.stringify(["plugin-api-key"]),
      "minimax uses the keyed plugin-api-key credential class",
    );
    for (const windowId of ["five-hour", "seven-day"]) {
      const metric = registry.resolveCapabilityMetricForWindow(minimaxUsage, windowId);
      assert(metric.metricKind === "usage-percent", `minimax ${windowId} resolves to the usage-percent metric`);
      assert(metric.metricDirection === "upper-bound", `minimax ${windowId} metric is upper-bound`);
      assert(metric.displayUnit === "percent", `minimax ${windowId} metric unit is percent`);
      assert(metric.coverageKind === "rolling-window", `minimax ${windowId} coverage is rolling-window`);
      assert(
        metric.severityStrategy.kind === "registry-default" &&
          metric.severityStrategy.reference === "upper-bound-usage-percent-default",
        `minimax ${windowId} uses the standard upper-bound usage-percent default severity`,
      );
    }
  }

  // Claude Code "fable" category (UNIT-USAGE-CLAUDE-FABLE, owner in-thread 2026-07-10): the built
  // registry must offer it as a claude-code usage window that resolves to the DEFAULT upper-bound
  // usage-percent metric (NO categoryMetrics override — a plain rolling weekly window like the 5h/7d
  // windows), and ONLY claude-code declares it (codex/zai/minimax must not).
  const claudeUsage = registry
    .findProviderEntry("claude-code")
    ?.capabilities.find((capability) => capability.actionFamilyId === "usage");
  assert(claudeUsage?.supportedWindows?.includes("fable") === true, "claude-code usage capability offers the fable category");
  if (claudeUsage !== undefined) {
    const fableMetric = registry.resolveCapabilityMetricForWindow(claudeUsage, "fable");
    assert(fableMetric.metricKind === "usage-percent", "claude-code fable category resolves to the usage-percent metric");
    assert(fableMetric.metricDirection === "upper-bound", "claude-code fable metric is upper-bound");
    assert(fableMetric.displayUnit === "percent", "claude-code fable metric unit is percent");
    assert(fableMetric.coverageKind === "rolling-window", "claude-code fable metric coverage is rolling-window");
    assert(
      fableMetric.severityStrategy.kind === "registry-default" &&
        fableMetric.severityStrategy.reference === "upper-bound-usage-percent-default",
      "claude-code fable uses the standard upper-bound usage-percent default severity",
    );
  }
  for (const otherUsageProvider of ["codex", "zai-coding-plan", "minimax"]) {
    const capability = registry.findProviderEntry(otherUsageProvider)?.capabilities.find((entry) => entry.actionFamilyId === "usage");
    assert(
      capability?.supportedWindows?.includes("fable") !== true,
      `${otherUsageProvider} does not offer the fable category (Claude Code only)`,
    );
  }

  // Claude Code "credit-spend" category (UNIT-USAGE-CLAUDE-CREDIT-SPEND, owner in-thread 2026-07-10):
  // the built registry must offer it as a claude-code usage window that resolves to the upper-bound
  // usage-spend MONEY metric with current-period coverage and a no-default (requires-user-profile)
  // severity strategy — and ONLY claude-code declares it. Its internal id is `credit-spend`, distinct
  // from the Codex `credits` count pool (asserted separately above), so the two never clash.
  assert(
    claudeUsage?.supportedWindows?.includes("credit-spend") === true,
    "claude-code usage capability offers the credit-spend category",
  );
  if (claudeUsage !== undefined) {
    const spendMetric = registry.resolveCapabilityMetricForWindow(claudeUsage, "credit-spend");
    assert(spendMetric.metricKind === "usage-spend", "claude-code credit-spend category resolves to the usage-spend metric");
    assert(spendMetric.metricDirection === "upper-bound", "claude-code credit-spend metric is upper-bound");
    assert(spendMetric.displayUnit === "money", "claude-code credit-spend metric unit is money");
    assert(spendMetric.coverageKind === "current-period", "claude-code credit-spend metric coverage is current-period");
    assert(
      spendMetric.severityStrategy.kind === "requires-user-profile",
      "claude-code credit-spend metric has a no-default (requires-user-profile) severity strategy",
    );
  }
  for (const otherUsageProvider of ["codex", "zai-coding-plan", "minimax"]) {
    const capability = registry.findProviderEntry(otherUsageProvider)?.capabilities.find((entry) => entry.actionFamilyId === "usage");
    assert(
      capability?.supportedWindows?.includes("credit-spend") !== true,
      `${otherUsageProvider} does not offer the credit-spend category (Claude Code only)`,
    );
  }

  console.log("[unit016] pass: built provider registry status gates");
}

function checkProviderRegistrySourceTruth() {
  const source = stripComments(readText("packages/provider-registry/src/index.ts"));
  const registryBlock = extractAssignedBlock(source, "PROVIDER_REGISTRY", "[", "]");
  const behaviorBlock = extractAssignedBlock(source, "IMPLEMENTATION_STATUS_BEHAVIOR", "{", "}");
  const actionFamilySource = stripComments(readText("packages/contracts/src/action-family.ts"));
  const providerSource = stripComments(readText("packages/contracts/src/providers.ts"));
  const actionFamilyIds = extractAssignedStringArray(actionFamilySource, "ACTION_FAMILY_IDS");
  const usageProviderIds = extractAssignedStringArray(providerSource, "USAGE_PROVIDER_IDS");
  const balanceProviderIds = extractAssignedStringArray(providerSource, "BALANCE_PROVIDER_IDS");
  const statusProviderIds = extractAssignedStringArray(providerSource, "STATUS_PROVIDER_IDS");

  assert(registryBlock !== undefined, "provider registry source literal scan finds PROVIDER_REGISTRY block");
  assert(behaviorBlock !== undefined, "provider registry source literal scan finds IMPLEMENTATION_STATUS_BEHAVIOR block");
  assert(arraysEqual(actionFamilyIds, expectedActionFamilyIds), "action family source tuple matches exact current set");
  assert(arraysEqual(usageProviderIds, expectedUsageProviders), "Usage provider source tuple matches exact current set");
  assert(arraysEqual(balanceProviderIds, expectedBalanceProviders), "Balance provider source tuple matches exact current set");
  assert(arraysEqual(statusProviderIds, expectedStatusProviders), "Status provider source tuple matches exact current set");

  if (registryBlock === undefined || behaviorBlock === undefined) {
    return;
  }

  const registryProviderIds = new Set(collectStringPropertyValues(registryBlock, "providerId"));
  assert(setEquals(registryProviderIds, expectedProviderIds), "provider registry source has the exact current provider identity set");

  for (const [providerId, expected] of expectedProviderStatus) {
    const providerBlock = extractObjectContainingStringProperty(registryBlock, "providerId", providerId);
    assert(providerBlock !== undefined, `provider registry source literal scan finds ${providerId} provider block`);
    if (providerBlock === undefined) {
      continue;
    }

    assert(
      hasStringProperty(providerBlock, "implementationStatus", expected.implementationStatus),
      `${providerId} source implementationStatus literal remains ${expected.implementationStatus}`,
    );
    assert(
      hasStringProperty(providerBlock, "sourceProofStatus", expected.sourceProofStatus),
      `${providerId} source sourceProofStatus literal remains ${expected.sourceProofStatus}`,
    );
    assert(
      providerBlock.includes("statusCapability(") === expectedStatusProviders.includes(providerId),
      `${providerId} source Status capability presence matches the exact Status provider set`,
    );
  }

  for (const [status, expected] of expectedImplementationStatusBehavior) {
    const statusBlock = extractObjectPropertyBlock(behaviorBlock, status);
    assert(statusBlock !== undefined, `provider registry source literal scan finds implementation behavior ${status}`);
    if (statusBlock === undefined) {
      continue;
    }

    assert(
      hasBooleanProperty(statusBlock, "selectionEligible", expected.selectionEligible),
      `${status} source selectionEligible literal remains ${expected.selectionEligible}`,
    );
    assert(
      hasBooleanProperty(statusBlock, "fetchAllowed", expected.fetchAllowed),
      `${status} source fetchAllowed literal remains ${expected.fetchAllowed}`,
    );
  }

  console.log("[unit016] pass: source provider registry status gates");
}

function readJson(relativeFile) {
  return JSON.parse(readText(relativeFile));
}

function readText(relativeFile) {
  return readFileSync(path.join(repoRoot, relativeFile), "utf8");
}

function walk(relativeDir, options = {}) {
  const root = path.join(repoRoot, relativeDir);
  if (!existsSync(root)) {
    return [];
  }

  const files = [];
  visit(root);
  return files;

  function visit(entry) {
    const stat = lstatSync(entry);
    const name = path.basename(entry);
    const rel = relativePath(entry);

    if (stat.isDirectory()) {
      if (
        name === ".git" ||
        name === ".codeindex" ||
        name === ".vscode" ||
        name === "node_modules" ||
        name === "coverage" ||
        (!options.includeBuildOutput && (name === "dist" || rel.includes(".sdPlugin/bin")))
      ) {
        return;
      }

      for (const child of readdirSync(entry)) {
        visit(path.join(entry, child));
      }
      return;
    }

    files.push(entry);
  }
}

function findPackageJsonFiles() {
  return ["package.json", ...walk("packages"), ...walk("apps"), ...walk("tooling")]
    .filter((file) => relativePath(file).endsWith("package.json"))
    .map((file) => (path.isAbsolute(file) ? file : path.join(repoRoot, file)));
}

function findNearestPackageRoot(file) {
  let current = path.dirname(file);
  while (current.startsWith(repoRoot)) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

function dependencyNames(packageJson) {
  const names = new Set();
  for (const field of dependencyFields) {
    for (const dependencyName of Object.keys(packageJson[field] ?? {})) {
      names.add(dependencyName);
    }
  }
  return names;
}

function checkScannerSelfTest() {
  const sample = [
    'const endpoint = "https://provider.example/path"; // https://comment.example',
    "const marker = `browser-session-token`;",
    "/* process.env.SHOULD_NOT_SURVIVE */",
  ].join("\n");
  const stripped = stripComments(sample);
  assert(stripped.includes("https://provider.example/path"), "scanner preserves URL literals while stripping comments");
  assert(!stripped.includes("https://comment.example"), "scanner strips line comments");
  assert(!stripped.includes("process.env.SHOULD_NOT_SURVIVE"), "scanner strips block comments");
  assert(stripped.includes("browser-session-token"), "scanner preserves template literal contents");

  const badPiSamples = new Map([
    [
      "provider metadata fields",
      `const option = { productLabel: "Claude Code", unavailableReason: "Adapter source proof required", openDecision: "Owner decision" };`,
    ],
    ["raw state status token", `setStatus(status, statusRow, payload.reasonCode || "action-settings-schema");`],
    ["raw validation status token", `status.textContent = payload.validation.reasonCode || "probe-required";`],
  ]);
  for (const [name, source] of badPiSamples) {
    const violations = collectPiVisibleCopyViolations("apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/property-inspector.js", source);
    assert(violations.length > 0, `PI visible-copy scanner flags ${name}`);
  }

  const goodPiSample = [
    `item.textContent = option.productLabel + (option.availabilityLabel || "Not available yet");`,
    `setStatus(status, statusRow, payload.validation ? payload.validation.message : "");`,
  ].join("\n");
  assert(
    collectPiVisibleCopyViolations("apps/streamdeck/com.blackice.ai-workbench.sdPlugin/ui/property-inspector.js", goodPiSample)
      .length === 0,
    "PI visible-copy scanner allows safe label and status copy",
  );

  const sampleRegistrySource = `
    export const IMPLEMENTATION_STATUS_BEHAVIOR = {
      implemented: { selectionEligible: true, fetchAllowed: true },
      probeRequired: { selectionEligible: false, fetchAllowed: false },
    } as const;

    export const PROVIDER_REGISTRY = [
      {
        providerId: "sample-provider",
        capabilities: [
          {
            implementationStatus: "probeRequired",
            sourceProofStatus: "probeRequired",
          },
        ],
      },
    ] as const;
  `;
  const sampleRegistryBlock = extractAssignedBlock(sampleRegistrySource, "PROVIDER_REGISTRY", "[", "]");
  const sampleBehaviorBlock = extractAssignedBlock(sampleRegistrySource, "IMPLEMENTATION_STATUS_BEHAVIOR", "{", "}");
  assert(sampleRegistryBlock !== undefined, "provider registry source scanner extracts registry array block");
  assert(sampleBehaviorBlock !== undefined, "provider registry source scanner extracts behavior object block");
  assert(
    sampleRegistryBlock !== undefined && hasStringProperty(sampleRegistryBlock, "providerId", "sample-provider"),
    "provider registry source scanner finds string properties in registry block",
  );

  const sampleProviderBlock =
    sampleRegistryBlock === undefined
      ? undefined
      : extractObjectContainingStringProperty(sampleRegistryBlock, "providerId", "sample-provider");
  assert(sampleProviderBlock !== undefined, "provider registry source scanner extracts provider object block");
  assert(
    sampleProviderBlock !== undefined && hasStringProperty(sampleProviderBlock, "implementationStatus", "probeRequired"),
    "provider registry source scanner checks provider status literals",
  );

  const sampleProbeRequiredBlock =
    sampleBehaviorBlock === undefined ? undefined : extractObjectPropertyBlock(sampleBehaviorBlock, "probeRequired");
  assert(sampleProbeRequiredBlock !== undefined, "provider registry source scanner extracts behavior status block");
  assert(
    sampleProbeRequiredBlock !== undefined && hasBooleanProperty(sampleProbeRequiredBlock, "fetchAllowed", false),
    "provider registry source scanner checks behavior boolean literals",
  );

  const equalitySample = [
    "if (a == b) {}",
    "if (a != b) {}",
    "if (a === b && a !== b) {}",
    "const literal = 'a == b';",
    "// comment == b",
    "/* block != b */",
  ].join("\n");
  const equalityViolations = collectLooseEqualityViolations(equalitySample);
  assert(
    equalityViolations.map((violation) => violation.operator).join(",") === "==,!=",
    "strict-equality scanner flags only loose operators in code",
  );

  assert(
    rawGlobalFetchCallPattern.test("const value = await fetch(request);"),
    "raw-fetch scanner flags a genuine raw global fetch( call",
  );
  assert(
    !rawGlobalFetchCallPattern.test("const value = yield* entry.fetch(request);"),
    "raw-fetch scanner ignores a .fetch( method/property call",
  );
  assert(
    !rawGlobalFetchCallPattern.test("const value = await prefetch(request);"),
    "raw-fetch scanner ignores an identifier ending in fetch(",
  );

  assert(
    objectQualifiedGlobalFetchCallPattern.test("const value = await globalThis.fetch(request);") &&
      objectQualifiedGlobalFetchCallPattern.test("const value = await self.fetch(request);") &&
      objectQualifiedGlobalFetchCallPattern.test("const value = await window.fetch(request);"),
    "object-qualified-fetch scanner flags globalThis/self/window .fetch( calls",
  );
  assert(
    !objectQualifiedGlobalFetchCallPattern.test("const value = yield* entry.fetch(request);") &&
      !objectQualifiedGlobalFetchCallPattern.test("const value = await client.fetch(request);") &&
      !objectQualifiedGlobalFetchCallPattern.test("const value = await prefetch(request);"),
    "object-qualified-fetch scanner ignores injected client .fetch( and identifiers ending in fetch(",
  );

  console.log("[unit016] pass: scanner self-test");
}

function collectLooseEqualityViolations(source) {
  const violations = [];
  let state = "code";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const previous = source[index - 1];
    const next = source[index + 1];
    const afterNext = source[index + 2];

    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }

    if (state === "string") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        state = "code";
        quote = "";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      state = "string";
      quote = current;
      escaped = false;
      continue;
    }

    if (current === "=" && next === "=" && previous !== "=" && previous !== "!" && afterNext !== "=") {
      violations.push({ index, operator: "==" });
    }

    if (current === "!" && next === "=" && afterNext !== "=") {
      violations.push({ index, operator: "!=" });
    }
  }

  return violations;
}

function collectPiVisibleCopyViolations(relativeFile, source) {
  const withoutComments = stripComments(relativeFile.endsWith(".html") ? stripHtmlComments(source) : source);
  const violations = [];
  const regexRules = [
    {
      label: "unavailableReason provider metadata field",
      pattern: /\bunavailableReason\b/,
    },
    {
      label: "openDecision provider metadata field",
      pattern: /\bopenDecision\b/,
    },
    {
      label: "payload.reasonCode status rendering",
      pattern: /\bpayload\s*\.\s*reasonCode\b/,
    },
    {
      label: "validation.reasonCode status rendering",
      pattern: /\b(?:payload\s*\.\s*)?validation\s*\.\s*reasonCode\b/,
    },
    {
      label: "textContent reasonCode status rendering",
      pattern: /\btextContent\s*=\s*[^;\n]*\breasonCode\b/,
    },
  ];

  for (const { label, pattern } of regexRules) {
    if (pattern.test(withoutComments)) {
      violations.push(label);
    }
  }

  if (hasFunctionCallArgumentMatching(withoutComments, "setStatus", /\breasonCode\b/)) {
    violations.push("setStatus reasonCode status rendering");
  }

  for (const token of piRawStatusTokens) {
    if (withoutComments.includes(token)) {
      violations.push(`raw status token "${token}"`);
    }
  }

  for (const phrase of piInternalProofPhrases) {
    if (withoutComments.includes(phrase)) {
      violations.push(`internal proof phrase "${phrase}"`);
    }
  }

  return violations;
}

function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function extractAssignedBlock(source, exportName, openChar, closeChar) {
  const assignmentPattern = new RegExp(`\\b${escapeRegExp(exportName)}\\b(?:\\s*:\\s*[^=]+)?\\s*=`);
  const match = assignmentPattern.exec(source);
  if (match === null) {
    return undefined;
  }

  const openIndex = source.indexOf(openChar, match.index + match[0].length);
  if (openIndex === -1) {
    return undefined;
  }

  const closeIndex = findMatchingDelimiter(source, openIndex, openChar, closeChar);
  if (closeIndex === -1) {
    return undefined;
  }

  return source.slice(openIndex, closeIndex + 1);
}

function extractObjectContainingStringProperty(source, propertyName, propertyValue) {
  const pattern = propertyStringPattern(propertyName, propertyValue);
  const match = pattern.exec(source);
  if (match === null) {
    return undefined;
  }

  const block = findEnclosingDelimitedBlock(source, match.index, "{", "}");
  return block;
}

function extractObjectPropertyBlock(source, propertyName) {
  const pattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:`);
  const match = pattern.exec(source);
  if (match === null) {
    return undefined;
  }

  const openIndex = source.indexOf("{", match.index + match[0].length);
  if (openIndex === -1) {
    return undefined;
  }

  const closeIndex = findMatchingDelimiter(source, openIndex, "{", "}");
  if (closeIndex === -1) {
    return undefined;
  }

  return source.slice(openIndex, closeIndex + 1);
}

function hasStringProperty(source, propertyName, propertyValue) {
  return propertyStringPattern(propertyName, propertyValue).test(source);
}

function hasBooleanProperty(source, propertyName, propertyValue) {
  return new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*${propertyValue ? "true" : "false"}\\b`).test(source);
}

function extractAssignedStringArray(source, exportName) {
  const block = extractAssignedBlock(source, exportName, "[", "]");
  return block === undefined
    ? undefined
    : [...block.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function collectStringPropertyValues(source, propertyName) {
  const pattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*["']([^"']+)["']`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function propertyStringPattern(propertyName, propertyValue) {
  return new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*["']${escapeRegExp(propertyValue)}["']`);
}

function findEnclosingDelimitedBlock(source, index, openChar, closeChar) {
  const stack = [];
  let state = "code";
  let quote = "";
  let escaped = false;

  for (let currentIndex = 0; currentIndex <= index; currentIndex += 1) {
    const current = source[currentIndex];

    if (state === "string") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        state = "code";
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      state = "string";
      quote = current;
      escaped = false;
      continue;
    }

    if (current === openChar) {
      stack.push(currentIndex);
      continue;
    }

    if (current === closeChar) {
      stack.pop();
    }
  }

  const openIndex = stack.at(-1);
  if (openIndex === undefined) {
    return undefined;
  }

  const closeIndex = findMatchingDelimiter(source, openIndex, openChar, closeChar);
  if (closeIndex === -1) {
    return undefined;
  }

  return source.slice(openIndex, closeIndex + 1);
}

function hasFunctionCallArgumentMatching(source, functionName, pattern) {
  const callPattern = new RegExp(`\\b${functionName}\\s*\\(`, "g");
  let match;
  while ((match = callPattern.exec(source)) !== null) {
    const openParenIndex = source.indexOf("(", match.index);
    const closeParenIndex = findMatchingCloseParen(source, openParenIndex);
    if (closeParenIndex === -1) {
      continue;
    }
    if (pattern.test(source.slice(openParenIndex + 1, closeParenIndex))) {
      return true;
    }
    callPattern.lastIndex = closeParenIndex + 1;
  }
  return false;
}

function findMatchingCloseParen(source, openParenIndex) {
  return findMatchingDelimiter(source, openParenIndex, "(", ")");
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let state = "code";
  let quote = "";
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];

    if (state === "string") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        state = "code";
        quote = "";
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      state = "string";
      quote = current;
      escaped = false;
      continue;
    }

    if (current === openChar) {
      depth += 1;
      continue;
    }

    if (current === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripComments(source) {
  let output = "";
  let state = "code";
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (current === "\n") {
        output += current;
        state = "code";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        index += 1;
        state = "code";
      } else if (current === "\n") {
        output += current;
      }
      continue;
    }

    if (state === "string") {
      output += current;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (current === "\\") {
        escaped = true;
        continue;
      }
      if (current === quote) {
        state = "code";
        quote = "";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      state = "string";
      quote = current;
      escaped = false;
      output += current;
      continue;
    }

    output += current;
  }

  return output;
}

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const staticImportExport = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireCall = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const pattern of [staticImportExport, dynamicImport, requireCall]) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

function collectLiteralHttpUrls(source) {
  return new Set(
    [...source.matchAll(/["'](https?:\/\/[^"']+)["']/g)].map((match) => match[1]),
  );
}

function countPatternMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

function isRejectedDependency(specifier) {
  // ADR-0021 (revised 2026-07-08) + rules §7/§13 + spec REQ-031: @effect/platform (its FetchHttpClient
  // layer) is the ADOPTED HTTP boundary, so it and its subpaths (e.g. @effect/platform/HttpClient) are
  // NOT rejected. @effect/platform-node STAYS rejected — its undici NodeHttpClient hard-requires
  // @effect/rpc/@effect/sql/@effect/cluster peers + undici, which the product rejects. axios/pino/
  // undici/zod remain rejected.
  return (
    rejectedDependencySpecifiers.includes(specifier) ||
    specifier === "@effect/platform-node" ||
    specifier.startsWith("@effect/platform-node/")
  );
}

function isEffectSpecifier(specifier) {
  return specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/");
}

function isStreamDeckSdkSpecifier(specifier) {
  return specifier === "@elgato/streamdeck" || specifier.startsWith("@elgato/streamdeck/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativePath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function arraysEqual(left, right) {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function fail(message) {
  failures.push(message);
}
