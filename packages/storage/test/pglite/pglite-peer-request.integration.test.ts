// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { PeerRequestEventV1, PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { getPgProjectionValue } from "../../src/pg/pg-projection-values.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const start = "2026-11-22T11:00:00.000Z";
const expiry = "2026-11-22T11:05:00.000Z";

function peerEvents(): readonly PeerRequestEventV1[] {
  return [
    {
      schema: "peer-request-event/v1",
      eventId: "event-pg-peer-1",
      workspaceRevision: 1,
      opId: "op_pg_peer_1",
      type: "peer_request_opened",
      actor: { principal: { personId: "person_alice" }, executor: null },
      source: "remote_direct",
      occurredAt: start,
      payload: {
        requestRevision: 1,
        request: {
          requestId: "peer_pg_1",
          from: { personId: "person_alice", nodeId: "node-a" },
          to: { personId: "person_bob", workId: "work_alpha", lane: "ops" },
          kind: "handoff",
          summary: "Handoff work_alpha to Bob",
          structuredBody: { claim: "WIP pushed.", requestedAction: "Continue verification." },
          attachments: [],
          continuationPacket: {
            anchorRef: "task/task_alpha",
            wipCommitSha: "1234567890abcdef",
            verifiedReceipts: ["colab_run_1"],
            inFlightDispatches: [],
            blockingGate: null,
            nextAction: "Run preflight.",
          },
        },
      },
    },
    {
      schema: "peer-request-event/v1",
      eventId: "event-pg-peer-2",
      workspaceRevision: 2,
      opId: "op_pg_peer_2",
      type: "peer_request_claimed",
      actor: { principal: { personId: "person_bob" }, executor: null },
      source: "remote_direct",
      occurredAt: start,
      payload: { requestId: "peer_pg_1", requestRevision: 2, expiresAt: expiry },
    },
    {
      schema: "peer-request-event/v1",
      eventId: "event-pg-peer-3",
      workspaceRevision: 3,
      opId: "op_pg_peer_3",
      type: "peer_request_done",
      actor: { principal: { personId: "person_bob" }, executor: null },
      source: "remote_direct",
      occurredAt: start,
      payload: { requestId: "peer_pg_1", requestRevision: 3, claimId: "event-pg-peer-2" },
    },
  ];
}

pgliteIntegrationSuite("PGlite PeerRequestV1 projection", () => {
  test("PGlite matches SQLite parity, enforces dual-principal readers, and backfills stale versions", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-peer",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        },
        events = peerEvents();

      const sqliteStore = makeTaskEventStore({ rootDir, repoId });
      const sqliteProj = makeTaskProjection({ rootDir, eventStore: sqliteStore });
      const pgStore = makeTaskEventStore({ rootDir, repoId, storage });
      const pgProj = makeTaskProjection({ rootDir, eventStore: pgStore, repoId, storage });
      try {
        for (const event of events) {
          const reqId =
            event.type === "peer_request_opened" ? event.payload.request.requestId : event.payload.requestId;
          const plan = canonicalEventWritePlan(event, "peer-request", reqId);
          sqliteStore.append({ event, plan, blobs: [] });
          sqliteProj.apply(event, plan);
          pgStore.append({ event, plan, blobs: [] });
          pgProj.apply(event, plan);
        }

        for (const query of [
          { by: "id" as const, requestId: "peer_pg_1" },
          { by: "list" as const, recipientPersonId: "person_bob", state: "DONE" as const },
          { by: "list" as const, senderPersonId: "person_alice", kind: "handoff" as const },
        ]) {
          assert.deepEqual(pgProj.readPeerRequests(query), sqliteProj.readPeerRequests(query));
        }
      } finally {
        sqliteProj.close();
        pgProj.close();
        await (pgStore as { close?: () => Promise<void> | void }).close?.();
      }

      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        const readersRow = (
          await backend.pool.query<{ readonly readers: string[] }>(
            `SELECT readers FROM ha_projection_values
             WHERE tenant_id='t' AND project_id='p' AND policy_epoch=1
               AND model='peer-request' AND owner_id='peer' AND entity_id='peer_pg_1'`,
          )
        ).rows[0];
        assert.ok(readersRow?.readers.includes("person_alice"), "sender principal is in readers");
        assert.ok(readersRow?.readers.includes("person_bob"), "recipient principal is in readers");
        assert.ok(!readersRow?.readers.includes("person_carol"), "unrelated principal is excluded");

        const client = await backend.pool.connect();
        try {
          for (const personId of ["person_alice", "person_bob"]) {
            const value = await getPgProjectionValue<{ readonly request: PeerRequestV1 }>(
              client,
              { tenantId: "t", projectId: "p", policyEpoch: 1, readers: [personId] },
              "peer-request",
              "peer_pg_1",
              "peer",
            );
            assert.equal(value?.request.requestId, "peer_pg_1");
          }
          const denied = await getPgProjectionValue<{ readonly request: PeerRequestV1 }>(
            client,
            { tenantId: "t", projectId: "p", policyEpoch: 1, readers: ["person_carol"] },
            "peer-request",
            "peer_pg_1",
            "peer",
          );
          assert.equal(denied, null, "unrelated principal cannot read peer request");
        } finally {
          client.release();
        }

        // Simulate stale model version and verify pending -> automatic backfill on reopen
        await backend.pool.query(
          "DELETE FROM ha_projection_values WHERE model IN ('peer-request', 'peer-request-list')",
        );
        await backend.pool.query("UPDATE ha_projection_meta SET peer_request_version=0");
        assert.equal(
          (await backend.projection.readPeerRequests({ by: "id", requestId: "peer_pg_1" })).status,
          "pending",
        );
      } finally {
        await backend.close();
      }

      const reopenedStore = makeTaskEventStore({ rootDir, repoId, storage });
      const reopenedProj = makeTaskProjection({ rootDir, eventStore: reopenedStore, repoId, storage });
      try {
        const backfilled = reopenedProj.readPeerRequests({ by: "id", requestId: "peer_pg_1" });
        assert.equal(backfilled.status, "ready");
        if (backfilled.status === "ready") {
          assert.equal(backfilled.requests.length, 1);
          assert.equal(backfilled.requests[0]!.state, "DONE");
        }
      } finally {
        reopenedProj.close();
        await (reopenedStore as { close?: () => Promise<void> | void }).close?.();
      }
    });
  });
});
