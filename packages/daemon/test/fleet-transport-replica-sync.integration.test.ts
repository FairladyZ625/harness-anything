// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { runFleetReplicaSync, waitForFleetReplicaSequence } from "../src/fleet/replica-sync.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";

// The old file's transfer machinery (session pool, ack store, legacy view rows, multi-path
// snapshot/delta framing, upload bounding) retired with the cut stack (dec_9284BD61). What still
// holds is the resident sync owner's contract, now against the walreceiver stream:
//   1. it follows new center commits without any read request,
//   2. a login completed between retries is used on the next retry without a restart,
//   3. the owning lifecycle can stop it, after which nothing further applies.
const replicaQuota = 64 * 1024 * 1024,
  nodeId = "node-one";

const viewDirOf = (viewRoot: string): string => path.join(viewRoot, "repos", "lease-repo", "views", nodeId);
import path from "node:path";

test("the resident sync follows new center commits without a read request", { timeout: 120_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  t.after(() => f.close());
  const viewRoot = path.join(f.root, "resident-view"),
    controller = new AbortController();
  t.after(() => controller.abort());
  const confirmed: number[] = [];
  void runFleetReplicaSync({
    ...f.peer(nodeId),
    viewRoot,
    diskQuotaBytes: replicaQuota,
    signal: controller.signal,
    onConfirmed: (revision) => {
      confirmed.push(revision);
    },
  });
  const created = await f.command(nodeId, { kind: "task-create", taskId: "task-resident-follow", title: "Follow" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFleetReplicaSequence({ viewRoot, repoId: "lease-repo", nodeId }, f.eventCount(), controller.signal);
  const generation = readReplicaGeneration(viewDirOf(viewRoot));
  assert.ok(generation, "the resident stream installed a replica generation");
  assert.equal(generation.metadata.position.revision, f.eventCount(), "the installed position names the center head");
  assert.ok(confirmed.length > 0, "the sync owner reported confirmed revisions");
});

test("a login completed before the next retry is used without restarting the sync", { timeout: 120_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  t.after(() => f.close());
  const viewRoot = path.join(f.root, "retry-view"),
    controller = new AbortController();
  t.after(() => controller.abort());
  // The token resolves per attempt (peer.ts readAccessToken), so a session approved after the
  // first failed attempt rides the retry loop without tearing the resident sync down.
  let attempts = 0;
  const tokenAt = async (): Promise<string | undefined> => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("authentication_required"), { code: "authentication_required" });
    return (await f.owners.readAccessToken(nodeId)()) ?? undefined;
  };
  void runFleetReplicaSync({
    ...f.peer(nodeId),
    readAccessToken: tokenAt,
    viewRoot,
    diskQuotaBytes: replicaQuota,
    signal: controller.signal,
  });
  const created = await f.command(nodeId, { kind: "task-create", taskId: "task-login-retry", title: "Retry" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFleetReplicaSequence({ viewRoot, repoId: "lease-repo", nodeId }, f.eventCount(), controller.signal);
  assert.ok(attempts >= 2, "the first attempt failed and a later attempt carried the approved session");
  assert.ok(readReplicaGeneration(viewDirOf(viewRoot)));
});

test("a stopped sync owner applies nothing further", { timeout: 120_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t);
  t.after(() => f.close());
  const viewRoot = path.join(f.root, "lifecycle-view"),
    controller = new AbortController();
  // The production wiring (daemon-host-open startReplicaSyncs) runs one resident sync per
  // enabled remote-edge registration and aborts it on close; this case pins that stop semantic.
  void runFleetReplicaSync({
    ...f.peer(nodeId),
    viewRoot,
    diskQuotaBytes: replicaQuota,
    signal: controller.signal,
  }).catch(() => undefined);
  const created = await f.command(nodeId, { kind: "task-create", taskId: "task-lifecycle", title: "Lifecycle" });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFleetReplicaSequence({ viewRoot, repoId: "lease-repo", nodeId }, f.eventCount(), controller.signal);
  controller.abort();
  const frozen = readReplicaGeneration(viewDirOf(viewRoot))?.metadata.position.revision;
  assert.ok(frozen !== undefined);
  const after = f.eventCount();
  const more = await f.command(nodeId, { kind: "task-create", taskId: "task-after-stop", title: "After stop" });
  assert.equal(more.outcome, "applied", JSON.stringify(more));
  assert.ok(f.eventCount() > after);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    readReplicaGeneration(viewDirOf(viewRoot))?.metadata.position.revision,
    frozen,
    "an aborted sync owner applies nothing further",
  );
});

// The upload-bounding and multi-path snapshot framing cases went with the transfer machinery;
// basebackup and replication-protocol.contract carry the bounded-transfer classes.
