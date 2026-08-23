// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateApiContractRegistry } from "./check-api-contract-registry.mjs";

test("W3 API registry accepts the exact transport-bound daemon catalog", () => withFixture((root) => {
  assert.deepEqual(evaluateApiContractRegistry(root), []);
}));

test("W3 API registry rejects an unregistered compatibility method", () => withFixture((root) => {
  const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
  writeFileSync(file, validRegistry().replace("  { method: \"repo.task.run\"", "  { method: \"repo.compat.run\", requiresRepo: true },\n  { method: \"repo.task.run\""));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /method catalog must equal/u);
}));

test("W3 API registry rejects repo routing that is not repo-scoped", () => withFixture((root) => {
  const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
  writeFileSync(file, validRegistry().replace('{ method: "repo.task.run", requiresRepo: true }', '{ method: "repo.task.run", requiresRepo: false }'));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /method catalog must equal/u);
}));

test("W3 API registry rejects an undeclared fleet RPC method", () => withFixture((root) => {
  const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
  writeFileSync(file, validRegistry().replace('  { id: "daemon.fleet.doc.sync"', '  { id: "daemon.fleet.compat.run", phase: "Fleet-Wiring", method: "daemon.fleet.compat.run", requiresRepo: false, params: shape({ payload: shape({}) }) },\n  { id: "daemon.fleet.doc.sync"'));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /fleet method catalog must equal/u);
}));

test("W3 API registry rejects a fleet method without a validated params shape", () => withFixture((root) => {
  const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
  writeFileSync(file, validRegistry().replace(', params: shape({ payload: shape({ conflictId: "string" }) })', ""));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /fleet method entries must declare a validated params shape/u);
}));

test("W3 API registry rejects restoration of the retired task route authority", () => withFixture((root) => {
  write(root, "packages/application/src/task-write-route-policy.ts", "export const restored = true;\n");
  assert.match(evaluateApiContractRegistry(root).join("\n"), /W3-retired API\/capability authority/u);
}));

test("W3 API registry rejects loss of payload self-report filtering", () => withFixture((root) => {
  write(root, "packages/daemon/src/repository-dispatch.ts", validRepositoryDispatch().replace(', "occurredAt"', ""));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /missing transport-bound RepoCell authority token occurredAt/u);
}));

test("W3 API registry follows a renamed transport-authority module", () => withFixture((root) => {
  renameSync(path.join(root, "packages/daemon/src/transport-binding.ts"), path.join(root, "packages/daemon/src/renamed-authority.ts"));
  write(root, "packages/daemon/src/transport-composition.ts", validHostComposition().replace("./transport-binding.ts", "./renamed-authority.ts"));
  assert.deepEqual(evaluateApiContractRegistry(root), []);
}));

function withFixture(run) { const root = mkdtempSync(path.join(tmpdir(), "w3-api-registry-")); try {
  write(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts", validRegistry());
  write(root, "packages/daemon/src/protocol/json-rpc-server.ts", validServer());
  write(root, "packages/daemon/src/daemon-host.ts", 'export { openDaemonHost } from "./transport-composition.ts";\n');
  write(root, "packages/daemon/src/transport-composition.ts", validHostComposition());
  write(root, "packages/daemon/src/transport-binding.ts", validTransportBinding());
  write(root, "packages/daemon/src/mode-admission.ts", '/** @daemon-transport-authority */\nexport function admit(auth) { return auth.assignmentBinding; }\n');
  write(root, "packages/daemon/src/repository-dispatch.ts", validRepositoryDispatch());
  write(root, "packages/daemon/src/transport/auth-context.ts", 'export type DaemonTransportKind = "unix-socket"; export interface Auth { unixSocketOwnerBoundary: unknown; assignmentBinding: { nodeId: string; assignmentId: string }; }\n');
  run(root);
} finally { rmSync(root, { recursive: true, force: true }); } }
function write(root, relative, body) { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
function validRegistry() { return `export const daemonProtocolMethods = Object.freeze([\n  { method: "protocol.hello", requiresRepo: false },\n  { method: "daemon.status", requiresRepo: false },\n  { method: "daemon.stop", requiresRepo: false },\n  { method: "daemon.repo.bootstrap", requiresRepo: false },\n  { method: "daemon.repo.register", requiresRepo: false },\n  { method: "daemon.repo.unregister", requiresRepo: false },\n  { method: "repo.task.run", requiresRepo: true }\n]);\nexport const fleetProtocolMethods = Object.freeze([\n  { id: "daemon.fleet.center.start", phase: "Fleet-Wiring", method: "daemon.fleet.center.start", requiresRepo: false, params: shape({ payload: shape({ port: "number" }) }) },\n  { id: "daemon.fleet.edge.sync", phase: "Fleet-Wiring", method: "daemon.fleet.edge.sync", requiresRepo: false, params: shape({ payload: shape({ host: "string" }) }) },\n  { id: "daemon.fleet.task.run", phase: "Fleet-Wiring", method: "daemon.fleet.task.run", requiresRepo: false, params: shape({ payload: shape({ action: "json" }) }) },\n  { id: "daemon.fleet.doc.sync", phase: "Fleet-Wiring", method: "daemon.fleet.doc.sync", requiresRepo: false, params: shape({ payload: shape({ workspaceRoot: "string" }) }) },\n  { id: "daemon.fleet.conflict.exit", phase: "Fleet-Wiring", method: "daemon.fleet.conflict.exit", requiresRepo: false, params: shape({ payload: shape({ conflictId: "string" }) }) }\n]);\n`; }
function validServer() { return `jsonRpcMethodContracts.some(() => true); request.method === "protocol.hello"; if (!handshaken) fail(); request.method === "daemon.status"; request.method === "daemon.stop"; request.method === "daemon.repo.bootstrap"; request.method === "daemon.repo.register"; request.method === "daemon.repo.unregister"; options.host.run(repo, action, options.authContext);\n`; }
function validHostComposition() { return `/** @daemon-transport-authority */
import { binding } from "./transport-binding.ts";
import { admit } from "./mode-admission.ts";
import { run } from "./repository-dispatch.ts";
export function openDaemonHost() { const cells = new Map<string, RepoCell>(); return { cells, binding, admit, run }; }
`; }
function validTransportBinding() { return `/** @daemon-transport-authority */
export function binding(auth) { auth.assignmentBinding; ({ kind: "assignment" }); makeTransportDerivedIdentityProvider(); return { actor: true, source: "local" }; }
`; }
function validRepositoryDispatch() { return `/** @daemon-transport-authority */
export function run() { return ["root", "canonicalRoot", "workspaceId", "expectedRevision", "eventId", "occurredAt"]; }
`; }
