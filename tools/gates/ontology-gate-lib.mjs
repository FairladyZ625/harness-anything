import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listWorktreeFiles } from "./git.mjs";

export function readText(rootDir, relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

export function lineNumber(sourceFile, offset) {
  return sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
}

export function parseTypeScript(rootDir, relativePath) {
  const body = readText(rootDir, relativePath);
  return ts.createSourceFile(relativePath, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) && current.arguments.length === 1) {
      current = current.arguments[0];
      continue;
    }
    break;
  }
  return current;
}

export function findVariable(sourceFile, name) {
  let found = null;
  visit(sourceFile);
  return found;

  function visit(node) {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
}

export function directObjectStringProperties(arrayExpression, propertyName) {
  const array = unwrapExpression(arrayExpression);
  if (!array || !ts.isArrayLiteralExpression(array)) return [];
  const rows = [];
  for (const element of array.elements) {
    const object = unwrapExpression(element);
    if (!object || !ts.isObjectLiteralExpression(object)) continue;
    const property = object.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) && candidate.name.text === propertyName) ||
          (ts.isStringLiteral(candidate.name) && candidate.name.text === propertyName)),
    );
    if (!property || !ts.isPropertyAssignment(property)) continue;
    const value = unwrapExpression(property.initializer);
    if (value && ts.isStringLiteralLike(value)) rows.push({ value: value.text, node: value });
  }
  return rows;
}

export function walkTypeScriptFiles(rootDir, relativeRoot) {
  // test/tests/fixtures and *.test/*.spec stay rule-excluded the way the old
  // walker skipped them; ignore authority moved to .gitignore.
  return listWorktreeFiles(rootDir, [relativeRoot]).filter(
    (file) =>
      /\.tsx?$/u.test(file) &&
      !/\.(?:test|spec)\.tsx?$/u.test(file) &&
      !/(?:^|\/)(?:test|tests|fixtures)\//u.test(file),
  );
}

export function parseCommonArgs(argv, { allowBase = false, allowFixture = false } = {}) {
  const options = { rootDir: process.cwd(), mode: "advisory", base: null, fixture: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") options.rootDir = path.resolve(requireValue(argv, ++index, flag));
    else if (flag === "--mode") options.mode = requireValue(argv, ++index, flag);
    else if (flag === "--base" && allowBase) options.base = requireValue(argv, ++index, flag);
    else if (flag === "--fixture" && allowFixture) options.fixture = path.resolve(requireValue(argv, ++index, flag));
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!["advisory", "ratchet"].includes(options.mode)) throw new Error("--mode must be advisory or ratchet");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function exitCodeFor(mode, findingCount) {
  return mode === "ratchet" && findingCount > 0 ? 1 : 0;
}

export function loadCatalogSnapshot(rootDir, fixture = null) {
  if (fixture) return JSON.parse(readFileSync(fixture, "utf8"));
  const modulePath = path.join(rootDir, "packages/kernel/src/domain/entity-kind-registry.ts");
  const script = [
    "const registry = await import(process.argv[1]);",
    "const result = registry.entityKindContracts.map((contract) => ({",
    "  kind: contract.kind,",
    "  available: registry.explainEntityKind(contract.kind).transitions.available,",
    "  actions: (contract.actionCatalog?.actions ?? []).map((action) => ({",
    "    id: action.id, execution: action.execution === null ? null : { ingress: action.execution.ingress, read: action.execution.read },",
    "    ...(Object.hasOwn(action, 'concurrency') ? { concurrency: action.concurrency } : {}),",
    "  })),",
    "}));",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return JSON.parse(runTypeScriptProbe(modulePath, script));
}

/**
 * The evaluated action surfaces G-B compares: registry contracts as the runtime builds them
 * (factory-made kinds included), ActionDeclarations, and the protocol ingress descriptors.
 */
export function loadActionCoverageSnapshot(rootDir) {
  const modules = [
    "packages/kernel/src/domain/entity-kind-registry.ts",
    "packages/kernel/src/domain/action-declaration.ts",
    "packages/daemon/src/protocol/daemon-protocol-commands.ts",
    "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts",
  ].map((file) => path.join(rootDir, file));
  const script = [
    "const [registry, declarations, commands, gui] = await Promise.all(process.argv.slice(1, 5).map((url) => import(url)));",
    "const result = {",
    "  kinds: registry.entityKindContracts.map((contract) => contract.kind),",
    "  stateStores: registry.entityKindContracts.map((contract) => ({ kind: contract.kind, stateStores: contract.stateStores ?? null })),",
    "  effects: registry.entityKindContracts.flatMap((contract) => (contract.actionCatalog?.actions ?? [])",
    "    .filter((action) => action.execution && !action.execution.read)",
    "    .map((action) => ({ kind: contract.kind, action: action.id, ingress: action.execution.ingress,",
    "      implementation: action.execution.implementation, policyAction: action.policy?.action ?? null }))),",
    "  declarations: declarations.actionDeclarations.map((entry) => ({ kind: entry.kind,",
    "    executionClass: entry.executionClass, residency: entry.residency.scope })),",
    "  artifactIngress: [...(declarations.artifactActionIngressKinds ?? [])],",
    "  ingress: [...commands.daemonProtocolCommands, ...gui.daemonGuiActionMethods]",
    "    .filter((entry) => entry.commandClass !== 'repo-read')",
    "    .map((entry) => ({ kind: entry.actionKind ?? entry.id, method: entry.method })),",
    "};",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return JSON.parse(runTypeScriptProbe(modules[0], script, ...modules.slice(1)));
}

export function loadStateAuthoritySnapshot(rootDir) {
  const action = loadActionCoverageSnapshot(rootDir);
  const eventPath = path.join(rootDir, "packages/kernel/src/domain/doc-sync-canonical-events.ts");
  if (!existsSync(eventPath)) return { ...action, canonicalEvents: [] };
  const script = [
    "const events = await import(process.argv[1]);",
    "process.stdout.write(JSON.stringify(events.canonicalEventSchemas.map(({ schema, owner }) => ({ schema, owner }))));",
  ].join("\n");
  try {
    return { ...action, canonicalEvents: JSON.parse(runTypeScriptProbe(eventPath, script)) };
  } catch (error) {
    throw new Error(`cannot load canonical event registry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runTypeScriptProbe(modulePath, script, ...otherModulePaths) {
  const args = ["--no-warnings", "--experimental-strip-types", "-e", script, pathToUrl(modulePath)];
  args.push(...otherModulePaths.map(pathToUrl));
  return execFileSync(process.execPath, args, {
    cwd: path.dirname(path.dirname(path.dirname(modulePath))),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function pathToUrl(filePath) {
  const normalized = path.resolve(filePath).split(path.sep).join("/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}
