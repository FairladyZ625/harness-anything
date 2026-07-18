#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const registryPath = path.resolve(root, process.env.HARNESS_WRITE_ROAD_REGISTRY ?? "tools/write-road-registry.json");
const sourceRoots = [
  "packages/adapters/local/src",
  "packages/application/src",
  "packages/cli/src",
  "packages/daemon/src",
  "packages/gui/src",
  "packages/kernel/src"
];
const fsWriteApis = new Set([
  "appendFile",
  "appendFileSync",
  "closeSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "fsyncSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync"
]);
const mutatingHttpMethods = new Set(["POST", "PUT", "DELETE"]);

const registry = loadRegistry();
const rows = registry.rows;
const discoveries = [
  ...discoverWriteOpKinds(),
  ...discoverMachineArtifactBoundaries(),
  ...discoverSourceSinks(),
  ...discoverDaemonCliActions(),
  ...discoverApiRoutes(),
  ...discoverPresetDeclarations()
];
const findings = [];

validateRegistryShape();
checkCoverage();
checkStaleRegistryEntries();
checkInventoryReconciliation();

if (findings.length > 0) {
  console.error("Write-road registry check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Write-road registry check passed (${rows.length} row(s), ${discoveries.length} discovered write surface(s)).`);
}

function loadRegistry() {
  const raw = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) fail("registry root must be a JSON object");
  if (parsed.schema !== "harness-anything/write-road-registry/v1") {
    fail("registry schema must be harness-anything/write-road-registry/v1");
  }
  if (!Array.isArray(parsed.rows)) fail("registry.rows must be an array");
  return parsed;
}

function validateRegistryShape() {
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    const label = `rows[${index}]`;
    if (!isObject(row)) record(`${label} must be an object`);
    if (typeof row.id !== "string" || row.id.trim() === "") record(`${label}.id must be non-empty`);
    if (ids.has(row.id)) record(`${label}.id duplicates ${row.id}`);
    ids.add(row.id);
    if (!["A", "B", "C", "D"].includes(row.road)) record(`${row.id}: road must be A, B, C, or D`);
    if (!Array.isArray(row.sourceInventoryRows) || row.sourceInventoryRows.length === 0) record(`${row.id}: sourceInventoryRows must be non-empty`);
    if (!isObject(row.channel)) record(`${row.id}: channel must declare pathClass and zoneClass`);
    if (isObject(row.channel)) {
      if (typeof row.channel.pathClass !== "string" || row.channel.pathClass.trim() === "") record(`${row.id}: channel.pathClass must be non-empty`);
      if (typeof row.channel.zoneClass !== "string" || row.channel.zoneClass.trim() === "") record(`${row.id}: channel.zoneClass must be non-empty`);
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) record(`${row.id}: evidence must be non-empty`);
    for (const evidence of row.evidence ?? []) {
      if (typeof evidence !== "string" || !evidence.includes(":")) {
        record(`${row.id}: evidence entry must be file:line anchored: ${String(evidence)}`);
        continue;
      }
      const evidencePath = evidence.split(":")[0];
      if (!existsSync(path.join(root, evidencePath))) record(`${row.id}: evidence path does not exist: ${evidencePath}`);
    }
    if (row.leaseRequired === true && !String(row.bearing ?? "").startsWith("task-")) {
      record(`${row.id}: leaseRequired rows must declare task-* bearing`);
    }
  }
}

function checkCoverage() {
  for (const discovery of discoveries) {
    if (!rows.some((row) => covers(row, discovery))) {
      record(`${discovery.key}: no write-road registry row covers ${discovery.message}`);
    }
  }
}

function checkStaleRegistryEntries() {
  const checks = [
    ["writeKinds", "write-op-kind", "writeOpKind"],
    ["machineArtifactBoundaries", "machine-artifact-boundary", "machineArtifactBoundary"],
    ["cliActions", "daemon-cli-action", "cliAction"],
    ["apiRoutes", "api-route", "apiRoute"],
    ["guiBridgeMethods", "gui-bridge-method", "guiBridgeMethod"],
    ["presetWriteScopes", "preset-write-scope", "presetWriteScope"],
    ["presetProduces", "preset-produce-scope", "presetProduceScope"]
  ];
  for (const row of rows) {
    for (const [field, type, property] of checks) {
      for (const value of asArray(row[field])) {
        if (!discoveries.some((discovery) => discovery.type === type && discovery[property] === value)) {
          record(`${row.id}: stale ${field} entry ${value}`);
        }
      }
    }
    for (const file of asArray(row.callsiteFiles)) {
      if (!discoveries.some((discovery) => discovery.type === "coordinator-callsite" && discovery.file === file)) {
        record(`${row.id}: stale callsiteFiles entry ${file}`);
      }
    }
    for (const entry of asArray(row.directWrites)) {
      if (!isObject(entry) || typeof entry.file !== "string") {
        record(`${row.id}: directWrites entries must include file`);
        continue;
      }
      if (!discoveries.some((discovery) =>
        discovery.type === "direct-write" &&
        discovery.file === entry.file &&
        (!entry.api || discovery.api === entry.api) &&
        (!entry.command || discovery.command === entry.command)
      )) {
        record(`${row.id}: stale directWrites entry ${entry.file}${entry.api ? `#${entry.api}` : ""}${entry.command ? `#${entry.command}` : ""}`);
      }
    }
  }
}

function checkInventoryReconciliation() {
  const covered = new Set();
  for (const row of rows) {
    for (const item of row.sourceInventoryRows) covered.add(item);
  }
  const declaredRowCount = registry.rowCountReconciliation?.registryRows;
  if (declaredRowCount !== undefined && declaredRowCount !== rows.length) {
    record(`rowCountReconciliation.registryRows is ${declaredRowCount}, but registry has ${rows.length} row(s)`);
  }
  for (let index = 1; index <= 26; index += 1) {
    if (!covered.has(index)) record(`source inventory row ${index} is not covered by registry rows`);
  }
  for (const item of [...covered].sort((a, b) => a - b)) {
    if (!Number.isInteger(item) || item < 1 || item > 26) record(`registry cites invalid sourceInventoryRows entry ${item}`);
  }
}

function covers(row, discovery) {
  if (discovery.type === "write-op-kind") return asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "machine-artifact-boundary") return asArray(row.machineArtifactBoundaries).includes(discovery.machineArtifactBoundary);
  if (discovery.type === "coordinator-callsite") return asArray(row.callsiteFiles).includes(discovery.file) || asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "direct-write") {
    return asArray(row.directWrites).some((entry) =>
      isObject(entry) &&
      entry.file === discovery.file &&
      (!entry.api || entry.api === discovery.api) &&
      (!entry.command || entry.command === discovery.command)
    );
  }
  if (discovery.type === "daemon-cli-action") return asArray(row.cliActions).includes(discovery.cliAction);
  if (discovery.type === "api-route") return asArray(row.apiRoutes).includes(discovery.apiRoute);
  if (discovery.type === "gui-bridge-method") return asArray(row.guiBridgeMethods).includes(discovery.guiBridgeMethod);
  if (discovery.type === "preset-write-scope") return asArray(row.presetWriteScopes).includes(discovery.presetWriteScope);
  if (discovery.type === "preset-produce-scope") return asArray(row.presetProduces).includes(discovery.presetProduceScope);
  return false;
}

function discoverWriteOpKinds() {
  const rel = "packages/kernel/src/ports/write-coordinator.ts";
  const sourceFile = parseSource(rel);
  const out = [];
  visit(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || !node.name.text.endsWith("WriteOpKind")) return;
    for (const literal of stringLiteralsInType(node.type)) {
      out.push(discovery("write-op-kind", rel, node, sourceFile, `WriteOpKind ${literal}`, { writeOpKind: literal }));
    }
  });
  return uniqueDiscoveries(out);
}

function discoverMachineArtifactBoundaries() {
  const rel = "packages/kernel/src/store/write-journal-operations.ts";
  const sourceFile = parseSource(rel);
  const out = [];
  visit(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== "MachineArtifactBoundary") return;
    for (const literal of stringLiteralsInType(node.type)) {
      out.push(discovery("machine-artifact-boundary", rel, node, sourceFile, `machine artifact boundary ${literal}`, { machineArtifactBoundary: literal }));
    }
  });
  return uniqueDiscoveries(out);
}

function discoverSourceSinks() {
  const out = [];
  for (const rel of sourceRoots.flatMap(walkTypeScriptFiles)) {
    const sourceFile = parseSource(rel);
    const bindings = fsBindings(sourceFile);
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callName = calledIdentifier(node.expression);
      if (["writeCoordinatedPayload", "writeCoordinatedTaskDocuments"].includes(callName)) {
        const writeOpKind = coordinatedCallKind(node);
        out.push(discovery("coordinator-callsite", rel, node.expression, sourceFile, `${callName}${writeOpKind ? ` ${writeOpKind}` : ""}`, { callName, writeOpKind }));
        return;
      }
      if (callName === "enqueue" && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "enqueue") {
        const writeOpKind = coordinatedCallKind(node);
        out.push(discovery("coordinator-callsite", rel, node.expression, sourceFile, `coordinator.enqueue${writeOpKind ? ` ${writeOpKind}` : ""}`, { callName: "coordinator.enqueue", writeOpKind }));
        return;
      }
      const api = calledFsApi(node.expression, bindings);
      if (api) {
        out.push(discovery("direct-write", rel, node.expression, sourceFile, `direct fs ${api}`, { api }));
        return;
      }
      const command = directGitCommand(node);
      if (command) {
        out.push(discovery("direct-write", rel, node.expression, sourceFile, `direct git ${command}`, { command }));
      }
    });
  }
  return uniqueDiscoveries(out);
}

function discoverDaemonCliActions() {
  const rel = "packages/daemon/src/protocol/method-registry.ts";
  const sourceFile = parseSource(rel);
  const wanted = new Set(["repoWriteCliActionKinds", "arbiterCliActionKinds"]);
  const out = [];
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !wanted.has(node.name.text)) return;
    const values = stringLiteralsInExpression(node.initializer);
    for (const value of values) {
      out.push(discovery("daemon-cli-action", rel, node.name, sourceFile, `daemon repo.command.run action ${value}`, { cliAction: value }));
    }
  });
  const taskPolicyRel = "packages/application/src/task-write-route-policy.ts";
  const taskPolicySource = parseSource(taskPolicyRel);
  for (const element of objectElementsInArray(taskPolicySource, "taskWriteCliRoutePolicies")) {
    const actionKind = stringProperty(element, "actionKind");
    if (actionKind) {
      out.push(discovery("daemon-cli-action", taskPolicyRel, element, taskPolicySource, `task write CLI route ${actionKind}`, { cliAction: actionKind }));
    }
  }
  return uniqueDiscoveries(out);
}

function discoverApiRoutes() {
  const out = [];
  for (const [rel, arrayName] of [
    ["packages/api-contracts/src/api-contract-registry.ts", "apiRouteContracts"],
    ["packages/application/src/task-write-route-policy.ts", "taskWriteApiRoutePolicies"]
  ]) {
    const sourceFile = parseSource(rel);
    for (const element of objectElementsInArray(sourceFile, arrayName)) {
      const id = stringProperty(element, "id");
      const method = stringProperty(element, "method");
      const guiBridgeMethod = stringProperty(element, "guiBridgeMethod");
      if (id && method && mutatingHttpMethods.has(method)) {
        out.push(discovery("api-route", rel, element, sourceFile, `mutating API route ${id}`, { apiRoute: id }));
        if (guiBridgeMethod) {
          out.push(discovery("gui-bridge-method", rel, element, sourceFile, `mutating GUI bridge method ${guiBridgeMethod}`, { guiBridgeMethod }));
        }
      }
    }
  }
  return uniqueDiscoveries(out);
}

function objectElementsInArray(sourceFile, arrayName) {
  const elements = [];
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== arrayName || !node.initializer) return;
    const array = unwrapExpression(node.initializer);
    if (!ts.isArrayLiteralExpression(array)) return;
    elements.push(...array.elements.filter(ts.isObjectLiteralExpression));
  });
  return elements;
}

function discoverPresetDeclarations() {
  const out = [];
  for (const rel of walkJsonFiles("packages/cli/src/commands/extensions/assets")) {
    const parsed = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    collectPresetScopes(parsed, rel, out);
  }
  return uniqueDiscoveries(out);
}

function collectPresetScopes(value, rel, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectPresetScopes(item, rel, out);
    return;
  }
  if (!isObject(value)) return;
  if (Array.isArray(value.writes)) {
    for (const scope of value.writes) {
      if (typeof scope === "string") {
        out.push({
          type: "preset-write-scope",
          file: rel,
          line: 1,
          character: 1,
          key: `${rel}#preset-write-scope:${scope}`,
          message: `preset/script declared write scope ${scope}`,
          presetWriteScope: scope
        });
      }
    }
  }
  if (Array.isArray(value.produces)) {
    for (const scope of value.produces) {
      if (typeof scope === "string") {
        out.push({
          type: "preset-produce-scope",
          file: rel,
          line: 1,
          character: 1,
          key: `${rel}#preset-produce-scope:${scope}`,
          message: `script declared produce scope ${scope}`,
          presetProduceScope: scope
        });
      }
    }
  }
  for (const child of Object.values(value)) collectPresetScopes(child, rel, out);
}

function coordinatedCallKind(node) {
  for (const arg of node.arguments) {
    const object = unwrapExpression(arg);
    if (!ts.isObjectLiteralExpression(object)) continue;
    const kind = stringProperty(object, "kind");
    if (kind) return kind;
  }
  return undefined;
}

function directGitCommand(node) {
  const callName = calledIdentifier(node.expression);
  if (callName !== "execFileSync" && callName !== "execFile") return undefined;
  const first = node.arguments[0];
  return first && ts.isStringLiteralLike(first) && first.text === "git" ? "git" : undefined;
}

function stringProperty(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propName = propertyNameText(property.name);
    if (propName !== name) continue;
    const initializer = unwrapExpression(property.initializer);
    if (ts.isStringLiteralLike(initializer)) return initializer.text;
  }
  return undefined;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function fsBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "node:fs" && statement.moduleSpecifier.text !== "node:fs/promises") continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (fsWriteApis.has(imported)) named.set(element.name.text, imported);
      }
    }
  }
  return { named, namespaces };
}

function calledFsApi(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "promises" &&
    bindings.namespaces.has(expression.expression.expression.getText())) {
    const api = expression.name.text;
    return fsWriteApis.has(api) ? api : undefined;
  }
  if (!bindings.namespaces.has(expression.expression.getText())) return undefined;
  const api = expression.name.text;
  return fsWriteApis.has(api) ? api : undefined;
}

function calledIdentifier(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

function stringLiteralsInType(node) {
  if (!node) return [];
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return [node.literal.text];
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(stringLiteralsInType);
  return [];
}

function stringLiteralsInExpression(node) {
  const expression = unwrapExpression(node);
  if (!expression) return [];
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => ts.isStringLiteralLike(element) ? [element.text] : []);
  }
  if (ts.isNewExpression(expression)) {
    return expression.arguments?.flatMap(stringLiteralsInExpression) ?? [];
  }
  return [];
}

function unwrapExpression(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function discovery(type, rel, node, sourceFile, message, extra = {}) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    type,
    file: rel,
    line: line + 1,
    character: character + 1,
    key: `${rel}#${type}@${line + 1}:${character + 1}`,
    message,
    ...extra
  };
}

function uniqueDiscoveries(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const semantic = [
      item.type,
      item.file,
      item.writeOpKind,
      item.machineArtifactBoundary,
      item.callName,
      item.api,
      item.command,
      item.cliAction,
      item.apiRoute,
      item.guiBridgeMethod,
      item.presetWriteScope,
      item.presetProduceScope,
      item.line,
      item.character
    ].filter(Boolean).join("|");
    if (seen.has(semantic)) continue;
    seen.add(semantic);
    out.push(item);
  }
  return out;
}

function parseSource(rel) {
  return ts.createSourceFile(rel, readFileSync(path.join(root, rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function walkTypeScriptFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  return ts.sys.readDirectory(absRoot, [".ts"], ["**/node_modules/**"], undefined)
    .filter((entry) => statSync(entry).isFile() && !entry.endsWith(".d.ts"))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .sort();
}

function walkJsonFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  return ts.sys.readDirectory(absRoot, [".json"], ["**/node_modules/**"], undefined)
    .filter((entry) => statSync(entry).isFile())
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .sort();
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(message) {
  findings.push(message);
}

function fail(message) {
  console.error(`Write-road registry check failed: ${message}`);
  process.exit(2);
}
