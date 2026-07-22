#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { childProcessApis } from "./child-process-apis.mjs";
import { fsWriteApis } from "./fs-write-apis.mjs";
import { discoverWorkspaceSourceRoots } from "./workspace-packages.mjs";

const root = process.cwd();
const registryPath = path.resolve(root, process.env.HARNESS_WRITE_ROAD_REGISTRY ?? "tools/write-road-registry.json");
const sourceRoots = [...discoverWorkspaceSourceRoots(root), "tools"];
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
checkWritePointRatchet();

if (findings.length > 0) {
  console.error("Write-road registry check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  const writePoints = discoveries.filter((item) => item.type === "direct-write");
  const omissionDebt = rows.flatMap((row) => asArray(row.directWrites)).filter((entry) => entry.classification === "omission-debt").length;
  const previous = previousWritePointCounts() ?? {
    coverage: registry.writePointRatchet.previousCoverage,
    omissionDebt: registry.writePointRatchet.previousOmissionDebt
  };
  console.log(`[write-road-coverage] current=${writePoints.length} previous=${previous.coverage} delta=${writePoints.length - previous.coverage}`);
  console.log(`[write-road-ratchet] current=${omissionDebt} previous=${previous.omissionDebt} delta=${omissionDebt - previous.omissionDebt}`);
  console.log(`Write-road registry check passed (${sourceRoots.length} production source root(s), ${rows.length} row(s), ${discoveries.length} discovered write surface(s)).`);
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
  const writePointKeys = new Set();
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
    for (const [writeIndex, entry] of asArray(row.directWrites).entries()) {
      const entryLabel = `${row.id}.directWrites[${writeIndex}]`;
      if (!isObject(entry)) {
        record(`${entryLabel} must be an object`);
        continue;
      }
      if (typeof entry.key !== "string" || entry.key.trim() === "") record(`${entryLabel}.key must be non-empty`);
      if (writePointKeys.has(entry.key)) record(`${entryLabel}.key duplicates ${entry.key}`);
      writePointKeys.add(entry.key);
      if (typeof entry.owner !== "string" || entry.owner.trim() === "") record(`${entryLabel}.owner must be non-empty`);
      if (!["coordinator-owned", "design-exemption", "omission-debt"].includes(entry.classification)) {
        record(`${entryLabel}.classification must be coordinator-owned, design-exemption, or omission-debt`);
      }
      if (typeof entry.ref !== "string" || !/^(?:ADR-\d{4}|dec_[A-Za-z0-9_]+|task_[A-Z0-9]+)/u.test(entry.ref)) {
        record(`${entryLabel}.ref must cite an ADR, decision, or task id`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) record(`${entryLabel}.reason must explain the governance basis`);
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
      if (!isObject(entry) || typeof entry.key !== "string") {
        record(`${row.id}: directWrites entries must include key`);
        continue;
      }
      if (!discoveries.some((discovery) => discovery.type === "direct-write" && discovery.key === entry.key)) {
        record(`${row.id}: stale directWrites entry ${entry.key}`);
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

function checkWritePointRatchet() {
  if (!isObject(registry.writePointRatchet)) {
    record("writePointRatchet must declare previousCoverage and previousOmissionDebt");
    return;
  }
  const previousCoverage = registry.writePointRatchet.previousCoverage;
  const previousOmissionDebt = registry.writePointRatchet.previousOmissionDebt;
  if (!Number.isInteger(previousCoverage) || previousCoverage < 0) record("writePointRatchet.previousCoverage must be a non-negative integer");
  if (!Number.isInteger(previousOmissionDebt) || previousOmissionDebt < 0) record("writePointRatchet.previousOmissionDebt must be a non-negative integer");
  const omissionDebt = rows.flatMap((row) => asArray(row.directWrites)).filter((entry) => entry.classification === "omission-debt").length;
  const comparison = previousWritePointCounts()?.omissionDebt ?? previousOmissionDebt;
  if (Number.isInteger(comparison) && omissionDebt > comparison) {
    record(`write-point omission debt grew from ${comparison} to ${omissionDebt}`);
  }
}

function previousWritePointCounts() {
  try {
    const raw = execFileSync("git", ["show", "HEAD^:tools/write-road-registry.json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const previous = JSON.parse(raw);
    if (!isObject(previous) || !Array.isArray(previous.rows)) return undefined;
    const entries = previous.rows.flatMap((row) => asArray(row.directWrites));
    if (entries.every((entry) => isObject(entry) && typeof entry.key === "string")) {
      return {
        coverage: entries.length,
        omissionDebt: entries.filter((entry) => entry.classification === "omission-debt").length
      };
    }
    const allowlistRaw = execFileSync("git", ["show", "HEAD^:tools/gate-allowlists/check-bypass-write-boundary.json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const allowlist = JSON.parse(allowlistRaw);
    if (!isObject(allowlist) || !isObject(allowlist.entries)) return undefined;
    return {
      coverage: Object.values(allowlist.entries).flatMap(asArray).length,
      omissionDebt: asArray(allowlist.entries.omissionDebt).length
    };
  } catch {
    return undefined;
  }
}

function covers(row, discovery) {
  if (discovery.type === "write-op-kind") return asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "machine-artifact-boundary") return asArray(row.machineArtifactBoundaries).includes(discovery.machineArtifactBoundary);
  if (discovery.type === "coordinator-callsite") return asArray(row.callsiteFiles).includes(discovery.file) || asArray(row.writeKinds).includes(discovery.writeOpKind);
  if (discovery.type === "direct-write") {
    return asArray(row.directWrites).some((entry) => isObject(entry) && entry.key === discovery.key);
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
  const rel = "packages/kernel/src/write-coordination/journal/operations/transaction-plan.ts";
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
  for (const rel of sourceRoots.flatMap(walkProductionSourceFiles)) {
    const sourceFile = parseSource(rel);
    const bindings = mutatingBindings(sourceFile);
    const occurrences = new Map();
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
      const mutation = calledMutatingApi(node.expression, bindings);
      if (mutation) {
        const occurrence = (occurrences.get(mutation.api) ?? 0) + 1;
        occurrences.set(mutation.api, occurrence);
        const key = `${rel}#${mutation.api}@${occurrence}`;
        out.push(discovery("direct-write", rel, node.expression, sourceFile, `direct ${mutation.kind} ${mutation.api}`, {
          api: mutation.api,
          mutationKind: mutation.kind,
          key
        }));
        return;
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

function mutatingBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleKind = moduleBindingKind(statement.moduleSpecifier.text);
      if (!moduleKind) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) namespaces.set(clause.name.text, moduleKind);
      const namedBindings = clause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.set(namedBindings.name.text, moduleKind);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (apisFor(moduleKind).has(imported)) named.set(element.name.text, { api: imported, kind: moduleKind });
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const moduleKind = requiredModuleKind(declaration.initializer);
      if (!moduleKind) continue;
      if (ts.isIdentifier(declaration.name)) namespaces.set(declaration.name.text, moduleKind);
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          if (apisFor(moduleKind).has(imported)) named.set(element.name.text, { api: imported, kind: moduleKind });
        }
      }
    }
  }
  return { named, namespaces };
}

function calledMutatingApi(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "promises" &&
    bindings.namespaces.get(expression.expression.expression.getText()) === "fs") {
    const api = expression.name.text;
    return fsWriteApis.has(api) ? { api, kind: "fs" } : undefined;
  }
  const kind = bindings.namespaces.get(expression.expression.getText());
  if (!kind) return undefined;
  const api = expression.name.text;
  return apisFor(kind).has(api) ? { api, kind } : undefined;
}

function moduleBindingKind(moduleName) {
  if (["fs", "fs/promises", "node:fs", "node:fs/promises"].includes(moduleName)) return "fs";
  if (moduleName === "child_process" || moduleName === "node:child_process") return "process";
  return undefined;
}

function requiredModuleKind(initializer) {
  if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "require") return undefined;
  const moduleName = initializer.arguments[0];
  return moduleName && ts.isStringLiteralLike(moduleName) ? moduleBindingKind(moduleName.text) : undefined;
}

function apisFor(kind) {
  return kind === "fs" ? fsWriteApis : childProcessApis;
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
  return ts.createSourceFile(rel, readFileSync(path.join(root, rel), "utf8"), ts.ScriptTarget.Latest, true, scriptKind(rel));
}

function walkProductionSourceFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  return ts.sys.readDirectory(absRoot, [".ts", ".tsx", ".js", ".mjs", ".cjs"], ["**/node_modules/**"], undefined)
    .filter((entry) => statSync(entry).isFile() && isProductionSource(entry))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .sort();
}

function isProductionSource(entry) {
  const normalized = entry.split(path.sep).join("/");
  return !normalized.endsWith(".d.ts") &&
    !/(?:^|\/)(?:fixtures?|test-fixtures)(?:\/|$)/u.test(normalized) &&
    !/(?:^|\.)test\.[^/]+$/u.test(normalized);
}

function scriptKind(rel) {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
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
