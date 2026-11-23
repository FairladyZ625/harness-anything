// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  PEER_REQUEST_MODEL_VERSION,
  type PeerRequestEventV1,
  type PeerRequestInput,
} from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStore } from "./helpers.ts";

const start = "2026-11-22T10:00:00.000Z";
const expiry = "2026-11-22T10:05:00.000Z";

function peerEvent<T extends PeerRequestEventV1["type"]>(
  workspaceRevision: number,
  type: T,
  payload: Extract<PeerRequestEventV1, { type: T }>["payload"],
  personId: string,
): Extract<PeerRequestEventV1, { type: T }> {
  return {
    schema: "peer-request-event/v1",
    eventId: `event-peer-${workspaceRevision}`,
    workspaceRevision,
    opId: `op_peer_${workspaceRevision}`,
    type,
    actor: { principal: { personId }, executor: null },
    source: "remote_direct",
    occurredAt: start,
    payload,
  } as Extract<PeerRequestEventV1, { type: T }>;
}

function makeRequest(requestId: string, overrides: Partial<PeerRequestInput> = {}): PeerRequestInput {
  return {
    requestId,
    from: { personId: "person_alice", nodeId: "node-a" },
    to: { personId: "person_bob", workId: "work_1", lane: "ops" },
    kind: "question",
    summary: `Check status for ${requestId}`,
    structuredBody: { claim: "Build stalled.", requestedAction: "Inspect logs." },
    attachments: [],
    ...overrides,
  };
}

test("SQLite PeerRequestV1 projection folds lifecycle, filters, paginates, and refolds stale versions", () => {
  withTempStore((rootDir) => {
    const store = makeTaskEventStore({ rootDir, repoId: "peer-proj" });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const events: PeerRequestEventV1[] = [
        peerEvent(1, "peer_request_opened", { requestRevision: 1, request: makeRequest("peer_1") }, "person_alice"),
        peerEvent(
          2,
          "peer_request_claimed",
          { requestId: "peer_1", requestRevision: 2, expiresAt: expiry },
          "person_bob",
        ),
        peerEvent(
          3,
          "peer_request_answered",
          {
            requestId: "peer_1",
            requestRevision: 3,
            claimId: "event-peer-2",
            reply: {
              structuredBody: { claim: "Root cause found.", requestedAction: "Apply patch." },
              attachments: [],
              minRevision: 3,
            },
          },
          "person_bob",
        ),
        peerEvent(
          4,
          "peer_request_opened",
          {
            requestRevision: 1,
            request: makeRequest("peer_2", {
              kind: "handoff",
              to: { personId: "person_bob", lane: "default" },
              continuationPacket: {
                anchorRef: "task/task_wip",
                wipCommitSha: "abcdef1234567",
                verifiedReceipts: ["run_1"],
                inFlightDispatches: [],
                blockingGate: null,
                nextAction: "Run Colab preflight.",
              },
            }),
          },
          "person_alice",
        ),
      ];
      for (const event of events) {
        const reqId = event.type === "peer_request_opened" ? event.payload.request.requestId : event.payload.requestId;
        const plan = canonicalEventWritePlan(event, "peer-request", reqId);
        store.append({ event, plan, blobs: [] });
        projection.apply(event, plan);
      }

      const byId = projection.readPeerRequests({ by: "id", requestId: "peer_1" });
      assert.equal(byId.status, "ready");
      if (byId.status === "ready") {
        assert.equal(byId.requests.length, 1);
        assert.equal(byId.requests[0]!.state, "ANSWERED");
        assert.equal(byId.requests[0]!.reply?.minRevision, 3);
      }

      const handoffs = projection.readPeerRequests({ by: "list", recipientPersonId: "person_bob", kind: "handoff" });
      assert.equal(handoffs.status, "ready");
      if (handoffs.status === "ready") {
        assert.equal(handoffs.requests.length, 1);
        assert.equal(handoffs.requests[0]!.requestId, "peer_2");
        assert.equal(handoffs.requests[0]!.continuationPacket?.wipCommitSha, "abcdef1234567");
      }

      const page1 = projection.readPeerRequests({ by: "list", recipientPersonId: "person_bob", limit: 1 });
      assert.equal(page1.status, "ready");
      if (page1.status === "ready") {
        assert.deepEqual(
          page1.requests.map((r) => r.requestId),
          ["peer_1"],
        );
        assert.ok(page1.nextCursor !== null);
        const page2 = projection.readPeerRequests({
          by: "list",
          recipientPersonId: "person_bob",
          limit: 1,
          cursor: page1.nextCursor!,
        });
        assert.equal(page2.status, "ready");
        if (page2.status === "ready") {
          assert.deepEqual(
            page2.requests.map((r) => r.requestId),
            ["peer_2"],
          );
          assert.equal(page2.nextCursor, null);
        }
      }
    } finally {
      projection.close();
    }

    // Simulate an older model version in SQLite and verify automatic refold on reopen
    const db = new DatabaseSync(projection.path);
    try {
      db.exec("DELETE FROM peer_request");
      db.exec(`UPDATE peer_request_cursor SET model_version = ${PEER_REQUEST_MODEL_VERSION - 1}`);
    } finally {
      db.close();
    }
    const reopened = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const recovered = reopened.readPeerRequests({ by: "list", recipientPersonId: "person_bob" });
      assert.equal(recovered.status, "ready");
      if (recovered.status === "ready") {
        assert.deepEqual(
          recovered.requests.map((r) => r.requestId),
          ["peer_1", "peer_2"],
        );
      }
    } finally {
      reopened.close();
    }
  });
});
