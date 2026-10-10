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
import { KeycloakPolicyAdapter } from "../src/keycloak-policy-adapter.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { parseFleetFrame } from "../src/fleet/contract.ts";

// dec_2665E58BA5AE42E37793193748/CH1: independent machines never inherit owner grants or teams.
// The retired broker suite is replaced by canonical lease tests through actual TLS clients.
test(
  "independent machines race one explicitly assigned canonical lease, reject immediately and preserve its holder on restart",
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
    assert.equal(results.filter((r) => r.code === "task_assignee_mismatch").length, 2, JSON.stringify(results));
    assert.equal(f.eventCount(), before + 1);
    // task-show is answered by the edge replica; a forwarded task-show is not a fleet frame at all.
    await assert.rejects(
      f.command("node-one", { kind: "task-show", taskId: "task-race" }),
      /violates closed schema fleet\.task\.command\/v1/u,
    );
    const shown = await f.host.run(
      "lease-repo",
      { kind: "task-show", taskId: "task-race" },
      f.owners.auth({ nodeId: "node-one" }),
    );
    const lease = JSON.parse(String(shown.evidence)).lease;
    assert.equal(lease.source.kind, "node");
    assert.ok(["node-one", "node-two", "center-node"].includes(lease.source.nodeId));
    await f.center.close();
    await f.closeHost(f.host);
    const host = await f.openHost();
    await f.openCenter(host);
    const after = await host.run(
      "lease-repo",
      { kind: "task-show", taskId: "task-race" },
      f.owners.auth({ nodeId: "node-one" }),
    );
    assert.deepEqual(JSON.parse(String(after.evidence)).lease, lease);
  },
);

test(
  "node selector rejects another machine, survives owner changes, and expires closed for machines",
  { timeout: 60_000 },
  async (t) => {
    let clock = Date.now();
    const f = await fleetNodeClaimFixture(t, undefined, undefined, () => new Date(clock).toISOString());
    await f.command("node-one", { kind: "task-create", taskId: "task-node", title: "Node" });
    const shown = await f.host.run(
      "lease-repo",
      { kind: "task-show", taskId: "task-node" },
      f.owners.auth({ nodeId: "node-one" }),
    );
    const snapshot = JSON.parse(String(shown.evidence));
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
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-node" },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
    );
    assert.equal(released.task.assignment.assignee.nodeId, "node-one");
    f.owners.reassign("node-one", "person-new");
    assert.equal((await f.command("node-one", { kind: "task-start", taskId: "task-node" })).outcome, "applied");
    await f.command("node-two", { kind: "task-create", taskId: "task-expired", title: "Expired selector" });
    const unassigned = JSON.parse(
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-expired" },
            f.owners.auth({ nodeId: "node-two" }),
          )
        ).evidence,
      ),
    );
    const expiry = new Date(clock + 10000).toISOString();
    const expired = await f.command("node-two", {
      kind: "task-assign",
      taskId: "task-expired",
      nodeId: "node-one",
      expiresAt: expiry,
      expectedVersion: unassigned.revision,
    });
    assert.equal(expired.outcome, "applied", JSON.stringify(expired));
    clock += 10001;
    const next = await f.command("node-two", { kind: "task-start", taskId: "task-expired" });
    assert.equal(next.code, "task_assignee_mismatch", JSON.stringify(next));
    const taken = JSON.parse(
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-expired" },
            f.owners.auth({ nodeId: "node-two" }),
          )
        ).evidence,
      ),
    );
    assert.equal(taken.lease, null);
    assert.equal(taken.task.assignment.expiresAt, expiry);
  },
);

test("permission revocation rejects task start without an accepted write", { timeout: 60_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  await f.command("node-one", { kind: "task-create", taskId: "task-revoke", title: "Revoke" });
  f.owners.keycloak.revoke((await f.owners.nodeSubject("node-one"))!, "lease-repo", ["task-start"]);
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
  "delivery preflight preserves machine task grants, rejects revocation and ignores changed owner",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    const peer = f.peer("node-one");
    f.owners.keycloak.revoke((await f.owners.nodeSubject("node-one"))!, "lease-repo", ["task-submit"]);
    f.owners.keycloak.permit((await f.owners.nodeSubject("node-one"))!, "lease-repo:task/task-delivery", [
      "task-submit",
    ]);
    const allowed = await readFleetRepositoryMetadataClient({
      ...peer,
      actionKind: "task-submit",
      taskId: "task-delivery",
    });
    assert.deepEqual(allowed.principal, {
      kind: "machine",
      nodeId: "node-one",
      subject: await f.owners.nodeSubject("node-one"),
    });
    assert.equal(allowed.actionAllowed, true);
    assert.equal(
      (await readFleetRepositoryMetadataClient({ ...peer, actionKind: "task-submit", taskId: "task-other" }))
        .actionAllowed,
      false,
    );
    f.owners.keycloak.revoke((await f.owners.nodeSubject("node-one"))!, "lease-repo:task/task-delivery", [
      "task-submit",
    ]);
    assert.equal(
      (await readFleetRepositoryMetadataClient({ ...peer, actionKind: "task-submit", taskId: "task-delivery" }))
        .actionAllowed,
      false,
    );
    f.owners.reassign("node-one", "person-replacement");
    assert.deepEqual((await readFleetRepositoryMetadataClient(peer)).principal, allowed.principal);
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
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-bundle" },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
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
    assert.equal((await f.command("node-one", { kind: "task-start", taskId: "task-other" })).outcome, "applied");
    const before = f.eventCount();
    const wrongNode = await submit("node-two", await prepare("node-two"));
    assert.equal(wrongNode.code, "task_assignee_mismatch", JSON.stringify(wrongNode));
    assert.equal((await submit("node-one", await prepare("node-one", otherLogical))).code, "execution_scope_mismatch");
    assert.equal(f.eventCount(), before);
    const assigned = JSON.parse(
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-bundle" },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
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
    const unassignedStart = await f.command("node-one", { kind: "task-start", taskId: "task-bundle" });
    assert.equal(unassignedStart.code, "task_assignee_mismatch");
    const unassigned = await f.host.run(
      "lease-repo",
      { kind: "task-show", taskId: "task-bundle" },
      f.owners.auth({ nodeId: "node-one" }),
    );
    assert.equal(
      (
        await f.command("node-one", {
          kind: "task-assign",
          taskId: "task-bundle",
          nodeId: "node-one",
          expectedVersion: JSON.parse(String(unassigned.evidence)).revision,
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
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-bundle" },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
    );
    assert.ok(body.includes("## Node candidate\n\n" + winner.lease.source.nodeId + "\n"));
    assert.equal((body.match(/## Node candidate/g) ?? []).length, 1);
  },
);

test(
  "native team membership is current and never substitutes for task-start permission",
  { timeout: 60000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, async (auth) =>
      new OidcSessionService(path.join(f.root, "user")).bind(auth),
    );
    f.owners.keycloak.interactiveSession("person-one", "node-one", f.owners.url);
    const humanCommand = (action: Record<string, unknown>) =>
      f.command("node-one", action, 5000, String(action.taskId), "token-person-one");
    const adapter = new KeycloakPolicyAdapter({
      url: f.owners.url,
      realm: "harness",
      resourceServerClientId: "harness-center",
    });
    await adapter.createTeam("center-token", "workers");
    const team = (await adapter.readTeams("center-token"))[0]!;
    const member = await adapter.findUserId("center-token", "person-one");
    assert.ok(member);
    await adapter.setTeamMember("center-token", team.id, member, true);
    await f.command("node-one", { kind: "task-create", taskId: "task-team", title: "Team" });
    const snapshot = JSON.parse(
      String(
        (
          await f.host.run(
            "lease-repo",
            { kind: "task-show", taskId: "task-team" },
            f.owners.auth({ nodeId: "node-one" }),
          )
        ).evidence,
      ),
    );
    assert.equal(
      (
        await f.command("node-one", {
          kind: "task-assign",
          taskId: "task-team",
          teamId: team.id,
          expectedVersion: snapshot.revision,
        })
      ).outcome,
      "applied",
    );
    const machineDenied = await f.command("node-one", { kind: "task-start", taskId: "task-team" });
    assert.equal(machineDenied.code, "task_assignee_mismatch");
    const before = f.eventCount();
    f.owners.keycloak.revoke("person-one", "lease-repo", ["task-start"]);
    const noPermission = await humanCommand({ kind: "task-start", taskId: "task-team" });
    assert.equal(noPermission.outcome, "op_rejected", JSON.stringify(noPermission));
    assert.equal(f.eventCount(), before);
    f.owners.keycloak.permit("person-one", "lease-repo", ["task-start"]);
    await adapter.setTeamMember("center-token", team.id, member, false);
    const removed = await humanCommand({ kind: "task-start", taskId: "task-team" });
    assert.equal(removed.code, "task_assignee_mismatch", JSON.stringify(removed));
    assert.equal(f.eventCount(), before);
    await adapter.setTeamMember("center-token", team.id, member, true);
    assert.equal((await humanCommand({ kind: "task-start", taskId: "task-team" })).outcome, "applied");
  },
);

test("unreachable Keycloak refuses task-start without an accepted canonical write", { timeout: 60000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  await f.command("node-one", { kind: "task-create", taskId: "task-offline", title: "Offline" });
  const before = f.eventCount();
  await f.owners.close();
  const denied = await f.command("node-one", { kind: "task-start", taskId: "task-offline" }).catch((error: unknown) => {
    assert.ok(error instanceof Error && "code" in error, String(error));
    return { outcome: "op_rejected", code: error.code };
  });
  assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
  // Center token acquisition fails before RepoCell authorization when the realm is offline.
  assert.equal(denied.code, "daemon_error", JSON.stringify(denied));
  assert.equal(f.eventCount(), before);
});

test("node document reads remain bound to the canonical lease scope", { timeout: 60000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  const created = await f.command("node-one", { kind: "task-create", taskId: "task-read", title: "Read" });
  const action = { kind: "doc-show", path: String(created.receipt?.packagePath) + "/task_plan.md" };
  const auth = f.owners.auth({ nodeId: "node-one" });
  const before = f.eventCount();
  const unheld = await f.host.run("lease-repo", action, auth);
  assert.equal(unheld.code, "execution_scope_mismatch", JSON.stringify(unheld));
  assert.equal(f.eventCount(), before);
  assert.equal((await f.command("node-one", { kind: "task-start", taskId: "task-read" })).outcome, "applied");
  const held = f.eventCount();
  const shown = await f.host.run("lease-repo", action, auth);
  assert.equal(shown.outcome, "applied", JSON.stringify(shown));
  assert.match(String(shown.evidence), /Read/);
  const other = await f.host.run("lease-repo", action, f.owners.auth({ nodeId: "node-two" }));
  assert.equal(other.code, "execution_scope_mismatch", JSON.stringify(other));
  assert.equal(f.eventCount(), held);
});
