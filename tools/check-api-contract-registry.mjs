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
  terminalPath: "packages/gui/src/terminal/session-registry.ts",
  daemonMethodRegistryPath: "packages/daemon/src/protocol/method-registry.ts",
  daemonApiSchemaFixtureRoot: "packages/daemon/fixtures/api-schemas"
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
  inspectPreloadProjection(root, paths.allowlistPath, violations);
  const preloadMethods = collectPreloadMethods(root, paths.allowlistPath, violations);
  const preloadCapabilities = collectPreloadCapabilities(root, paths.allowlistPath, violations);
  const bridgeHandlers = collectGuiBridgeHandlerImplementations(root, paths.bridgePath, violations);
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

  compareSets(preloadMethods, new Set(preloadCapabilities.keys()), {
    leftName: "preload allowlist",
    rightName: "preload capability metadata",
    filePath: paths.allowlistPath,
    violations
  });
  inspectSchemaContracts(schemaContracts, applicationDeclarations, guiDeclarations, paths.registryPath, violations);
  inspectApiSchemaFixtures(root, schemaContracts, paths.daemonApiSchemaFixtureRoot, violations);
  inspectRegistryEntries(registry, schemaContracts, serviceMethods, preloadMethods, preloadCapabilities, paths.registryPath, violations);
  inspectDaemonMethodRegistry(root, paths.daemonMethodRegistryPath, registry, violations);
  inspectRequiredTerminalRoutes(registry, paths.registryPath, violations);
  inspectDeferredContracts(deferredContracts, registry, localControllerMethods, preloadMethods, preloadCapabilities, paths.registryPath, violations);
  inspectBridgeHandlers(registry, bridgeHandlers, paths.bridgePath, violations);
  compareSets(preloadMethods, coveredBridgeMethods, {
    leftName: "preload allowlist",
    rightName: "API registry or deferred GUI bridge contract",
    filePath: paths.registryPath,
    violations
  });
  compareSets(new Set(bridgeHandlers.keys()), new Set(registry.map((entry) => entry.guiBridgeMethod).filter(Boolean)), {
    leftName: "GUI shipped bridge handler implementations",
    rightName: "active API registry GUI bridge methods",
    filePath: paths.bridgePath,
    violations
  });
  inspectDeferredMethodsExcludedFromBridgeHandlers(deferredContracts, bridgeHandlers, paths.bridgePath, violations);

  return violations;
}

function inspectApiSchemaFixtures(root, schemaContracts, fixtureRoot, violations) {
  const absoluteFixtureRoot = path.join(root, fixtureRoot);
  if (!existsSync(absoluteFixtureRoot)) return;
  for (const entry of schemaContracts) {
    if (!entry.id) continue;
    const fixtureDir = path.join(fixtureRoot, schemaFixtureName(entry.id));
    for (const fileName of ["valid.json", "invalid.json"]) {
      const relativePath = path.join(fixtureDir, fileName).split(path.sep).join("/");
      if (!existsSync(path.join(root, relativePath))) {
        violations.push(`${fixtureRoot}: schema ${entry.id} missing fixture ${relativePath}`);
      }
    }
  }
}

function inspectDaemonMethodRegistry(root, relativePath, routeContracts, violations) {
  const source = readSource(root, relativePath, []);
  if (!source) return;
  if (!source.text.includes("apiRouteContracts")) {
    violations.push(`${relativePath}: daemon method registry must import the API contract registry authority`);
  }
  if (!/contracts\.map\s*\(/u.test(source.text)) {
    violations.push(`${relativePath}: daemon service method registry must be derived with contracts.map(...)`);
  }
  if (!/method:\s*`repo\.\$\{contract\.id\}`/u.test(source.text)) {
    violations.push(`${relativePath}: daemon JSON-RPC service methods must derive method names from route contract ids`);
  }
  for (const contract of routeContracts) {
    if (!contract.id) continue;
    const manualMethodLiteral = `"repo.${contract.id}"`;
    if (source.text.includes(manualMethodLiteral)) {
      violations.push(`${relativePath}: repo.${contract.id} must not be hand-listed; derive it from apiRouteContracts`);
    }
  }
  for (const requiredMethod of ["protocol.hello", "repo.notifications.subscribe", "repo.notifications.unsubscribe", "admin.people.list", "admin.rbac.roles.list"]) {
    if (!source.text.includes(requiredMethod)) {
      violations.push(`${relativePath}: missing daemon protocol method ${requiredMethod}`);
    }
  }
}

function schemaFixtureName(schemaId) {
  return schemaId.replace(/[^A-Za-z0-9.-]+/gu, "__");
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

function inspectPreloadProjection(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return;
  const allowedInitializer = findVariableInitializer(source.file, "allowedPreloadApi");
  const capabilitiesInitializer = findVariableInitializer(source.file, "preloadApiCapabilities");
  const hasLiteralAllowlist = allowedInitializer && ts.isObjectLiteralExpression(stripAsExpression(allowedInitializer));
  const hasLiteralCapabilities = capabilitiesInitializer && ts.isObjectLiteralExpression(stripAsExpression(capabilitiesInitializer));
  if (!hasLiteralAllowlist) {
    violations.push(`${relativePath}: allowedPreloadApi must declare the real preload API surface as an object literal`);
  }
  if (!hasLiteralCapabilities) {
    violations.push(`${relativePath}: preloadApiCapabilities must declare the real preload API metadata as an object literal`);
  }
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

function collectPreloadCapabilities(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Map();
  const initializer = findVariableInitializer(source.file, "preloadApiCapabilities");
  if (!initializer || !ts.isObjectLiteralExpression(stripAsExpression(initializer))) {
    violations.push(`${relativePath}: missing preloadApiCapabilities object literal`);
    return new Map();
  }
  const capabilities = new Map();
  for (const property of stripAsExpression(initializer).properties) {
    const method = propertyName(property.name, source.file);
    if (!method || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(stripAsExpression(property.initializer))) {
      violations.push(`${relativePath}: preloadApiCapabilities entries must be object literals`);
      continue;
    }
    const capability = readStringObject(stripAsExpression(property.initializer), source.file);
    capabilities.set(method, capability);
    if (capability.method !== method) {
      violations.push(`${relativePath}: preload capability ${method} method must equal ${method}`);
    }
    if (!["shipped", "deferred"].includes(capability.status)) {
      violations.push(`${relativePath}: preload capability ${method} status must be shipped or deferred`);
    }
    if (capability.status === "deferred" && !capability.reason) {
      violations.push(`${relativePath}: preload capability ${method} deferred status requires reason`);
    }
  }
  return capabilities;
}

function collectGuiBridgeHandlerImplementations(root, relativePath, violations) {
  const source = readSource(root, relativePath, violations);
  if (!source) return new Map();
  const initializer = findVariableInitializer(source.file, "guiBridgeHandlerImplementations");
  if (!initializer || !ts.isObjectLiteralExpression(stripAsExpression(initializer))) {
    violations.push(`${relativePath}: missing guiBridgeHandlerImplementations object literal`);
    return new Map();
  }
  const handlers = new Map();
  for (const property of stripAsExpression(initializer).properties) {
    const method = propertyName(property.name, source.file);
    if (!method || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(stripAsExpression(property.initializer))) {
      violations.push(`${relativePath}: guiBridgeHandlerImplementations entries must be object literals`);
      continue;
    }
    if (handlers.has(method)) {
      violations.push(`${relativePath}: duplicate GUI bridge handler implementation for ${method}`);
      continue;
    }
    const handler = stripAsExpression(property.initializer);
    const metadata = readStringObject(handler, source.file);
    handlers.set(method, {
      serviceMethod: metadata.serviceMethod,
      serviceCalls: collectServiceCalls(handler, source.file)
    });
  }
  return handlers;
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

function inspectRegistryEntries(entries, schemaContracts, serviceMethods, preloadMethods, preloadCapabilities, relativePath, violations) {
  const ids = new Set();
  const methodPaths = new Set();
  const activeGuiBridgeMethods = new Set();
  const schemaIds = new Set(schemaContracts.map((entry) => entry.id));

  for (const entry of entries) {
    const label = entry.id ? `route ${entry.id}` : "route <missing id>";
    for (const field of requiredFields) {
      if (!entry[field]) violations.push(`${relativePath}: ${label} missing ${field}`);
    }
    if (entry.outputSchemaId === "") violations.push(`${relativePath}: ${label} has an empty outputSchemaId`);
    if (entry.id && ids.has(entry.id)) violations.push(`${relativePath}: duplicate route id ${entry.id}`);
    if (entry.id) ids.add(entry.id);
    if (entry.guiBridgeMethod && activeGuiBridgeMethods.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: duplicate active guiBridgeMethod ${entry.guiBridgeMethod}`);
    }
    if (entry.guiBridgeMethod) activeGuiBridgeMethods.add(entry.guiBridgeMethod);
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
    if (entry.guiBridgeMethod && preloadCapabilities.get(entry.guiBridgeMethod)?.status !== "shipped") {
      violations.push(`${relativePath}: ${label} guiBridgeMethod ${entry.guiBridgeMethod} must be marked shipped in preload capabilities`);
    }
  }
}

function inspectDeferredContracts(deferredContracts, routeContracts, serviceMethods, preloadMethods, preloadCapabilities, relativePath, violations) {
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
    if (entry.guiBridgeMethod && preloadCapabilities.get(entry.guiBridgeMethod)?.status !== "deferred") {
      violations.push(`${relativePath}: ${label} must be marked deferred in preload capabilities`);
    }
  }
}

function inspectBridgeHandlers(contracts, bridgeHandlers, relativePath, violations) {
  for (const entry of contracts) {
    if (!entry.guiBridgeMethod || !entry.serviceMethod) continue;
    const handler = bridgeHandlers.get(entry.guiBridgeMethod);
    if (!handler) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} is registered as active but has no shipped bridge handler implementation`);
      continue;
    }
    if (handler.serviceMethod !== entry.serviceMethod) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} shipped bridge handler declares ${handler.serviceMethod ?? "<missing>"} but registry requires LocalControllerService.${entry.serviceMethod}`);
    }
    if (!handler.serviceCalls.has(entry.serviceMethod)) {
      violations.push(`${relativePath}: ${entry.guiBridgeMethod} shipped bridge handler does not call LocalControllerService.${entry.serviceMethod}`);
    }
    for (const serviceCall of handler.serviceCalls) {
      if (serviceCall !== entry.serviceMethod) {
        violations.push(`${relativePath}: ${entry.guiBridgeMethod} shipped bridge handler calls unexpected LocalControllerService.${serviceCall}`);
      }
    }
  }
}

function inspectDeferredMethodsExcludedFromBridgeHandlers(deferredContracts, bridgeHandlers, relativePath, violations) {
  for (const entry of deferredContracts) {
    if (entry.guiBridgeMethod && bridgeHandlers.has(entry.guiBridgeMethod)) {
      violations.push(`${relativePath}: deferred ${entry.guiBridgeMethod} must not appear in GUI shipped bridge handler implementations`);
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
  while (true) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.expression.getText() === "Object" &&
      current.expression.name.text === "freeze" &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
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
