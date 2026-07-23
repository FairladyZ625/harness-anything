/**
 * Discovers every write surface the repository actually exposes, by reading
 * source rather than by trusting a declaration. The registry checker compares
 * this discovery against tools/write-road-registry.json; keeping the two apart
 * means an unregistered write road is found by evidence, not by bookkeeping.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { childProcessApis } from "./child-process-apis.mjs";
import { fsWriteApis } from "./fs-write-apis.mjs";
import { discoverWorkspaceSourceRoots } from "./workspace-packages.mjs";

const mutatingHttpMethods = new Set(["POST", "PUT", "DELETE"]);
const taskReviewControllerCalls = new Set(["map", "pipe", "runPromise", "startTaskReview", "validateLocalControllerTaskId"]);
const taskReviewGuardCalls = new Set(["succeed", "taskFailure"]);
const root = process.cwd();
const sourceRoots = [...discoverWorkspaceSourceRoots(root), "tools"];

export function discoverWriteSurfaces() {
  return [
    ...discoverWriteOpKinds(),
    ...discoverMachineArtifactBoundaries(),
    ...discoverSourceSinks(),
    ...discoverDaemonCliActions(),
    ...discoverApiRoutes(),
    ...discoverPresetDeclarations()
  ];
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
  const taskReviewIsRequestGuard = discoverTaskReviewRequestGuard();
  for (const [rel, arrayName] of [
    ["packages/api-contracts/src/api-contract-registry.ts", "apiRouteContracts"],
    ["packages/application/src/task-write-route-policy.ts", "taskWriteApiRoutePolicies"]
  ]) {
    const sourceFile = parseSource(rel);
    for (const element of objectElementsInArray(sourceFile, arrayName)) {
      const id = stringProperty(element, "id");
      const method = stringProperty(element, "method");
      const serviceMethod = stringProperty(element, "serviceMethod");
      const guiBridgeMethod = stringProperty(element, "guiBridgeMethod");
      if (id && method && mutatingHttpMethods.has(method)) {
        if (serviceMethod === "reviewTask" && taskReviewIsRequestGuard) continue;
        out.push(discovery("api-route", rel, element, sourceFile, `mutating API route ${id}`, { apiRoute: id }));
        if (guiBridgeMethod) {
          out.push(discovery("gui-bridge-method", rel, element, sourceFile, `mutating GUI bridge method ${guiBridgeMethod}`, { guiBridgeMethod }));
        }
      }
    }
  }
  return uniqueDiscoveries(out);
}

function discoverTaskReviewRequestGuard() {
  const controllerRel = "packages/application/src/local-controller-service.ts";
  const lifecycleRel = "packages/application/src/task-lifecycle-orchestrator.ts";
  if (![controllerRel, lifecycleRel].every((rel) => existsSync(path.join(root, rel)))) return false;
  const controllerBody = propertyImplementationBody(parseSource(controllerRel), "reviewTask");
  const guardBody = propertyImplementationBody(parseSource(lifecycleRel), "startTaskReview");
  return controllerBody !== undefined &&
    guardBody !== undefined &&
    setsEqual(calledNamesIn(controllerBody), taskReviewControllerCalls) &&
    setsEqual(calledNamesIn(guardBody), taskReviewGuardCalls) &&
    stringLiteralsInNode(guardBody).includes("execution_submission_required");
}

function propertyImplementationBody(sourceFile, propertyName) {
  let body;
  visit(sourceFile, (node) => {
    if (!ts.isPropertyAssignment(node) || propertyNameText(node.name) !== propertyName) return;
    const implementation = unwrapExpression(node.initializer);
    if (ts.isArrowFunction(implementation) || ts.isFunctionExpression(implementation)) body = implementation.body;
  });
  return body;
}

function calledNamesIn(node) {
  const calls = new Set();
  visit(node, (child) => {
    if (ts.isCallExpression(child)) calls.add(calledIdentifier(child.expression));
  });
  calls.delete("");
  return calls;
}

function stringLiteralsInNode(node) {
  const literals = [];
  visit(node, (child) => {
    if (ts.isStringLiteralLike(child)) literals.push(child.text);
  });
  return literals;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
