// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { actionDeclarations, disableDaemonRepo, unbindDaemonRepo } from "@harness-anything/kernel";
import { AccessAdminService, type AccessAdminRequest } from "../src/access-admin-service.ts";
import { requireAuthorizedFleetAction } from "../src/host-action-authorization.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { alignSessionLifetime, sessionLifetimeBounds } from "../src/keycloak-session-lifetime.ts";
import { managedRbacReceiptJournal, managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { fleetCenterConfigPath, saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "./keycloak.fixtures.ts";

async function fixture(
  t: TestContext,
  ports: {
    readonly now?: () => number;
    readonly wrapFetch?: (inner: typeof fetch) => typeof fetch;
  } = {},
) {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot(),
    fetchPort = ports.wrapFetch?.(keycloak.fetch) ?? keycloak.fetch,
    oidc = new OidcSessionService(user.root, { fetch: fetchPort, ...(ports.now ? { now: ports.now } : {}) }),
    admin = new AccessAdminService(oidc, user.root, { fetch: fetchPort }),
    config = { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" };
  t.after(user.cleanup);
  await new KeycloakPolicyAdapter(config, keycloak.fetch).syncBasePolicy("center-token");
  keycloak.writes.length = 0;
  return {
    keycloak,
    admin,
    oidc,
    ...user,
    journal: () =>
      managedRbacReceiptJournal(user.root)
        .read()
        .map((line) => JSON.parse(line)),
    run: (request: AccessAdminRequest) => admin.run({ operationId: randomUUID(), ...request }),
    // The production evaluation path: RepoCell → KeycloakPolicyAdapter → UMA decision.
    evaluate: async (personId: string, repoId: string, action: RepoTaskAction) =>
      (
        await evaluateRepoCellAction({
          action,
          binding: {
            actor: { principal: { personId }, executor: null },
            source: "local",
            keycloakAuthorization: {
              session: {
                personId,
                accessToken: `token-${personId}`,
                url: keycloakUrl,
                realm: keycloakRealm,
                clientId: "harness-center",
              },
            },
          },
          actionId: randomUUID(),
          repoId,
          revision: 1,
          now: "2026-10-01T00:00:00.000Z",
          fetchPort: keycloak.fetch,
        })
      ).outcome,
  };
}

/** Two registered repositories, a bound fleet center, and the edge permission groups every invitation test needs. */
async function edgeJoinCenter(t: TestContext, base: Awaited<ReturnType<typeof fixture>>) {
  const work = mkdtempSync(path.join(tmpdir(), "ha-edge-invitation-")),
    certificate = path.join(work, "center.crt"),
    key = path.join(work, "center.key");
  t.after(() => rmSync(work, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  for (const repoId of ["repo-a", "repo-b"]) {
    const canonicalRoot = path.join(work, repoId);
    mkdirSync(path.join(canonicalRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(canonicalRoot, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings: {}\n",
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonicalRoot });
    execFileSync("git", ["add", "harness/harness.yaml"], { cwd: canonicalRoot });
    execFileSync(
      "git",
      ["-c", "user.name=Edge invite test", "-c", "user.email=edge-invite@example.invalid", "commit", "-qm", "seed"],
      { cwd: canonicalRoot },
    );
    registerBootstrappedDaemonRepo({ canonicalRoot, repoId, userRoot: base.root, createConvenienceLinks: false });
  }
  saveFleetCenterConfig(base.root, "default", {
    bind: "127.0.0.1",
    externalUrl: "https://center.example:7545",
    port: 8443,
    repoId: "repo-a",
    keyPath: key,
    certPath: certificate,
    stateRoot: path.join(work, "fleet-state"),
    quotaBytes: 1024 * 1024,
  });
  base.keycloak.account("person-admin");
  await base.run({
    operation: "group-create",
    groupId: "edge-source",
    displayName: "Edge source",
    scopes: [],
    composites: ["viewer"],
  });
  await base.run({
    operation: "group-create",
    groupId: "edge-selected",
    displayName: "Edge selected",
    scopes: [],
    composites: ["edge-source"],
  });
  return base;
}

test("a group granted on repository A allows there and denies on repository B", async (t) => {
  const { keycloak, run, evaluate } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("bob");
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "denied");
  const granted = await run({ operation: "grant", personId: "alice", groupId: "contributor", resource: "repo-a" });
  assert.deepEqual([granted.ok, granted.outcome], [true, "applied"]);
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "allowed");
  // A repository grant covers the objects inside that repository.
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-start", taskId: "task_1" }), "allowed");
  assert.equal(await evaluate("alice", "repo-b", { kind: "task-create" }), "denied");
  assert.equal(await evaluate("alice", "repo-a", { kind: "repo-purge" }), "denied");
  assert.equal(await evaluate("bob", "repo-a", { kind: "task-create" }), "denied");
  // Every permission the grant wrote names exactly one resource.
  assert.deepEqual(
    [...keycloak.permissions.values()].map((permission) => permission.resources.length),
    [1],
  );

  // Negative control: the unbound Base scope permission this slice removed would let repository B through.
  await run({ operation: "grant", personId: "bob", groupId: "viewer", resource: "repo-b" });
  await run({ operation: "grant", personId: "bob", groupId: "contributor", resource: "repo-b" });
  const [policyId] = [...keycloak.userPolicies.values()]
    .filter((policy) => policy.name === "grant-users:contributor:repo-a")
    .map((policy) => policy.id);
  keycloak.permissions.set("unbound", {
    id: "unbound",
    name: "base-contributor-task-create",
    resources: [],
    scopes: ["task-create"],
    policies: [policyId!],
  });
  assert.equal(await evaluate("alice", "repo-b", { kind: "task-create" }), "allowed");

  await run({ operation: "revoke", personId: "alice", groupId: "contributor", resource: "repo-a" });
  keycloak.permissions.delete("unbound");
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "denied");
});

test("an EntityRef grant does not widen to the repository or its other objects", async (t) => {
  const { keycloak, run, evaluate } = await fixture(t);
  keycloak.account("bob");
  await run({ operation: "grant", personId: "bob", groupId: "maintainer", resource: "repo-b:task/task_123" });
  assert.equal(await evaluate("bob", "repo-b", { kind: "task-complete", taskId: "task_123" }), "allowed");
  assert.equal(await evaluate("bob", "repo-b", { kind: "task-complete", taskId: "task_456" }), "denied");
  assert.equal(await evaluate("bob", "repo-b", { kind: "task-create" }), "denied");
  await assert.rejects(run({ operation: "grant", personId: "bob", groupId: "maintainer", resource: "Repo B" }), {
    code: "access_resource_invalid",
  });
  await assert.rejects(run({ operation: "grant", personId: "nobody", groupId: "maintainer", resource: "repo-b" }), {
    code: "access_person_unknown",
  });
  await assert.rejects(run({ operation: "grant", personId: "bob", groupId: "missing", resource: "repo-b" }), {
    code: "policy_group_unknown",
  });
});

test("custom groups compose Base groups, re-expand their grants, and trace every action to its source", async (t) => {
  const { keycloak, admin, run, evaluate } = await fixture(t),
    version = async (id: string) =>
      ((await admin.run({ operation: "group-list" })).groups as { id: string; version: string }[]).find(
        (group) => group.id === id,
      )!.version;
  keycloak.account("bob");
  await run({
    operation: "group-create",
    groupId: "release",
    scopes: ["task-review-execution"],
    composites: ["contributor"],
  });
  await run({ operation: "group-create", groupId: "audit", composites: ["release"] });
  await run({ operation: "grant", personId: "bob", groupId: "audit", resource: "repo-a" });
  assert.equal(await evaluate("bob", "repo-a", { kind: "task-create" }), "allowed");
  assert.equal(await evaluate("bob", "repo-a", { kind: "decision-reject" }), "denied");

  const effective = await admin.run({
      operation: "effective-permissions",
      personId: "bob",
      resource: "repo-a:task/task_9",
    }),
    sources = (action: string) =>
      (effective.actions as { action: string; sources: unknown }[]).find((item) => item.action === action)?.sources;
  assert.deepEqual(effective.grants, [
    { groupId: "audit", resource: "repo-a", inheritedGroups: ["audit", "release", "contributor", "viewer"] },
  ]);
  assert.deepEqual(sources("task-review-execution"), [
    { grantedGroup: "audit", sourceGroup: "release", resource: "repo-a" },
  ]);
  assert.deepEqual(sources("task-create"), [{ grantedGroup: "audit", sourceGroup: "contributor", resource: "repo-a" }]);
  assert.equal(sources("repo-purge"), undefined);

  // Editing the inherited group reaches the grant made through the inheriting group.
  await run({
    operation: "group-update",
    groupId: "release",
    scopes: ["task-review-execution", "decision-reject"],
    expectedVersion: await version("release"),
  });
  assert.equal(await evaluate("bob", "repo-a", { kind: "decision-reject" }), "allowed");

  keycloak.writes.length = 0;
  await assert.rejects(
    run({
      operation: "group-update",
      groupId: "release",
      composites: ["audit"],
      expectedVersion: await version("release"),
    }),
    { code: "policy_group_invalid" },
  );
  await assert.rejects(run({ operation: "group-create", groupId: "bad", scopes: ["not-an-action"] }), {
    code: "policy_group_invalid",
  });
  await assert.rejects(
    run({ operation: "group-update", groupId: "admin", scopes: [], expectedVersion: await version("admin") }),
    { code: "base_policy_group_read_only" },
  );
  await assert.rejects(
    run({ operation: "group-delete", groupId: "release", expectedVersion: await version("release") }),
    { code: "policy_group_in_use" },
  );
  assert.deepEqual(keycloak.writes, [], "a rejected group change writes nothing to Keycloak");

  await run({ operation: "revoke", personId: "bob", groupId: "audit", resource: "repo-a" });
  await run({ operation: "group-delete", groupId: "audit", expectedVersion: await version("audit") });
  await run({ operation: "group-delete", groupId: "release", expectedVersion: await version("release") });
  assert.deepEqual([keycloak.roles.has("audit"), keycloak.roles.has("release")], [false, false]);
});

test("two administrators editing one group from the same version: one applied, one version_conflict", async (t) => {
  const { admin, run, signIn } = await fixture(t),
    read = async () =>
      (
        (await admin.run({ operation: "group-list" })).groups as { id: string; version: string; scopes: string[] }[]
      ).find((group) => group.id === "release")!;
  await run({ operation: "group-create", groupId: "release", scopes: ["task-review-execution"] });
  const version = (await read()).version;
  // Each request reads its administrator's session before it enters the queue; both are queued before either runs.
  signIn("admin-one");
  const first = run({
    operation: "group-update",
    groupId: "release",
    scopes: ["decision-review"],
    expectedVersion: version,
  });
  signIn("admin-two");
  const second = run({
      operation: "group-update",
      groupId: "release",
      scopes: ["decision-reject"],
      expectedVersion: version,
    }),
    results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => [result.actor, result.ok, result.outcome]),
    [
      ["admin-one", true, "applied"],
      ["admin-two", false, "version_conflict"],
    ],
  );
  assert.deepEqual((await read()).scopes, ["decision-review"]);
  assert.equal(results[1]!.currentVersion, (await read()).version);
  const retried = await run({
    operation: "group-update",
    groupId: "release",
    scopes: ["decision-reject", "decision-review"],
    expectedVersion: String(results[1]!.currentVersion),
  });
  assert.deepEqual([retried.actor, retried.outcome], ["admin-two", "applied"]);
  assert.deepEqual((await read()).scopes, ["decision-reject", "decision-review"]);
});

test("the journal holds receipts only, and a lost receipt is reconciled without repeating the write", async (t) => {
  const { keycloak, oidc, root, journal, run, evaluate } = await fixture(t),
    file = managedRbacReceiptJournal(root);
  keycloak.account("alice");
  let failSettlement = true;
  const flaky = new AccessAdminService(oidc, root, {
      fetch: keycloak.fetch,
      journal: {
        read: file.read,
        append: (line) => {
          if (failSettlement && JSON.parse(line).phase === "settled") throw new Error("disk full");
          file.append(line);
        },
      },
    }),
    operationId = randomUUID(),
    request = { operation: "grant", operationId, personId: "alice", groupId: "contributor", resource: "repo-a" };
  await assert.rejects(flaky.run(request), { code: "access_receipt_unsettled" });
  // Keycloak already holds the grant; the journal shows the intent with no settlement.
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "allowed");
  assert.deepEqual(
    journal().map((record) => record.phase),
    ["intent"],
  );
  keycloak.writes.length = 0;
  await assert.rejects(flaky.run(request), { code: "access_receipt_unsettled" });
  failSettlement = false;
  const reconciled = await flaky.run({ operation: "receipt-reconcile", operationId });
  assert.deepEqual([reconciled.ok, reconciled.outcome, reconciled.reconciledBy], [true, "applied", "person-admin"]);
  assert.deepEqual(keycloak.writes, [], "neither the retry nor the reconciliation repeats the Keycloak write");
  await assert.rejects(flaky.run(request), { code: "access_operation_settled" });

  // Evaluation never reads the journal: a hand-written receipt grants nothing, a deleted journal revokes nothing.
  file.append(
    JSON.stringify({
      schema: "harness-access-receipt/v1",
      phase: "settled",
      operation: "grant",
      outcome: "applied",
      operationId: randomUUID(),
      expect: { kind: "grant", groupId: "admin", resource: "repo-b", personId: "alice", held: true },
    }),
  );
  assert.equal(await evaluate("alice", "repo-b", { kind: "task-create" }), "denied");
  await run({ operation: "revoke", personId: "alice", groupId: "contributor", resource: "repo-a" });
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "denied");
  assert.equal(
    journal().some((record) => record.operation === "grant" && record.outcome === "applied"),
    true,
  );
});

test("the read side lists every action facet, every held grant by person, and the receipts behind an answer", async (t) => {
  const { keycloak, admin, run, journal, root } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("bob");
  // An account without a Harness person id cannot be named by a grant, so it is not offered.
  keycloak.users.set("service", { id: "service", username: "service-account", attributes: {} });

  const catalog = (await admin.run({ operation: "group-list" })).actions as {
    action: string;
    executionClass: string;
    policyTier: string;
    residencyScope: string;
  }[];
  assert.deepEqual(
    catalog.map((item) => item.action),
    actionDeclarations.map((declaration) => declaration.policyAction),
  );
  assert.deepEqual(
    catalog.find((item) => item.action === "task-create"),
    {
      action: "task-create",
      presentation: { domain: "task", name: "创建任务", description: "登记新的任务及其合同。" },
      executionClass: "repo-write",
      policyTier: "contributor",
      residencyScope: "canonical",
    },
  );

  await run({ operation: "group-create", groupId: "release", composites: ["contributor"] });
  await run({ operation: "grant", personId: "alice", groupId: "release", resource: "repo-a" });
  await run({ operation: "grant", personId: "bob", groupId: "viewer", resource: "repo-b:task/task_1" });
  await run({ operation: "grant", personId: "alice", groupId: "maintainer", resource: "repo-b" });
  const listed = await admin.run({ operation: "grant-list" });
  assert.deepEqual(listed.people, [
    { personId: "alice", username: "alice" },
    { personId: "bob", username: "bob" },
  ]);
  assert.deepEqual(
    (listed.grants as { personId: string; groupId: string; resource: string }[])
      .map((grant) => `${grant.personId} ${grant.groupId} ${grant.resource}`)
      .sort(),
    ["alice maintainer repo-b", "alice release repo-a", "bob viewer repo-b:task/task_1"],
  );

  const operations = (receipts: unknown) =>
      (receipts as { operation: string; expect: { groupId: string } }[]).map(
        (receipt) => `${receipt.operation} ${receipt.expect.groupId}`,
      ),
    effective = await admin.run({ operation: "effective-permissions", personId: "alice", resource: "repo-a" });
  // Newest first; the grant on repository B and the grant to bob are not part of alice's answer on repository A.
  assert.deepEqual(operations(effective.receipts), ["grant release", "group-create release"]);
  assert.deepEqual(operations((await admin.run({ operation: "receipt-list" })).receipts), [
    "grant maintainer",
    "grant viewer",
    "grant release",
    "group-create release",
  ]);

  // An operation that reached Keycloak without a settled receipt is listed as its intent, so it can be reconciled.
  const settled = journal().filter((record) => record.phase === "settled").length;
  managedRbacReceiptJournal(root).append(
    JSON.stringify({ operationId: "lost", operation: "revoke", actor: "person-admin", phase: "intent" }),
  );
  const [newest] = (await admin.run({ operation: "receipt-list" })).receipts as {
    operationId: string;
    phase: string;
  }[];
  assert.deepEqual([newest!.operationId, newest!.phase, settled], ["lost", "intent", 4]);
});

test("access administration requires the access-admin role before anything reaches Keycloak", async (t) => {
  const { keycloak, run, signIn } = await fixture(t);
  keycloak.account("alice");
  signIn("person-member", ["offline_access"]);
  for (const operation of [
    "group-list",
    "grant",
    "group-create",
    "effective-permissions",
    "receipt-reconcile",
    "session-lifetime",
    "session-lifetime-set",
  ])
    await assert.rejects(
      run({
        operation,
        personId: "alice",
        groupId: "contributor",
        resource: "repo-a",
        sessionLifetimeSeconds: 600,
        expectedVersion: "1800",
      }),
      { code: "authorization_denied" },
      operation,
    );
  assert.deepEqual(keycloak.writes, []);
  assert.equal(keycloak.realm.ssoSessionIdleTimeout, 1_800);
});

test("permission requests retain the authenticated task requester instead of the center login", async (t) => {
  const { admin, keycloak } = await fixture(t);
  keycloak.account("worker");
  const request = { operation: "permission-request-create", groupId: "viewer", resource: "repo-a:task/task-worker" };
  const result = await admin.run(request, "worker");
  assert.equal((result.request as { personId: string }).personId, "worker");
  await assert.rejects(admin.run({ ...request, personId: "another" }, "worker"), { code: "authorization_denied" });
});

test("permission request listing derives approver visibility from policy authority", async (t) => {
  const { keycloak, run, signIn } = await fixture(t);
  keycloak.account("requester");
  keycloak.account("member");
  signIn("requester", ["offline_access"]);
  await run({ operation: "permission-request-create", groupId: "viewer", resource: "repo-a" });
  signIn("member", []);
  const memberList = await run({ operation: "permission-request-list" });
  assert.deepEqual([memberList.canDecide, memberList.requests], [false, []]);
  signIn("requester", ["offline_access"]);
  const requesterList = await run({ operation: "permission-request-list" });
  assert.deepEqual(
    [requesterList.canDecide, (requesterList.requests as { personId: string }[]).map((row) => row.personId)],
    [false, ["requester"]],
  );
});

test("permission requests bind exact versions and settle one concurrent decision", async (t) => {
  const { keycloak, run, signIn } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("admin");
  signIn("alice", ["offline_access"]);
  const created = await run({
    operation: "permission-request-create",
    groupId: "viewer",
    resource: "repo-a",
    rationale: "read",
  });
  assert.equal(created.ok, true);
  const request = created.request as { requestId: string; version: number };
  signIn("admin");
  const [first, second] = await Promise.all([
    run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "reject",
    }),
    run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
  ]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal([first, second].filter((result) => result.code === "version_conflict").length, 1);
});

test("permission requests require an independent approver and unchanged action scope", async (t) => {
  const { keycloak, run, signIn, admin } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("admin");
  await run({ operation: "group-create", groupId: "release", scopes: ["task-create"] });
  signIn("alice", ["offline_access"]);
  const created = await run({ operation: "permission-request-create", groupId: "release", resource: "repo-a" }),
    request = created.request as { requestId: string; version: number };
  await assert.rejects(
    run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
    { code: "authorization_denied" },
  );

  signIn("admin");
  const before = await admin.run({ operation: "group-list" }),
    release = (before.groups as { id: string; version: string; scopes: string[] }[]).find(
      (item) => item.id === "release",
    )!;
  await run({
    operation: "group-update",
    groupId: "release",
    scopes: ["task-create", "task-delete"],
    expectedVersion: release.version,
  });
  await assert.rejects(
    run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
    { code: "permission_request_changed" },
  );
  assert.equal((await admin.run({ operation: "permission-request-list" })).requests instanceof Array, true);
});

test("permission approval evaluates the approver's requested scope and permits delegated approval", async (t) => {
  const { keycloak, run, signIn, evaluate } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("admin");
  await run({ operation: "group-create", groupId: "release", scopes: ["task-create"] });
  signIn("alice", ["offline_access"]);
  const created = await run({ operation: "permission-request-create", groupId: "release", resource: "repo-a" }),
    request = created.request as { requestId: string; version: number };

  signIn("admin");
  await assert.rejects(
    run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
    { code: "authorization_denied" },
  );

  // Holding the requested grant is authority to delegate it; it must not be mistaken for self-approval.
  await run({ operation: "grant", personId: "admin", groupId: "release", resource: "repo-a" });
  const approved = await run({
    operation: "permission-request-decide",
    requestId: request.requestId,
    requestVersion: request.version,
    decision: "approve",
  });
  assert.equal(approved.ok, true);
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "allowed");
});

test("a permission request takes effect only after Keycloak accepts its grant", async (t) => {
  const { keycloak, run, signIn, oidc, root, evaluate } = await fixture(t);
  keycloak.account("alice");
  keycloak.account("admin");
  keycloak.permit("admin", "@fleet", ["permission-request-decide"]);
  signIn("alice", ["offline_access"]);
  const created = await run({ operation: "permission-request-create", groupId: "contributor", resource: "repo-a" }),
    request = created.request as { requestId: string; version: number };
  signIn("admin");
  await run({ operation: "grant", personId: "admin", groupId: "contributor", resource: "repo-a" });
  const failing = new AccessAdminService(oidc, root, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (
        init?.method !== "GET" &&
        (url.pathname.includes("/policy/user/") || url.pathname.includes("/permission/scope/"))
      )
        return Response.json({ error: "fixture_write_denied" }, { status: 403 });
      return keycloak.fetch(input, init);
    },
  });
  await assert.rejects(
    failing.run({
      operation: "permission-request-decide",
      requestId: request.requestId,
      requestVersion: request.version,
      decision: "approve",
    }),
    (error: unknown) => error instanceof Error && /returned HTTP 403/u.test(error.message),
  );
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "denied");
  const pending = (await run({ operation: "permission-request-list" })).requests as {
    state: string;
    version: number;
  }[];
  assert.deepEqual(
    [
      pending.find((item) => item.state === "pending")?.state,
      pending.find((item) => item.state === "pending")?.version,
    ],
    ["pending", 1],
  );

  const accepted = await run({
    operation: "permission-request-decide",
    requestId: request.requestId,
    requestVersion: request.version,
    decision: "approve",
  });
  assert.equal(accepted.ok, true);
  assert.equal(await evaluate("alice", "repo-a", { kind: "task-create" }), "allowed");
});

test("the session lifetime is read from and written to the realm, within bounds, against the value read", async (t) => {
  const { keycloak, admin, run, journal } = await fixture(t),
    realmAdmin = { url: keycloakUrl, realm: keycloakRealm, accessToken: "center-token" };
  // A realm that predates the session lifetime runs Keycloak's defaults until the daemon aligns it.
  await alignSessionLifetime(realmAdmin, keycloak.fetch);
  assert.deepEqual(keycloak.realm, {
    ssoSessionIdleTimeout: 6 * 60 * 60,
    ssoSessionMaxLifespan: sessionLifetimeBounds.maximumSeconds,
    offlineSessionIdleTimeout: 90 * 24 * 60 * 60,
    offlineSessionMaxLifespanEnabled: false,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
  });
  assert.deepEqual(await admin.run({ operation: "session-lifetime" }), {
    ok: true,
    seconds: 21_600,
    version: "21600",
    defaultSeconds: 21_600,
    minimumSeconds: 300,
    maximumSeconds: 31_536_000,
  });

  const changed = await run({
    operation: "session-lifetime-set",
    sessionLifetimeSeconds: 7_200,
    expectedVersion: "21600",
  });
  assert.deepEqual(
    [changed.ok, changed.outcome, changed.actor, changed.expect],
    [true, "applied", "person-admin", { kind: "session-lifetime", seconds: 7_200 }],
  );
  assert.equal(keycloak.realm.ssoSessionIdleTimeout, 7_200);
  assert.equal((await admin.run({ operation: "session-lifetime" })).seconds, 7_200);
  // Aligning again leaves a lifetime an administrator set alone.
  await alignSessionLifetime(realmAdmin, keycloak.fetch);
  assert.equal(keycloak.realm.ssoSessionIdleTimeout, 7_200);

  // A second administrator still holding the old value is told so instead of overwriting the first.
  const stale = await run({ operation: "session-lifetime-set", sessionLifetimeSeconds: 900, expectedVersion: "21600" });
  assert.deepEqual(
    [stale.ok, stale.outcome, stale.expectedVersion, stale.currentVersion],
    [false, "version_conflict", "21600", "7200"],
  );
  for (const sessionLifetimeSeconds of [299, 31_536_001, 600.5, undefined])
    await assert.rejects(
      run({ operation: "session-lifetime-set", sessionLifetimeSeconds, expectedVersion: "7200" }),
      { code: "session_lifetime_invalid" },
      String(sessionLifetimeSeconds),
    );
  await assert.rejects(run({ operation: "session-lifetime-set", sessionLifetimeSeconds: 900 }), {
    code: "access_request_invalid",
  });
  assert.equal(keycloak.realm.ssoSessionIdleTimeout, 7_200);
  assert.deepEqual(
    journal().map((record) => [record.operation, record.phase, record.outcome ?? null]),
    [
      ["session-lifetime-set", "intent", null],
      ["session-lifetime-set", "settled", "applied"],
      ["session-lifetime-set", "settled", "version_conflict"],
    ],
  );
});

test("first-administrator bootstrap with two different usernames creates exactly one administrator", async (t) => {
  const { keycloak, oidc } = await fixture(t),
    person = (name: string) => ({
      username: name,
      email: `${name}@example.invalid`,
      displayName: name,
      password: "fixture-password",
      personId: name,
    }),
    outcomes = await Promise.allSettled([oidc.bootstrapAdmin(person("first")), oidc.bootstrapAdmin(person("second"))]);
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.status === "fulfilled" ? "created" : (outcome.reason as { code: string }).code)),
    ["created", "bootstrap_admin_closed"],
  );
  assert.equal(keycloak.realmRoles.get("access-admin")!.members.size, 1);
  assert.deepEqual(
    [...keycloak.users.values()].map((user) => user.attributes.harness_person_id),
    [["first"]],
  );
});

test("host-level actions answer to the fleet grant of the signed-in person, never to a repository", async (t) => {
  const { keycloak, root, run } = await fixture(t),
    requests: string[] = [],
    fetchPort = (async (input, init) => {
      requests.push(String((init?.body as URLSearchParams).get("permission")));
      return keycloak.fetch(input, init);
    }) as typeof fetch,
    attempt = (personId?: string) =>
      requireAuthorizedFleetAction({
        kind: "runtime-instance-create",
        userRoot: root,
        auth: {
          transportKind: "fleet-tls",
          ...(personId
            ? {
                oidcPrincipal: {
                  personId,
                  subject: personId,
                  expiresAt: Date.now() + 60_000,
                  accessToken: `token-${personId}`,
                  authority: { url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center" },
                },
              }
            : {}),
        },
        actionId: "runtime-instance-create:test",
        evaluatedAtCut: "runtime-instances:current",
        fetchPort,
      });
  keycloak.account("alice");
  await run({ operation: "grant", personId: "alice", groupId: "admin", resource: "repo-a" });
  await assert.rejects(attempt("alice"), { code: "authorization_denied" });
  await run({ operation: "grant", personId: "alice", groupId: "admin", resource: "@fleet" });
  const decision = await attempt("alice");
  assert.deepEqual([decision.policyRef, decision.outcome], ["keycloak-policy@1", "allowed"]);
  assert.deepEqual([...new Set(requests)], ["@fleet#runtime-instance-create"]);
  await assert.rejects(attempt(), { code: "authentication_required" });
});

test("edge invitations grant each selected repository and reject inherited permission drift or revocation", async (t) => {
  const { keycloak, admin, run, signIn, journal } = await edgeJoinCenter(t, await fixture(t));
  const issued = await run({
      operation: "edge-join-create",
      personId: "person-invited",
      username: "edge-operator",
      email: "edge@example.invalid",
      displayName: "Edge Operator",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["edge-selected"],
      nodeLabel: "edge-test",
    }),
    issuedLink = issued.link;
  assert.equal(typeof issuedLink, "string", "CLI and GUI receive the encoded invitation link");
  assert.match(String(issuedLink), /^harness-edge:\/\/join\/[A-Za-z0-9_-]+$/u);
  const link = JSON.parse(
    Buffer.from(String(issuedLink).slice("harness-edge://join/".length), "base64url").toString("utf8"),
  ) as {
    readonly joinId: string;
    readonly token?: string;
    readonly repoIds: readonly string[];
    readonly loginClientId: string;
    readonly centerOrigin: string;
  };
  assert.ok(link.token);
  assert.equal(link.centerOrigin, "https://center.example:7545");
  const decodedLink = JSON.parse(
    Buffer.from(String(issuedLink).slice("harness-edge://join/".length), "base64url").toString("utf8"),
  ) as { readonly centerOrigin: string };
  assert.equal(decodedLink.centerOrigin, "https://center.example:7545");
  assert.deepEqual([issued.ok, issued.state, link.repoIds], [true, "pending", ["repo-a", "repo-b"]]);
  assert.equal(
    JSON.stringify(journal()).includes(link.token),
    false,
    "the writer journal stores no plaintext invite token",
  );
  const grants = (await run({ operation: "grant-list" })).grants as {
    readonly personId: string;
    readonly groupId: string;
    readonly resource: string;
  }[];
  assert.deepEqual(
    grants.filter((grant) => grant.personId === "person-invited").map((grant) => [grant.groupId, grant.resource]),
    [
      ["edge-selected", "repo-a"],
      ["edge-selected", "repo-b"],
    ],
  );

  const source = (
    (await run({ operation: "group-list" })).groups as { readonly id: string; readonly version: string }[]
  ).find((group) => group.id === "edge-source")!;
  await run({
    operation: "group-update",
    groupId: source.id,
    displayName: "Edge source",
    scopes: [],
    composites: ["contributor"],
    expectedVersion: source.version,
  });
  keycloak.interactiveSession("person-invited", "edge-device", keycloakUrl, "invited-token", link.loginClientId);
  const nodeCount = keycloak.nodeClients.size;
  await assert.rejects(
    admin.admitEdgeJoin({ joinId: link.joinId, inviteToken: link.token, accessToken: "invited-token" }),
    { code: "permission_snapshot_changed" },
  );
  assert.equal(keycloak.nodeClients.size, nodeCount, "permission drift fails before minting an edge credential");
  assert.deepEqual(
    (await admin.run({ operation: "edge-join-status", joinId: link.joinId })).state,
    "pending",
    "a refused admission leaves the invite available for a fresh decision",
  );

  const second = await run({
    operation: "edge-join-create",
    personId: "person-invited",
    username: "edge-operator-2",
    email: "edge@example.invalid",
    displayName: "Edge Operator",
    repoIds: ["repo-a", "repo-b"],
    groupIds: ["edge-selected"],
  });
  const revoked = await run({ operation: "edge-join-revoke", joinId: String(second.joinId) });
  assert.deepEqual(
    revoked,
    { ok: true, joinId: String(second.joinId), state: "revoked" },
    "revoke answers with the join's identity and state only",
  );
  assert.equal(typeof second.link, "string", "a second CLI invitation also returns a string link");
  const revokedToken = JSON.parse(
    Buffer.from(String(second.link).slice("harness-edge://join/".length), "base64url").toString("utf8"),
  ).token as string;
  await assert.rejects(
    admin.admitEdgeJoin({ joinId: String(second.joinId), inviteToken: revokedToken, accessToken: "invited-token" }),
    { code: "join_revoked" },
  );
  signIn("person-admin");
});

test("edge invitations require a configured external center URL even when the listener binds wildcard", async (t) => {
  const { root, keycloak, run } = await edgeJoinCenter(t, await fixture(t));
  const config = JSON.parse(readFileSync(fleetCenterConfigPath(root, "default"), "utf8")) as Record<string, unknown>;
  config.bind = "0.0.0.0";
  writeFileSync(fleetCenterConfigPath(root, "default"), JSON.stringify(config));
  keycloak.account("person-invited");
  const issued = await run({
      operation: "edge-join-create",
      personId: "person-invited",
      repoIds: ["repo-a"],
      groupIds: ["viewer"],
    }),
    decoded = JSON.parse(
      Buffer.from(String(issued.link).slice("harness-edge://join/".length), "base64url").toString("utf8"),
    ) as { readonly centerOrigin: string };
  assert.equal(new URL(decoded.centerOrigin).origin, "https://center.example:7545");
  t.diagnostic(`decoded invitation center origin: ${new URL(decoded.centerOrigin).origin}`);

  delete config.externalUrl;
  writeFileSync(fleetCenterConfigPath(root, "default"), JSON.stringify(config));
  await assert.rejects(
    run({
      operation: "edge-join-create",
      personId: "person-invited",
      repoIds: ["repo-a"],
      groupIds: ["viewer"],
    }),
    {
      code: "fleet_center_address_unavailable",
      message: /ha daemon fleet center start --external-url https:\/\/center\.example:7545/u,
    },
  );
});

test("a win32 invitation registers a win32 edge node, and an unknown platform is refused", async (t) => {
  const { keycloak, admin, run } = await edgeJoinCenter(t, await fixture(t)),
    issued = await run({
      operation: "edge-join-create",
      personId: "person-invited",
      username: "edge-operator",
      email: "edge@example.invalid",
      displayName: "Edge Operator",
      repoIds: ["repo-a"],
      groupIds: ["edge-selected"],
      nodeLabel: "windows-node",
      platform: "win32",
    }),
    link = JSON.parse(
      Buffer.from(String(issued.link).slice("harness-edge://join/".length), "base64url").toString("utf8"),
    ) as { readonly joinId: string; readonly token: string; readonly loginClientId: string };
  assert.equal(issued.ok, true);
  // Negative control: the write boundary still refuses a platform outside the shared vocabulary.
  await assert.rejects(
    run({
      operation: "edge-join-create",
      personId: "person-invited",
      repoIds: ["repo-a"],
      groupIds: ["edge-selected"],
      platform: "windows",
    }),
    { code: "edge_join_invalid" },
  );
  keycloak.interactiveSession("person-invited", "edge-device", keycloakUrl, "invited-token", link.loginClientId);
  const admitted = await admin.admitEdgeJoin({
    joinId: link.joinId,
    inviteToken: link.token,
    accessToken: "invited-token",
  });
  assert.equal(admitted.personId, "person-invited");
  const device = JSON.parse(
    keycloak.nodeClients.get(`harness-node-${admitted.nodeId}`)!.attributes.harness_device!,
  ) as { readonly platform: string; readonly systemName: string };
  assert.deepEqual([device.platform, device.systemName], ["win32", "windows-node"]);
  // The node projection the GUI lists carries the same win32 value back.
  const listed = (await run({ operation: "node-list" })).nodes as {
    readonly nodeId: string;
    readonly platform: string;
  }[];
  assert.equal(listed.find((node) => node.nodeId === admitted.nodeId)?.platform, "win32");
});

test("an existing member is invited without new-user fields; an unknown person still needs them", async (t) => {
  const { keycloak, run } = await edgeJoinCenter(t, await fixture(t));
  const first = await run({
    operation: "edge-join-create",
    personId: "person-invited",
    username: "edge-operator",
    email: "edge@example.invalid",
    displayName: "Edge Operator",
    repoIds: ["repo-a"],
    groupIds: ["edge-selected"],
  });
  assert.equal(first.ok, true);
  // The member already carries the account: the invitation addresses them by identity and grants only.
  const renewed = await run({
    operation: "edge-join-create",
    personId: "person-invited",
    repoIds: ["repo-b"],
    groupIds: ["edge-selected"],
  });
  assert.equal(renewed.ok, true);
  assert.notEqual(String(renewed.joinId), String(first.joinId));
  // A person the center does not know would create an account, so each new-user field is required.
  await assert.rejects(
    run({ operation: "edge-join-create", personId: "person-new", repoIds: ["repo-a"], groupIds: ["edge-selected"] }),
    { code: "access_request_invalid" },
  );
  assert.equal(
    [...keycloak.users.values()].some((user) => user.attributes.harness_person_id?.[0] === "person-new"),
    false,
    "no account is created for the refused invitation",
  );
});

test(
  "edge-join-create renews a lapsing administrator session inside the write queue",
  { timeout: 10_000 },
  async (t) => {
    const clock = { now: Date.now() },
      { keycloak, run, root } = await edgeJoinCenter(
        t,
        await fixture(t, {
          now: () => clock.now,
          // Each Keycloak round trip advances the test clock, pulling the invite into the renewal margin.
          wrapFetch: (inner) =>
            (async (input, init) => {
              clock.now += 1_000;
              return inner(input, init);
            }) as typeof fetch,
        }),
      ),
      adminUser = [...keycloak.users.values()].find(
        (user) => user.attributes.harness_person_id?.[0] === "person-admin",
      )!;
    // The renewal's fresh token carries the administrator's realm role.
    keycloak.realmRoles.set("access-admin", {
      id: "role-access-admin",
      name: "access-admin",
      composites: new Set(),
      members: new Set([adminUser.id]),
    });
    // 30.5s of access-token life: the entry role check does not renew; the invite's first round trips do.
    managedRbacSessionStore(root).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "token-person-admin",
        refreshToken: "token-person-admin",
        subject: "person-admin",
        personId: "person-admin",
        expiresAt: clock.now + 30_500,
        sessionExpiresAt: clock.now + 21_600_000,
        roles: ["access-admin"],
      }),
    );
    const issued = await run({
      operation: "edge-join-create",
      personId: "person-newcomer",
      username: "newcomer",
      email: "newcomer@example.invalid",
      displayName: "New Comer",
      repoIds: ["repo-a"],
      groupIds: ["edge-selected"],
    });
    assert.equal(issued.ok, true);
    assert.equal(
      [...keycloak.users.values()].some((user) => user.attributes.harness_person_id?.[0] === "person-newcomer"),
      true,
      "the lapsing session still invited the new operator",
    );
  },
);

test("an invitation is refused at consume when its repository was disabled or removed after issuance", async (t) => {
  const { keycloak, admin, run, root } = await edgeJoinCenter(t, await fixture(t)),
    issued = await run({
      operation: "edge-join-create",
      personId: "person-invited",
      username: "edge-operator",
      email: "edge@example.invalid",
      displayName: "Edge Operator",
      repoIds: ["repo-a", "repo-b"],
      groupIds: ["edge-selected"],
    }),
    link = JSON.parse(
      Buffer.from(String(issued.link).slice("harness-edge://join/".length), "base64url").toString("utf8"),
    ) as {
      readonly joinId: string;
      readonly token?: string;
      readonly loginClientId: string;
    };
  assert.ok(link.token);
  keycloak.interactiveSession("person-invited", "edge-device", keycloakUrl, "invited-token", link.loginClientId);
  const nodeCount = keycloak.nodeClients.size,
    admit = () => admin.admitEdgeJoin({ joinId: link.joinId, inviteToken: link.token!, accessToken: "invited-token" });
  disableDaemonRepo("repo-b", { userRoot: root });
  await assert.rejects(admit(), { code: "repo_namespace_unknown" }, "a disabled repository refuses the consume");
  unbindDaemonRepo("repo-b", { userRoot: root });
  await assert.rejects(admit(), { code: "repo_namespace_unknown" }, "a removed repository refuses the consume");
  assert.equal(keycloak.nodeClients.size, nodeCount, "no edge node is minted for a refused repository check");
  assert.equal((await run({ operation: "edge-join-status", joinId: link.joinId })).state, "pending");
});
