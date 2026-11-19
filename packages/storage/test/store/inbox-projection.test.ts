// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { InboxItem, InboxRead } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { inboxBundle, inboxEvent, inboxParityQueries, inboxScenario } from "./inbox-events.fixture.ts";
import { bundle, eventAt, initRepo } from "./task-event-store.fixtures.ts";

function items(read: InboxRead): readonly InboxItem[] {
  assert.equal(read.status, "ready");
  return read.status === "ready" ? read.items : [];
}

test("SQLite Inbox projection folds per item, dedupes, orders queues, and rebuilds to the same state", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "inbox-sqlite", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    for (const event of inboxScenario()) {
      store.append(inboxBundle(event));
      projection.apply(event);
    }

    // (a) the duplicate dedupe key under a new item id never became an item.
    assert.deepEqual(items(projection.readInbox({ by: "item", inboxId: "task:task_a", itemId: "item-a1-retry" })), []);
    const [a1] = items(projection.readInbox({ by: "dedupe", inboxId: "task:task_a", dedupeKey: "k-a1" }));
    assert.equal(a1?.itemId, "item-a1");
    assert.equal(a1?.status, "completed");
    assert.equal(a1?.completedByDispatchId, "dispatch_a1");
    // (b) the retired source was dropped as dropped_stale.
    const [b1] = items(projection.readInbox({ by: "item", inboxId: "task:task_b", itemId: "item-b1" }));
    assert.equal(b1?.status, "dropped_stale");
    assert.equal(b1?.settlementReason, "source_retired");

    const pending = projection.readInbox({ by: "queue", status: "pending", consumerKind: "unattended_dispatch" });
    assert.deepEqual(
      items(pending).map(({ itemId, enqueuedRevision }) => [itemId, enqueuedRevision]),
      [
        ["item-a2", 6],
        ["item-c1", 9],
      ],
    );
    const firstPage = projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "unattended_dispatch",
      limit: 1,
    });
    assert.deepEqual(
      items(firstPage).map(({ itemId }) => itemId),
      ["item-a2"],
    );
    assert.equal(firstPage.status === "ready" ? firstPage.nextCursor : undefined, "6");
    const secondPage = projection.readInbox({
      by: "queue",
      status: "pending",
      consumerKind: "unattended_dispatch",
      limit: 1,
      cursor: "6",
    });
    assert.deepEqual(
      items(secondPage).map(({ itemId }) => itemId),
      ["item-c1"],
    );
    assert.equal(secondPage.status === "ready" ? secondPage.nextCursor : undefined, null);
    assert.deepEqual(
      items(
        projection.readInbox({
          by: "queue",
          status: "quarantined_external",
          consumerKind: "quarantined_external",
        }),
      ).map(({ itemId }) => itemId),
      ["item-x1"],
    );
    assert.deepEqual(
      items(projection.readInbox({ by: "queue", status: "claimed", consumerKind: "unattended_dispatch" })),
      [],
    );
    const [peerRequest] = items(
      projection.readInbox({
        by: "queue",
        status: "claimed",
        consumerKind: "interactive_watch",
        inboxId: "person:owner",
      }),
    );
    assert.equal(peerRequest?.itemId, "peer-request");
    assert.equal(peerRequest?.senderPersonId, "person-inbox", "the envelope actor takes precedence over payload metadata");
    assert.equal(peerRequest?.workId, "work-a2a");
    assert.equal(peerRequest?.lane, "owner-review");
    assert.equal(peerRequest?.correlationId, "corr-request-1");
    assert.equal(peerRequest?.minRevision, 14);
    assert.deepEqual(peerRequest?.requiredBlobSha256s, ["a".repeat(64)]);
    const [peerReply] = items(
      projection.readInbox({
        by: "queue",
        status: "pending",
        consumerKind: "interactive_watch",
        inboxId: "person:owner",
      }),
    );
    assert.equal(peerReply?.itemId, "peer-reply");
    assert.equal(peerReply?.senderPersonId, "person-inbox");
    assert.equal(peerReply?.minRevision, 12, "omitted causal watermarks default to the enqueue revision");
    assert.deepEqual(peerReply?.requiredBlobSha256s, []);
    assert.throws(
      () => projection.readInbox({ by: "queue", status: "pending", consumerKind: "unattended_dispatch", cursor: "x" }),
      /cursor is invalid/u,
    );

    const reads = inboxParityQueries.map((query) => projection.readInbox(query)),
      digest = projection.readStateDigest(),
      projectionPath = projection.path;
    projection.close();

    // A version-1 Inbox table has no consumer_kind column; opening drops it and refolds from canonical events.
    const db = new DatabaseSync(projectionPath);
    db.exec(
      "DROP INDEX inbox_item_queue; DROP INDEX inbox_item_inbox_queue; " +
        "ALTER TABLE inbox_item DROP COLUMN consumer_kind; UPDATE inbox_cursor SET model_version=1;",
    );
    db.close();
    const rebuilt = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(
      inboxParityQueries.map((query) => rebuilt.readInbox(query)),
      reads,
    );
    assert.equal(rebuilt.readStateDigest(), digest);
    rebuilt.close();
    await store.drain();
  });
});

test("a source event and its inbox_item_enqueued commit in one publication, or neither does", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "inbox-batch", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store }),
      source = eventAt(1),
      wakeup = inboxEvent(2, "inbox_item_enqueued", {
        inboxId: `task:${source.taskId}`,
        itemId: "item-batch",
        source: "ruling_resolved",
        sourceRef: `task/${source.taskId}`,
        sourceEpoch: 1,
        dedupeKey: "k-batch",
        admission: "dispatchable",
        consumerKind: "unattended_dispatch",
        taskId: source.taskId,
        agentId: null,
        summary: "wakeup committed with its source",
        enqueuedAt: "2026-11-18T00:00:02.000Z",
      });

    // A rejected member rolls the whole publication back: no source state without its wakeup intent.
    const invalid = { ...wakeup, payload: { ...wakeup.payload, admission: "quarantined_external" as const } };
    assert.throws(() => store.append({ ...inboxBundle(invalid), preceding: [bundle(source)] }));
    assert.equal(store.readHead(), null);

    store.append({ ...inboxBundle(wakeup), preceding: [bundle(source)] });
    assert.equal(store.readHead()?.revision, 2);
    projection.apply(source);
    projection.apply(wakeup);
    const [item] = items(
      projection.readInbox({
        by: "queue",
        status: "pending",
        consumerKind: "unattended_dispatch",
        inboxId: `task:${source.taskId}`,
      }),
    );
    assert.equal(item?.itemId, "item-batch");
    assert.equal(item?.enqueuedRevision, 2);
    projection.close();
    await store.drain();
  });
});
