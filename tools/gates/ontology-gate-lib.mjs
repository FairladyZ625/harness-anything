import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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
  const start = path.join(rootDir, relativeRoot);
  const files = [];
  walk(start);
  return files.sort();

  function walk(directory) {
    if (!existsSync(directory)) return;
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["dist", "node_modules", "test", "tests", "fixtures"].includes(entry.name)) walk(absolute);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name) || /\.(?:test|spec)\.tsx?$/u.test(entry.name)) continue;
      files.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
    }
  }
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

export function loadDurableActionKinds(rootDir, fixture = null) {
  if (fixture) {
    const parsed = JSON.parse(readFileSync(fixture, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("durable action fixture must be an array");
    return [...new Set(parsed.map(String))].sort();
  }
  const commandsPath = path.join(rootDir, "packages/daemon/src/protocol/daemon-protocol-commands.ts");
  const guiPath = path.join(rootDir, "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts");
  const script = [
    "const commands = await import(process.argv[1]);",
    "const gui = await import(process.argv[2]);",
    "const kinds = [...commands.daemonProtocolCommands, ...gui.daemonGuiActionMethods]",
    "  .filter((entry) => entry.commandClass !== 'repo-read')",
    "  .map((entry) => entry.actionKind ?? entry.id);",
    "process.stdout.write(JSON.stringify([...new Set(kinds)].sort()));",
  ].join("\n");
  return JSON.parse(runTypeScriptProbe(commandsPath, script, guiPath));
}

function runTypeScriptProbe(modulePath, script, secondModulePath = null) {
  const args = ["--no-warnings", "--experimental-strip-types", "-e", script, pathToUrl(modulePath)];
  if (secondModulePath) args.push(pathToUrl(secondModulePath));
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
