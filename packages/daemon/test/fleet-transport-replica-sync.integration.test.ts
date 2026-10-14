// harness-test-tier: integration
// The resident sync owner (runFleetReplicaSync) against a real center: a login completed between
// retries is used on the next attempt without restarting the sync, and the owner then follows
// center commits with no read request, notifying onConfirmed. The old file's transfer machinery
// (session pool, ack store, snapshot/delta framing) retired with the cut stack (dec_9284BD61);
// resume, takeover and stop semantics live in fleet-replica-resident-stream.integration.test.ts.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFleetRepositoryMetadataClient } from "../src/fleet/peer.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import { runFleetReplicaSync } from "../src/fleet/replica-sync.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { waitForState } from "./fleet-replication.fixture.ts";

const nodeId = "node-one",
  repoId = "lease-repo";

test(
  "a login completed before the next retry is used without restarting, then commits follow",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    t.after(() => f.close());
    const viewRoot = path.join(f.root, "retry-view"),
      viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
      applied = () => readReplicaGeneration(viewDir)?.metadata.position.sequence ?? -1,
      controller = new AbortController(),
      failures: unknown[] = [];
    let attempts = 0,
      confirmations = 0;
    // The token resolves per attempt, so a session approved after the first failed attempt rides
    // the retry loop without tearing the resident sync down.
    const readAccessToken = async (): Promise<string | undefined> => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("authentication_required"), { code: "authentication_required" });
      return await f.owners.readAccessToken(nodeId)();
    };
    const running = runFleetReplicaSync({
      ...f.peer(nodeId),
      readAccessToken,
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
      signal: controller.signal,
      onConfirmed: () => {
        confirmations += 1;
      },
      onFailure: (error) => failures.push(error),
    });
    t.after(async () => {
      controller.abort();
      await running;
    });
    const head = async () => (await readFleetRepositoryMetadataClient(f.peer(nodeId))).replicationSequence;
    const initial = await head();
    await waitForState(() => applied() >= initial, "the retried attempt to install the replica", 60_000);
    assert.equal(failures.length, 1, "exactly the first attempt failed");
    assert.match(String(failures[0]), /authentication_required/u);
    const created = await f.command(nodeId, { kind: "task-create", taskId: "task-login-retry", title: "Retry" });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const next = await head();
    assert.ok(next > initial, "the command moved the center head");
    await waitForState(() => applied() >= next, "the resident sync to follow the commit", 60_000);
    await waitForState(() => confirmations > 0, "onConfirmed after applied commits");
    assert.equal(attempts, 2, "one retry, then one resident session for every later commit");
  },
);
