// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateApiContractRegistry } from "./check-api-contract-registry.mjs";

test("W3 API registry accepts the exact transport-bound daemon catalog", () =>
  withFixture((root) => {
    assert.deepEqual(evaluateApiContractRegistry(root), []);
  }));

test("W3 API registry rejects an unregistered compatibility method", () =>
  withFixture((root) => {
    const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
    writeFileSync(
      file,
      validRegistry().replace(
        '  { method: "repo.task.run"',
        '  { method: "repo.compat.run", requiresRepo: true },\n  { method: "repo.task.run"',
      ),
    );
    assert.match(evaluateApiContractRegistry(root).join("\n"), /method catalog must equal/u);
  }));

test("W3 API registry rejects repo routing that is not repo-scoped", () =>
  withFixture((root) => {
    const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
    writeFileSync(
      file,
      validRegistry().replace(
        '{ method: "repo.task.run", requiresRepo: true }',
        '{ method: "repo.task.run", requiresRepo: false }',
      ),
    );
    assert.match(evaluateApiContractRegistry(root).join("\n"), /method catalog must equal/u);
  }));

test("W3 API registry rejects an undeclared fleet RPC method", () =>
  withFixture((root) => {
    const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
    writeFileSync(
      file,
      validRegistry().replace(
        '  { id: "daemon.fleet.doc.sync"',
        '  { id: "daemon.fleet.compat.run", phase: "Fleet-Wiring", method: "daemon.fleet.compat.run", requiresRepo: false, params: shape({ payload: shape({}) }) },\n  { id: "daemon.fleet.doc.sync"',
      ),
    );
    assert.match(evaluateApiContractRegistry(root).join("\n"), /fleet method catalog must equal/u);
  }));

test("W3 API registry rejects a fleet method without a validated params shape", () =>
  withFixture((root) => {
    const file = path.join(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts");
    writeFileSync(file, validRegistry().replace(', params: shape({ payload: shape({ conflictId: "string" }) })', ""));
    assert.match(
      evaluateApiContractRegistry(root).join("\n"),
      /fleet method entries must declare a validated params shape/u,
    );
  }));

test("W3 API registry rejects restoration of the retired task route authority", () =>
  withFixture((root) => {
    write(root, "packages/application/src/task-write-route-policy.ts", "export const restored = true;\n");
    assert.match(evaluateApiContractRegistry(root).join("\n"), /W3-retired API\/capability authority/u);
  }));

test("W3 API registry rejects loss of payload self-report filtering", () =>
  withFixture((root) => {
    write(root, "packages/daemon/src/repository-dispatch.ts", validRepositoryDispatch().replace(', "occurredAt"', ""));
    assert.match(
      evaluateApiContractRegistry(root).join("\n"),
      /missing transport-bound RepoCell authority token occurredAt/u,
    );
  }));

test("W3 API registry follows a renamed transport-authority module", () =>
  withFixture((root) => {
    renameSync(
      path.join(root, "packages/daemon/src/transport-binding.ts"),
      path.join(root, "packages/daemon/src/renamed-authority.ts"),
    );
    write(
      root,
      "packages/daemon/src/transport-composition.ts",
      validHostComposition().replace("./transport-binding.ts", "./renamed-authority.ts"),
    );
    assert.deepEqual(evaluateApiContractRegistry(root), []);
  }));

for (const [label, before, after] of [
  ["OIDC verification", "await oidc.bind(auth)", "auth"],
  ["assignment binding call", "return nodeOwnerBinding(auth)", "return localDefaultBinding(auth, executor)"],
  ["local expiry guard", "auth.oidcPrincipal.expiresAt <= Date.now()", "false"],
  ["local person binding", "personId: auth.oidcPrincipal.personId", 'personId: "client-person"'],
  ["Keycloak session connection", "withSessionEnvironment({", "unboundSession({"],
  ["Keycloak session credential", "accessToken: auth.oidcPrincipal.accessToken", 'accessToken: "client-token"'],
  ["registered owner guard", "owner.nodeId !== assignment.nodeId", "false"],
  ["authenticated owner source", "owner = auth.nodePrincipal", "owner = clientOwner"],
  ["authenticated assignment source", "assignment = auth.assignmentBinding!", "assignment = clientAssignment"],
  ["registered person binding", "personId: owner.personId", 'personId: "client-person"'],
  ["assignment provenance", "nodeId: owner.nodeId", 'nodeId: "client-node"'],
  ["node Keycloak connection", "auth.keycloakCenter()", "otherAuthority()"],
  ["center registry connection", "keycloakNodeRegistry(context.keycloakCenter)", "otherRegistry()"],
  ["node credential validation", "adapter.authenticateNode(nodeId, credential)", "adapter.acceptNode(nodeId)"],
  ["registered owner lookup", "adapter.readNode(token, nodeId)", "adapter.readClientOwner(nodeId)"],
]) {
  test(`API registry rejects loss of ${label} even with the old syntax in prose`, () =>
    withFixture((root) => {
      for (const [file, source] of [
        ["transport-composition.ts", validHostComposition()],
        ["transport-binding.ts", validTransportBinding()],
        ["node-registry.ts", validNodeRegistry()],
      ]) {
        write(root, `packages/daemon/src/${file}`, source.replace(before, after) + `\n// ${before}\n`);
      }
      assert.match(evaluateApiContractRegistry(root).join("\n"), /missing authenticated principal wiring/u);
    }));
}

test("API registry rejects a restored roster branch after OIDC binding", () =>
  withFixture((root) => {
    write(
      root,
      "packages/daemon/src/transport-binding.ts",
      validTransportBinding().replace(
        "return localDefaultBinding(auth, executor);\n}",
        "return rosterBinding(auth);\n}",
      ),
    );
    assert.match(evaluateApiContractRegistry(root).join("\n"), /local ingress must end at authenticated/u);
  }));

for (const field of ["actor", "root", "source"]) {
  test(`API registry rejects client ${field} injection`, () =>
    withFixture((root) => {
      write(
        root,
        "packages/daemon/src/repository-dispatch.ts",
        validRepositoryDispatch() + `\nexport const injected = payload.${field};\n`,
      );
      assert.match(evaluateApiContractRegistry(root).join("\n"), /must bind actor\/root\/source/u);
    }));
}

for (const [label, specifier] of [
  ["relative source path", "./unsafe-authority.ts"],
  ["workspace package identity", "@harness-anything/daemon/internal/unsafe-authority"],
]) {
  test(`W3 API registry follows ${label} to reject payload-derived authority`, () =>
    withFixture((root) => {
      write(
        root,
        "packages/daemon/src/unsafe-authority.ts",
        "/** @daemon-transport-authority */\nexport const unsafe = payload.root;\n",
      );
      write(
        root,
        "packages/daemon/src/daemon-host.ts",
        `import { unsafe } from "${specifier}";\nexport { openDaemonHost } from "./transport-composition.ts";\nexport { unsafe };\n`,
      );
      assert.match(evaluateApiContractRegistry(root).join("\n"), /must bind actor\/root\/source/u);
    }));
}

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "w3-api-registry-"));
  try {
    write(
      root,
      "packages/daemon/package.json",
      JSON.stringify({
        name: "@harness-anything/daemon",
        exports: { "./internal/unsafe-authority": "./src/unsafe-authority.ts" },
      }),
    );
    write(root, "packages/daemon/src/protocol/daemon-protocol.contract.ts", validRegistry());
    write(root, "packages/daemon/src/protocol/json-rpc-server.ts", validServer());
    write(root, "packages/daemon/src/daemon-host.ts", 'export { openDaemonHost } from "./transport-composition.ts";\n');
    write(root, "packages/daemon/src/transport-composition.ts", validHostComposition());
    write(root, "packages/daemon/src/transport-binding.ts", validTransportBinding());
    write(
      root,
      "packages/daemon/src/mode-admission.ts",
      "/** @daemon-transport-authority */\nexport function admit(auth) { return auth.assignmentBinding; }\n",
    );
    write(root, "packages/daemon/src/repository-dispatch.ts", validRepositoryDispatch());
    write(root, "packages/daemon/src/node-registry.ts", validNodeRegistry());
    write(
      root,
      "packages/daemon/src/transport/auth-context.ts",
      'export type DaemonTransportKind = "unix-socket"; export interface Auth { unixSocketOwnerBoundary: unknown; assignmentBinding: { nodeId: string; assignmentId: string }; }\n',
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function write(root, relative, body) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
function validRegistry() {
  return `export const daemonProtocolMethods = Object.freeze([\n  { method: "protocol.hello", requiresRepo: false },\n  { method: "daemon.status", requiresRepo: false },\n  { method: "daemon.stop", requiresRepo: false },\n  { method: "daemon.repo.bootstrap", requiresRepo: false },\n  { method: "daemon.rbac.manage", requiresRepo: false },\n  { method: "daemon.repo.register", requiresRepo: false },\n  { method: "daemon.repo.update", requiresRepo: false },\n  { method: "daemon.repo.backup", requiresRepo: false },\n  { method: "daemon.repo.restoreDrill", requiresRepo: false },\n  { method: "daemon.repo.unbind", requiresRepo: false },\n  { method: "daemon.repo.purge", requiresRepo: false },\n  { method: "daemon.connection.register", requiresRepo: false },\n  { method: "daemon.connection.update", requiresRepo: false },\n  { method: "daemon.connection.unregister", requiresRepo: false },\n  { method: "daemon.connection.probe", requiresRepo: false },\n  { method: "repo.task.run", requiresRepo: true },\n  { method: "repo.task.read", requiresRepo: true }\n]);\nexport const fleetProtocolMethods = Object.freeze([\n  { id: "daemon.fleet.center.start", phase: "Fleet-Wiring", method: "daemon.fleet.center.start", requiresRepo: false, params: shape({ payload: shape({ port: "number" }) }) },\n  { id: "daemon.fleet.edge.sync", phase: "Fleet-Wiring", method: "daemon.fleet.edge.sync", requiresRepo: false, params: shape({ payload: shape({ host: "string" }) }) },\n  { id: "daemon.fleet.task.run", phase: "Fleet-Wiring", method: "daemon.fleet.task.run", requiresRepo: false, params: shape({ payload: shape({ action: "json" }) }) },\n  { id: "daemon.fleet.doc.sync", phase: "Fleet-Wiring", method: "daemon.fleet.doc.sync", requiresRepo: false, params: shape({ payload: shape({ workspaceRoot: "string" }) }) },\n  { id: "daemon.fleet.conflict.exit", phase: "Fleet-Wiring", method: "daemon.fleet.conflict.exit", requiresRepo: false, params: shape({ payload: shape({ conflictId: "string" }) }) }\n]);\n`;
}
function validServer() {
  return `jsonRpcMethodContracts.some(() => true); request.method === "protocol.hello"; if (!handshaken) fail(); request.method === "daemon.status"; request.method === "daemon.stop"; request.method === "daemon.repo.bootstrap"; request.method === "daemon.rbac.manage"; case "daemon.repo.register": case "daemon.repo.backup": case "daemon.repo.restoreDrill": case "daemon.repo.unbind": case "daemon.repo.purge": case "daemon.connection.probe": options.host.run(repo, action, options.authContext);\n`;
}
function validHostComposition() {
  return `/** @daemon-transport-authority */
import { binding, binding as deriveBinding } from "./transport-binding.ts";
import { admit } from "./mode-admission.ts";
import { run } from "./repository-dispatch.ts";
import { keycloakNodeRegistry } from "./node-registry.ts";
export function openDaemonHost() {
  const cells = new Map<string, RepoCell>();
  const hostBinding = async (rootDir, auth, executor) => deriveBinding(rootDir, { ...(await oidc.bind(auth)), keycloakCenter }, executor);
  const nodes = keycloakNodeRegistry(context.keycloakCenter);
  return { cells, binding, admit, run, hostBinding, nodes };
}
`;
}
function validTransportBinding() {
  return `/** @daemon-transport-authority */
export function localDefaultBinding(auth, executor) {
  if (!auth.oidcPrincipal || auth.oidcPrincipal.expiresAt <= Date.now()) throw new Error("authentication_required");
  return withSessionEnvironment({ actor: { principal: { personId: auth.oidcPrincipal.personId }, executor }, source: "local" }, auth);
}
function withSessionEnvironment(binding, auth) {
  return { ...binding, keycloakAuthorization: { session: { accessToken: auth.oidcPrincipal.accessToken } } };
}
function nodeOwnerBinding(auth) {
  const assignment = auth.assignmentBinding!, owner = auth.nodePrincipal;
  if (!owner || owner.nodeId !== assignment.nodeId || !auth.keycloakCenter) throw new Error("authentication_required");
  return { actor: { principal: { personId: owner.personId }, executor: null },
    source: { kind: "assignment", nodeId: owner.nodeId, assignmentId: assignment.assignmentId },
    keycloakAuthorization: { center: auth.keycloakCenter() } };
}
export function binding(rootDir, auth, executor) {
  if (auth.assignmentBinding) return nodeOwnerBinding(auth);
  return localDefaultBinding(auth, executor);
}
`;
}
function validNodeRegistry() {
  return `export function keycloakNodeRegistry(center) {
    const open = async () => ({ adapter, token: (await center()).accessToken });
    return {
      authenticate: async (nodeId, credential) => (await open()).adapter.authenticateNode(nodeId, credential),
      nodeOwner: async (nodeId) => { const { adapter, token } = await open(); return (await adapter.readNode(token, nodeId))?.personId || null; }
    };
  }`;
}
function validRepositoryDispatch() {
  return `/** @daemon-transport-authority */
export function run() { return ["root", "canonicalRoot", "workspaceId", "expectedRevision", "eventId", "occurredAt"]; }
`;
}
