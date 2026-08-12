// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("W3 API registry rejects restoration of the retired task route authority", () => withFixture((root) => {
  write(root, "packages/application/src/task-write-route-policy.ts", "export const restored = true;\n");
  assert.match(evaluateApiContractRegistry(root).join("\n"), /W3-retired API\/capability authority/u);
}));

test("W3 API registry rejects loss of payload self-report filtering", () => withFixture((root) => {
  write(root, "packages/daemon/src/daemon-host.ts", validHost().replace(', "occurredAt"', ""));
  assert.match(evaluateApiContractRegistry(root).join("\n"), /missing transport-bound RepoCell authority token occurredAt/u);
}));

function withFixture(run) { const root = mkdtempSync(path.join(tmpdir(), "w3-api-registry-")); try {
  write(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts", validRegistry());
  write(root, "packages/daemon/src/protocol/json-rpc-server.ts", validServer());
  write(root, "packages/daemon/src/daemon-host.ts", validHost());
  write(root, "packages/daemon/src/transport/auth-context.ts", 'export type DaemonTransportKind = "unix-socket"; export interface Auth { unixSocketOwnerBoundary: unknown; assignmentBinding: { nodeId: string; assignmentId: string }; }\n');
  run(root);
} finally { rmSync(root, { recursive: true, force: true }); } }
function write(root, relative, body) { const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); }
function validRegistry() { return `export const daemonProtocolMethods = Object.freeze([\n  { method: "protocol.hello", requiresRepo: false },\n  { method: "daemon.status", requiresRepo: false },\n  { method: "daemon.repo.bootstrap", requiresRepo: false },\n  { method: "daemon.repo.register", requiresRepo: false },\n  { method: "daemon.repo.unregister", requiresRepo: false },\n  { method: "repo.task.run", requiresRepo: true }\n]);\n`; }
function validServer() { return `jsonRpcMethodContracts.some(() => true); request.method === "protocol.hello"; if (!handshaken) fail(); request.method === "daemon.status"; request.method === "daemon.repo.bootstrap"; request.method === "daemon.repo.register"; request.method === "daemon.repo.unregister"; options.host.run(repo, action, options.authContext);\n`; }
function validHost() { return `const cells = new Map<string, RepoCell>(); auth.assignmentBinding; ({ kind: "assignment" }); makeTransportDerivedIdentityProvider(); ["actor", "root", "canonicalRoot", "source", "workspaceId", "expectedRevision", "eventId", "occurredAt"];\n`; }
