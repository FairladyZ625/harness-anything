// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { keycloakUserRoot, serveKeycloak } from "./keycloak.fixtures.ts";

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

test("builtin owner has repository admin scopes but permission requests require the collaboration plugin", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-admin-authority-")),
    session = createIdentitySession(root),
    host = await openDaemonHost({ userRoot: root, daemonId: "builtin-admin-authority", oidc: session });
  t.after(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
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
  for (const operation of ["permission-request-list", "permission-request-decide", "group-list", "grant-list"])
    await assert.rejects(
      host.manageRbac(
        { rootDir: root, operation },
        { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0 } },
      ),
      { code: "identity_plugin_required" },
    );
  t.diagnostic(
    "OBSERVED builtin: owner repository admin=allowed; permission requests/catalog=identity_plugin_required.",
  );
});
