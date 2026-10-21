// harness-test-tier: integration
// TC-FLEET-CHAOS-01 (design: harness/tasks/task_0f452959ff91b5dcaa78604f61-fleet/artifacts/
// fleet-concurrency-test-design.md §3.1): after a successor center raises the writer epoch, a
// still-open connection to the old center must not persist a late write. Two layers are asserted
// separately, because either one failing alone is the split-brain event:
//   1. frame admission compares the frame's epoch with the *current* authority row;
//   2. the append fence compares the center's *owned* lease with the authority row, so a frame that
//      forges the successor's epoch still cannot append under the old holder.
// The old center keeps its cached lease on purpose: that is the split-brain state, not a bug.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

const repoId = "lease-repo";

type LateWrite = {
  readonly opId: string;
  readonly taskId: string;
  readonly title: string;
};

const lateWrite = (suffix: string): LateWrite => ({
  opId: `op-split-brain-${suffix}`,
  taskId: `task-split-${suffix}`,
  title: `Split brain ${suffix}`,
});

test(
  "an old center cannot persist a late write after a successor raises the writer epoch",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetNodeClaimFixture(t),
      ca = readFileSync(path.join(fixture.root, "tls.crt")),
      sockets: Array<() => void> = [];
    t.after(() => {
      for (const close of sockets.splice(0)) close();
    });
    const peer = await rawPeer((close) => sockets.push(close), fixture.center.port, ca, "node-one", "secret-node-one"),
      metadata = await peer.request({
        schema: "fleet.repo.metadata.get/v1",
        messageId: "metadata-before-takeover",
        repoId,
      });
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1", JSON.stringify(metadata));
    if (metadata.schema !== "fleet.repo.metadata.result/v1") return;
    const ownedEpoch = metadata.writerEpoch,
      eventsBefore = fixture.eventCount();
    assert.ok(ownedEpoch >= 1);

    // A successor center on the same state root takes over while the old center stays alive and
    // keeps serving its existing TLS session.
    const authority = openPersistentWriterEpoch({ stateRoot: fixture.writerEpochStateRoot }),
      successor = authority.acquire(repoId);
    try {
      assert.equal(successor.epoch, ownedEpoch + 1);

      // Layer 1: the frame names the old center's epoch, which is no longer the current row.
      const stale = await sendWrite(peer, lateWrite("stale"), ownedEpoch);
      assert.equal(stale.schema, "fleet.error/v1", JSON.stringify(stale));
      if (stale.schema !== "fleet.error/v1") return;
      assert.equal(stale.code, "writer_epoch_stale");
      assert.match(
        stale.message,
        /is stale for lease-repo/u,
        "the stale frame is refused by frame admission, before any handler runs",
      );

      // Layer 2: the frame forges the successor's epoch, so admission passes; the old center's
      // owned lease is still the previous epoch, and the append fence must roll it back.
      const forged = await sendWrite(peer, lateWrite("forged"), successor.epoch);
      assert.equal(forged.schema, "fleet.task.result/v1", JSON.stringify(forged));
      if (forged.schema !== "fleet.task.result/v1") return;
      assert.equal(forged.outcome, "op_rejected");
      assert.equal(forged.code, "writer_epoch_stale");
      assert.equal(
        (forged.receipt as { readonly proof?: unknown }).proof,
        undefined,
        "a fenced-out write never produced proof of publication",
      );
      // Two independent guards sit on the storage boundary: the writer worker checks the fence
      // descriptor before it runs the command, and the accepting transaction re-checks it under
      // BEGIN IMMEDIATE. Either one alone rejects this frame; removing both makes the write land
      // (negative control recorded in artifacts/).
      assert.match(
        JSON.stringify(forged.receipt),
        /reacquire the writer epoch/u,
        "the rejection comes from the storage boundary, not from frame admission",
      );

      assert.equal(fixture.eventCount(), eventsBefore, "no canonical event was appended by either late write");
      const ledger = JSON.stringify(makeTaskEventReader({ rootDir: fixture.repo, repoId }).read().events);
      for (const write of [lateWrite("stale"), lateWrite("forged")])
        assert.doesNotMatch(ledger, new RegExp(write.taskId, "u"), `${write.taskId} never reached the ledger`);

      // Recovery: the epoch the successor won is served by the next center, which accepts the
      // same write; the old center's cached lease stays fenced out for good.
      const replacement = await fixture.openCenter(fixture.host),
        recovered = await rawPeer((close) => sockets.push(close), replacement.port, ca, "node-one", "secret-node-one"),
        current = await recovered.request({
          schema: "fleet.repo.metadata.get/v1",
          messageId: "metadata-after-takeover",
          repoId,
        });
      assert.equal(current.schema, "fleet.repo.metadata.result/v1", JSON.stringify(current));
      if (current.schema !== "fleet.repo.metadata.result/v1") return;
      assert.equal(current.writerEpoch, successor.epoch, "the live holder of the raised epoch serves the edge");
      const applied = await sendWrite(recovered, lateWrite("recovered"), current.writerEpoch);
      assert.equal(applied.schema, "fleet.task.result/v1", JSON.stringify(applied));
      if (applied.schema !== "fleet.task.result/v1") return;
      assert.equal(applied.outcome, "applied", JSON.stringify(applied.receipt));
      assert.equal(fixture.eventCount(), eventsBefore + 1);
      assert.match(
        JSON.stringify(makeTaskEventReader({ rootDir: fixture.repo, repoId }).read().events),
        new RegExp(lateWrite("recovered").taskId, "u"),
        "the live holder's write reached the canonical ledger",
      );
    } finally {
      authority.close();
    }
  },
);

function sendWrite(
  peer: Awaited<ReturnType<typeof rawPeer>>,
  write: LateWrite,
  writerEpoch: number,
): ReturnType<Awaited<ReturnType<typeof rawPeer>>["request"]> {
  return peer.request({
    schema: "fleet.task.command/v1",
    messageId: `write-${write.opId}`,
    writerEpoch,
    opId: write.opId,
    repoId,
    taskId: write.taskId,
    action: { kind: "task-create", taskId: write.taskId, title: write.title },
    docChanges: null,
    mirrorBaseCut: null,
  });
}
