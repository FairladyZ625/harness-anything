// harness-test-tier: contract
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AccessAdminService, type AccessAdminRequest } from "../src/access-admin-service.ts";
import { requireAuthorizedFleetAction } from "../src/host-action-authorization.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { managedRbacReceiptJournal } from "../src/managed-rbac-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "./keycloak.fixtures.ts";

async function fixture() {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot(),
    oidc = new OidcSessionService(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch }),
    config = { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" };
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
              accessToken: `token-${personId}`,
              url: keycloakUrl,
              realm: keycloakRealm,
              clientId: "harness-center",
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

test("a group granted on repository A allows there and denies on repository B", async () => {
  const { keycloak, run, evaluate } = await fixture();
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

test("an EntityRef grant does not widen to the repository or its other objects", async () => {
  const { keycloak, run, evaluate } = await fixture();
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

test("custom groups compose Base groups, re-expand their grants, and trace every action to its source", async () => {
  const { keycloak, admin, run, evaluate } = await fixture(),
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

test("two administrators editing one group from the same version: one applied, one version_conflict", async () => {
  const { admin, run, signIn } = await fixture(),
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

test("the journal holds receipts only, and a lost receipt is reconciled without repeating the write", async () => {
  const { keycloak, oidc, root, journal, run, evaluate } = await fixture(),
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

test("access administration requires the access-admin role before anything reaches Keycloak", async () => {
  const { keycloak, run, signIn } = await fixture();
  keycloak.account("alice");
  signIn("person-member", ["offline_access"]);
  for (const operation of ["group-list", "grant", "group-create", "effective-permissions", "receipt-reconcile"])
    await assert.rejects(
      run({ operation, personId: "alice", groupId: "contributor", resource: "repo-a" }),
      { code: "authorization_denied" },
      operation,
    );
  assert.deepEqual(keycloak.writes, []);
});

test("first-administrator bootstrap with two different usernames creates exactly one administrator", async () => {
  const { keycloak, oidc } = await fixture(),
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

test("host-level actions answer to the fleet grant of the signed-in person, never to a repository", async () => {
  const { keycloak, root, run } = await fixture(),
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
