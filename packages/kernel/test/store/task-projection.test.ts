// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import { DOC_CODEC_ID, DOC_POLICY_ID, docSyncWritePlan, type DocEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("task/doc reducers share one SQLite transaction and L2 rebuild restores exact document bytes", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore }), body = "# Notes\n\nAppended prose.\n", hash = sha256Text(body), base = eventStore.currentCommit();
    const event: DocEventV1 = { schema: "doc-event/v1", eventId: "doc-event", workspaceRevision: 1, opId: "doc-op", type: "documents_written", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-11T00:00:00.000Z",
      payload: { executionId: "execution-1", baseLedgerSha: base, changes: [{ path: "context/notes.md", baseBlobSha256: null, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, policyId: DOC_POLICY_ID,
        regionProofs: [{ regionId: "heading/notes", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } };
    const plan = docSyncWritePlan(event); eventStore.append({ event, plan, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] }); assert.throws(() => projection.apply(event), /write plan/iu);
    assert.deepEqual(projection.apply(event, plan).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    const first = projection.readDocument("context/notes.md"); assert.equal(first.status, "ready"); assert.equal(first.document?.body, body); assert.equal(first.document?.blobSha256, hash); assert.equal(projection.readOperation(event.opId)?.event.schema, "doc-event/v1");
    rmSync(projection.path, { force: true }); const rebuilt = projection.rebuild(); assert.equal(rebuilt.watermark, 1); assert.deepEqual(projection.readDocument("context/notes.md").document, first.document);
  });
});

test("replica basis returns one exact L2 manifest and only post-cut applied events", async () => {
  await withTempStoreAsync(async (rootDir) => { initRepo(rootDir); const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore }), body = "# Replica\n", hash = sha256Text(body), base = eventStore.currentCommit();
    const event: DocEventV1 = { schema: "doc-event/v1", eventId: "replica-event", workspaceRevision: 1, opId: "replica-op", type: "documents_written", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", payload: { executionId: null, baseLedgerSha: base, changes: [{ path: "context/replica.md", baseBlobSha256: null, candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }, policyId: DOC_POLICY_ID, regionProofs: [{ regionId: "heading/replica", policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(""), candidateSha256: hash, insertBytes: Buffer.byteLength(body) }] }] } }, plan = docSyncWritePlan(event);
    eventStore.append({ event, plan, blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }] });
    assert.deepEqual(projection.readReplicaBasis(null), { watermark: 0, sourceRevision: 1, headEvent: null, events: [], documents: [] });
    projection.apply(event, plan);
    assert.deepEqual(projection.readReplicaBasis(null), { watermark: 1, sourceRevision: 1, headEvent: event, events: [], documents: [{ path: "context/replica.md", blobSha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" }] });
    assert.deepEqual(projection.readReplicaBasis(0).events, [event]);
  });
});

test("steady apply and rebuild use the same reducer and reproduce watermark, op index, lease intervals", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    for (const event of lifecycleFixture().events) {
      eventStore.append(taskBundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    }

    const first = projection.read("task-1");
    assert.equal(first.status, "ready");
    assert.equal(first.watermark, 6);
    assert.equal(first.snapshot.task?.status, "done");
    assert.deepEqual(first.snapshot.executions.map((execution) => execution.state), ["accepted"]);
    const startOpId = lifecycleFixture().events[1]!.opId;
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");
    assert.deepEqual(projection.readLeaseIntervals("task-1").map((interval) => ({
      executionId: interval.executionId,
      acquiredRevision: interval.acquiredRevision,
      releasedRevision: interval.releasedRevision,
      reason: interval.reason
    })), [{ executionId: "execution-1", acquiredRevision: 2, releasedRevision: 3, reason: "initial_claim" }]);

    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 6);
    assert.equal(rebuilt.metrics.reducedItems, 6);
    assert.equal(rebuilt.metrics.maxBatchItems <= 64, true);
    assert.deepEqual(projection.read("task-1").snapshot, first.snapshot);
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");

    const db = new DatabaseSync(projection.path);
    db.prepare("UPDATE task_snapshot SET snapshot_json = 'not-json'").run();
    db.close();
    assert.throws(() => projection.read("task-1"), /projection.*mismatch/u);
    projection.rebuild();
    assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "accepted");
  });
});

// The title's "64-item/100ms" is pinned by check-implementation-contracts.mjs and no longer
// describes this test: it runs at catchUpLimit 2, and the 100ms budget was an unenforced
// literal removed with the receipt field that carried it. Renaming needs that gate updated.
test("completion lookup answers from the projection index and stays scoped to one task and execution", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir); const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }), projection = makeTaskProjection({ rootDir, eventStore }), events = lifecycleFixture().events;
    const completion = events.find((event) => event.type === "task_completed")!;
    for (const event of events) { eventStore.append(taskBundle(event)); projection.apply(event); }
    assert.deepEqual(projection.readTaskCompletion("task-1", "execution-1"), completion);
    assert.equal(projection.readTaskCompletion("task-1", "execution-2"), null);
    assert.equal(projection.readTaskCompletion("task-2", "execution-1"), null);
    // A completion published to the store but not yet reduced must still be found, or a crash between publication and
    // projection would report the write as unpublished and invite a duplicate attempt.
    const lagging = makeTaskProjection({ rootDir, eventStore, projectionPath: `${projection.path}.lagging` });
    for (const event of events.filter((event) => event.type !== "task_completed")) lagging.apply(event);
    assert.deepEqual(lagging.readTaskCompletion("task-1", "execution-1"), completion);
  });
});

test("projection catch-up processes at most one bounded round and never reports stale data ready", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    for (const event of lifecycleFixture().events) eventStore.append(taskBundle(event));
    const projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 2, now: () => "2026-08-11T00:30:00.000Z" });

    let previousWatermark = 0;
    for (let round = 0; round < 6; round += 1) {
      const read = projection.read("task-1");
      assert.equal(read.watermark >= previousWatermark, true);
      assert.equal(read.sourceRevision, 6);
      // The receipt must name the limit this projection actually runs under, not a constant:
      // it is constructed with catchUpLimit 2, so a hardcoded 64 would be a false bound.
      assert.equal(read.catchUp.maxItems, 2);
      assert.equal(read.catchUp.reducedItems <= read.catchUp.maxItems, true);
      if (read.status === "ready") { assert.equal(read.watermark, 6); return; }
      previousWatermark = read.watermark;
    }
    assert.fail("bounded catch-up did not drain its persisted deferred events");
  });
});

test("lease CAS rejects stale renew/release, marks expiry orphaned, and permits takeover", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const fixture = lifecycleFixture();
    eventStore.append(taskBundle(fixture.events[0]!));
    projection.apply(fixture.events[0]!);
    const started = fixture.events[1]!;
    if (started.type !== "execution_started") throw new Error("fixture requires execution_started");

    const reserving = projection.reserveLease({ ...started.payload.lease, phase: "reserving" }, started.occurredAt);
    const active = projection.activateLease(reserving);
    assert.equal(active.phase, "active");
    assert.throws(() => projection.renewLease({ ...active, version: active.version - 1 }, "2026-08-11T02:00:00.000Z"), /stale/u);
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.equal(renewed.version, active.version + 1);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.throws(() => projection.releaseLease(active), /stale/u);

    const takeover = projection.reserveLease({ ...started.payload.lease, executionId: "execution-2", phase: "reserving",
      expiresAt: "2026-08-11T03:00:00.000Z", version: renewed.version + 1 }, "2026-08-11T02:00:00.000Z");
    assert.equal(takeover.executionId, "execution-2");
  });
});

test("renewed lease survives database rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created)); projection.apply(created);
    eventStore.append(taskBundle(started)); projection.apply(started);
    const renewed = {
      schema: "task-event/v1", eventId: "event-renew", workspaceRevision: 3, opId: "op-renew", taskId: started.taskId,
      type: "lease_renewed", actor: started.actor, source: started.source, occurredAt: "2026-08-11T00:02:00.000Z",
      payload: { task: started.payload.task, execution: started.payload.execution,
        lease: { ...started.payload.lease, expiresAt: "2026-08-11T02:00:00.000Z", version: started.payload.lease.version + 1 },
        previousHolder: { taskId: started.taskId, executionId: started.payload.execution.executionId, actor: started.actor, source: started.source },
        leaseExpiresAt: "2026-08-11T02:00:00.000Z", reason: "same_principal_reconnect" }
    } as unknown as TaskEventV1;
    eventStore.append(taskBundle(renewed)); projection.apply(renewed);
    const beforeLease = projection.currentLease("task-1");
    const beforeIntervals = projection.readLeaseIntervals("task-1");

    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();

    assert.equal(rebuilt.watermark, 3);
    assert.deepEqual(projection.currentLease("task-1"), beforeLease);
    assert.deepEqual(projection.readLeaseIntervals("task-1"), beforeIntervals);
  });
});
test("a lapsed reservation stops being a lease while a lapsed active lease stays orphaned", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created)); projection.apply(created);

    // A reservation whose execution was never published: the CAS row is the only trace it ever existed.
    projection.reserveLease({ ...started.payload.lease, executionId: "execution-unpublished", phase: "reserving",
      expiresAt: "2026-08-11T01:00:00.000Z", version: 0 }, "2026-08-11T00:00:00.000Z");
    // Still inside its TTL it must keep protecting the round against a concurrent claim.
    assert.equal(projection.currentLease("task-1", "2026-08-11T00:30:00.000Z")?.phase, "reserving");
    // Past its TTL it can never be published, so it is not a lease and must not wedge the task.
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z"), null);
    // The snapshot a daemon reads after the TTL lapsed is what task show and task release act on.
    assert.equal(makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T02:00:00.000Z" }).read("task-1").snapshot.lease, null);

    // Contrast, holding every other input fixed and varying only the phase: a published lease that
    // lapsed is still a lease, because a real execution stands behind it and release must audit it.
    eventStore.append(taskBundle(started)); projection.apply(started);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.executionId, started.payload.execution.executionId);
  });
});

function taskBundle(event: TaskEventV1): CanonicalWriteBundle { return { event, plan: taskLifecycleWritePlan(event), blobs: [] }; }

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Test");
  git(rootDir, "config", "user.email", "projection-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
