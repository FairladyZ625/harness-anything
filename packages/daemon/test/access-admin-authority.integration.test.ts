// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { managedRbacReceiptJournal } from "../src/daemon-host/access-admin-state.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { keycloakRealm, keycloakSessionStore, keycloakUserRoot, serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { git, initRepo } from "./fleet-runtime-recovery.fixtures.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";
import { startDaemon, type RunningDaemon } from "../src/daemon-host/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("registered edges read only their current repository's member directory without a local Keycloak center", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-edge-member-directory-"))),
    userRoot = path.join(root, "center"),
    edgeUserRoot = path.join(root, "edge"),
    keyPath = path.join(root, "center.key"),
    certPath = path.join(root, "center.crt"),
    repoIds = ["repo-a", "repo-b"],
    nodeId = "edge-node";
  const owners = await fleetNodeOwners({ userRoot, owners: { [nodeId]: "repo-admin" }, repoIds, grantAll: false });
  const open: {
    host?: Awaited<ReturnType<typeof openDaemonHost>>;
    edge?: RunningDaemon;
  } = {};
  t.after(async () => {
    await open.edge?.stop();
    await open.host?.close();
    await owners.close();
    removeTempRepository(root);
  });
  for (const repoId of repoIds) {
    const canonicalRoot = path.join(root, `center-${repoId}`);
    mkdirSync(path.join(canonicalRoot, "harness"), { recursive: true });
    initRepo(canonicalRoot);
    writeFileSync(
      path.join(canonicalRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
    );
    git(canonicalRoot, "add", "harness");
    git(canonicalRoot, "commit", "-qm", "seed");
    registerBootstrappedDaemonRepo({ canonicalRoot, repoId, userRoot, createConvenienceLinks: false });
  }
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const session = createIdentitySession(userRoot);
  const host = await openDaemonHost({ userRoot, daemonId: "member-directory-center", oidc: session });
  open.host = host;
  await host.attachmentsSettled();

  owners.keycloak.account("repo-member");
  owners.keycloak.account("other-repo-member");
  const { provider, accessToken } = await session.center();
  await provider.syncBasePolicy(accessToken);
  const groups = await provider.readPolicyGroups(accessToken);
  for (const [groupId, resource, personId] of [
    ["admin", "repo-a", "repo-admin"],
    ["viewer", "repo-a", "repo-member"],
    ["viewer", "repo-b", "repo-admin"],
    ["contributor", "repo-b", "other-repo-member"],
  ] as const) {
    const userId = (await provider.findUserId(accessToken, personId))!;
    await provider.writeGrant(
      accessToken,
      { groupId, resource, userIds: [userId] },
      effectivePolicyGroupScopes(groups, groupId),
    );
  }
  owners.keycloak.account("center-operator");
  owners.keycloak.permit("center-operator", "repo-a", ["daemon-fleet-center-start"]);
  signInAt(userRoot, "center-operator");
  const listener = await host.fleet.startCenter(
    { port: 0, repoId: "repo-a", keyPath, certPath, quotaBytes: 64 * 1024 * 1024 },
    { transportKind: "unix-socket" },
  );
  assert.equal(listener.outcome, "applied");
  const machineCredential = owners.keycloak.node(nodeId, "repo-admin");
  const issuer = `${owners.url}/realms/${keycloakRealm}`,
    authority = { url: owners.url, realm: keycloakRealm, clientId: `harness-node-${nodeId}` },
    edgeRoot = (repoId: string) => path.join(root, `edge-${repoId}`);
  for (const repoId of repoIds) {
    const canonicalRoot = edgeRoot(repoId);
    mkdirSync(path.join(canonicalRoot, "harness"), { recursive: true });
    initRepo(canonicalRoot);
    writeFileSync(
      path.join(canonicalRoot, "harness/harness.yaml"),
      readFileSync(path.join(root, `center-${repoId}`, "harness/harness.yaml")),
    );
    writeFleetEdgeConfig(edgeUserRoot, repoId, {
      repoId,
      nodeId,
      host: "localhost",
      port: Number(listener.port),
      caPath: certPath,
      credential: machineCredential,
      quotaBytes: 1024,
      viewRoot: path.join(root, `view-${repoId}`),
    });
    registerBootstrappedDaemonRepo({
      canonicalRoot,
      repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    oidcCenterSelections(edgeUserRoot).write(canonicalRoot, { issuer, authority });
  }
  const edgeSession = createIdentitySession(edgeUserRoot);
  function signIn(personId: string): void {
    owners.keycloak.interactiveSession(personId, nodeId, owners.url);
    keycloakSessionStore(edgeUserRoot, issuer, keycloakRealm).write(
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer,
        authority,
        loginTarget: edgeRoot("repo-a"),
        accessToken: `token-${personId}`,
        subject: personId,
        personId,
        expiresAt: Date.now() + 3_600_000,
        roles: [],
      }),
    );
  }
  signIn("repo-admin");
  const running = await startDaemon({
    userRoot: edgeUserRoot,
    daemonId: "member-directory-edge",
    buildSupersessionEnabled: false,
  });
  assert.ok("stop" in running);
  open.edge = running;
  const read = (repoId: string, rootDir?: string) =>
    requestDaemonJsonRpcAt(
      running.endpoint,
      "daemon.rbac.manage",
      { operation: "repository-members", repoId, ...(rootDir === undefined ? {} : { rootDir }) },
      1000,
      15_000,
    );
  assert.equal((await edgeSession.requireSession(edgeRoot("repo-a"))).personId, "repo-admin");
  assert.equal(existsSync(path.join(edgeUserRoot, "rbac/config.json")), false);
  assert.deepEqual(await read("repo-a"), {
    ok: true,
    personId: "repo-admin",
    isRepoAdmin: true,
    canManageFleetNodes: false,
    members: [
      { personId: "repo-admin", username: "repo-admin" },
      { personId: "repo-member", username: "repo-member" },
    ],
  });
  assert.deepEqual(await read("repo-b", edgeRoot("repo-a")), {
    ok: true,
    personId: "repo-admin",
    isRepoAdmin: false,
    canManageFleetNodes: false,
    members: [],
  });
  signIn("repo-member");
  assert.deepEqual(await read("repo-a"), {
    ok: true,
    personId: "repo-member",
    isRepoAdmin: false,
    canManageFleetNodes: false,
    members: [],
  });
  for (const method of ["repo.agenda.read", "repo.works.briefs.read", "repo.workspace.scope.read"]) {
    const result = await requestDaemonJsonRpcAt(
      running.endpoint,
      method,
      {
        repo: { repoId: "repo-a" },
        payload: {
          scopePersonId: "repo-admin",
          ...(method === "repo.workspace.scope.read" ? { rootTaskId: "task-cross-member" } : {}),
        },
      },
      1_000,
      15_000,
    );
    assert.equal(result.ok, false, method);
    assert.equal(result.code, "authorization_denied", `${method}: ${String(result.rejectionExplanation)}`);
  }
  assert.equal(existsSync(path.join(edgeUserRoot, "rbac/config.json")), false);

  await t.test("Fleet retirement previews and confirms at the bound center", async () => {
    const target = "retirement-target",
      credential = owners.keycloak.node(target, "other-repo-member"),
      adminPersonId = "fleet-admin";
    owners.keycloak.account(adminPersonId);
    const adminUserId = (await provider.findUserId(accessToken, adminPersonId))!;
    for (const [groupId, resource] of [
      ["admin", "@fleet"],
      ["contributor", "repo-a"],
    ] as const)
      await provider.writeGrant(
        accessToken,
        { groupId, resource, userIds: [adminUserId] },
        effectivePolicyGroupScopes(groups, groupId),
      );
    const unregister = (
      params: { confirm?: boolean; expectedVersion?: string; operationId?: string; force?: boolean } = {},
      repoId = "repo-a",
      targetNodeId = target,
    ) =>
      requestDaemonJsonRpcAt(
        running.endpoint,
        "daemon.rbac.manage",
        {
          operation: "node-unregister",
          repoId,
          rootDir: path.join(root, "unregistered"),
          nodeId: targetNodeId,
          ...params,
        },
        1000,
        15_000,
      );
    const journal = managedRbacReceiptJournal(userRoot);
    signIn(adminPersonId);
    assert.equal((await read("repo-a")).canManageFleetNodes, true);
    const preview = await unregister();
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.dryRun, true);
    assert.equal(preview.nodeId, target);
    assert.equal(preview.expectedVersion, "1");
    assert.equal(await provider.authenticateNode(target, credential), true);
    assert.deepEqual(journal.read(), []);

    const confirmation = { confirm: true, expectedVersion: String(preview.expectedVersion) };
    for (const personId of ["repo-member", "repo-admin"]) {
      signIn(personId);
      assert.equal((await unregister()).code, "authorization_denied");
      assert.equal((await unregister(confirmation)).code, "authorization_denied");
    }
    assert.deepEqual(journal.read(), []);
    signIn(adminPersonId);
    assert.equal((await unregister({}, "repo-b")).code, "authorization_denied");
    assert.equal((await unregister({}, "unknown-repo")).code, "repo_namespace_unknown");
    assert.equal((await unregister({ confirm: true })).code, "access_request_invalid");
    assert.deepEqual(journal.read(), []);
    const conflict = await unregister({ ...confirmation, expectedVersion: "stale" });
    assert.equal(conflict.code, "version_conflict");
    assert.equal(conflict.currentVersion, preview.expectedVersion);
    assert.equal(await provider.authenticateNode(target, credential), true);

    const operationId = "edge-node-retirement";
    const receipt = await unregister({ ...confirmation, operationId });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.actor, adminPersonId);
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.outcome, "applied");
    assert.equal((await provider.readNode(accessToken, target))?.state, "removed");
    assert.equal((await provider.readNode(accessToken, nodeId))?.state, "active");
    assert.equal(await provider.authenticateNode(target, credential), false);
    assert.equal((await unregister({ ...confirmation, operationId })).code, "access_operation_settled");
    assert.deepEqual(
      journal
        .read()
        .map((line) => JSON.parse(line))
        .filter((row) => row.operationId === operationId)
        .map(({ actor, phase }) => ({ actor, phase })),
      [
        { actor: adminPersonId, phase: "intent" },
        { actor: adminPersonId, phase: "settled" },
      ],
    );
    assert.deepEqual(managedRbacReceiptJournal(edgeUserRoot).read(), []);

    const selfPreview = await unregister({}, "repo-a", nodeId);
    assert.equal(selfPreview.online, true);
    const selfConfirm = { confirm: true, expectedVersion: String(selfPreview.expectedVersion) };
    assert.equal((await unregister(selfConfirm, "repo-a", nodeId)).code, "node_busy");
    const selfReceipt = await unregister(
      { ...selfConfirm, force: true, operationId: "retire-sending-node" },
      "repo-a",
      nodeId,
    );
    assert.equal(selfReceipt.outcome, "applied", JSON.stringify(selfReceipt));
    assert.equal((await provider.readNode(accessToken, nodeId))?.state, "removed");
    assert.equal(await provider.authenticateNode(nodeId, machineCredential), false);
  });
});

async function keycloakFixture(t: TestContext, fleetGrant = true) {
  const server = await serveKeycloak(),
    realm = server.keycloak,
    user = keycloakUserRoot();
  server.bind(user.root);
  const session = createIdentitySession(user.root),
    host = await openDaemonHost({ userRoot: user.root, daemonId: "admin-authority", oidc: session }),
    center = await session.center();
  t.after(async () => {
    await host.close();
    await server.close();
    user.cleanup();
  });
  for (const person of ["requester", "policy-admin", "role-admin"]) realm.account(person);
  await center.provider.syncBasePolicy(center.accessToken);
  const groups = await center.provider.readPolicyGroups(center.accessToken),
    adminScopes = effectivePolicyGroupScopes(groups, "admin"),
    policyUserId = (await center.provider.findUserId(center.accessToken, "policy-admin"))!;
  // Use the actual group/grant materialization, not a substituted authorization result.
  for (const resource of fleetGrant ? ["@fleet", "repo-a"] : ["repo-a"])
    await center.provider.writeGrant(
      center.accessToken,
      { groupId: "admin", resource, userIds: [policyUserId] },
      adminScopes,
    );
  const run = async (request: Parameters<typeof host.manageRbac>[0], socketOwner = false) =>
    host.manageRbac(
      { rootDir: user.root, ...request },
      await session.bind({
        transportKind: "unix-socket",
        ...(socketOwner ? { unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0 } } : {}),
      }),
    );
  user.signIn("requester", []);
  // Socket-owner transport admits creating a request; it does not manufacture an approver grant.
  const ownerUid = process.getuid?.() ?? 0,
    created = await host.manageRbac(
      { rootDir: user.root, operation: "permission-request-create", groupId: "viewer", resource: "repo-a" },
      { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid } },
    ),
    request = created.request as { requestId: string; version: number };
  return { ...user, realm, session, run, request };
}

test("Keycloak policy admin without the realm role approves a request and lists groups and grants", async (t) => {
  const f = await keycloakFixture(t);
  f.signIn("policy-admin", []);
  assert.deepEqual((await f.session.requireSession()).roles, []);
  assert.equal((await f.session.bootstrapStatus()).required, false);
  const listed = await f.run({ operation: "permission-request-list" });
  assert.equal(listed.canDecide, true);
  assert.equal((listed.requests as unknown[]).length, 1);
  const settled = await f.run({
    operation: "permission-request-decide",
    requestId: f.request.requestId,
    requestVersion: f.request.version,
    decision: "approve",
  });
  assert.equal((settled.request as { state: string }).state, "approved");
  const center = await f.session.center();
  assert.equal(
    (
      await center.provider.authorizePerson({
        adminAccessToken: center.accessToken,
        personId: "requester",
        action: "repository-read",
        resource: { kind: "repository", repoId: "repo-a" },
      })
    ).outcome,
    "allowed",
  );
  for (const operation of ["group-list", "grant-list"]) assert.equal((await f.run({ operation })).ok, true);
});

test("Keycloak realm role without policy grants cannot manage access or approve a request", async (t) => {
  const f = await keycloakFixture(t);
  f.signIn("role-admin", ["access-admin"]);
  for (const operation of ["group-list", "grant-list"])
    await assert.rejects(f.run({ operation }, true), { code: "authorization_denied" });
  await assert.rejects(
    f.session.invite({
      username: "invited",
      personId: "invited",
      displayName: "Invited",
      email: "invited@example.invalid",
    }),
    { code: "authorization_denied" },
  );
  await assert.rejects(
    f.session.configureAuthority(async () => ({ ok: true }), f.root),
    { code: "authorization_denied" },
  );
  assert.equal((await f.run({ operation: "permission-request-list" })).canDecide, false);
  await assert.rejects(
    f.run({
      operation: "permission-request-decide",
      requestId: f.request.requestId,
      requestVersion: f.request.version,
      decision: "approve",
    }),
    { code: "authorization_denied" },
  );
  t.diagnostic("VERIFIED role-only: group-list/grant-list/approval=authorization_denied (policy).");
});

test("repository admin sees and approves only its repository requests without a fleet grant", async (t) => {
  const f = await keycloakFixture(t, false);
  f.signIn("policy-admin", []);
  assert.equal((await f.session.bootstrapStatus()).required, true);
  const listed = await f.run({ operation: "permission-request-list" }, true);
  assert.equal(listed.canDecide, true);
  assert.equal((listed.requests as unknown[]).length, 1);
  const decision = {
    operation: "permission-request-decide",
    requestId: f.request.requestId,
    requestVersion: f.request.version,
    decision: "approve",
  };
  for (const operation of ["group-list", "grant-list"])
    await assert.rejects(f.run({ operation }, true), { code: "authorization_denied" });
  const settled = await f.run(decision);
  assert.equal((settled.request as { state: string }).state, "approved");
  t.diagnostic("VERIFIED repository-only: canDecide=true; approval=allowed; global administration=denied.");
});

for (const decision of ["approve", "reject"] as const) {
  test(`socket ownership and a legacy realm role cannot ${decision} without a policy grant`, async (t) => {
    const f = await keycloakFixture(t);
    f.signIn("role-admin", ["access-admin"]);
    await assert.rejects(
      f.run(
        {
          operation: "permission-request-decide",
          requestId: f.request.requestId,
          requestVersion: f.request.version,
          decision,
        },
        true,
      ),
      { code: "authorization_denied" },
    );
    assert.equal((await f.run({ operation: "permission-request-list" }, true)).canDecide, false);
  });

  test(`repository approval scope cannot be spoofed to ${decision} another repository's request`, async (t) => {
    const f = await keycloakFixture(t, false);
    f.signIn("requester", []);
    const created = await f.run(
        { operation: "permission-request-create", groupId: "viewer", resource: "repo-b" },
        true,
      ),
      foreign = created.request as { requestId: string; version: number };
    f.signIn("policy-admin", []);
    const listed = await f.run({ operation: "permission-request-list" }, true);
    assert.deepEqual(
      (listed.requests as { requestId: string }[]).map((row) => row.requestId),
      [f.request.requestId],
    );
    await assert.rejects(
      f.run(
        {
          operation: "permission-request-decide",
          requestId: foreign.requestId,
          requestVersion: foreign.version,
          decision,
          resource: "repo-a",
          repoId: "repo-a",
        },
        true,
      ),
      { code: "authorization_denied" },
    );
  });
}

test("a repository admin can reject an entity request through its repository ancestor", async (t) => {
  const f = await keycloakFixture(t, false);
  f.signIn("requester", []);
  const created = await f.run(
      {
        operation: "permission-request-create",
        groupId: "viewer",
        resource: "repo-a:task/task-test",
      },
      true,
    ),
    entity = created.request as { requestId: string; version: number };
  f.signIn("policy-admin", []);
  assert.equal((await f.run({ operation: "permission-request-list" })).canDecide, true);
  const result = await f.run({
    operation: "permission-request-decide",
    requestId: entity.requestId,
    requestVersion: entity.version,
    decision: "reject",
  });
  assert.equal((result.request as { state: string }).state, "rejected");
});

test("builtin owner reads real local policy and requests but cannot approve its own request", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-admin-authority-")),
    session = createIdentitySession(root),
    host = await openDaemonHost({ userRoot: root, daemonId: "builtin-admin-authority", oidc: session });
  t.after(async () => {
    await host.close();
    removeTempRepository(root);
  });
  await session.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "test-owner-password",
    personId: "person-owner",
  });
  const login = await session.begin("http://127.0.0.1:43123/callback"),
    response = await fetch(String(login.authorizationUrl), {
      method: "POST",
      body: new URLSearchParams({ username: "owner", password: "test-owner-password", state: String(login.state) }),
      redirect: "manual",
    }),
    callback = new URL(response.headers.get("location")!);
  await session.complete(callback.searchParams.get("code")!, String(login.state));
  assert.equal((await session.requireSession()).personId, "person-owner");
  const center = await session.center();
  await center.provider.claimRepositoryOwner(center.accessToken, "repo-a", "person-owner");
  assert.ok(effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin").includes("permission-request-decide"));
  assert.equal(
    (
      await center.provider.authorizePerson({
        adminAccessToken: center.accessToken,
        personId: "person-owner",
        action: "permission-request-decide",
        resource: { kind: "repository", repoId: "repo-a" },
      })
    ).outcome,
    "allowed",
  );
  const manage = (request: Record<string, unknown>) =>
    host.manageRbac(
      { rootDir: root, ...request },
      { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0 } },
    );
  for (const operation of ["permission-request-list", "group-list", "grant-list"])
    assert.equal((await manage({ operation })).ok, true);
  const pending = await manage({ operation: "permission-request-create", groupId: "viewer", resource: "repo-a" });
  const request = pending.request as { requestId: string; version: number };
  await assert.rejects(
    manage({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
    { code: "authorization_denied" },
  );
  await assert.rejects(manage({ operation: "team-create", teamName: "Other people", operationId: "team-negative" }), {
    code: "identity_plugin_required",
  });
  t.diagnostic(
    "OBSERVED builtin: local policy and own requests are real; self approval denied; team creation requires plugin.",
  );
});
