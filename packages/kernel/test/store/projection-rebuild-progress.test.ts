// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { compileFactWrite, factWritePlan, type FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import type { PersistedCanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";

// A full rebuild used to run silent: the writer supervisor's 30s stall watchdog could not tell a
// working-but-slow rebuild apart from a wedged worker, so large projections (ai-mbse, 37s) were
// killed mid-rebuild. Rebuild must report per-round progress exactly like incremental catch-up.
test("explicit rebuild reports per-round progress like catch-up", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore } = threeFactLedger(rootDir, "rebuild-progress");
    const progress: Array<{ readonly applied: number; readonly total: number; readonly watermark: number }> = [],
      projection = makeTaskProjection({
        rootDir,
        eventStore,
        catchUpLimit: 1,
        onProgress: (round) => progress.push({ ...round, total: round.total ?? -1 }),
      });
    const receipt = projection.rebuild();
    assert.equal(receipt.watermark, 3);
    assert.deepEqual(progress, [
      { applied: 1, total: 3, watermark: 1 },
      { applied: 2, total: 3, watermark: 2 },
      { applied: 3, total: 3, watermark: 3 },
    ]);
    projection.close();
  });
});

test("explicit rebuild without a progress callback still completes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore } = threeFactLedger(rootDir, "rebuild-quiet");
    const projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 1 });
    assert.equal(projection.rebuild().watermark, 3);
    projection.close();
  });
});

test("batched and coalesced replay has the same projection bytes as event-at-a-time apply", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const template = lifecycleFixture().events[0]!;
    if (template.type !== "task_created") throw new Error("lifecycle fixture must begin with task_created");
    const count = 130,
      events: PersistedCanonicalEventV1[] = Array.from({ length: count }, (_, index) => {
        const revision = index + 1,
          taskId = `equivalent-catch-up-${revision}`;
        return {
          ...template,
          eventId: `equivalent-event-${revision}`,
          opId: `equivalent-op-${revision}`,
          taskId,
          workspaceRevision: revision,
          payload: { ...template.payload, task: { ...template.payload.task, taskId, pinned: revision === 1 } },
        };
      }),
      fact = compileFactWrite({
        event: {
          schema: "fact-event/v1",
          eventId: "equivalent-fact-event",
          workspaceRevision: count + 1,
          opId: "equivalent-fact-op",
          taskId: "equivalent-catch-up-1",
          factId: "F-11223344",
          type: "fact_recorded",
          actor: { principal: { personId: "projection-rebuild-test" }, executor: null },
          source: "local",
          occurredAt: "2026-08-28T00:00:00.000Z",
          payload: {
            statement: "A fact replay keeps its persisted bytes.",
            evidenceSource: "projection replay equivalence fixture",
            observedAt: "2026-08-28T00:00:00.000Z",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
            provenance: [
              {
                runtime: "codex",
                sessionId: "projection-rebuild-progress",
                transcriptReachability: "by_session_id",
                boundAt: "2026-08-28T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      blobBySha = new Map(fact.blobs.map((blob) => [blob.sha256, new TextEncoder().encode(blob.body)]));
    events.push(fact.event);
    const amendedTaskId = "equivalent-catch-up-1",
      amendedTask = { ...template.payload.task, taskId: amendedTaskId, pinned: true };
    for (let index = 0; index < 70; index += 1) {
      const revision = events.length + 1;
      if (index === 35) {
        const interruptTaskId = "equivalent-interrupt-task";
        events.push({
          ...template,
          eventId: `equivalent-interrupt-event-${revision}`,
          opId: `equivalent-interrupt-op-${revision}`,
          taskId: interruptTaskId,
          workspaceRevision: revision,
          payload: { ...template.payload, task: { ...template.payload.task, taskId: interruptTaskId } },
        });
        continue;
      }
      const title = `Equivalent title revision ${revision}`;
      events.push({
        ...template,
        eventId: `equivalent-amend-event-${revision}`,
        opId: `equivalent-amend-op-${revision}`,
        taskId: amendedTaskId,
        workspaceRevision: revision,
        type: "task_amended",
        occurredAt: new Date(Date.UTC(2026, 7, 28, 0, index)).toISOString(),
        payload: {
          task: { ...amendedTask, title },
          mutation: { command: "amend", reason: title, fields: ["title"] },
          documentClaims: [],
        },
      } as PersistedCanonicalEventV1);
    }
    const eventCount = events.length,
      eventStore: EventStreamPort = {
        readHead: () => ({ revision: eventCount, eventDigest: `sha256:${"b".repeat(64)}` }),
        readBatch: (cursor, maxItems) => {
          const start = cursor === null ? 0 : Number(cursor),
            batch = events.slice(start, start + maxItems),
            end = start + batch.length;
          return {
            sourceRevision: eventCount,
            events: batch,
            cursor: end >= eventCount ? null : String(end),
            done: end >= eventCount,
            accessedItems: batch.length,
            prefetchContent: (replay) =>
              new Map(
                replay.flatMap((event) => {
                  const sha256 = event.schema === "fact-event/v1" ? event.payload.factsDocumentClaim?.sha256 : null,
                    bytes = sha256 === null || sha256 === undefined ? undefined : blobBySha.get(sha256);
                  return sha256 !== null && sha256 !== undefined && bytes !== undefined
                    ? [[sha256, bytes] as const]
                    : [];
                }),
              ),
          };
        },
        readContentBlob: (sha256) => blobBySha.get(sha256) ?? null,
      },
      batched = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 32 }),
      eventAtATime = makeTaskProjection({
        rootDir,
        eventStore,
        projectionPath: path.join(rootDir, ".harness/cache/event-at-a-time.sqlite"),
      });

    const receipt = batched.catchUp!();
    for (const event of events)
      eventAtATime.apply(
        event,
        event.schema === "fact-event/v1" ? factWritePlan(event) : taskLifecycleWritePlan(event as never),
      );
    eventAtATime.catchUp!();
    assert.equal(receipt.watermark, eventCount);
    assert.equal(receipt.metrics.maxBatchItems, 32);
    assert.equal(batched.readStateDigest(), eventAtATime.readStateDigest());
    assert.equal(JSON.stringify(batched.searchFacts({})), JSON.stringify(eventAtATime.searchFacts({})));
    batched.close();
    eventAtATime.close();
  });
});

function threeFactLedger(rootDir: string, repoId: string) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir });
  (["F-A1B2C3D4", "F-11223344", "F-DEADBEEF"] as const).forEach((factId, index) => {
    const event: FactEventDraftV1 = {
      schema: "fact-event/v1",
      eventId: `event-${factId}`,
      workspaceRevision: index + 1,
      opId: `op-${factId}`,
      factId,
      type: "fact_recorded",
      actor: { principal: { personId: "projection-rebuild-test" }, executor: null },
      source: "local",
      occurredAt: "2026-08-28T00:00:00.000Z",
      payload: {
        statement: `Rebuild progress fixture fact ${index + 1}.`,
        evidenceSource: "projection rebuild progress fixture",
        observedAt: "2026-08-28T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "projection-rebuild-progress",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
    };
    eventStore.append(compileFactWrite({ event }));
  });
  return {
    projectionPath: path.join(rootDir, ".harness/cache/task.sqlite"),
    eventStore,
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Rebuild Test");
  git(rootDir, "config", "user.email", "projection-rebuild@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
