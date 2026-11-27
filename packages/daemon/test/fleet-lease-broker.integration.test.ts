// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@harness-anything/kernel";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import {
  readFleetReceiptClient,
  readFleetRepositoryMetadataClient,
  runFleetUploadClient,
  runFleetTaskCommandClient,
} from "../src/daemon-host/fleet/peer.ts";
import { requireExecutionActionScope } from "../src/daemon-host/runtime-execution-scope.ts";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { KeycloakPolicyAdapter } from "@harness-anything/authorization/keycloak";
import { parseFleetFrame } from "../src/daemon-host/fleet/command-protocol.ts";

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
  "node selector rejects same person's other node and reassigned owner; release retains selector",
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
    // A node principal identifies the current owner of that node. Reassignment of the node
    // therefore follows the assigned principal; it is not a stale person field on the relation.
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
    assert.equal(next.outcome, "applied", JSON.stringify(next));
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
    assert.equal(taken.lease.source.nodeId, "node-two");
    assert.equal(taken.task.assignment.expiresAt, expiry);
  },
);

test("task owner on another node can take over and submit the current execution", { timeout: 60_000 }, async (t) => {
  const taskId = "task-owner-cross-node",
    executionId = "exe-owner-cross-node",
    f = await fleetNodeClaimFixture(t);
  const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(),
    mainBranch = git(f.repo, "branch", "--show-current"),
    origin = path.join(f.root, "task-origin.git");
  git(f.root, "clone", "--bare", "--no-local", f.repo, origin);
  git(f.repo, "remote", "add", "origin", origin);
  git(f.repo, "fetch", "origin");
  git(f.repo, "remote", "set-head", "origin", mainBranch);
  const created = await f.command("node-one", { kind: "task-create", taskId, title: "Cross-node takeover" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const started = await f.command("node-one", { kind: "task-start", taskId, executionId });
  assert.equal(started.outcome, "applied", JSON.stringify(started));

  const foreign = await f.command("center-node", {
    kind: "task-release",
    taskId,
    forceTakeover: true,
    reason: "Reject a principal other than the task owner.",
  });
  assert.equal(foreign.code, "lease_conflict", JSON.stringify(foreign));
  const released = await f.command("node-two", {
    kind: "task-release",
    taskId,
    forceTakeover: true,
    reason: "Worker process exited on node one; owner continues the existing execution.",
  });
  assert.equal(released.outcome, "applied", JSON.stringify(released));
  const rejoined = await f.command("node-two", { kind: "task-start", taskId, executionId });
  assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));

  const shown = await f.host.run("lease-repo", { kind: "task-show", taskId }, f.owners.auth({ nodeId: "node-two" }));
  const current = JSON.parse(String(shown.evidence));
  assert.equal(current.lease.source.nodeId, "node-two");
  assert.equal(current.lease.executionId, executionId);
  const staleWorker = await f.command("node-one", {
    kind: "task-progress-append",
    taskId,
    text: "stale worker write after owner takeover",
  });
  assert.equal(staleWorker.outcome, "op_rejected", JSON.stringify(staleWorker));

  const packagePath = String(created.receipt?.packagePath),
    closeoutPath = `${packagePath}/closeout.md`,
    closeout =
      "## Summary\nOwner took over after worker exit.\n" +
      "## Verification\nCross-node release and rejoin were accepted.\n" +
      "## Residual Risk\nNo live worker remained.\n" +
      "## Same Mechanism Elsewhere\nThe lease fences every node.\n";
  const workerRoot = path.join(f.root, "node-two-worker");
  git(f.root, "clone", "--no-checkout", "--no-local", origin, workerRoot);
  git(workerRoot, "checkout", "-b", taskId, `origin/${mainBranch}`);
  git(workerRoot, "config", "user.name", "person-one");
  git(workerRoot, "config", "user.email", "person-one@users.noreply.github.com");
  writeFileSync(path.join(workerRoot, "delivery.txt"), "Owner takeover delivery.\n");
  git(workerRoot, "add", "delivery.txt");
  git(workerRoot, "commit", "-qm", "feat: deliver after owner takeover");
  const commitSha = git(workerRoot, "rev-parse", "HEAD");
  git(workerRoot, "push", "origin", taskId);
  const [closeoutCandidate] = await runFleetUploadClient({
    ...f.peer("node-two"),
    changes: [{ path: closeoutPath, body: Buffer.from(closeout), mediaType: "text/markdown" }],
  });
  const closeoutBase = sha256Bytes(readFileSync(path.join(f.repo, "harness", closeoutPath)));
  const submitted = await runFleetTaskCommandClient({
    ...f.peer("node-two"),
    opId: randomUUID(),
    taskId,
    action: { kind: "task-submit", taskId, executionId, commitSha },
    waitMs: 5_000,
    docChanges: [
      {
        path: closeoutPath,
        baseBlobSha256: closeoutBase,
        policyId: "markdown-body-replaceable/v1",
        candidate: closeoutCandidate!,
      },
    ],
  });
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  const final = await f.host.run("lease-repo", { kind: "task-show", taskId }, f.owners.auth({ nodeId: "node-two" }));
  const snapshot = JSON.parse(String(final.evidence));
  assert.equal(snapshot.executions[0].state, "submitted");
  assert.equal(
    snapshot.executions[0].actor.executor,
    null,
    "owner takeover submits the current execution without a manual executor declaration",
  );
});

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
    const taskReads: string[] = [];
    const f = await fleetNodeClaimFixture(t, (run) => async (...args) => {
      if (args[1].kind === "task-show") taskReads.push(String(args[1].taskId));
      return run(...args);
    });
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
    assert.deepEqual(taskReads, [], "permission admission must not read a task or require a lease");
    await assert.rejects(
      readFleetRepositoryMetadataClient({
        ...peer,
        actionKind: "task-submit",
        taskId: "task-delivery",
        executionId: null,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "task_read_failed",
      "explicit current-holder proof still requires a canonical task",
    );
    assert.deepEqual(taskReads, ["task-delivery"]);
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
    assert.equal(
      (
        await readFleetRepositoryMetadataClient({
          ...peer,
          actionKind: "task-submit",
          taskId: "task-delivery",
          executionId: null,
        })
      ).actionAllowed,
      false,
      "revoked permission refuses holder proof before reading task state",
    );
    assert.deepEqual(taskReads, ["task-delivery"]);
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
          expectedVersion: assigned.assignmentRevision,
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
    const f = await fleetNodeClaimFixture(t);
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
    const before = f.eventCount();
    f.owners.keycloak.revoke("person-one", "lease-repo", ["task-start"]);
    const noPermission = await f.command("node-one", { kind: "task-start", taskId: "task-team" });
    assert.equal(noPermission.outcome, "op_rejected", JSON.stringify(noPermission));
    assert.equal(f.eventCount(), before);
    f.owners.keycloak.permit("person-one", "lease-repo", ["task-start"]);
    await adapter.setTeamMember("center-token", team.id, member, false);
    const removed = await f.command("node-one", { kind: "task-start", taskId: "task-team" });
    assert.equal(removed.code, "task_assignee_mismatch", JSON.stringify(removed));
    assert.equal(f.eventCount(), before);
    await adapter.setTeamMember("center-token", team.id, member, true);
    assert.equal((await f.command("node-one", { kind: "task-start", taskId: "task-team" })).outcome, "applied");
  },
);

test(
  "a committed task receipt is recoverable by the request opId after its response is lost",
  { timeout: 60000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    await f.command("node-one", { kind: "task-create", taskId: "task-receipt", title: "Receipt" });
    const requestOpId = randomUUID(),
      applied = await runFleetTaskCommandClient({
        ...f.peer("node-one"),
        opId: requestOpId,
        taskId: "task-receipt",
        action: { kind: "task-start", taskId: "task-receipt" },
        waitMs: 5_000,
      });
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const canonicalOpId = applied.receipt?.opId;
    assert.equal(typeof canonicalOpId, "string");
    assert.notEqual(canonicalOpId, requestOpId, "the stored receipt keeps its canonical command identity");

    // The caller only has the request opId after losing the response; receipt-show must still find
    // the committed canonical receipt through the listener's correlation map.
    const recovered = await readFleetReceiptClient({ ...f.peer("node-one"), opId: requestOpId });
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(recovered.opId, canonicalOpId);
    assert.equal(recovered.revision, applied.revision);
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
  assert.equal(denied.code, "keycloak_unavailable", JSON.stringify(denied));
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

function receiptEvidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence));
}

async function prepareCarriedDoc(
  f: Awaited<ReturnType<typeof fleetNodeClaimFixture>>,
  nodeId: string,
  logicalPath: string,
  suffix: string,
) {
  const originalBody = readFileSync(path.join(f.repo, "harness", logicalPath), "utf8");
  const body = `${originalBody}\n<!-- edge note: ${suffix} -->\n`;
  const [candidate] = await runFleetUploadClient({ ...f.peer(nodeId), changes: [{ path: logicalPath, body }] });
  return {
    path: logicalPath,
    baseBlobSha256: sha256Bytes(Buffer.from(originalBody)),
    policyId: "markdown-body-replaceable/v1",
    candidate: candidate!,
  };
}

test(
  "Part B: edge principal under keycloak-policy@1 cleans up own unleased and expired-orphaned historical tasks (with dirty edge docs & N-1 docChanges) and frees WIP while preserving all negative boundaries",
  { timeout: 120_000 },
  async (t) => {
    let clock = "2026-11-27T00:00:00.000Z";
    const f = await fleetNodeClaimFixture(t, undefined, undefined, () => clock);
    const edge = await fleetEdgeHostFixture(t, f, { now: () => clock });

    // Set tight WIP limit = 2 so freeing WIP slots is directly observable.
    const setWip = await f.host.run(
      "lease-repo",
      { kind: "settings-update", wipLimit: 2, idempotencyKey: "edge-cleanup-wip-2" },
      localAuthFixture(),
    );
    assert.equal(setWip.outcome, "applied", JSON.stringify(setWip));

    // 1. Own historical task with released lease + dirty edge mirror file -> transition cancelled frees WIP.
    const createdCancel = await f.command("node-one", {
      kind: "task-create",
      taskId: "task-edge-own-cancel",
      title: "Own historical task to cancel",
    });
    assert.equal(createdCancel.outcome, "applied", JSON.stringify(createdCancel));
    const cancelPkg = String(createdCancel.receipt?.packagePath);
    assert.equal(
      (await f.command("node-one", { kind: "task-start", taskId: "task-edge-own-cancel" })).outcome,
      "applied",
    );
    assert.equal(
      (await f.command("node-one", { kind: "task-release", taskId: "task-edge-own-cancel", reason: "Done locally" }))
        .outcome,
      "applied",
    );
    await f.host.settleMaterialization("lease-repo", "own cancel task settled");

    // 2. Own historical task with expired orphaned lease -> release + resolved-by frees second WIP slot.
    const createdOrphan = await f.command("node-one", {
      kind: "task-create",
      taskId: "task-edge-own-orphan",
      title: "Own historical task with expired orphaned lease",
    });
    assert.equal(createdOrphan.outcome, "applied", JSON.stringify(createdOrphan));
    const orphanPkg = String(createdOrphan.receipt?.packagePath);
    assert.equal(
      (await f.command("node-one", { kind: "task-start", taskId: "task-edge-own-orphan", ttlMs: 60_000 })).outcome,
      "applied",
    );
    await f.host.settleMaterialization("lease-repo", "own orphan task settled");

    // Verify WIP is now full (2/2): a third task cannot start yet.
    assert.equal(
      (await f.command("node-one", { kind: "task-create", taskId: "task-edge-next", title: "Blocked by WIP" })).outcome,
      "applied",
    );
    const wipBlocked = await f.command("node-one", { kind: "task-start", taskId: "task-edge-next" });
    assert.equal(wipBlocked.outcome, "op_rejected", JSON.stringify(wipBlocked));
    assert.equal(wipBlocked.code, "task_wip_limit_reached", JSON.stringify(wipBlocked));

    // Advance clock past TTL so task-edge-own-orphan's lease becomes `orphaned`.
    clock = "2026-11-27T02:00:00.000Z";

    // Simulate N-1 edge client carrying dirty task_plan.md on task-release (orphaned lease) AND task-transition cancelled.
    const orphanDoc = await prepareCarriedDoc(f, "node-one", `${orphanPkg}/task_plan.md`, "orphan-release-dirty");
    const releasedOrphan = await runFleetTaskCommandClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      taskId: "task-edge-own-orphan",
      action: { kind: "task-release", taskId: "task-edge-own-orphan", reason: "Expired orphaned lease cleanup" },
      waitMs: 5_000,
      docChanges: [orphanDoc],
    });
    assert.equal(releasedOrphan.outcome, "applied", JSON.stringify(releasedOrphan));
    assert.equal(
      (releasedOrphan.receipt?.authorizationDecision as { readonly policyRef?: string } | undefined)?.policyRef,
      "keycloak-policy@1",
    );

    // Dirty local file in edge workspace -> both N-1 carried docChanges and direct edge.command succeed without execution_scope_mismatch.
    await edge.command({ kind: "task-show", taskId: "task-edge-own-cancel" });
    const edgePlanPath = path.join(edge.edgeRoot, "harness", ...cancelPkg.split("/"), "task_plan.md");
    mkdirSync(path.dirname(edgePlanPath), { recursive: true });
    writeFileSync(edgePlanPath, "# Dirty local edge task plan\n\n<!-- local dirty edge edit -->\n");
    const cancelDoc = await prepareCarriedDoc(f, "node-one", `${cancelPkg}/task_plan.md`, "cancel-dirty");
    const cancelledOwn = await runFleetTaskCommandClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      taskId: "task-edge-own-cancel",
      action: {
        kind: "task-transition",
        taskId: "task-edge-own-cancel",
        status: "cancelled",
        force: true,
        reason: "Historical task superseded/merged; releasing WIP",
      },
      waitMs: 5_000,
      docChanges: [cancelDoc],
    });
    assert.equal(cancelledOwn.outcome, "applied", JSON.stringify(cancelledOwn));

    // Archive own unleased task via direct edge.command (with dirty edge workspace file) AND verify N-1 carried docChanges.
    await f.host.settleMaterialization("lease-repo", "before archive");
    const edgeArchivedOwn = await edge.command({
      kind: "task-archive",
      taskId: "task-edge-own-cancel",
      reason: "Archive retired own task from edge host with dirty mirror",
    });
    assert.equal(edgeArchivedOwn.outcome, "applied", JSON.stringify(edgeArchivedOwn));

    const createdN1Archive = await f.command("node-one", {
      kind: "task-create",
      taskId: "task-edge-n1-archive",
      title: "Own unleased task for N-1 docChanges archive",
    });
    assert.equal(createdN1Archive.outcome, "applied", JSON.stringify(createdN1Archive));
    const n1ArchivePkg = String(createdN1Archive.receipt?.packagePath);
    await f.host.settleMaterialization("lease-repo", "before N-1 archive");
    const archiveDoc = await prepareCarriedDoc(f, "node-one", `${n1ArchivePkg}/task_plan.md`, "archive-dirty");
    const archivedOwn = await runFleetTaskCommandClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      taskId: "task-edge-n1-archive",
      action: { kind: "task-archive", taskId: "task-edge-n1-archive", reason: "Archive retired own task (N-1)" },
      waitMs: 5_000,
      docChanges: [archiveDoc],
    });
    assert.equal(archivedOwn.outcome, "applied", JSON.stringify(archivedOwn));

    // Complete own historical task via --resolved-by <commitSha> with carried docChanges.
    await f.host.settleMaterialization("lease-repo", "before pinning origin/main");
    const headSha = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", f.repo, "update-ref", "refs/remotes/origin/main", headSha]);
    execFileSync("git", ["-C", f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const recordedFact = await f.command("node-one", {
      kind: "fact-record",
      statement: `Merged on main at ${headSha}`,
      evidenceSource: "test:edge-cleanup",
      confidence: "high",
      memoryClass: "semantic",
    });
    assert.equal(recordedFact.outcome, "applied", JSON.stringify(recordedFact));
    const factId = String(receiptEvidence(recordedFact.receipt as Record<string, unknown>).factId);
    await waitForFleetPublication(f.host, "lease-repo", String(recordedFact.receipt?.opId), localAuthFixture());
    await f.host.settleMaterialization("lease-repo", "before resolved-by");
    const resolvedDoc = await prepareCarriedDoc(f, "node-one", `${orphanPkg}/task_plan.md`, "resolved-by-dirty");
    const completedOwn = await runFleetTaskCommandClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      taskId: "task-edge-own-orphan",
      action: {
        kind: "task-complete",
        taskId: "task-edge-own-orphan",
        resolvedBy: headSha,
        resolutionFact: `fact/${factId}`,
        resolutionRationale: "Commit already merged on main",
      },
      waitMs: 5_000,
      docChanges: [resolvedDoc],
    });
    assert.equal(completedOwn.outcome, "applied", JSON.stringify(completedOwn));

    // WIP is now freed (0/2) -> task-edge-next can start immediately.
    const startedNext = await f.command("node-one", { kind: "task-start", taskId: "task-edge-next" });
    assert.equal(startedNext.outcome, "applied", JSON.stringify(startedNext));

    // --- NEGATIVE CONTROLS ---

    // (a) Active unexpired held lease owned by person-center on center-node -> person-one on node-one MUST be rejected.
    const foreignTask = await f.command("center-node", {
      kind: "task-create",
      taskId: "task-foreign-live",
      title: "Foreign task with live lease",
    });
    assert.equal(foreignTask.outcome, "applied", JSON.stringify(foreignTask));
    const foreignPkg = String(foreignTask.receipt?.packagePath);
    assert.equal(
      (await f.command("center-node", { kind: "task-start", taskId: "task-foreign-live", ttlMs: 3_600_000 })).outcome,
      "applied",
    );
    await f.host.settleMaterialization("lease-repo", "foreign live task");

    const foreignRelease = await f.command("node-one", {
      kind: "task-release",
      taskId: "task-foreign-live",
      reason: "Attempt foreign hijack",
    });
    assert.equal(foreignRelease.outcome, "op_rejected", JSON.stringify(foreignRelease));
    assert.equal(foreignRelease.code, "lease_conflict", JSON.stringify(foreignRelease));

    const foreignCancel = await f.command("node-one", {
      kind: "task-transition",
      taskId: "task-foreign-live",
      status: "cancelled",
      force: true,
      reason: "Attempt foreign cancel",
    });
    assert.equal(foreignCancel.outcome, "op_rejected", JSON.stringify(foreignCancel));

    const foreignArchive = await f.command("node-one", {
      kind: "task-archive",
      taskId: "task-foreign-live",
      reason: "Attempt foreign archive",
    });
    assert.equal(foreignArchive.outcome, "op_rejected", JSON.stringify(foreignArchive));
    assert.equal(foreignArchive.code, "active_lease", JSON.stringify(foreignArchive));

    // (b) Foreign unleased task (owned by person-center) with carried docChanges from person-one -> rejected with execution_scope_mismatch.
    assert.equal(
      (await f.command("center-node", { kind: "task-release", taskId: "task-foreign-live", reason: "Owner releases" }))
        .outcome,
      "applied",
    );
    await f.host.settleMaterialization("lease-repo", "foreign unleased");
    const foreignDoc = await prepareCarriedDoc(f, "node-one", `${foreignPkg}/task_plan.md`, "foreign-unleased");
    const foreignDocCancel = await runFleetTaskCommandClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      taskId: "task-foreign-live",
      action: {
        kind: "task-transition",
        taskId: "task-foreign-live",
        status: "cancelled",
        force: true,
        reason: "Non-owner carried doc cancel",
      },
      waitMs: 5_000,
      docChanges: [foreignDoc],
    });
    assert.equal(foreignDocCancel.outcome, "op_rejected", JSON.stringify(foreignDocCancel));
    assert.equal(foreignDocCancel.code, "execution_scope_mismatch", JSON.stringify(foreignDocCancel));

    // (c) review-consent from an edge node MUST STILL fail (never bypassed).
    const consentRejected = await f.command("node-one", {
      kind: "task-review-consent",
      taskId: "task-edge-own-cancel",
      executionId: "exe-missing",
      reviewId: "review-missing",
    });
    assert.equal(consentRejected.outcome, "op_rejected", JSON.stringify(consentRejected));

    // (d) Task-bound implementation worker credential MUST STILL be blocked from operating on any other task.
    const workerPrincipal = {
      schema: "runtime-execution-principal/v1" as const,
      repoId: "lease-repo",
      personId: "person-one",
      dispatchId: "dispatch_worker_1",
      runtimeSessionId: "rt_worker_1",
      role: "implementation" as const,
      taskId: "task-edge-next",
      executionId: "exe_worker_1",
      source: { kind: "node" as const, nodeId: "node-one" },
      expiresAt: "2026-11-27T12:00:00.000Z",
    };
    for (const crossTaskAction of [
      { kind: "task-transition", taskId: "task-edge-own-cancel", status: "cancelled", force: true, reason: "cross" },
      { kind: "task-release", taskId: "task-edge-own-cancel", reason: "cross" },
      { kind: "task-archive", taskId: "task-edge-own-cancel", reason: "cross" },
      { kind: "task-complete", taskId: "task-edge-own-cancel", resolvedBy: headSha },
    ]) {
      assert.throws(
        () => requireExecutionActionScope(workerPrincipal, crossTaskAction),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "execution_credential_rejected",
        `implementation worker must be rejected for cross-task ${crossTaskAction.kind}`,
      );
    }
  },
);
