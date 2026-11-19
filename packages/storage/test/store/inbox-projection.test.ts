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

    const pending = projection.readInbox({ by: "queue", status: "pending" });
    assert.deepEqual(
      items(pending).map(({ itemId, enqueuedRevision }) => [itemId, enqueuedRevision]),
      [
        ["item-a2", 6],
        ["item-c1", 9],
      ],
    );
    const firstPage = projection.readInbox({ by: "queue", status: "pending", limit: 1 });
    assert.deepEqual(
      items(firstPage).map(({ itemId }) => itemId),
      ["item-a2"],
    );
    assert.equal(firstPage.status === "ready" ? firstPage.nextCursor : undefined, "6");
    const secondPage = projection.readInbox({ by: "queue", status: "pending", limit: 1, cursor: "6" });
    assert.deepEqual(
      items(secondPage).map(({ itemId }) => itemId),
      ["item-c1"],
    );
    assert.equal(secondPage.status === "ready" ? secondPage.nextCursor : undefined, null);
    assert.deepEqual(
      items(projection.readInbox({ by: "queue", status: "quarantined_external" })).map(({ itemId }) => itemId),
      ["item-x1"],
    );
    assert.deepEqual(items(projection.readInbox({ by: "queue", status: "claimed" })), []);
    assert.throws(() => projection.readInbox({ by: "queue", status: "pending", cursor: "x" }), /cursor is invalid/u);

    const reads = inboxParityQueries.map((query) => projection.readInbox(query)),
      digest = projection.readStateDigest(),
      projectionPath = projection.path;
    projection.close();

    // A cache from another model version (or before the tables existed) refolds from its own event rows.
    const db = new DatabaseSync(projectionPath);
    db.exec("DROP TABLE inbox_item; DROP TABLE inbox_cursor;");
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
    const [item] = items(projection.readInbox({ by: "queue", status: "pending", inboxId: `task:${source.taskId}` }));
    assert.equal(item?.itemId, "item-batch");
    assert.equal(item?.enqueuedRevision, 2);
    projection.close();
    await store.drain();
  });
});
