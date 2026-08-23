#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const expectedMethods = Object.freeze([
  { method: "protocol.hello", requiresRepo: false },
  { method: "daemon.status", requiresRepo: false },
  { method: "daemon.stop", requiresRepo: false },
  { method: "daemon.repo.bootstrap", requiresRepo: false },
  { method: "daemon.repo.register", requiresRepo: false },
  { method: "daemon.repo.unregister", requiresRepo: false },
  { method: "repo.task.run", requiresRepo: true }
]);
// The fleet channel is part of the same closed RPC surface: every daemon-side
// fleet handler must be declared here with a validated params shape.
const expectedFleetMethods = Object.freeze([
  { method: "daemon.fleet.center.start" },
  { method: "daemon.fleet.edge.sync" },
  { method: "daemon.fleet.task.run" },
  { method: "daemon.fleet.doc.sync" },
  { method: "daemon.fleet.conflict.exit" }
]);
const retiredAuthorities = [
  "packages/application/src/task-write-route-policy.ts",
  "packages/cli/src/cli/parsers/capabilities.ts",
  "packages/daemon/src/identity/authorization.ts",
  "packages/daemon/src/protocol/forced-command-root.ts",
  "packages/daemon/src/protocol/receipt-envelope.ts",
  "packages/daemon/src/transport/named-pipe.ts",
  "packages/daemon/src/transport/ssh-exec.ts",
  "packages/daemon/src/transport/ssh-forced-command.ts",
  "packages/daemon/src/transport/ssh-tunnel-token.ts"
];
const transportAuthorityMarker = "@daemon-transport-authority";

export function evaluateApiContractRegistry(root = process.cwd()) {
  const violations = [];
  const registryPath = "packages/daemon/src/protocol/daemon-protocol.contract.ts";
  const serverPath = "packages/daemon/src/protocol/json-rpc-server.ts";
  const hostPath = "packages/daemon/src/daemon-host.ts";
  const authPath = "packages/daemon/src/transport/auth-context.ts";
  const registry = read(root, registryPath, violations), server = read(root, serverPath, violations);
  const hostGraph = collectRuntimeAuthorityGraph(root, hostPath, violations),
    hostAuthorities = hostGraph.filter(({ source }) => source.includes(transportAuthorityMarker)),
    auth = read(root, authPath, violations);
  if (registry) {
    const methods = collectMethodContracts(registry, registryPath, violations);
    if (JSON.stringify(methods) !== JSON.stringify(expectedMethods)) {
      violations.push(`${registryPath}: method catalog must equal ${JSON.stringify(expectedMethods)}; found ${JSON.stringify(methods)}`);
    }
    const fleetMethods = collectMethodContracts(registry, registryPath, violations, "fleetProtocolMethods");
    if (JSON.stringify(fleetMethods) !== JSON.stringify(expectedFleetMethods)) {
      violations.push(`${registryPath}: fleet method catalog must equal ${JSON.stringify(expectedFleetMethods)}; found ${JSON.stringify(fleetMethods)}`);
    }
    if (/apiRouteContracts|capabilit|notifications?|admin\.(?:people|rbac)/u.test(registry)) {
      violations.push(`${registryPath}: retired GUI/API capability authority must not feed the W3 daemon protocol`);
    }
  }
  if (server) {
    for (const token of ["jsonRpcMethodContracts.some", "request.method === \"protocol.hello\"", "if (!handshaken)",
      "request.method === \"daemon.status\"", "request.method === \"daemon.stop\"", "request.method === \"daemon.repo.bootstrap\"",
      "request.method === \"daemon.repo.register\"", "request.method === \"daemon.repo.unregister\""]) {
      if (!server.includes(token)) violations.push(`${serverPath}: missing protocol closure token ${token}`);
    }
    if (!/options\.host\.run\(repo,\s*action[^,]*,\s*options\.authContext\)/u.test(server)) violations.push(`${serverPath}: repo.task.run must pass transport authentication to the daemon host`);
    if (/notifications?|admin\.(?:people|rbac)|fallback|capabilit/iu.test(server)) violations.push(`${serverPath}: retired notification/admin/capability fallback must not return`);
  }
  if (hostGraph.length > 0 && hostAuthorities.length === 0) {
    violations.push(`${hostPath} runtime graph: no module declares the ${transportAuthorityMarker} role`);
  }
  if (hostAuthorities.length > 0) {
    for (const token of ["new Map<string, RepoCell>()", "auth.assignmentBinding", "kind: \"assignment\"", "makeTransportDerivedIdentityProvider",
      "actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt"]) {
      if (!hostAuthorities.some(({ source }) => source.includes(token))) {
        violations.push(`${hostPath} runtime graph: missing transport-bound RepoCell authority token ${token}`);
      }
    }
    if (hostAuthorities.some(({ source }) => /payload\.(?:actor|root|source|workspaceId)|HARNESS_ACTOR|local fallback/iu.test(source))) {
      violations.push(`${hostPath} runtime graph: daemon ingress must bind actor/root/source instead of trusting payload or fallback identity`);
    }
  }
  if (auth) {
    for (const token of ["DaemonTransportKind = \"unix-socket\"", "unixSocketOwnerBoundary", "assignmentBinding", "nodeId", "assignmentId"]) {
      if (!auth.includes(token)) violations.push(`${authPath}: missing authenticated transport binding ${token}`);
    }
  }
  for (const retired of retiredAuthorities) if (existsSync(path.join(root, retired))) violations.push(`${retired}: W3-retired API/capability authority must not exist`);
  return violations;
}

function collectRuntimeAuthorityGraph(root, entryPath, violations) {
  const authorityRoot = path.dirname(path.join(root, entryPath)), pending = [entryPath], visited = new Set(), modules = [];
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const source = read(root, relativePath, violations);
    if (!source) continue;
    modules.push({ path: relativePath, source });
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
    for (const statement of file.statements) {
      const specifier = runtimeModuleSpecifier(statement);
      if (!specifier?.startsWith(".")) continue;
      const resolved = resolveRuntimeModule(root, authorityRoot, relativePath, specifier);
      if (resolved === undefined) continue;
      if (resolved) pending.push(resolved);
      else violations.push(`${relativePath}: cannot resolve runtime authority dependency ${specifier}`);
    }
  }
  return modules;
}

function runtimeModuleSpecifier(statement) {
  if (ts.isImportDeclaration(statement)) {
    if (statement.importClause?.isTypeOnly) return null;
    if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && !statement.importClause.name && statement.importClause.namedBindings.elements.every((element) => element.isTypeOnly)) return null;
    return ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return null;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.every((element) => element.isTypeOnly)) return null;
    return statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
  }
  return null;
}

function resolveRuntimeModule(root, authorityRoot, importerPath, specifier) {
  const importer = path.join(root, importerPath), requested = path.resolve(path.dirname(importer), specifier);
  if (requested !== authorityRoot && !requested.startsWith(`${authorityRoot}${path.sep}`)) return undefined;
  const extension = path.extname(requested), candidates = extension
    ? [requested, ...([".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? [requested.slice(0, -extension.length) + ".ts", requested.slice(0, -extension.length) + ".tsx"] : [])]
    : [requested, ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map((candidate) => requested + candidate), ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].map((candidate) => path.join(requested, `index${candidate}`))];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  return resolved ? path.relative(root, resolved).split(path.sep).join("/") : null;
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectMethodContracts(source, relativePath, violations, variableName = "daemonProtocolMethods") {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName) initializer = declaration.initializer;
    }
  }
  if (initializer && ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)
    && initializer.expression.expression.getText(file) === "Object" && initializer.expression.name.text === "freeze") initializer = initializer.arguments[0];
  if (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    violations.push(`${relativePath}: ${variableName} must be one frozen contract array literal`);
    return [];
  }
  return initializer.elements.flatMap((element) => {
    if (!ts.isObjectLiteralExpression(element)) { violations.push(`${relativePath}: method entries must be object literals`); return []; }
    if (variableName === "fleetProtocolMethods" && !element.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(file).replace(/["']/gu, "") === "params")) { violations.push(`${relativePath}: fleet method entries must declare a validated params shape`); return []; }
    const values = Object.fromEntries(element.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = property.name.getText(file).replace(/["']/gu, "");
      if (ts.isStringLiteral(property.initializer)) return [[name, property.initializer.text]];
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return [[name, true]];
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return [[name, false]];
      return [];
    }));
    return variableName === "fleetProtocolMethods" ? [{ method: values.method }] : [{ method: values.method, requiresRepo: values.requiresRepo }];
  });
}

function read(root, relativePath, violations) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) { violations.push(`${relativePath}: required W3 protocol authority is missing`); return ""; }
  return readFileSync(absolute, "utf8");
}

function main() {
  const violations = evaluateApiContractRegistry();
  if (violations.length > 0) { console.error("API contract registry check failed:"); for (const violation of violations) console.error(`- ${violation}`); process.exitCode = 1; }
  else console.log("API contract registry check passed: the exact W3 daemon RPC catalog is transport-bound and capability-fallback free.");
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
