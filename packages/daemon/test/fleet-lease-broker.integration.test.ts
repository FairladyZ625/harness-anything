// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@harness-anything/kernel";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetUploadClient,
  runFleetTaskCommandClient,
} from "../src/fleet/edge.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { parseFleetFrame } from "../src/fleet/contract.ts";

// The retired broker suite is replaced by canonical lease tests through actual TLS clients.
test(
  "same-person nodes race one canonical lease, reject immediately and preserve its holder on restart",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    assert.equal(
      (await f.command("node-one", { kind: "task-create", taskId: "task-race", title: "Race" })).outcome,
      "applied",
    );
    const before = f.eventCount();
    const results = await Promise.all(
      ["node-one", "node-two", "center-node"].map((nodeId) =>
        f.command(nodeId, { kind: "task-start", taskId: "task-race" }),
      ),
    );
    assert.equal(results.filter((r) => r.outcome === "applied").length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.code === "lease_conflict").length, 2, JSON.stringify(results));
    assert.equal(f.eventCount(), before + 1);
    const shown = await f.command("node-one", { kind: "task-show", taskId: "task-race" });
    const lease = JSON.parse(String(shown.receipt?.evidence)).lease;
    assert.equal(lease.source.kind, "node");
    assert.ok(["node-one", "node-two", "center-node"].includes(lease.source.nodeId));
    await f.center.close();
    await f.closeHost(f.host);
    const host = await f.openHost();
    const center = await f.openCenter(host);
    const after = await f.commandOn(center, "node-one", { kind: "task-show", taskId: "task-race" });
    assert.deepEqual(JSON.parse(String(after.receipt?.evidence)).lease, lease);
  },
);

test(
  "node selector rejects same person's other node and reassigned owner; release retains selector",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    await f.command("node-one", { kind: "task-create", taskId: "task-node", title: "Node" });
    const shown = await f.command("node-one", { kind: "task-show", taskId: "task-node" });
    const snapshot = JSON.parse(String(shown.receipt?.evidence));
    const assigned = await f.command("node-one", {
      kind: "task-assign",
      taskId: "task-node",
      nodeId: "node-one",
      expectedVersion: snapshot.revision,
    });
    assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));
    const wrong = await f.command("node-two", { kind: "task-start", taskId: "task-node" });
    assert.equal(wrong.code, "task_assignee_mismatch", JSON.stringify(wrong));
    assert.equal((await f.command("node-one", { kind: "task-start", taskId: "task-node" })).outcome, "applied");
    const deniedRelease = await f.command("node-two", { kind: "task-release", taskId: "task-node" });
    assert.equal(deniedRelease.code, "lease_conflict", JSON.stringify(deniedRelease));
    assert.equal((await f.command("node-one", { kind: "task-release", taskId: "task-node" })).outcome, "applied");
    const released = JSON.parse(
      String((await f.command("node-one", { kind: "task-show", taskId: "task-node" })).receipt?.evidence),
    );
    assert.equal(released.task.assignment.assignee.nodeId, "node-one");
    f.owners.reassign("node-one", "person-new");
    assert.equal(
      (await f.command("node-one", { kind: "task-start", taskId: "task-node" })).code,
      "task_assignee_mismatch",
    );
  },
);

test("permission revocation rejects task start without an accepted write", { timeout: 60_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  await f.command("node-one", { kind: "task-create", taskId: "task-revoke", title: "Revoke" });
  f.owners.keycloak.revoke("person-one", "lease-repo", ["task-start"]);
  const before = f.eventCount();
  const denied = await f.command("node-one", { kind: "task-start", taskId: "task-revoke" });
  assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
  assert.equal(f.eventCount(), before);
});

test(
  "metadata retains owned epoch and stale writer cannot append; retired assignment frames reject",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const peer = f.peer("node-one");
    const metadata = await readFleetRepositoryMetadataClient(peer);
    assert.equal(metadata.repoId, "lease-repo");
    assert.ok(metadata.writerEpoch > 0);
    assert.ok(!("scope" in metadata));
    const authority = openPersistentWriterEpoch({ stateRoot: f.writerEpochStateRoot });
    try {
      const successor = authority.acquire("lease-repo");
      assert.ok(successor.epoch > metadata.writerEpoch);
      assert.equal((await readFleetRepositoryMetadataClient(peer)).writerEpoch, metadata.writerEpoch);
      const before = f.eventCount();
      const rejected = await f.command("node-one", { kind: "task-create", taskId: "task-stale", title: "Stale" });
      assert.equal(rejected.code, "writer_epoch_stale", JSON.stringify(rejected));
      assert.equal(f.eventCount(), before);
    } finally {
      authority.close();
    }
    assert.throws(() =>
      parseFleetFrame(JSON.stringify({ schema: "fleet.assignment.get/v1", messageId: "old", assignmentId: "old" })),
    );
  },
);

test(
  "delivery preflight preserves task-scoped submit grants and rejects revocation and changed owner",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const peer = f.peer("node-one");
    f.owners.keycloak.revoke("person-one", "lease-repo", ["task-submit"]);
    f.owners.keycloak.permit("person-one", "lease-repo:task/task-delivery", ["task-submit"]);
    const allowed = await readFleetRepositoryMetadataClient({
      ...peer,
      actionKind: "task-submit",
      taskId: "task-delivery",
    });
    assert.equal(allowed.personId, "person-one");
    assert.equal(allowed.actionAllowed, true);
    assert.equal(
      (await readFleetRepositoryMetadataClient({ ...peer, actionKind: "task-submit", taskId: "task-other" }))
        .actionAllowed,
      false,
    );
    f.owners.keycloak.revoke("person-one", "lease-repo:task/task-delivery", ["task-submit"]);
    assert.equal(
      (await readFleetRepositoryMetadataClient({ ...peer, actionKind: "task-submit", taskId: "task-delivery" }))
        .actionAllowed,
      false,
    );
    f.owners.reassign("node-one", "person-replacement");
    assert.equal((await readFleetRepositoryMetadataClient(peer)).personId, "person-replacement");
    assert.throws(() =>
      parseFleetFrame(
        JSON.stringify({
          schema: "fleet.repo.metadata.get/v1",
          messageId: "metadata-invalid",
          repoId: "lease-repo",
          actionKind: "not-a-declared-action",
        }),
      ),
    );
  },
);

test(
  "reserve bundles enforce node selector, task package and a single canonical append",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const first = await f.command("node-one", { kind: "task-create", taskId: "task-bundle", title: "Bundle" });
    const other = await f.command("node-one", { kind: "task-create", taskId: "task-other", title: "Other" });
    await f.host.settleMaterialization("lease-repo", "bundle canonical fixture");
    const logical = String(first.receipt?.packagePath) + "/task_plan.md";
    const otherLogical = String(other.receipt?.packagePath) + "/task_plan.md";
    const prepare = async (nodeId: string, docPath = logical) => {
      const originalBody = readFileSync(path.join(f.repo, "harness", docPath), "utf8");
      const body = originalBody + "\n## Node candidate\n\n" + nodeId + "\n";
      const [candidate] = await runFleetUploadClient({ ...f.peer(nodeId), changes: [{ path: docPath, body }] });
      return {
        path: docPath,
        baseBlobSha256: sha256Bytes(Buffer.from(originalBody)),
        policyId: "markdown-body-replaceable/v1",
        candidate: candidate!,
      };
    };
    const submit = (nodeId: string, doc: Awaited<ReturnType<typeof prepare>>) =>
      runFleetTaskCommandClient({
        ...f.peer(nodeId),
        opId: randomUUID(),
        taskId: "task-bundle",
        action: { kind: "task-start", taskId: "task-bundle" },
        waitMs: 5000,
        docChanges: [doc],
      });
    const shown = JSON.parse(
      String((await f.command("node-one", { kind: "task-show", taskId: "task-bundle" })).receipt?.evidence),
    );
    assert.equal(
      (
        await f.command("node-one", {
          kind: "task-assign",
          taskId: "task-bundle",
          nodeId: "node-one",
          expectedVersion: shown.revision,
        })
      ).outcome,
      "applied",
    );
    const before = f.eventCount();
    const wrongNode = await submit("node-two", await prepare("node-two"));
    assert.equal(wrongNode.code, "task_assignee_mismatch", JSON.stringify(wrongNode));
    assert.equal((await submit("node-one", await prepare("node-one", otherLogical))).code, "execution_scope_mismatch");
    assert.equal(f.eventCount(), before);
    const assigned = JSON.parse(
      String((await f.command("node-one", { kind: "task-show", taskId: "task-bundle" })).receipt?.evidence),
    );
    assert.equal(
      (
        await f.command("node-one", {
          kind: "task-unassign",
          taskId: "task-bundle",
          expectedVersion: assigned.revision,
        })
      ).outcome,
      "applied",
    );
    const docs = await Promise.all(["node-one", "node-two"].map((n) => prepare(n)));
    const start = f.eventCount();
    const results = await Promise.all(docs.map((doc, i) => submit(i === 0 ? "node-one" : "node-two", doc)));
    assert.equal(results.filter((r) => r.outcome === "applied").length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.outcome === "op_rejected").length, 1, JSON.stringify(results));
    assert.equal(f.eventCount(), start + 1);
    await f.host.settleMaterialization("lease-repo", "bundle race published");
    const body = readFileSync(path.join(f.repo, "harness", logical), "utf8");
    const winner = JSON.parse(
      String((await f.command("node-one", { kind: "task-show", taskId: "task-bundle" })).receipt?.evidence),
    );
    assert.ok(body.includes("## Node candidate\n\n" + winner.lease.source.nodeId + "\n"));
    assert.equal((body.match(/## Node candidate/g) ?? []).length, 1);
  },
);
