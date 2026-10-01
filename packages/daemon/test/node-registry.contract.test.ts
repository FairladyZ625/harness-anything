// harness-test-tier: contract
// dec_D60FAA451F24160E970323B6F3 CH1/CH2: a fleet connection authenticates a machine; the person it acts
// for is center state in Keycloak, written through the access-admin queue and read for every frame.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AccessAdminService, type AccessAdminRequest } from "../src/access-admin-service.ts";
import { binding as deriveBinding } from "../src/daemon-host-binding.ts";
import { keycloakNodeRegistry } from "../src/fleet-center-admission.ts";
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { managedRbacReceiptJournal } from "../src/managed-rbac-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import type { RepoCellBinding, RepoTaskAction } from "../src/repo-cell-types.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "./keycloak.fixtures.ts";

const center = { url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" };

async function fixture() {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot(),
    oidc = new OidcSessionService(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch });
  await new KeycloakPolicyAdapter(
    { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
    keycloak.fetch,
  ).syncBasePolicy("center-token");
  keycloak.writes.length = 0;
  const run = (request: AccessAdminRequest) => admin.run({ operationId: randomUUID(), ...request });
  return {
    keycloak,
    run,
    ...user,
    registry: keycloakNodeRegistry(async () => center, keycloak.fetch),
    nodes: async () =>
      (await admin.run({ operation: "node-list" })).nodes as { nodeId: string; personId: string; version: string }[],
    journal: () => managedRbacReceiptJournal(user.root).read(),
    evaluate: async (binding: RepoCellBinding, action: RepoTaskAction) =>
      (
        await evaluateRepoCellAction({
          action,
          binding,
          actionId: randomUUID(),
          repoId: "repo-a",
          revision: 1,
          now: "2026-10-01T00:00:00.000Z",
          fetchPort: keycloak.fetch,
        })
      ).outcome,
  };
}

// The three entry points one person can act through: a signed-in local session, and two fleet nodes
// registered to that person. Only the local one holds the person's own token.
const entries = (personId: string): Readonly<Record<string, RepoCellBinding>> => {
  const actor = { principal: { personId }, executor: null };
  return {
    local: {
      actor,
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
    "edge-a": {
      actor,
      source: { kind: "assignment", nodeId: "edge-a", assignmentId: "assignment-a" },
      keycloakAuthorization: { center },
    },
    "edge-b": {
      actor,
      source: { kind: "assignment", nodeId: "edge-b", assignmentId: "assignment-b" },
      keycloakAuthorization: { center },
    },
  };
};

test("registering a node issues its machine credential once and records who it acts for", async () => {
  const { keycloak, run, nodes, journal, registry } = await fixture();
  keycloak.account("alice");
  assert.deepEqual(await nodes(), []);
  const registered = await run({ operation: "node-register", nodeId: "edge-a", personId: "alice" });
  assert.deepEqual([registered.ok, registered.outcome, registered.actor], [true, "applied", "person-admin"]);
  const credential = String(registered.credential);
  assert.ok(credential.length > 0);
  const listed = await nodes();
  assert.deepEqual(
    listed.map(({ nodeId, personId }) => ({ nodeId, personId })),
    [{ nodeId: "edge-a", personId: "alice" }],
  );
  assert.equal((registered.expect as { version: string }).version, listed[0]!.version);
  // The audit journal holds an intent and a settlement for the write, and never the credential itself.
  assert.deepEqual(
    journal().map((line) => (JSON.parse(line) as { phase: string }).phase),
    ["intent", "settled"],
  );
  assert.equal(journal().join("\n").includes(credential), false);
  // The registry answers from Keycloak: this credential is this node's, and no other node's.
  assert.equal(await registry.authenticate("edge-a", credential), true);
  assert.equal(await registry.authenticate("edge-a", "not-the-credential"), false);
  assert.equal(await registry.authenticate("edge-b", credential), false);
  assert.equal(await registry.nodeOwner("edge-a"), "alice");
});

// Whoever runs the registration is often an agent whose output is kept, so the credential goes into a
// file the caller names and the receipt only says where.
test("a first registration puts the credential in the caller's file and keeps it out of the receipt", async (t) => {
  const { keycloak, run, nodes, journal, registry, root } = await fixture(),
    directory = mkdtempSync(path.join(tmpdir(), "ha-node-credential-")),
    file = path.join(directory, "edge-a.credential"),
    register = { operation: "node-register", nodeId: "edge-a", personId: "alice" };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  keycloak.account("alice");
  keycloak.account("bob");
  // A path that is taken, or that the center cannot place, refuses the registration before the intent
  // is recorded and before Keycloak is written.
  writeFileSync(file, "somebody else's credential");
  await assert.rejects(run({ ...register, credentialFile: file }), { code: "credential_file_unavailable" });
  await assert.rejects(run({ ...register, credentialFile: "edge-a.credential" }), {
    code: "credential_file_unavailable",
  });
  assert.equal(readFileSync(file, "utf8"), "somebody else's credential");
  assert.deepEqual([keycloak.writes, journal(), await nodes()], [[], [], []]);
  rmSync(file);
  // Keycloak refusing the write leaves no empty file where a credential was expected.
  const refusing = new AccessAdminService(new OidcSessionService(root, { fetch: keycloak.fetch }), root, {
    fetch: ((input, init) =>
      init?.method === "POST" && String(input).endsWith("/clients")
        ? Promise.resolve(new Response("{}", { status: 500 }))
        : keycloak.fetch(input, init)) as typeof fetch,
  });
  await assert.rejects(refusing.run({ ...register, operationId: randomUUID(), credentialFile: file }));
  assert.equal(existsSync(file), false);

  const registered = await run({ ...register, credentialFile: file });
  assert.deepEqual(
    [registered.ok, registered.outcome, registered.credentialFile, "credential" in registered],
    [true, "applied", file, false],
  );
  const credential = readFileSync(file, "utf8");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await registry.authenticate("edge-a", credential), true);
  assert.equal(JSON.stringify(registered).includes(credential), false);
  assert.equal(journal().join("\n").includes(credential), false);
  // Without a file the credential is still returned once, as before.
  assert.equal(typeof (await run({ ...register, nodeId: "edge-b" })).credential, "string");
  // Neither moving the node nor a refused registration mints a credential, so neither leaves a file.
  const unused = path.join(directory, "edge-a-again.credential"),
    version = (await nodes()).find(({ nodeId }) => nodeId === "edge-a")!.version,
    conflict = await run({ ...register, credentialFile: unused }),
    moved = await run({ ...register, personId: "bob", expectedVersion: version, credentialFile: unused });
  assert.deepEqual(
    [conflict.code, moved.ok, "credential" in moved, "credentialFile" in moved],
    ["version_conflict", true, false, false],
  );
  assert.equal(existsSync(unused), false);
  assert.equal(readFileSync(file, "utf8"), credential);
});

test("moving a node to another person applies to the next read and issues no second credential", async () => {
  const { keycloak, run, nodes, registry } = await fixture();
  keycloak.account("alice");
  keycloak.account("bob");
  const first = await run({ operation: "node-register", nodeId: "edge-a", personId: "alice" }),
    version = (await nodes())[0]!.version,
    moved = await run({ operation: "node-register", nodeId: "edge-a", personId: "bob", expectedVersion: version });
  assert.deepEqual([moved.ok, moved.outcome], [true, "applied"]);
  assert.equal("credential" in moved, false);
  assert.equal(await registry.nodeOwner("edge-a"), "bob");
  assert.notEqual((await nodes())[0]!.version, version);
  assert.equal(await registry.authenticate("edge-a", String(first.credential)), true);
});

test("two registrations of one node from the same version: one applied, one version_conflict", async () => {
  const { keycloak, run, nodes, signIn } = await fixture();
  keycloak.account("alice");
  keycloak.account("bob");
  // Both requests read their administrator's session before entering the queue; both are queued before either runs.
  signIn("admin-one");
  const first = run({ operation: "node-register", nodeId: "edge-a", personId: "alice" });
  signIn("admin-two");
  const second = run({ operation: "node-register", nodeId: "edge-a", personId: "bob" }),
    results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => [result.actor, result.ok, result.outcome]),
    [
      ["admin-one", true, "applied"],
      ["admin-two", false, "version_conflict"],
    ],
  );
  const current = (await nodes())[0]!;
  assert.equal(current.personId, "alice");
  assert.deepEqual(
    {
      nodeId: results[1]!.nodeId,
      expectedVersion: results[1]!.expectedVersion,
      currentVersion: results[1]!.currentVersion,
    },
    { nodeId: "edge-a", expectedVersion: "", currentVersion: current.version },
  );
  assert.equal("credential" in results[1]!, false);
  assert.equal(keycloak.writes.filter((write) => write === "POST /clients").length, 1);
  // The loser re-reads and retries against the version it was told about.
  const retried = await run({
    operation: "node-register",
    nodeId: "edge-a",
    personId: "bob",
    expectedVersion: String(results[1]!.currentVersion),
  });
  assert.deepEqual([retried.actor, retried.outcome], ["admin-two", "applied"]);
  assert.equal((await nodes())[0]!.personId, "bob");
});

test("unregistering a node removes it from Keycloak, so its credential and its owner are gone", async () => {
  const { keycloak, run, nodes, journal, registry } = await fixture();
  keycloak.account("alice");
  const credential = String(
    (await run({ operation: "node-register", nodeId: "edge-a", personId: "alice" })).credential,
  );
  await run({ operation: "node-register", nodeId: "edge-b", personId: "alice" });
  const version = (await nodes())[0]!.version;
  assert.equal(await registry.authenticate("edge-a", credential), true);
  // A version nobody read is refused before Keycloak changes.
  const stale = await run({ operation: "node-unregister", nodeId: "edge-a", expectedVersion: "stale" });
  assert.deepEqual(
    [stale.ok, stale.code, stale.nodeId, stale.expectedVersion, stale.currentVersion],
    [false, "version_conflict", "edge-a", "stale", version],
  );
  assert.equal(keycloak.writes.filter((write) => write.startsWith("DELETE")).length, 0);
  await assert.rejects(run({ operation: "node-unregister", nodeId: "edge-a" }), { code: "access_request_invalid" });
  // Two administrators remove the node from the same version: one applies, the other is told it is gone.
  const results = await Promise.all([
    run({ operation: "node-unregister", nodeId: "edge-a", expectedVersion: version }),
    run({ operation: "node-unregister", nodeId: "edge-a", expectedVersion: version }),
  ]);
  assert.deepEqual(
    results.map((result) => [result.ok, result.outcome, result.actor]),
    [
      [true, "applied", "person-admin"],
      [false, "version_conflict", "person-admin"],
    ],
  );
  assert.deepEqual([results[1]!.expectedVersion, results[1]!.currentVersion], [version, ""]);
  assert.equal(keycloak.writes.filter((write) => write.startsWith("DELETE /clients/")).length, 1);
  assert.deepEqual(
    (await nodes()).map(({ nodeId }) => nodeId),
    ["edge-b"],
    "only the named node is removed",
  );
  assert.equal(await registry.authenticate("edge-a", credential), false);
  assert.equal(await registry.nodeOwner("edge-a"), null);
  // The removal is audited like every other registry write.
  const removal = journal()
    .map((line) => JSON.parse(line) as { operation: string; phase: string; outcome?: string })
    .filter((record) => record.operation === "node-unregister")
    .map(({ phase, outcome }) => [phase, outcome]);
  assert.deepEqual(removal, [
    ["settled", "version_conflict"],
    ["intent", undefined],
    ["settled", "applied"],
    ["settled", "version_conflict"],
  ]);
  // Registering the node again mints a new credential; the removed one stays refused.
  const again = await run({ operation: "node-register", nodeId: "edge-a", personId: "alice" });
  assert.notEqual(again.credential, credential);
  assert.equal(await registry.authenticate("edge-a", credential), false);
  assert.equal(await registry.authenticate("edge-a", String(again.credential)), true);
});

test("node registration needs an administrator, a known person, and a well-formed node id", async () => {
  const { keycloak, run, signIn } = await fixture();
  keycloak.account("alice");
  await assert.rejects(run({ operation: "node-register", nodeId: "edge-a", personId: "nobody" }), {
    code: "access_person_unknown",
  });
  await assert.rejects(run({ operation: "node-register", nodeId: "edge a/../b", personId: "alice" }), {
    code: "node_invalid",
  });
  signIn("person-member", ["offline_access"]);
  for (const operation of ["node-list", "node-register", "node-unregister"])
    await assert.rejects(
      run({ operation, nodeId: "edge-a", personId: "alice", expectedVersion: "any" }),
      { code: "authorization_denied" },
      operation,
    );
  assert.deepEqual(keycloak.writes, []);
});

test("one person gets one answer for one action on one object, through a local session or either node", async () => {
  const { keycloak, run, evaluate } = await fixture();
  keycloak.account("alice");
  await run({ operation: "grant", personId: "alice", groupId: "contributor", resource: "repo-a" });
  await run({ operation: "grant", personId: "alice", groupId: "maintainer", resource: "repo-a:task/task-owned" });
  const cases: readonly (readonly [string, RepoTaskAction, string])[] = [
      ["a repository-level contributor action", { kind: "task-create" }, "allowed"],
      ["a maintainer action on the one task granted", { kind: "task-complete", taskId: "task-owned" }, "allowed"],
      ["the same maintainer action on another task", { kind: "task-complete", taskId: "task-other" }, "denied"],
      ["an administrator action", { kind: "people-add" }, "denied"],
    ],
    table: Record<string, string[]> = {};
  for (const [label, action, expected] of cases) {
    const outcomes = await Promise.all(Object.values(entries("alice")).map((binding) => evaluate(binding, action)));
    table[label] = outcomes;
    assert.deepEqual(outcomes, [expected, expected, expected], label);
  }
  // The table holds both answers, so three equal columns are not the product of a path that only ever denies.
  assert.deepEqual([...new Set(Object.values(table).flat())].sort(), ["allowed", "denied"]);
});

test("the answer follows the person a node is registered to, not the node", async () => {
  const { keycloak, run, evaluate, nodes, registry } = await fixture();
  keycloak.account("alice");
  keycloak.account("bob");
  await run({ operation: "grant", personId: "alice", groupId: "contributor", resource: "repo-a" });
  await run({ operation: "node-register", nodeId: "edge-a", personId: "alice" });
  const through = async () => {
    const owner = await registry.nodeOwner("edge-a");
    assert.ok(owner);
    return [owner, await evaluate(entries(owner)["edge-a"]!, { kind: "task-create" })];
  };
  assert.deepEqual(await through(), ["alice", "allowed"]);
  await run({
    operation: "node-register",
    nodeId: "edge-a",
    personId: "bob",
    expectedVersion: (await nodes())[0]!.version,
  });
  assert.deepEqual(await through(), ["bob", "denied"], "the same node now carries bob, who holds no grant");
  await run({ operation: "grant", personId: "bob", groupId: "contributor", resource: "repo-a" });
  assert.deepEqual(await through(), ["bob", "allowed"]);
});

test("an actor reported by the assignment or the frame never reaches the decision", async () => {
  const { keycloak, run, evaluate, root } = await fixture();
  keycloak.account("alice");
  keycloak.account("root-admin");
  await run({ operation: "grant", personId: "root-admin", groupId: "admin", resource: "repo-a" });
  const assignment = {
      assignmentId: "assignment-a",
      nodeId: "edge-a",
      repoId: "repo-a",
      viewId: "view-a",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scope: { kind: "task" as const, taskId: "task-owned", executionId: "execution-1", paths: ["src"] },
    },
    selfReported = { principal: { personId: "root-admin" }, executor: { kind: "agent", id: "edge-a" } },
    derive = (extra: Readonly<Record<string, unknown>>, assignmentExtra: Readonly<Record<string, unknown>>) =>
      deriveBinding(root, {
        transportKind: "fleet-tls",
        assignmentBinding: { ...assignment, ...assignmentExtra },
        nodePrincipal: { nodeId: "edge-a", personId: "alice" },
        keycloakCenter: async () => center,
        ...extra,
      } as Parameters<typeof deriveBinding>[1]),
    plain = await derive({}, {}),
    claimed = await derive({ actor: selfReported, personId: "root-admin" }, { actor: selfReported });
  assert.deepEqual(claimed, plain);
  assert.deepEqual(claimed.actor, { principal: { personId: "alice" }, executor: null });
  // root-admin holds the action; the node's owner does not, and the claim does not lend it to her.
  assert.equal(await evaluate(entries("root-admin")["edge-a"]!, { kind: "people-add" }), "allowed");
  assert.equal(await evaluate(claimed, { kind: "people-add" }), "denied");
  // A frame whose node has no registered owner is not carried by a claim either.
  await assert.rejects(
    deriveBinding(root, {
      transportKind: "fleet-tls",
      assignmentBinding: { ...assignment, actor: selfReported },
      keycloakCenter: async () => center,
    } as Parameters<typeof deriveBinding>[1]),
    { code: "authentication_required" },
  );
});

test("a person evaluated through the center needs a center credential and a Keycloak account", async () => {
  const { keycloak, run, evaluate } = await fixture();
  keycloak.account("alice");
  await run({ operation: "grant", personId: "alice", groupId: "contributor", resource: "repo-a" });
  const edge = entries("alice")["edge-a"]!;
  assert.equal(await evaluate(edge, { kind: "task-create" }), "allowed");
  // A session that belongs to someone else does not speak for alice, and without the center nothing does.
  assert.equal(
    await evaluate(
      { ...edge, keycloakAuthorization: { session: { ...entries("bob").local!.keycloakAuthorization!.session! } } },
      { kind: "task-create" },
    ),
    "denied",
  );
  assert.equal(await evaluate(entries("ghost")["edge-a"]!, { kind: "task-create" }), "denied");
});
