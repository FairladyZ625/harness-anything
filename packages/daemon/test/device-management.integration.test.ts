// harness-test-tier: integration
// dec_F01770FD0DCF72683B7C4C7A47/CH5–CH7: one person's independently revocable devices.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { AccessAdminService, type AccessAdminRequest } from "../src/access-admin-service.ts";
import { keycloakNodeRegistry } from "../src/fleet-center-admission.ts";
import { KeycloakPolicyAdapter, type KeycloakNode } from "../src/keycloak-policy-adapter.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { fakeKeycloak, keycloakUserRoot, keycloakUrl, keycloakRealm } from "./keycloak.fixtures.ts";

test("owners rename, pause, reapprove, remove and globally revoke versioned devices without transferring them", async (t) => {
  const user = keycloakUserRoot(),
    keycloak = fakeKeycloak();
  t.after(user.cleanup);
  keycloak.account("alice");
  keycloak.account("bob");
  const oidc = new OidcSessionService(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch }),
    run = (request: AccessAdminRequest) => admin.run({ operationId: randomUUID(), ...request }),
    adapter = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      keycloak.fetch,
    ),
    registry = keycloakNodeRegistry(
      async () => ({ url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" }),
      keycloak.fetch,
    ),
    read = async (id: string) => (await adapter.readNode("center-token", id))!,
    devices = async () => (await run({ operation: "device-list" })).nodes as KeycloakNode[];
  for (const [nodeId, personId] of [
    ["A", "alice"],
    ["B", "alice"],
    ["C", "bob"],
  ]) {
    const reply = await run({
      operation: "node-register",
      nodeId,
      personId,
      systemName: `${nodeId}-system`,
      platform: "linux",
      displayName: `${nodeId}-display`,
      credentialFile: path.join(user.root, `${nodeId}.credential`),
    });
    assert.equal(reply.ok, true);
    keycloak.interactiveSession(personId!, nodeId!, keycloakUrl, `device-${nodeId}`);
  }
  user.signIn("alice", []);
  assert.deepEqual(
    (await devices()).map((node) => node.nodeId),
    ["A", "B"],
  );
  await assert.rejects(run({ operation: "device-pause", nodeId: "C", expectedVersion: "1" }), {
    code: "authorization_denied",
  });
  const original = await read("A"),
    competing = await Promise.all([
      run({ operation: "device-rename", nodeId: "A", displayName: "工作机 A", expectedVersion: "1" }),
      run({ operation: "device-rename", nodeId: "A", displayName: "stale", expectedVersion: "1" }),
    ]);
  assert.deepEqual(
    competing.map((reply) => reply.outcome),
    ["applied", "version_conflict"],
  );
  assert.deepEqual(await read("A"), { ...original, displayName: "工作机 A", revision: 2 });
  assert.equal((await run({ operation: "device-pause", nodeId: "A", expectedVersion: "2" })).ok, true);
  assert.equal(await registry.nodeOwner("A"), null);
  assert.equal(await registry.nodeOwner("B"), "alice");
  assert.equal((await read("A")).revocation, "complete");
  const introspect = async (token: string) =>
    (await (
      await keycloak.fetch(`${keycloakUrl}/realms/harness/protocol/openid-connect/token/introspect`, {
        method: "POST",
        body: new URLSearchParams({ client_id: "harness-center", token }),
      })
    ).json()) as { active: boolean };
  assert.equal((await introspect("device-A")).active, false);
  assert.equal((await introspect("device-B")).active, true);
  assert.equal((await run({ operation: "device-resume", nodeId: "A", expectedVersion: "3" })).ok, true);
  assert.equal((await introspect("device-A")).active, false, "resuming cannot revive the old session");
  keycloak.interactiveSession("alice", "A", keycloakUrl, "reapproved-A");
  assert.equal((await introspect("reapproved-A")).active, true);
  assert.equal((await run({ operation: "device-remove", nodeId: "A", expectedVersion: "4" })).ok, true);
  assert.equal((await read("A")).state, "removed");
  assert.equal((await introspect("reapproved-A")).active, false);
  await assert.rejects(run({ operation: "device-resume", nodeId: "A", expectedVersion: "5" }), {
    code: "device_removed",
  });
  user.signIn("person-admin");
  await assert.rejects(run({ operation: "node-register", nodeId: "A", personId: "bob", expectedVersion: "5" }), {
    code: "device_already_registered",
  });
  user.signIn("alice", []);
  const list = await run({ operation: "device-list" });
  assert.equal((await run({ operation: "device-logout-all", expectedVersion: String(list.version) })).ok, true);
  assert.equal((await read("A")).state, "removed");
  assert.equal((await read("B")).state, "paused");
  assert.equal((await introspect("device-B")).active, false);
  assert.equal((await introspect("device-C")).active, true);
});

test("revocation failure blocks the device before settlement, and an explicit new request can finish it", async (t) => {
  const user = keycloakUserRoot(),
    keycloak = fakeKeycloak();
  t.after(user.cleanup);
  keycloak.account("alice");
  keycloak.node("A", "alice");
  keycloak.interactiveSession("alice", "A", keycloakUrl, "device-A");
  user.signIn("alice", []);
  let fail = true;
  const fetchPort: typeof fetch = (input, init) =>
      fail && init?.method === "DELETE" && String(input).includes("/consents/")
        ? Promise.resolve(new Response(null, { status: 503 }))
        : keycloak.fetch(input, init),
    admin = new AccessAdminService(new OidcSessionService(user.root, { fetch: fetchPort }), user.root, {
      fetch: fetchPort,
    }),
    operationId = randomUUID();
  await assert.rejects(admin.run({ operationId, operation: "device-pause", nodeId: "A", expectedVersion: "1" }), {
    code: "keycloak_admin_rejected",
  });
  const pending = (await admin.run({ operation: "device-list" })).nodes as KeycloakNode[];
  assert.deepEqual([pending[0]!.state, pending[0]!.revocation, pending[0]!.revision], ["paused", "pending", 2]);
  await assert.rejects(
    admin.run({ operationId: randomUUID(), operation: "device-resume", nodeId: "A", expectedVersion: "2" }),
    { code: "access_operation_unsettled" },
  );
  fail = false;
  assert.equal(
    (await admin.run({ operationId: randomUUID(), operation: "device-pause", nodeId: "A", expectedVersion: "2" })).ok,
    true,
  );
  assert.equal(((await admin.run({ operation: "device-list" })).nodes as KeycloakNode[])[0]!.revocation, "complete");
});

test("real center CLI lists and changes only the current person's versioned devices", async (t) => {
  const user = keycloakUserRoot(),
    served = await serveKeycloak();
  served.bind(user.root);
  served.keycloak.account("alice");
  served.keycloak.node("A", "alice");
  served.keycloak.node("B", "alice");
  served.keycloak.node("C", "bob");
  user.signIn("alice", []);
  const oidc = new OidcSessionService(user.root),
    host = await openDaemonHost({ userRoot: user.root, daemonId: "device-cli", oidc });
  const transport = createUnixSocketTransportServer({
    daemonId: "device-cli",
    socketPath: localUserDaemonEndpoint(user.root, "device-cli"),
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({
        host,
        build: { commit: null },
        authContext,
        emit,
        sessionPrincipal: async () => (await oidc.bind({ transportKind: "unix-socket" })).oidcPrincipal,
      }),
  });
  await transport.start();
  t.after(async () => {
    await transport.stop();
    await host.close();
    await served.close();
    user.cleanup();
  });
  const invoke = async (operation: string, flags: string[] = []) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
    const child = spawn(
      process.execPath,
      [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        user.root,
        "--json",
        "bootstrap",
        "--operation",
        operation,
        ...flags,
      ],
      {
        env: { ...env, HARNESS_DAEMON_USER_ROOT: user.root, HARNESS_DAEMON_ID: "device-cli" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    assert.equal(code, 0, stdout + stderr);
    return JSON.parse(stdout);
  };
  const listed = await invoke("device-list");
  assert.deepEqual(
    listed.nodes.map((node: KeycloakNode) => node.nodeId),
    ["A", "B"],
  );
  for (const [operation, version] of [
    ["device-pause", "1"],
    ["device-resume", "2"],
    ["device-remove", "3"],
  ]) {
    const receipt = await invoke(operation!, [
      "--node-id",
      "A",
      "--expected-version",
      version!,
      "--operation-id",
      randomUUID(),
    ]);
    assert.equal(receipt.outcome, "applied");
  }
  const final = await invoke("device-list");
  assert.deepEqual(
    final.nodes.map((node: KeycloakNode) => [node.nodeId, node.state]),
    [
      ["A", "removed"],
      ["B", "active"],
    ],
  );
});
