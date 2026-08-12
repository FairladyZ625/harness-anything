#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const expectedMethods = Object.freeze([
  { method: "protocol.hello", requiresRepo: false },
  { method: "daemon.status", requiresRepo: false },
  { method: "daemon.repo.bootstrap", requiresRepo: false },
  { method: "daemon.repo.register", requiresRepo: false },
  { method: "daemon.repo.unregister", requiresRepo: false },
  { method: "repo.task.run", requiresRepo: true }
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

export function evaluateApiContractRegistry(root = process.cwd()) {
  const violations = [];
  const registryPath = "packages/daemon/src/protocol/daemon-protocol.contract.ts";
  const serverPath = "packages/daemon/src/protocol/json-rpc-server.ts";
  const hostPath = "packages/daemon/src/daemon-host.ts";
  const authPath = "packages/daemon/src/transport/auth-context.ts";
  const registry = read(root, registryPath, violations), server = read(root, serverPath, violations);
  const host = read(root, hostPath, violations), auth = read(root, authPath, violations);
  if (registry) {
    const methods = collectMethodContracts(registry, registryPath, violations);
    if (JSON.stringify(methods) !== JSON.stringify(expectedMethods)) {
      violations.push(`${registryPath}: method catalog must equal ${JSON.stringify(expectedMethods)}; found ${JSON.stringify(methods)}`);
    }
    if (/apiRouteContracts|capabilit|notifications?|admin\.(?:people|rbac)/u.test(registry)) {
      violations.push(`${registryPath}: retired GUI/API capability authority must not feed the W3 daemon protocol`);
    }
  }
  if (server) {
    for (const token of ["jsonRpcMethodContracts.some", "request.method === \"protocol.hello\"", "if (!handshaken)",
      "request.method === \"daemon.status\"", "request.method === \"daemon.repo.bootstrap\"",
      "request.method === \"daemon.repo.register\"", "request.method === \"daemon.repo.unregister\""]) {
      if (!server.includes(token)) violations.push(`${serverPath}: missing protocol closure token ${token}`);
    }
    if (!/options\.host\.run\(repo,\s*action[^,]*,\s*options\.authContext\)/u.test(server)) violations.push(`${serverPath}: repo.task.run must pass transport authentication to the daemon host`);
    if (/notifications?|admin\.(?:people|rbac)|fallback|capabilit/iu.test(server)) violations.push(`${serverPath}: retired notification/admin/capability fallback must not return`);
  }
  if (host) {
    for (const token of ["new Map<string, RepoCell>()", "auth.assignmentBinding", "kind: \"assignment\"", "makeTransportDerivedIdentityProvider",
      "actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt"]) {
      if (!host.includes(token)) violations.push(`${hostPath}: missing transport-bound RepoCell authority token ${token}`);
    }
    if (/payload\.(?:actor|root|source|workspaceId)|HARNESS_ACTOR|local fallback/iu.test(host)) {
      violations.push(`${hostPath}: daemon ingress must bind actor/root/source instead of trusting payload or fallback identity`);
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

function collectMethodContracts(source, relativePath, violations) {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "daemonProtocolMethods") initializer = declaration.initializer;
    }
  }
  if (initializer && ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)
    && initializer.expression.expression.getText(file) === "Object" && initializer.expression.name.text === "freeze") initializer = initializer.arguments[0];
  if (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    violations.push(`${relativePath}: daemonProtocolMethods must be one frozen contract array literal`);
    return [];
  }
  return initializer.elements.flatMap((element) => {
    if (!ts.isObjectLiteralExpression(element)) { violations.push(`${relativePath}: method entries must be object literals`); return []; }
    const values = Object.fromEntries(element.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = property.name.getText(file).replace(/["']/gu, "");
      if (ts.isStringLiteral(property.initializer)) return [[name, property.initializer.text]];
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return [[name, true]];
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return [[name, false]];
      return [];
    }));
    return [{ method: values.method, requiresRepo: values.requiresRepo }];
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
