// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { openFleetEdgeView, openPeer, runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { withEdgeReadModel } from "../src/fleet-edge-task-read.ts";

test(
  "eight independent edge replicas hold delivery leases without occupying the canonical write queue",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "before-delivery", title: "Before delivery" }))
        .outcome,
      "applied",
    );
    const replica = f.host.replica("lease-repo");
    await replica.prepare();
    const firstCut = await replica.waitForCut(f.eventCount());
    const edges = Array.from({ length: 8 }, (_, index) => {
      const nodeId = `eight-edge-${index}`;
      f.owners.reassign(nodeId, `eight-owner-${index}`);
      const principalId = `machine:${nodeId}:${f.owners.keycloak.nodeClients.get(`harness-node-${nodeId}`)!.id}-service`,
        viewRoot = path.join(f.root, nodeId);
      return { nodeId, principalId, viewRoot, view: openFleetEdgeView(viewRoot, 64 * 1024 * 1024) };
    });
    // Each real TLS client materializes its own snapshot, then deliberately holds the ACK.
    const held = await Promise.all(
      edges.map(async (edge) => {
        const peer = await openPeer(f.peer(edge.nodeId));
        t.after(() => peer.close());
        peer.send({ schema: "fleet.replica.pull/v1", messageId: peer.messageId(), repoId: "lease-repo" });
        for (;;) {
          const frame = await peer.next();
          const ack = edge.view.receive(frame);
          if (ack) {
            assert.equal(ack.schema, "fleet.ack/v1");
            return { ...edge, peer, ack: ack as Extract<typeof ack, { schema: "fleet.ack/v1" }> };
          }
        }
      }),
    );
    const status = () => f.center.status().replicas.filter((row) => row.nodeId.startsWith("eight-edge-"));
    assert.equal(status().length, 8);
    for (const row of status()) {
      assert.equal(row.activeTransfers, 1);
      assert.equal(row.deliveryLease?.nodeId, row.nodeId);
      assert.equal(row.deliveryLease?.claimFence, 1);
      assert.equal(row.ackRevision, null);
      assert.ok(row.transferMetrics.transferBytes > 0);
    }
    await assert.rejects(
      runFleetReplicaPullClient({
        ...f.peer(edges[0]!.nodeId),
        viewRoot: path.join(f.root, "competing-same-node"),
        diskQuotaBytes: 64 * 1024 * 1024,
      }),
      { code: "replica_delivery_busy" },
    );
    // A writer must finish before any delivery releases its lease or advances its ACK.
    const written = await f.command("center-node", {
      kind: "task-create",
      taskId: "during-delivery",
      title: "During eight deliveries",
    });
    assert.equal(written.outcome, "applied", JSON.stringify(written));
    const secondCut = await replica.waitForCut(f.eventCount());
    assert.ok(secondCut.revision > firstCut.revision);
    assert.equal(status().filter((row) => row.activeTransfers === 1 && row.ackRevision === null).length, 8);
    const queueDepth = f.host.status().repos.find((repo) => repo.repoId === "lease-repo")?.queueDepth;
    assert.equal(queueDepth, 0, "parked deliveries do not hold canonical writer work");
    for (const edge of held.slice(0, 4)) await edge.peer.request(edge.ack);
    assert.equal(status().filter((row) => row.ackRevision === firstCut.revision).length, 4);
    assert.equal(status().filter((row) => row.ackRevision === null).length, 4);
    for (const edge of held.slice(4)) await edge.peer.request(edge.ack);
    for (const edge of held) edge.peer.close();
    await runFleetReplicaPullClient({
      ...f.peer(edges[0]!.nodeId),
      viewRoot: edges[0]!.viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
    });
    const final = status();
    assert.equal(final.find((row) => row.nodeId === edges[0]!.nodeId)?.lagRevisions, 0);
    assert.ok(
      final
        .filter((row) => row.nodeId !== edges[0]!.nodeId)
        .every((row) => row.lagRevisions === secondCut.revision - firstCut.revision),
    );
    for (const edge of edges) {
      const cut = withEdgeReadModel({ ...edge, repoId: "lease-repo" }, (projection) => ({
        cut: projection.readCut().sourceRevision,
        later: projection.readTaskExists("during-delivery"),
      }));
      assert.equal(cut.cut, edge === edges[0] ? secondCut.revision : firstCut.revision);
      assert.equal(cut.later, edge === edges[0]);
    }
    t.diagnostic(`N=8 canonical write completed with eight active leases; queueDepth=${queueDepth}`);
    for (const row of final)
      t.diagnostic(
        JSON.stringify({
          nodeId: row.nodeId,
          repoId: row.repoId,
          viewId: row.viewId,
          ackCut: row.ackRevision,
          centerCut: row.centerRevision,
          lag: row.lagRevisions,
          active: row.activeTransfers,
          metrics: row.transferMetrics,
        }),
      );
  },
);
