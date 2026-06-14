#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaults = {
  registryPath: "packages/gui/src/api/api-contract-registry.ts",
  allowlistPath: "packages/gui/src/preload/allowlist.ts",
  bridgePath: "packages/gui/src/api/service-bridge.ts",
  applicationPath: "packages/application/src/index.ts",
  terminalPath: "packages/gui/src/terminal/session-registry.ts"
};
const supportedServices = new Set(["LocalControllerService", "TerminalSessionService"]);
const requiredTerminalRoutes = [
  { id: "terminal.sessions.create", method: "POST", path: "/api/terminal/sessions", serviceMethod: "createSession" },
  { id: "terminal.sessions.list", method: "GET", path: "/api/terminal/sessions", serviceMethod: "listSessions" },
  { id: "terminal.sessions.get", method: "GET", path: "/api/terminal/sessions/:id", serviceMethod: "getSession" },
  { id: "terminal.sessions.attach", method: "WS", path: "/api/terminal/sessions/:id/attach", serviceMethod: "attachSession" },
  { id: "terminal.sessions.resize", method: "POST", path: "/api/terminal/sessions/:id/resize", serviceMethod: "resizeSession" },
  { id: "terminal.sessions.close", method: "DELETE", path: "/api/terminal/sessions/:id", serviceMethod: "closeSession" }
];
const validMethods = new Set(["GET", "POST", "PUT", "DELETE", "WS"]);
const validAuthModes = new Set(["local-session-token", "ssh-tunnel-local-token", "none"]);
const requiredFields = [
  "id",
  "method",
  "path",
  "inputSchemaId",
  "errorSchemaId",
  "service",
  "serviceMethod",
  "auth"
];
const schemaIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\/v[1-9][0-9]*$/u;

export function evaluateApiContractRegistry(root = process.cwd(), options = {}) {
  const paths = { ...defaults, ...options };
  const violations = [];
  const registry = collectApiRouteContracts(root, paths.registryPath, violations);
  const schemaContracts = collectApiSchemaContracts(root, paths.registryPath, violations);
  const deferredContracts = collectDeferredGuiBridgeContracts(root, paths.registryPath, violations);
  const preloadMethods = collectPreloadMethods(root, paths.allowlistPath, violations);
  const dispatchBranches = collectDispatchBranches(root, paths.bridgePath, violations);
  const applicationDeclarations = collectTypeDeclarations(root, paths.applicationPath, violations);
  const registryDeclarations = collectTypeDeclarations(root, paths.registryPath, violations);
  const terminalDeclarations = collectTypeDeclarations(root, paths.terminalPath, violations);
  const guiDeclarations = new Set([...registryDeclarations, ...terminalDeclarations]);
  const localControllerMethods = collectInterfaceMethods(root, paths.applicationPath, "LocalControllerService", violations);
  const terminalSessionMethods = collectInterfaceMethods(root, paths.terminalPath, "TerminalSessionService", violations);
  const serviceMethods = new Map([
    ["LocalControllerService", localControllerMethods],
    ["TerminalSessionService", terminalSessionMethods]
  ]);
  if (localControllerMethods.size === 0) violations.push(`${paths.applicationPath}: missing LocalControllerService methods`);
  const coveredBridgeMethods = new Set([
    ...registry.map((entry) => entry.guiBridgeMethod).filter(Boolean),
    ...deferredContracts.map((entry) => entry.guiBridgeMethod).filter(Boolean)
  ]);

  inspectSchemaContracts(schemaContracts, applicationDeclarations, guiDeclarations, paths.registryPath, violations);
  inspectRegistryEntries(registry, schemaContracts, serviceMethods, preloadMethods, paths.registryPath, violations);
  inspectRequiredTerminalRoutes(registry, paths.registryPath, violations);
  inspectDeferredContracts(deferredContracts, registry, localControllerMethods, preloadMethods, paths.registryPath, violations);
  inspectDispatchBranches([...registry, ...deferredContracts], dispatchBranches, paths.bridgePath, violations);
  compareSets(preloadMethods, coveredBridgeMethods, {
    leftName: "preload allowlist",
    rightName: "API registry or deferred GUI bridge contract",
    filePath: paths.registryPath,
    violations
  });
  compareSets(new Set(dispatchBranches.keys()), coveredBridgeMethods, {
    leftName: "GUI service dispatch",
    rightName: "API registry or deferred GUI bridge contract",
    filePath: paths.registryPath,
    violations
  });

  return violations;
}

function inspectRequiredTerminalRoutes(entries, relativePath, violations) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const required of requiredTerminalRoutes) {
    const entry = byId.get(required.id);
    if (!entry) {
      violations.push(`${relativePath}: missing required terminal route ${required.id}`);
      continue;
    }
    for (const field of ["method", "path", "serviceMethod"]) {
      if (entry[field] !== required[field]) {
        violations.push(`${relativePath}: terminal route ${required.id} ${field} must be ${required[field]}`);
      }
    }
    if (entry.service !== "TerminalSessionService") {
      violations.push(`${relativePath}: terminal route ${required.id} service must be TerminalSessionService`);
    }
  }
}

function collectApiSchemaContracts(root, relativePath, violations) {
  return collectStringObjectArray(root, relativePath, "apiSchemaContracts", violations);
}

function collectDeferredGuiBridgeContracts(root, relativePath, violations) {
  return collectStringObjectArray(root, relativePath, "deferredGuiBridgeContracts", violations);
}

function collectApiRouteContracts(root, relativePath, violations) {
  return collectStringObjectArray(root, relativePath, "apiRouteContracts", violations);
}

function collectStringObjectArray(root, relativePath, variableName, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return [];
  const registryNode = findVariableInitializer(source.file, variableName);
  if (!registryNode || !ts.isArrayLiteralExpression(stripAsExpression(registryNode))) {
    violations.push(`${relativePath}: missing ${variableName} array literal`);
    return [];
  }

  const entries = [];
  const arrayNode = stripAsExpression(registryNode);
  for (const element of arrayNode.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      violations.push(`${relativePath}: ${variableName} entries must be object literals`);
      continue;
    }
    entries.push(readStringObject(element, source.file));
  }
  return entries;
}

function collectPreloadMethods(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Set();
  const initializer = findVariableInitializer(source.file, "allowedPreloadApi");
  if (!initializer || !ts.isObjectLiteralExpression(stripAsExpression(initializer))) {
    violations.push(`${relativePath}: missing allowedPreloadApi object literal`);
    return new Set();
  }
  return new Set(stripAsExpression(initializer).properties.map((property) => propertyName(property.name, source.file)).filter(Boolean));
}

function collectDispatchBranches(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Map();
  const branches = new Map();
  let foundDispatcher = false;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "dispatchGuiServiceMethod") {
      foundDispatcher = true;
      collectMethodBranches(node, source.file, branches, relativePath, violations);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.file);
  if (!foundDispatcher) violations.push(`${relativePath}: missing dispatchGuiServiceMethod`);
  return branches;
}

function collectTypeDeclarations(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Set();
  const declarations = new Set();

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) declarations.add(node.name.text);
    ts.forEachChild(node, visit);
  }

  visit(source.file);
  return declarations;
}

function collectInterfaceMethods(root, relativePath, interfaceName, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Set();
  const methods = new Set();

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) methods.add(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.file);
  return methods;
}

function inspectSchemaContracts(schemaContracts, applicationDeclarations, registryDeclarations, relativePath, violations) {
  const ids = new Set();
  for (const entry of schemaContracts) {
    const label = entry.id ? `schema ${entry.id}` : "schema <missing id>";
    for (const field of ["id", "owner", "typeName"]) {
      if (!entry[field]) violations.push(`${relativePath}: ${label} missing ${field}`);
    }
    if (entry.id && ids.has(entry.id)) violations.push(`${relativePath}: duplicate schema id ${entry.id}`);
    if (entry.id) ids.add(entry.id);
    if (entry.id && !schemaIdPattern.test(entry.id)) violations.push(`${relativePath}: ${label} has malformed id`);
    if (entry.owner && !["application", "gui"].includes(entry.owner)) violations.push(`${relativePath}: ${label} has invalid owner ${entry.owner}`);
    if (entry.owner === "application" && entry.typeName && !applicationDeclarations.has(entry.typeName)) {
      violations.push(`${relativePath}: ${label} points to missing application type ${entry.typeName}`);
    }
    if (entry.owner === "gui" && entry.typeName && !registryDeclarations.has(entry.typeName)) {
      violations.push(`${relativePath}: ${label} points to missing GUI contract type ${entry.typeName}`);
    }
  }
}

function inspectRegistryEntries(entries, schemaContracts, serviceMethods, preloadMethods, relativePath, violations) {
  const ids = new Set();
  const methodPaths = new Set();
  const schemaIds = new Set(schemaContracts.map((entry) => entry.id));

  for (const entry of entries) {
    const label = entry.id ? `route ${entry.id}` : "route <missing id>";
    for (const field of requiredFields) {
      if (!entry[field]) violations.push(`${relativePath}: ${label} missing ${field}`);
    }
    if (entry.outputSchemaId === "") violations.push(`${relativePath}: ${label} has an empty outputSchemaId`);
    if (entry.id && ids.has(entry.id)) violations.push(`${relativePath}: duplicate route id ${entry.id}`);
    if (entry.id) ids.add(entry.id);
    const methodPath = `${entry.method ?? ""} ${entry.path ?? ""}`;
    if (entry.method && entry.path && methodPaths.has(methodPath)) violations.push(`${relativePath}: duplicate route method/path ${methodPath}`);
    if (entry.method && entry.path) methodPaths.add(methodPath);
    if (entry.method && !validMethods.has(entry.method)) violations.push(`${relativePath}: ${label} has invalid method ${entry.method}`);
    if (entry.auth && !validAuthModes.has(entry.auth)) violations.push(`${relativePath}: ${label} has invalid auth ${entry.auth}`);
    if (entry.path && !entry.path.startsWith("/api/")) violations.push(`${relativePath}: ${label} path must start with /api/`);
    for (const field of ["inputSchemaId", "outputSchemaId", "errorSchemaId"]) {
      if (entry[field] && !schemaIdPattern.test(entry[field])) violations.push(`${relativePath}: ${label} has malformed ${field} ${entry[field]}`);
      if (entry[field] && !schemaIds.has(entry[field])) violations.push(`${relativePath}: ${label} ${field} ${entry[field]} is not registered in apiSchemaContracts`);
    }
    if (entry.service && !supportedServices.has(entry.service)) {
      violations.push(`${relativePath}: ${label} unsupported service ${entry.service}`);
    }
    const methodSet = serviceMethods.get(entry.service);
    if (entry.service && entry.serviceMethod && (!methodSet || !methodSet.has(entry.serviceMethod))) {
      violations.push(`${relativePath}: ${label} points to missing ${entry.service}.${entry.serviceMethod}`);
    }
    if (entry.service === "LocalControllerService" && !entry.guiBridgeMethod) {
      violations.push(`${relativePath}: ${label} LocalControllerService route missing guiBridgeMethod`);
    }
    if (entry.service === "TerminalSessionService" && entry.guiBridgeMethod) {
      violations.push(`${relativePath}: ${label} TerminalSessionService route must not declare guiBridgeMethod`);
    }
    if (entry.guiBridgeMethod && !preloadMethods.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: ${label} guiBridgeMethod ${entry.guiBridgeMethod} is not in preload allowlist`);
    }
  }
}

function inspectDeferredContracts(deferredContracts, routeContracts, serviceMethods, preloadMethods, relativePath, violations) {
  const activeMethods = new Set(routeContracts.map((entry) => entry.guiBridgeMethod));
  const deferredMethods = new Set();
  for (const entry of deferredContracts) {
    const label = entry.guiBridgeMethod ? `deferred ${entry.guiBridgeMethod}` : "deferred <missing guiBridgeMethod>";
    for (const field of ["guiBridgeMethod", "service", "serviceMethod", "reason"]) {
      if (!entry[field]) violations.push(`${relativePath}: ${label} missing ${field}`);
    }
    if (entry.guiBridgeMethod && deferredMethods.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: duplicate deferred guiBridgeMethod ${entry.guiBridgeMethod}`);
    }
    if (entry.guiBridgeMethod) deferredMethods.add(entry.guiBridgeMethod);
    if (entry.guiBridgeMethod && activeMethods.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} cannot be both an API route and a deferred GUI bridge contract`);
    }
    if (entry.service && entry.service !== "LocalControllerService") {
      violations.push(`${relativePath}: ${label} unsupported service ${entry.service}`);
    }
    if (entry.serviceMethod && !serviceMethods.has(entry.serviceMethod)) {
      violations.push(`${relativePath}: ${label} points to missing LocalControllerService.${entry.serviceMethod}`);
    }
    if (entry.guiBridgeMethod && !preloadMethods.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: ${label} is not in preload allowlist`);
    }
  }
}

function inspectDispatchBranches(contracts, dispatchBranches, relativePath, violations) {
  for (const entry of contracts) {
    if (!entry.guiBridgeMethod || !entry.serviceMethod) continue;
    const serviceCalls = dispatchBranches.get(entry.guiBridgeMethod);
    if (!serviceCalls) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} is registered but has no dispatch branch`);
      continue;
    }
    if (!serviceCalls.has(entry.serviceMethod)) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} dispatch does not call LocalControllerService.${entry.serviceMethod}`);
    }
    for (const serviceCall of serviceCalls) {
      if (serviceCall !== entry.serviceMethod) {
        violations.push(`${relativePath}: ${entry.guiBridgeMethod} dispatch calls unexpected LocalControllerService.${serviceCall}`);
      }
    }
  }
}

function compareSets(left, right, context) {
  for (const value of left) {
    if (!right.has(value)) context.violations.push(`${context.filePath}: ${value} is in ${context.leftName} but missing from ${context.rightName}`);
  }
  for (const value of right) {
    if (!left.has(value)) context.violations.push(`${context.filePath}: ${value} is in ${context.rightName} but missing from ${context.leftName}`);
  }
}

function collectMethodBranches(node, sourceFile, branches, relativePath, violations) {
  function visit(child) {
    if (ts.isIfStatement(child)) {
      const methodName = readMethodEquality(child.expression, sourceFile);
      if (methodName) {
        if (branches.has(methodName)) {
          violations.push(`${relativePath}: duplicate dispatch branch for ${methodName}`);
        } else {
          branches.set(methodName, collectServiceCalls(child.thenStatement, sourceFile));
        }
        if (child.elseStatement) visit(child.elseStatement);
        return;
      }
    }
    ts.forEachChild(child, visit);
  }

  visit(node);
}

function readMethodEquality(expression, sourceFile) {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined;
  const left = expression.left.getText(sourceFile);
  const right = expression.right.getText(sourceFile);
  if (left === "method" && ts.isStringLiteral(expression.right)) return expression.right.text;
  if (right === "method" && ts.isStringLiteral(expression.left)) return expression.left.text;
  return undefined;
}

function collectServiceCalls(node, sourceFile) {
  const serviceCalls = new Set();
  function visit(child) {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
      const receiver = child.expression.expression.getText(sourceFile);
      if (receiver === "service") serviceCalls.add(child.expression.name.text);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return serviceCalls;
}

function readStringObject(objectNode, sourceFile) {
  const record = {};
  for (const property of objectNode.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name, sourceFile);
    const value = stripAsExpression(property.initializer);
    if (name && ts.isStringLiteralLike(value)) record[name] = value.text;
  }
  return record;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return initializer;
}

function propertyName(name, sourceFile) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

function stripAsExpression(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function readSource(root, relativePath, violations) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    violations.push(`${relativePath}: missing file`);
    return undefined;
  }
  const text = readFileSync(absolutePath, "utf8");
  return {
    text,
    file: ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = evaluateApiContractRegistry();
  if (violations.length > 0) {
    console.error("API contract registry check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("API contract registry check passed.");
}
