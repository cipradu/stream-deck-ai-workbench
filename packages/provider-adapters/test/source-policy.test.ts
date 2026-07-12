import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageTsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const packageBuildTsconfigPath = fileURLToPath(new URL("../tsconfig.build.json", import.meta.url));
const policyTestSourcePath = fileURLToPath(import.meta.url);
const governedRequestPath = fileURLToPath(new URL("../src/governed-request.ts", import.meta.url));
const directHelperFixturePath = fileURLToPath(new URL("./fixtures/source-policy/direct-helper.ts", import.meta.url));
const namedAliasFixturePath = fileURLToPath(new URL("./fixtures/source-policy/named-alias.ts", import.meta.url));
const namespaceFixturePath = fileURLToPath(new URL("./fixtures/source-policy/namespace-member.ts", import.meta.url));
const localBarrelFixturePath = fileURLToPath(new URL("./fixtures/source-policy/local-barrel-use.ts", import.meta.url));
const transitiveBarrelFixturePath = fileURLToPath(new URL("./fixtures/source-policy/transitive-barrel-use.ts", import.meta.url));
const forwardingFixturePath = fileURLToPath(new URL("./fixtures/source-policy/forwarding-assignment.ts", import.meta.url));
const dynamicImportFixturePath = fileURLToPath(new URL("./fixtures/source-policy/dynamic-import.ts", import.meta.url));
const deferredImportFixturePath = fileURLToPath(new URL("./fixtures/source-policy/deferred-import.ts", import.meta.url));
const requireFixturePath = fileURLToPath(new URL("./fixtures/source-policy/require-loader.ts", import.meta.url));
const moduleRequireFixturePath = fileURLToPath(new URL("./fixtures/source-policy/module-require-loader.ts", import.meta.url));
const moduleBracketRequireFixturePath = fileURLToPath(new URL("./fixtures/source-policy/module-bracket-require-loader.ts", import.meta.url));
const requireAliasFixturePath = fileURLToPath(new URL("./fixtures/source-policy/require-alias-loader.ts", import.meta.url));
const unresolvedFixturePath = fileURLToPath(new URL("./fixtures/source-policy/unresolved-runtime-origin.ts", import.meta.url));
const unresolvedPropertyFixturePath = fileURLToPath(new URL("./fixtures/source-policy/unresolved-property-origin.ts", import.meta.url));
const namespaceBracketFixturePath = fileURLToPath(new URL("./fixtures/source-policy/namespace-bracket-helper.ts", import.meta.url));
const namespaceComputedFixturePath = fileURLToPath(new URL("./fixtures/source-policy/namespace-computed-helper.ts", import.meta.url));
const resolvedCompoundReceiverFixturePath = fileURLToPath(new URL("./fixtures/source-policy/resolved-compound-receiver.ts", import.meta.url));
const ordinaryNumericIndexFixturePath = fileURLToPath(new URL("./fixtures/source-policy/ordinary-numeric-index.ts", import.meta.url));
const governedWrapperBypassFixturePath = fileURLToPath(new URL("./fixtures/source-policy/governed-wrapper-unintended-bypass.ts", import.meta.url));
const typeOnlyFixturePath = fileURLToPath(new URL("./fixtures/source-policy/type-only.ts", import.meta.url));
const importTypeFixturePath = fileURLToPath(new URL("./fixtures/source-policy/import-type-position.ts", import.meta.url));
const safeConstantFixturePath = fileURLToPath(new URL("./fixtures/source-policy/safe-constant.ts", import.meta.url));
const declaredSharingBypassFixturePath = fileURLToPath(new URL("./fixtures/source-policy/declared-sharing-bypass.ts", import.meta.url));
const declaredSharingBoundaryFixturePath = fileURLToPath(new URL("./fixtures/source-policy/declared-sharing-boundary.ts", import.meta.url));
const sourceFlightRuntimePath = fileURLToPath(new URL("../src/source-flight-runtime.ts", import.meta.url));
const usageDispatchPath = fileURLToPath(new URL("../src/providers/usage/index.ts", import.meta.url));
const balanceDispatchPath = fileURLToPath(new URL("../src/providers/balance/index.ts", import.meta.url));
const providerSourcesRoot = fileURLToPath(new URL("../src/providers", import.meta.url));
const productionSourcesRoot = fileURLToPath(new URL("../src", import.meta.url));
const canonicalGovernedWrapperNames = [
  "governedRequestJsonSchema",
  "governedRequestTextBody",
  "governedExecuteRequest",
] as const;

interface PolicyFinding {
  readonly category: string;
  readonly column: number;
  readonly line: number;
  readonly path: string;
}

interface ProductionSourceInventory {
  readonly program: ts.Program;
  readonly runtimeRootPaths: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly unsupportedFindings: readonly PolicyFinding[];
}

function inspectSourcePolicy(
  scanPaths: readonly string[],
  declaredSharingPaths: readonly string[] = [],
  rootNames?: readonly string[],
  tsconfigPath = packageTsconfigPath,
  governedSourcePath = governedRequestPath,
): readonly PolicyFinding[] {
  return inspectSourcePolicyProgram(
    createSourcePolicyProgram(tsconfigPath, rootNames),
    scanPaths,
    declaredSharingPaths,
    governedSourcePath,
  );
}

function inspectSourcePolicyProgram(
  program: ts.Program,
  scanPaths: readonly string[],
  declaredSharingPaths: readonly string[] = [],
  governedSourcePath = governedRequestPath,
): readonly PolicyFinding[] {
  const checker = program.getTypeChecker();
  const governedRequestSource = program.getSourceFile(governedSourcePath);
  if (governedRequestSource === undefined) {
    throw new Error("Governed request source is unavailable to the compiler program.");
  }
  const protectedSymbols = protectedHttpHelperSymbols(governedRequestSource, checker);
  const sanctionedWrappers = sanctionedWrapperDeclarations(governedRequestSource, checker);
  const sharingBoundary =
    declaredSharingPaths.length === 0
      ? undefined
      : sharingBoundarySymbolForProgram(program, checker);
  const findings: PolicyFinding[] = [];

  for (const scanPath of scanPaths) {
    const source = program.getSourceFile(scanPath);
    if (source === undefined) {
      throw new Error("Policy scan source is unavailable to the compiler program.");
    }
    inspectRuntimeReferences(source, checker, protectedSymbols, sanctionedWrappers, findings);
    if (declaredSharingPaths.includes(scanPath) && (sharingBoundary === undefined || !hasSharingBoundaryCall(source, checker, sharingBoundary))) {
      findings.push(finding("declared-sharing-flight-bypass", source, source));
    }
  }

  return findings;
}

function createSourcePolicyProgram(tsconfigPath: string, rootNames?: readonly string[]): ts.Program {
  const config = parsedTypeScriptConfig(tsconfigPath);
  return ts.createProgram({
    rootNames: rootNames === undefined ? config.fileNames : [policyTestSourcePath, ...rootNames],
    options: config.options,
  });
}

function parsedTypeScriptConfig(tsconfigPath: string): ts.ParsedCommandLine {
  const configDiagnostics: ts.Diagnostic[] = [];
  const configHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      configDiagnostics.push(diagnostic);
    },
  };
  const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, configHost);
  if (config === undefined || configDiagnostics.length > 0 || config.errors.length > 0) {
    throw new Error("Provider-adapters TypeScript configuration is unavailable.");
  }
  return config;
}

function sharingBoundarySymbolForProgram(program: ts.Program, checker: ts.TypeChecker): ts.Symbol {
  const source = program.getSourceFile(sourceFlightRuntimePath);
  if (source === undefined) {
    throw new Error("Source-flight runtime is unavailable to the compiler program.");
  }
  return sharingBoundarySymbol(source, checker);
}

function fixtureProgramRoots(rootNames: readonly string[]): readonly string[] {
  return [policyTestSourcePath, ...rootNames];
}

function sharingBoundarySymbol(source: ts.SourceFile, checker: ts.TypeChecker): ts.Symbol {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "runClaudeCodeUsageSource") {
      const symbol = terminalSymbol(checker.getSymbolAtLocation(statement.name), checker);
      if (symbol !== undefined) {
        return symbol;
      }
    }
  }
  throw new Error("Claude source-flight boundary is unavailable to the compiler program.");
}

function hasSharingBoundaryCall(source: ts.SourceFile, checker: ts.TypeChecker, boundary: ts.Symbol): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const symbol = terminalSymbol(checker.getSymbolAtLocation(node.expression), checker);
      if (symbol === boundary) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function protectedHttpHelperSymbols(source: ts.SourceFile, checker: ts.TypeChecker): ReadonlySet<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || statement.importClause?.namedBindings === undefined) {
      continue;
    }
    // This is the authoritative protected-import declaration, not a runtime
    // enforcement rule: later checks compare terminal symbols only.
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@ai-workbench/http") {
      continue;
    }
    if (!ts.isNamedImports(statement.importClause.namedBindings)) {
      continue;
    }
    for (const binding of statement.importClause.namedBindings.elements) {
      if (binding.isTypeOnly) {
        continue;
      }
      const symbol = terminalSymbol(checker.getSymbolAtLocation(binding.name), checker);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Value) !== 0) {
        symbols.add(symbol);
      }
    }
  }

  return symbols;
}

function inspectRuntimeReferences(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  protectedSymbols: ReadonlySet<ts.Symbol>,
  sanctionedWrappers: ReadonlySet<ts.FunctionDeclaration>,
  findings: PolicyFinding[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier === ts.SyntaxKind.DeferKeyword) {
        findings.push(finding("dynamic-runtime-loader", source, node.importClause));
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      return;
    }
    const loaderViolation = runtimeLoaderViolation(node, checker);
    if (loaderViolation !== undefined) {
      findings.push(finding(loaderViolation.category, source, loaderViolation.node));
      return;
    }
    const accessViolation = runtimeAccessViolation(node, checker, protectedSymbols, sanctionedWrappers);
    if (accessViolation !== undefined) {
      findings.push(finding(accessViolation.category, source, accessViolation.node));
      return;
    }
    if (ts.isIdentifier(node) && !isTypePosition(node)) {
      const symbol = terminalSymbol(checker.getSymbolAtLocation(node), checker);
      if (symbol !== undefined && protectedSymbols.has(symbol)) {
        if (!isWithinSanctionedWrapper(node, sanctionedWrappers)) {
          findings.push(finding("protected-helper-runtime-use", source, node));
        }
      } else if (isBareRuntimeRequireReference(node)) {
        findings.push(finding("commonjs-runtime-loader", source, node));
      } else if (symbol === undefined && isRuntimeValueReference(node)) {
        findings.push(finding("unresolved-runtime-origin", source, node));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

function sanctionedWrapperDeclarations(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<ts.FunctionDeclaration> {
  const wrappersByName = new Map<string, ts.FunctionDeclaration>();
  const expectedNames = new Set<string>(canonicalGovernedWrapperNames);
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name === undefined || !expectedNames.has(statement.name.text)) {
      continue;
    }
    if (wrappersByName.has(statement.name.text) || terminalSymbol(checker.getSymbolAtLocation(statement.name), checker) === undefined) {
      throw new Error("Canonical governed wrapper declaration is unavailable to the compiler program.");
    }
    wrappersByName.set(statement.name.text, statement);
  }
  if (wrappersByName.size !== canonicalGovernedWrapperNames.length) {
    throw new Error("Canonical governed wrapper declaration is unavailable to the compiler program.");
  }
  return new Set(wrappersByName.values());
}

interface RuntimeLoaderViolation {
  readonly category: "dynamic-runtime-loader" | "commonjs-runtime-loader";
  readonly node: ts.Node;
}

function runtimeLoaderViolation(node: ts.Node, checker: ts.TypeChecker): RuntimeLoaderViolation | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { category: "dynamic-runtime-loader", node: node.expression };
  }
  if (isBareRuntimeRequireReference(node.expression)) {
    return { category: "commonjs-runtime-loader", node: node.expression };
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "module" &&
      node.expression.name.text === "require"
      ? { category: "commonjs-runtime-loader", node: node.expression }
      : undefined;
  }
  return ts.isElementAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "module" &&
    staticMemberSymbol(node.expression, checker)?.getName() === "require"
    ? { category: "commonjs-runtime-loader", node: node.expression.argumentExpression }
    : undefined;
}

interface RuntimeAccessViolation {
  readonly category: "protected-helper-runtime-use" | "runtime-unresolved-origin";
  readonly node: ts.Node;
}

function runtimeAccessViolation(
  node: ts.Node,
  checker: ts.TypeChecker,
  protectedSymbols: ReadonlySet<ts.Symbol>,
  sanctionedWrappers: ReadonlySet<ts.FunctionDeclaration>,
): RuntimeAccessViolation | undefined {
  if (!ts.isExpression(node) || isTypePosition(node)) {
    return undefined;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const memberSymbol = terminalSymbol(checker.getSymbolAtLocation(node.name), checker);
    if (memberSymbol !== undefined && protectedSymbols.has(memberSymbol)) {
      return isWithinSanctionedWrapper(node, sanctionedWrappers)
        ? undefined
        : { category: "protected-helper-runtime-use", node: node.name };
    }
    const receiverSymbol = terminalSymbol(checker.getSymbolAtLocation(node.expression), checker);
    if (receiverSymbol === undefined && ts.isIdentifier(node.expression)) {
      return { category: "runtime-unresolved-origin", node: node.expression };
    }
    return receiverSymbol !== undefined &&
      memberSymbol === undefined &&
      moduleExportsProtectedHelper(receiverSymbol, checker, protectedSymbols)
      ? { category: "runtime-unresolved-origin", node: node.name }
      : undefined;
  }
  if (!ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const receiverSymbol = terminalSymbol(checker.getSymbolAtLocation(node.expression), checker);
  const memberSymbol = staticMemberSymbol(node, checker);
  if (memberSymbol !== undefined && protectedSymbols.has(memberSymbol)) {
    return isWithinSanctionedWrapper(node, sanctionedWrappers)
      ? undefined
      : { category: "protected-helper-runtime-use", node: node.argumentExpression };
  }
  if (receiverSymbol === undefined && ts.isIdentifier(node.expression)) {
    return { category: "runtime-unresolved-origin", node: node.expression };
  }
  return receiverSymbol !== undefined &&
    moduleExportsProtectedHelper(receiverSymbol, checker, protectedSymbols) &&
    (memberSymbol === undefined || !ts.isStringLiteral(node.argumentExpression))
    ? { category: "runtime-unresolved-origin", node: node.argumentExpression }
    : undefined;
}

function staticMemberSymbol(node: ts.ElementAccessExpression, checker: ts.TypeChecker): ts.Symbol | undefined {
  return terminalSymbol(checker.getSymbolAtLocation(node.argumentExpression), checker);
}

function moduleExportsProtectedHelper(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  protectedSymbols: ReadonlySet<ts.Symbol>,
): boolean {
  if ((symbol.flags & ts.SymbolFlags.Module) === 0) {
    return false;
  }
  return checker.getExportsOfModule(symbol).some((candidate) => {
    const terminal = terminalSymbol(candidate, checker);
    return terminal !== undefined && protectedSymbols.has(terminal);
  });
}

function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) {
      return current;
    }
  }
  return undefined;
}

function isWithinSanctionedWrapper(node: ts.Node, wrappers: ReadonlySet<ts.FunctionDeclaration>): boolean {
  const wrapper = enclosingFunctionDeclaration(node);
  return wrapper !== undefined && wrappers.has(wrapper);
}

function isRuntimeValueReference(node: ts.Identifier): boolean {
  return ts.isExpression(node) && !ts.isIdentifier(node.parent) && !ts.isPropertyAccessExpression(node.parent);
}

function isBareRuntimeRequireReference(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === "require" && isRuntimeValueReference(node);
}

function terminalSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (symbol === undefined) {
    return undefined;
  }
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (ts.isExpression(current)) {
      return false;
    }
  }
  return false;
}

function finding(category: string, source: ts.SourceFile, node: ts.Node): PolicyFinding {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return {
    category,
    path: relative(packageRoot, source.fileName).replaceAll("\\", "/"),
    line: position.line + 1,
    column: position.character + 1,
  };
}

function productionSourceInventory(): ProductionSourceInventory {
  const program = createSourcePolicyProgram(packageBuildTsconfigPath);
  const sourcePaths: string[] = [];
  const unsupportedFindings: PolicyFinding[] = [];
  for (const source of program.getSourceFiles()) {
    if (!isStrictlyWithin(productionSourcesRoot, source.fileName) || source.isDeclarationFile) {
      continue;
    }
    if (source.fileName.endsWith(".ts")) {
      sourcePaths.push(source.fileName);
    } else {
      unsupportedFindings.push(finding("unsupported-runtime-source-kind", source, source));
    }
  }
  const runtimeRootPaths = program.getRootFileNames().filter((fileName) => {
    const source = program.getSourceFile(fileName);
    return source !== undefined && isStrictlyWithin(productionSourcesRoot, fileName) && !source.isDeclarationFile;
  });
  return {
    program,
    runtimeRootPaths: runtimeRootPaths.sort(),
    sourcePaths: sourcePaths.sort(),
    unsupportedFindings,
  };
}

function isStrictlyWithin(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith("../") &&
    !pathFromRoot.startsWith("..\\") &&
    !isAbsolute(pathFromRoot);
}

async function discoverProviderLeafModulePaths(): Promise<readonly string[]> {
  const families = await readdir(providerSourcesRoot, { withFileTypes: true });
  const modules: string[] = [];
  for (const family of families) {
    if (!family.isDirectory()) {
      continue;
    }
    const familyRoot = join(providerSourcesRoot, family.name);
    const providers = await readdir(familyRoot, { withFileTypes: true });
    for (const provider of providers) {
      if (!provider.isDirectory()) {
        continue;
      }
      const indexPath = join(familyRoot, provider.name, "index.ts");
      if (ts.sys.fileExists(indexPath)) {
        modules.push(indexPath);
      }
    }
  }
  return modules.sort();
}

describe("provider adapter source policy", () => {
  it("rejects direct protected-helper runtime use", () => {
    const findings = inspectSourcePolicy(
      [directHelperFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, directHelperFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "protected-helper-runtime-use",
      path: "test/fixtures/source-policy/direct-helper.ts",
      line: 3,
      column: 23,
    });
  });

  it("rejects unintended raw-helper functions in a governed-wrapper compiler source", () => {
    const findings = inspectSourcePolicy(
      [governedWrapperBypassFixturePath],
      [],
      fixtureProgramRoots([governedWrapperBypassFixturePath]),
      packageTsconfigPath,
      governedWrapperBypassFixturePath,
    );

    expect(findings).toEqual([
      {
        category: "protected-helper-runtime-use",
        path: "test/fixtures/source-policy/governed-wrapper-unintended-bypass.ts",
        line: 16,
        column: 10,
      },
    ]);
  });

  it("rejects semantic aliases, namespace members, barrels, and forwarding assignments", () => {
    const scanPaths = [
      namedAliasFixturePath,
      namespaceFixturePath,
      localBarrelFixturePath,
      transitiveBarrelFixturePath,
      forwardingFixturePath,
    ];
    const findings = inspectSourcePolicy(scanPaths, [], fixtureProgramRoots([governedRequestPath, ...scanPaths]));

    expect(findings).toHaveLength(5);
    expect(findings.every((candidate) => candidate.category === "protected-helper-runtime-use")).toBe(true);
    expect(findings.map((candidate) => candidate.path).sort()).toEqual([
      "test/fixtures/source-policy/forwarding-assignment.ts",
      "test/fixtures/source-policy/local-barrel-use.ts",
      "test/fixtures/source-policy/named-alias.ts",
      "test/fixtures/source-policy/namespace-member.ts",
      "test/fixtures/source-policy/transitive-barrel-use.ts",
    ]);
  });

  it("rejects dynamic runtime import before module resolution can whitelist it", () => {
    const findings = inspectSourcePolicy(
      [dynamicImportFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, dynamicImportFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "dynamic-runtime-loader",
      path: "test/fixtures/source-policy/dynamic-import.ts",
      line: 2,
      column: 22,
    });
  });

  it("rejects parser-supported deferred imports before module resolution can whitelist them", () => {
    const findings = inspectSourcePolicy(
      [deferredImportFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, deferredImportFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "dynamic-runtime-loader",
      path: "test/fixtures/source-policy/deferred-import.ts",
      line: 2,
      column: 8,
    });
  });

  it("rejects CommonJS loaders and unresolved runtime origins", () => {
    const scanPaths = [requireFixturePath, moduleRequireFixturePath, unresolvedFixturePath];
    const findings = inspectSourcePolicy(scanPaths, [], fixtureProgramRoots([governedRequestPath, ...scanPaths]));

    expect(findings.map((candidate) => candidate.category).sort()).toEqual([
      "commonjs-runtime-loader",
      "commonjs-runtime-loader",
      "unresolved-runtime-origin",
    ]);
  });

  it("rejects module bracket CommonJS loaders", () => {
    const findings = inspectSourcePolicy(
      [moduleBracketRequireFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, moduleBracketRequireFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "commonjs-runtime-loader",
      path: "test/fixtures/source-policy/module-bracket-require-loader.ts",
      line: 1,
      column: 21,
    });
  });

  it("rejects bare require aliases at their runtime source", () => {
    const findings = inspectSourcePolicy(
      [requireAliasFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, requireAliasFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "commonjs-runtime-loader",
      path: "test/fixtures/source-policy/require-alias-loader.ts",
      line: 1,
      column: 14,
    });
  });

  it("rejects unresolved runtime property origins", () => {
    const findings = inspectSourcePolicy(
      [unresolvedPropertyFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, unresolvedPropertyFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "runtime-unresolved-origin",
      path: "test/fixtures/source-policy/unresolved-property-origin.ts",
      line: 2,
      column: 23,
    });
  });

  it("rejects bracketed namespace protected-helper access", () => {
    const findings = inspectSourcePolicy(
      [namespaceBracketFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, namespaceBracketFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "protected-helper-runtime-use",
      path: "test/fixtures/source-policy/namespace-bracket-helper.ts",
      line: 3,
      column: 28,
    });
  });

  it("rejects computed keys on namespaces that export protected helpers", () => {
    const findings = inspectSourcePolicy(
      [namespaceComputedFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, namespaceComputedFixturePath]),
    );

    expect(findings).toContainEqual({
      category: "runtime-unresolved-origin",
      path: "test/fixtures/source-policy/namespace-computed-helper.ts",
      line: 4,
      column: 28,
    });
  });

  it("allows resolved compound runtime receivers", () => {
    const findings = inspectSourcePolicy(
      [resolvedCompoundReceiverFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, resolvedCompoundReceiverFixturePath]),
    );

    expect(findings).toEqual([]);
  });

  it("allows ordinary numeric element indices", () => {
    const findings = inspectSourcePolicy(
      [ordinaryNumericIndexFixturePath],
      [],
      fixtureProgramRoots([governedRequestPath, ordinaryNumericIndexFixturePath]),
    );

    expect(findings).toEqual([]);
  });

  it("allows sanctioned wrappers, type-only forms, and safe constants through a barrel", () => {
    const scanPaths = [governedRequestPath, typeOnlyFixturePath, importTypeFixturePath, safeConstantFixturePath];
    const findings = inspectSourcePolicy(scanPaths, [], fixtureProgramRoots([governedRequestPath, ...scanPaths]));

    expect(findings).toEqual([]);
  });

  it("rejects declared-sharing bypass and permits the canonical flight boundary", () => {
    expect(() =>
      inspectSourcePolicy(
        [declaredSharingBypassFixturePath],
        [declaredSharingBypassFixturePath],
        fixtureProgramRoots([governedRequestPath, declaredSharingBypassFixturePath]),
      ),
    ).toThrow("Source-flight runtime is unavailable to the compiler program.");
    const bypassFindings = inspectSourcePolicy(
      [declaredSharingBypassFixturePath],
      [declaredSharingBypassFixturePath],
      fixtureProgramRoots([governedRequestPath, sourceFlightRuntimePath, declaredSharingBypassFixturePath]),
    );
    const boundaryFindings = inspectSourcePolicy(
      [declaredSharingBoundaryFixturePath],
      [declaredSharingBoundaryFixturePath],
      fixtureProgramRoots([governedRequestPath, sourceFlightRuntimePath, declaredSharingBoundaryFixturePath]),
    );

    expect(bypassFindings).toContainEqual({
      category: "declared-sharing-flight-bypass",
      path: "test/fixtures/source-policy/declared-sharing-bypass.ts",
      line: 1,
      column: 1,
    });
    expect(boundaryFindings).toEqual([]);
  });

  it("scans the complete build-config production source inventory and retains all current provider leaves", async () => {
    const providerModulePaths = await discoverProviderLeafModulePaths();
    const inventory = productionSourceInventory();
    const findings = inspectSourcePolicyProgram(inventory.program, inventory.sourcePaths, [usageDispatchPath]);

    expect(providerModulePaths).toHaveLength(16);
    expect(inventory.sourcePaths).toHaveLength(30);
    expect(inventory.sourcePaths).toEqual(expect.arrayContaining([...inventory.runtimeRootPaths]));
    expect(inventory.sourcePaths).toEqual(expect.arrayContaining([
      balanceDispatchPath,
      usageDispatchPath,
      governedRequestPath,
      sourceFlightRuntimePath,
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ]));
    expect(inventory.unsupportedFindings).toEqual([]);
    expect(findings).toEqual([]);
  });
});
