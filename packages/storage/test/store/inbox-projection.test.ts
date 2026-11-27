// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
} from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import type { InboxItem, InboxQuery, InboxRead } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "../../src/fleet-basebackup-layout.ts";
import { hydrateReplicaSeed } from "../../src/fleet-replica-seed.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { openReplicaProjection } from "../../src/replica-projection.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
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
    assert.equal(
      peerRequest?.senderPersonId,
      "person-inbox",
      "the envelope actor takes precedence over payload metadata",
    );
    assert.equal(peerRequest?.workId, "work-a2a");
    assert.equal(peerRequest?.lane, "owner-review");
    assert.equal(peerRequest?.correlationId, "corr-request-1");
    assert.equal(peerRequest?.minRevision, 15);
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
    assert.equal(peerReply?.minRevision, 12, "omitted causal watermarks default to the enqueue workspace revision");
    assert.deepEqual(peerReply?.requiredBlobSha256s, []);
    const [peerCompleted] = items(
      projection.readInbox({ by: "item", inboxId: "person:owner", itemId: "peer-completed" }),
    );
    assert.equal(peerCompleted?.status, "completed", "interactive consumers can settle a claimed request");
    const [peerFailed] = items(projection.readInbox({ by: "item", inboxId: "person:owner", itemId: "peer-failed" }));
    assert.equal(peerFailed?.status, "failed", "interactive consumers can fail a claimed request");
    const historyPage1 = projection.readInbox({ by: "inbox", inboxId: "person:owner", limit: 2 });
    assert.deepEqual(
      items(historyPage1).map(({ itemId, status }) => [itemId, status]),
      [
        ["peer-request", "claimed"],
        ["peer-reply", "pending"],
      ],
    );
    assert.equal(historyPage1.status === "ready" ? historyPage1.nextCursor : undefined, "12");
    const historyPage2 = projection.readInbox({ by: "inbox", inboxId: "person:owner", limit: 2, cursor: "12" });
    assert.deepEqual(
      items(historyPage2).map(({ itemId, status }) => [itemId, status]),
      [
        ["peer-completed", "completed"],
        ["peer-failed", "failed"],
      ],
    );
    assert.equal(historyPage2.status === "ready" ? historyPage2.nextCursor : undefined, null);
    assert.throws(
      () => projection.readInbox({ by: "queue", status: "pending", consumerKind: "unattended_dispatch", cursor: "x" }),
      /cursor is invalid/u,
    );
    assert.throws(
      () =>
        projection.readInbox({
          by: "queue",
          status: "pending",
          consumerKind: "interactive_watch",
        } as unknown as InboxQuery),
      /interactive watch Inbox reads require a targeted inboxId/u,
    );
    assert.throws(
      () =>
        projection.readInbox({
          by: "queue",
          status: "pending",
          consumerKind: "interactive_watch",
          inboxId: undefined,
        } as unknown as InboxQuery),
      /interactive watch Inbox reads require a targeted inboxId/u,
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

test("PR 1A reader-first N/N-1 compat (dec_659E15CF, dec_A7A88E2079CA1DE548234A6CC3): sqlite-event-store, fleet-replica-seed, and inbox-projection replay runtime_steer and runtime_report alongside N-1 events", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const repoId = "inbox-reader-first-seed",
      sourceDir = path.join(rootDir, "source"),
      replicaDir = path.join(rootDir, "replica"),
      sourceLedgerPath = path.join(sourceDir, ".harness", "store", "generations", "3", "ledger.sqlite"),
      fence = { repoId, holder: "center-writer", epoch: 1 };
    mkdirSync(path.dirname(sourceLedgerPath), { recursive: true });
    mkdirSync(path.join(replicaDir, "harness"), { recursive: true });

    const baselineEvent = inboxEvent(1, "inbox_item_enqueued", {
      inboxId: "task:task_legacy",
      itemId: "item-legacy-1",
      source: "ruling_resolved",
      sourceRef: "dispatch/dispatch_legacy",
      sourceEpoch: 1,
      dedupeKey: "ruling_resolved:dispatch/dispatch_legacy@1",
      admission: "dispatchable",
      consumerKind: "unattended_dispatch",
      taskId: "task_legacy",
      agentId: "neon",
      summary: "N-1 baseline ruling event",
      enqueuedAt: "2026-11-27T01:00:01.000Z",
    });
    const steerEvent = inboxEvent(2, "inbox_item_enqueued", {
      inboxId: "task:task_steer",
      itemId: "item-steer-1",
      source: "runtime_steer",
      sourceRef: "dispatch/dispatch_steer",
      sourceEpoch: 1,
      dedupeKey: "runtime_steer:dispatch/dispatch_steer@1",
      admission: "dispatchable",
      consumerKind: "unattended_dispatch",
      taskId: "task_steer",
      agentId: "neon",
      lane: "steer",
      summary: "Queued runtime steer",
      enqueuedAt: "2026-11-27T01:00:02.000Z",
    });
    const reportEvent = inboxEvent(3, "inbox_item_enqueued", {
      inboxId: "person:owner",
      itemId: "item-report-1",
      source: "runtime_report",
      sourceRef: "task/task_steer",
      sourceEpoch: 1,
      dedupeKey: "runtime_report:task/task_steer@1",
      admission: "dispatchable",
      consumerKind: "interactive_watch",
      taskId: null,
      agentId: null,
      lane: "milestone",
      summary: "Child milestone report",
      enqueuedAt: "2026-11-27T01:00:03.000Z",
    });

    const sourceStore = openSqliteEventStore({ repoId, databasePath: sourceLedgerPath, generation: 3 });
    try {
      sourceStore.claimWriter(fence);
      for (const event of [baselineEvent, steerEvent, reportEvent]) {
        const bytes = serializePersistedCanonicalEvent(event);
        assert.deepEqual(parseCanonicalEvent(bytes), event);
        sourceStore.appendCommand(
          {
            fence,
            intent: { opId: event.opId, intentDigest: `sha256:${sha256Text(bytes)}`, summary: event.type },
            events: [event],
          },
          [bytes],
        );
      }
      const position = sourceStore.replicationPosition(),
        events = sourceStore.eventRows(),
        outcomes = sourceStore.outcomes(),
        replicaLedgerPath = path.join(
          replicaDir,
          BASE_BACKUP_ARCHIVE_ROOT,
          "store",
          "generations",
          "3",
          "ledger.sqlite",
        ),
        seedDir = path.dirname(replicaLedgerPath);
      mkdirSync(seedDir, { recursive: true });
      const target = openSqliteEventStore({ repoId, databasePath: replicaLedgerPath, generation: 3 });
      target.close();
      writeFileSync(path.join(seedDir, "canonical-seed.json"), JSON.stringify({ events, outcomes, writer: fence }));

      await hydrateReplicaSeed(replicaDir, {
        schema: "fleet-basebackup/v3",
        readerProfile: null,
        repoId,
        position,
        ledgerGeneration: 3,
        projectionSchema: taskProjectionSchemaVersion,
      });

      const hydrated = openReplicaProjection({
        repoId,
        rootDir: replicaDir,
        ledgerPath: replicaLedgerPath,
        projectionPath: path.join(replicaDir, BASE_BACKUP_ARCHIVE_ROOT, "cache", "task.sqlite"),
        generation: 3,
      });
      try {
        const [legacy] = items(
          hydrated.projection.readInbox({ by: "item", inboxId: "task:task_legacy", itemId: "item-legacy-1" }),
        );
        const [steer] = items(
          hydrated.projection.readInbox({ by: "item", inboxId: "task:task_steer", itemId: "item-steer-1" }),
        );
        const [report] = items(
          hydrated.projection.readInbox({ by: "item", inboxId: "person:owner", itemId: "item-report-1" }),
        );
        assert.equal(legacy?.source, "ruling_resolved");
        assert.equal(legacy?.status, "pending");
        assert.equal(steer?.source, "runtime_steer");
        assert.equal(steer?.consumerKind, "unattended_dispatch");
        assert.equal(steer?.lane, "steer");
        assert.equal(steer?.status, "pending");
        assert.equal(report?.source, "runtime_report");
        assert.equal(report?.consumerKind, "interactive_watch");
        assert.equal(report?.lane, "milestone");
        assert.equal(report?.status, "pending");
      } finally {
        hydrated.close();
      }
    } finally {
      sourceStore.close();
    }
  });
});
