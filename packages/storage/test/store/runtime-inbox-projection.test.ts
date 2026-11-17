// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const ACTOR = { principal: { personId: "person-inbox" }, executor: null } as const;

function initRepo(rootDir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Inbox Test"],
    ["config", "user.email", "inbox@example.invalid"],
    ["commit", "--allow-empty", "-qm", "base"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
}

function inboxEvents(): readonly AgentRuntimeEventV1[] {
  return [
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-inbox-1",
      workspaceRevision: 1,
      opId: "op-inbox-1",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:01.000Z",
      type: "runtime_inbox_enqueued",
      payload: {
        inboxId: "task:task-a",
        itemId: "item-a",
        source: "ruling_resolved",
        dedupeKey: "ruling:d-a",
        coalesceWindowMs: 0,
        midRunPolicy: "defer_next_run",
        taskId: "task-a",
        dispatchId: "dispatch_000000000000000000000001",
        squadRunId: null,
        agentId: "terra",
        summary: "Answer A",
        data: { answer: "yes" },
        contextRef: null,
        enqueuedAt: "2026-11-17T00:00:01.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-inbox-2",
      workspaceRevision: 2,
      opId: "op-inbox-2",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:02.000Z",
      type: "runtime_inbox_enqueued",
      payload: {
        inboxId: "task:task-b",
        itemId: "item-b",
        source: "timer_fired",
        dedupeKey: "timer:b",
        coalesceWindowMs: 0,
        midRunPolicy: "defer_next_run",
        taskId: "task-b",
        dispatchId: null,
        squadRunId: null,
        agentId: null,
        summary: "Timer B",
        data: {},
        contextRef: null,
        enqueuedAt: "2026-11-17T00:00:02.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-inbox-3",
      workspaceRevision: 3,
      opId: "op-inbox-3",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:03.000Z",
      type: "runtime_inbox_claimed",
      payload: {
        inboxId: "task:task-a",
        itemIds: ["item-a"],
        claimFence: 1,
        claimedByDispatchId: null,
        claimedAt: "2026-11-17T00:00:03.000Z",
        leaseUntil: "2026-11-17T00:01:03.000Z",
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-inbox-4",
      workspaceRevision: 4,
      opId: "op-inbox-4",
      actor: ACTOR,
      source: "local",
      occurredAt: "2026-11-17T00:00:04.000Z",
      type: "runtime_inbox_settled",
      payload: {
        inboxId: "task:task-a",
        itemIds: ["item-a"],
        claimFence: 1,
        settlement: "consumed",
        settledByDispatchId: "dispatch_000000000000000000000002",
        reason: "resumed_provider_session",
        settledAt: "2026-11-17T00:00:04.000Z",
      },
    },
  ];
}

test("SQLite runtime inbox projection supports incremental folding, pagination, catchup, and rebuild parity", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "inbox-sqlite", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of inboxEvents()) {
      store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
      projection.apply(event);
    }

    const openPage = projection.readRuntimeInbox({ by: "open", limit: 1 });
    assert.equal(openPage.status, "ready");
    if (openPage.status !== "ready") return;
    assert.deepEqual(
      openPage.rows.map((row) => row.inboxId),
      ["task:task-b"],
    );
    assert.equal(openPage.nextCursor, null);

    const pointA = projection.readRuntimeInbox({ by: "inbox", inboxId: "task:task-a" });
    assert.equal(pointA.status, "ready");
    if (pointA.status !== "ready") return;
    assert.equal(pointA.rows[0]?.items[0]?.status, "consumed");

    const digest = projection.readStateDigest(),
      projectionPath = projection.path;
    projection.close();

    const db = new DatabaseSync(projectionPath);
    db.exec("DROP TABLE runtime_inbox_group; DROP TABLE runtime_inbox_cursor;");
    db.close();

    const rebuilt = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(rebuilt.readRuntimeInbox({ by: "open", limit: 10 }), openPage);
    assert.deepEqual(rebuilt.readRuntimeInbox({ by: "inbox", inboxId: "task:task-a" }), pointA);
    assert.equal(rebuilt.readStateDigest(), digest);
    rebuilt.close();
    await store.drain();
  });
});
