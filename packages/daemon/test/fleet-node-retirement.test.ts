// harness-test-tier: contract
import path from "node:path";
import { createReplicationRetention, openReplicationSlots } from "@harness-anything/storage";
import { createReplicaStatusTracker } from "../src/fleet/replica-status.ts";
import { renderCliReceipt } from "@harness-anything/cli/internal/cli/receipt-render-registry";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { AccessAdminService } from "../src/access-admin-service.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { managedRbacReceiptJournal } from "../src/access-admin-state.ts";
import { fakeKeycloak, keycloakUserRoot, keycloakUrl, keycloakRealm } from "./keycloak.fixtures.ts";

function retirementFixture(t: TestContext, ownerExists = true) {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot();
  t.after(user.cleanup);
  if (ownerExists) keycloak.account("person-owner");
  const credential = keycloak.node("retired-test-node", "person-owner"),
    oidc = createIdentitySession(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch }),
    provider = new KeycloakPolicyAdapter(
      { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
      keycloak.fetch,
    );
  return { admin, provider, credential, userRoot: user.root, fetch: keycloak.fetch, keycloak };
}

test("node-unregister without explicit confirmation previews without changing access or recording a write", async (t) => {
  const { admin, provider, credential, userRoot } = retirementFixture(t),
    before = await provider.readNode("center-token", "retired-test-node");
  assert.equal(await provider.authenticateNode("retired-test-node", credential), true);
  const result = await admin.run({ operation: "node-unregister", nodeId: "retired-test-node", expectedVersion: "1" });
  assert.equal(result.dryRun, true, JSON.stringify(result));
  assert.deepEqual(await provider.readNode("center-token", "retired-test-node"), before);
  assert.equal(await provider.authenticateNode("retired-test-node", credential), true);
  assert.deepEqual(managedRbacReceiptJournal(userRoot).read(), []);
});

test("confirmed retirement revokes a device even when its owner account no longer exists", async (t) => {
  const { admin, provider, credential } = retirementFixture(t, false),
    request = { operation: "node-unregister", nodeId: "retired-test-node", expectedVersion: "1", confirm: true };
  const result = await admin.run(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await provider.authenticateNode("retired-test-node", credential), false);
  const node = await provider.readNode("center-token", "retired-test-node");
  assert.equal(node?.state, "removed");
  assert.equal(node?.revocation, "complete");
});

test("retirement preview enumerates all repository slots; confirmed removal fences old ACKs and preserves other nodes", async (t) => {
  const { admin, userRoot } = retirementFixture(t, false),
    slots = openReplicationSlots(path.join(userRoot, "fleet", "replication-slots.sqlite")),
    old = slots.claim({ repoId: "repo-a", nodeId: "retired-test-node" }, "history"),
    other = slots.claim({ repoId: "repo-a", nodeId: "other-node" }, "history");
  t.after(() => slots.close());
  slots.claim({ repoId: "repo-b", nodeId: "retired-test-node" }, "history");
  const position = { history: "history", sequence: 1, revision: 1 },
    ack = { durable: position, applied: position };
  slots.acknowledge(old, ack, position);
  const otherPosition = { ...position, sequence: 3, revision: 3 };
  slots.acknowledge(other, { durable: otherPosition, applied: otherPosition }, otherPosition);
  const pruned: number[] = [],
    retention = createReplicationRetention({
      windowCommits: 100,
      slotFloor: () => slots.minimumAck("repo-a", "history"),
      prune: (sequence) => {
        pruned.push(sequence);
      },
    }),
    unpin = retention.pin({ ...position, sequence: 2, revision: 2 }),
    head = { ...position, sequence: 5, revision: 5 };
  await retention.advance(head);
  const before = slots.list().filter((slot) => slot.nodeId === "other-node"),
    preview = await admin.run({ operation: "node-unregister", nodeId: "retired-test-node" });
  assert.equal(preview.dryRun, true);
  const humanPreview = renderCliReceipt(preview).text;
  assert.match(humanPreview, /Dry run/u);
  assert.match(humanPreview, /retired-test-node/u, "default CLI text must show the selected node");
  assert.match(humanPreview, /repo-a/u, "default CLI text must show the affected repository slots");
  assert.match(humanPreview, /expectedVersion/u, "default CLI text must show the version required for confirmation");
  assert.deepEqual(
    (preview.slots as { repoId: string }[]).map((slot) => slot.repoId),
    ["repo-a", "repo-b"],
  );
  assert.equal(slots.current(old), true);
  const result = await admin.run({
    operation: "node-unregister",
    nodeId: "retired-test-node",
    expectedVersion: String(preview.expectedVersion),
    confirm: true,
  });
  assert.equal(result.ok, true);
  assert.match(renderCliReceipt(result).text, /Node retired/u);
  assert.match(renderCliReceipt(result).text, /retired-test-node/u);
  assert.match(renderCliReceipt(result).text, /repo-b/u);
  assert.deepEqual(slots.list(), before);
  assert.equal(slots.current(old), false);
  assert.throws(() => slots.acknowledge(old, ack, position), /fenced/u);
  assert.equal(slots.current(other), true);
  await retention.advance(head);
  unpin();
  await retention.advance(head);
  assert.deepEqual(
    pruned,
    [1, 2, 3],
    "retirement releases only its slot floor, preserving the backup pin and healthy ACK",
  );
  const tracker = createReplicaStatusTracker({
    slots,
    attachedRepositories: () => new Set(["repo-a", "repo-z"]),
    head: () => head,
    isConnected: () => false,
    diskQuotaBytes: null,
  });
  tracker.recordFailure(
    { nodeId: "retired-test-node", repoId: "repo-z" },
    { code: "edge_upgrade_required", message: "old edge" },
  );
  assert.ok(tracker.snapshot().some((row) => row.nodeId === "retired-test-node"));
  tracker.removeNode("retired-test-node");
  assert.deepEqual(
    tracker.snapshot().map((row) => row.nodeId),
    ["other-node"],
  );
  const receipts = managedRbacReceiptJournal(userRoot)
    .read()
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    receipts.map((row) => row.phase),
    ["intent", "settled"],
  );
  assert.equal(receipts[1].retirement.slots.length, 2);
  assert.equal(receipts[1].actor, "person-admin");
});

test("busy admission checks online, lease and execution independently; force remains explicit and audited", async (t) => {
  for (const reason of ["online", "leases", "executions"] as const) {
    const { fetch: fixtureFetch, userRoot, provider, credential } = retirementFixture(t),
      snapshot = {
        online: reason === "online",
        inFlight: 0,
        slots: [],
        leases: reason === "leases" ? [{ repoId: "repo", taskId: "task", executionId: "execution" }] : [],
        executions: reason === "executions" ? [{ repoId: "repo", runtimeSessionId: "runtime" }] : [],
      };
    let fenced = 0,
      removed = 0;
    const admin = new AccessAdminService(createIdentitySession(userRoot, { fetch: fixtureFetch }), userRoot, {
      fetch: fixtureFetch,
      nodeRetirement: {
        inspect: () => snapshot,
        drain: async () => undefined,
        fence: () => {
          fenced++;
          return () => {
            fenced--;
          };
        },
        remove: () => {
          removed++;
        },
      },
    });
    await assert.rejects(
      admin.run({ operation: "node-unregister", nodeId: "retired-test-node", expectedVersion: "1", confirm: true }),
      { code: "node_busy" },
    );
    assert.equal(await provider.authenticateNode("retired-test-node", credential), true);
    assert.equal(fenced, 0);
    assert.equal(removed, 0);
    const forced = await admin.run({
      operation: "node-unregister",
      nodeId: "retired-test-node",
      expectedVersion: "1",
      confirm: true,
      force: true,
    });
    assert.equal(forced.ok, true);
    assert.equal(fenced, 0);
    assert.equal(removed, 1);
    assert.deepEqual((forced.retirement as { leases: unknown }).leases, snapshot.leases);
  }
});

test("orphan slots with no registry client can be retired without making their old identity reusable", async (t) => {
  const { admin, keycloak, provider, userRoot } = retirementFixture(t, false),
    slots = openReplicationSlots(path.join(userRoot, "fleet", "replication-slots.sqlite"));
  t.after(() => slots.close());
  keycloak.nodeClients.delete("harness-node-retired-test-node");
  slots.claim({ repoId: "orphan-repo", nodeId: "retired-test-node" }, "orphan-history");
  const preview = await admin.run({ operation: "node-unregister", nodeId: "retired-test-node" });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.personId, null);
  assert.equal(preview.expectedVersion, "unregistered");
  const result = await admin.run({
    operation: "node-unregister",
    nodeId: "retired-test-node",
    expectedVersion: "unregistered",
    confirm: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(slots.list(), []);
  assert.equal((await provider.readNode("center-token", "retired-test-node"))?.state, "removed");
  assert.equal(await provider.authenticateNode("retired-test-node", "old-secret"), false);
  keycloak.account("new-owner");
  await assert.rejects(
    admin.run({ operation: "node-register", nodeId: "retired-test-node", personId: "new-owner", expectedVersion: "1" }),
    { code: "device_removed" },
  );
  await assert.rejects(admin.run({ operation: "node-unregister", nodeId: "typo-node" }), { code: "node_unknown" });
});
