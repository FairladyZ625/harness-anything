// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { taskLifecycleWritePlan, type TaskProjectionQueries } from "@harness-anything/kernel";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { writeFileDurably } from "../../storage/src/durable-file.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchLiveIndex,
} from "../src/daemon-host/dispatch-stream.ts";
import { dispatchEvidenceStatePath, writeDispatchEvidenceState } from "../src/daemon-host/dispatch-evidence-state.ts";
import { measureLocalRootStorage, reclaimLocalRootStorage } from "../src/daemon-host/local-root-storage.ts";
import { cachePurgeDerivedDirectories } from "../src/daemon-host/repo-cache-purge.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

function createTestRepo(prefix: string): { readonly rootDir: string; readonly cleanup: () => void } {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  return { rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

function writeDummyFile(target: string, bytes: number): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.alloc(bytes, 0x61));
}

function seedClosedDispatch(rootDir: string, dispatchId: string, taskId: string | null, startedAt: string): void {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId,
    executionId: taskId ? `exec-${taskId}` : null,
    runtimeSessionId: `runtime-${dispatchId}`,
    instanceId: "instance-test",
    startedAt,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "process_started",
    pid: 999_999,
    occurredAt: startedAt,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "provider_event",
    occurredAt: startedAt,
    event: { type: "model.streaming", turnId: "t1", payload: { kind: "text_delta", delta: "hello " } },
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "provider_event",
    occurredAt: startedAt,
    event: { type: "model.streaming", turnId: "t1", payload: { kind: "text_delta", delta: "world" } },
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "process_exit",
    exitCode: 0,
    occurredAt: startedAt,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "terminal_outcome",
    occurredAt: startedAt,
    reason: "completed",
    body: "done",
    payload: {
      runtimeSessionId: `runtime-${dispatchId}`,
      outcome: "succeeded",
      resultRef: `dispatch:${dispatchId}`,
      result: { text: "hello world" },
      endedAt: startedAt,
    },
  });
}

test("measureLocalRootStorage handles missing localRoot and classifies entries against purge SSoT without following symlinks", () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-measure-");
  try {
    const missing = measureLocalRootStorage(rootDir);
    assert.equal(missing.schema, "doctor-storage/v1");
    assert.equal(missing.exists, false);
    assert.equal(missing.totalBytes, 0);

    writeDummyFile(path.join(rootDir, ".harness", "store", "generations", "3", "ledger.sqlite"), 1024);
    writeDummyFile(path.join(rootDir, ".harness", "wal", "head.json"), 64);
    writeDummyFile(path.join(rootDir, ".harness", "cache", "task.sqlite"), 512);
    writeDummyFile(path.join(rootDir, ".harness", "cache", "completion-conversion-verification.sqlite"), 256);
    writeDummyFile(
      path.join(rootDir, ".harness", "runtime", "dispatches", "archive", "dispatch_111111111111111111111111.jsonl"),
      128,
    );
    writeDummyFile(path.join(rootDir, ".harness", "settings.local.json"), 32);
    writeDummyFile(path.join(rootDir, "outside.txt"), 4096);
    symlinkSync(path.join(rootDir, "outside.txt"), path.join(rootDir, ".harness", "cache", "linked-outside"));

    const report = measureLocalRootStorage(rootDir);
    assert.equal(report.exists, true);
    assert.equal(report.byClass.authoritative.bytes, 1024 + 64);
    assert.equal(report.byClass.unrecognized.bytes, 32);
    assert.ok(report.byClass.derived.bytes >= 512 + 256 + 128);
    assert.ok(report.byClass.derived.bytes < 4096, "symlink target bytes outside localRoot must not be traversed");

    const topDerived = new Set(cachePurgeDerivedDirectories.map((entry) => entry.split("/")[0]!));
    for (const entry of report.entries) {
      if (topDerived.has(entry.name)) assert.equal(entry.classification, "derived");
    }
    assert.ok(report.highlights.some((h) => h.path === "cache/completion-conversion-verification.sqlite"));
    assert.ok(report.highlights.some((h) => h.path === "store/generations"));
  } finally {
    cleanup();
  }
});

test("reclaimLocalRootStorage preserves canonical ledger replay, in-flight runtimes, pending evidence, and active handoffs while reclaiming terminal/derived artifacts", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-reclaim-");
  const nowMs = Date.parse("2026-11-19T00:00:00.000Z");
  const oldIso = new Date(nowMs - 90 * 86_400_000).toISOString();
  const recentIso = new Date(nowMs - 2 * 86_400_000).toISOString();

  const settledStreamId = "dispatch_111111111111111111111111";
  const legacyTerminalId = "dispatch_222222222222222222222222";
  const liveStreamId = "dispatch_333333333333333333333333";
  const pendingEvidenceId = "dispatch_444444444444444444444444";
  const factProtectedArchiveId = "dispatch_555555555555555555555555";
  const expiredArchiveId = "dispatch_666666666666666666666666";
  const orphanSidecarId = "dispatch_777777777777777777777777";
  const handoffTerminalId = "dispatch_888888888888888888888888";
  const handoffRevokedId = "dispatch_999999999999999999999999";
  const handoffResumedId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa";
  const handoffActiveId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb";

  const eventStore = makeTaskEventStore({ rootDir, repoId: "reclaim-test" });
  const projection = makeTaskProjection({ rootDir, eventStore });
  try {
    const doneEvents = lifecycleFixture({
      taskId: "task_done",
      executionId: "exec-done",
      reviewId: "review-done",
    }).events;
    const activeEvents = lifecycleFixture({
      taskId: "task_active",
      executionId: "exec-active",
      reviewId: "review-active",
    })
      .events.slice(0, 2)
      .map((event, index) => ({
        ...event,
        eventId: `event-active-${index + 1}`,
        opId: `${event.opId}-active`,
        workspaceRevision: doneEvents.length + index + 1,
      }));
    const allEvents = [...doneEvents, ...activeEvents];
    for (const event of allEvents) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
    }

    const beforeRebuild = projection.rebuild();
    assert.equal(beforeRebuild.watermark, allEvents.length);

    // 1. Settled dispatch still in live dispatches/ (must be archived + compacted + removed from live-index)
    seedClosedDispatch(rootDir, settledStreamId, "task_done", recentIso);
    writeDispatchEvidenceState(rootDir, settledStreamId, "not-required");
    assert.equal(readDispatchLiveIndex(rootDir, ["task_done"]).entries.length, 1);

    // 2. Legacy pre-lifecycle dispatch for a terminal task (no lifecycle row, terminalOutcome present)
    seedClosedDispatch(rootDir, legacyTerminalId, "task_done", recentIso);

    // 3. In-flight runtime dispatch (must NEVER be archived or deleted)
    openDispatchStream(rootDir, {
      dispatchId: liveStreamId,
      taskId: "task_active",
      executionId: "exec-active",
      runtimeSessionId: "runtime-live",
      instanceId: "instance-test",
      startedAt: recentIso,
    });
    appendRuntimeWorkerRecord(rootDir, liveStreamId, {
      kind: "process_started",
      pid: process.pid,
      occurredAt: recentIso,
    });

    // 4. Settled dispatch whose evidence is still pending (must NEVER be compacted or deleted)
    seedClosedDispatch(rootDir, pendingEvidenceId, "task_done", oldIso);
    writeDispatchEvidenceState(rootDir, pendingEvidenceId, "pending");

    // 5. Archived streams: one Fact-protected (must survive >60d), one expired (must be pruned)
    seedClosedDispatch(rootDir, factProtectedArchiveId, "task_done", oldIso);
    archiveDispatchStream(rootDir, factProtectedArchiveId);
    seedClosedDispatch(rootDir, expiredArchiveId, "task_done", oldIso);
    archiveDispatchStream(rootDir, expiredArchiveId);

    // 6. Orphaned non-pending evidence sidecar
    writeDispatchEvidenceState(rootDir, orphanSidecarId, "stored");

    // 7. Handoffs: terminal task, revoked, resumed -> rollout removed; active -> rollout preserved
    for (const [id, meta] of [
      [handoffTerminalId, { taskId: "task_done", revokedAt: null }],
      [handoffRevokedId, { taskId: "task_active", revokedAt: recentIso }],
      [handoffResumedId, { taskId: "task_active", revokedAt: null }],
      [handoffActiveId, { taskId: "task_active", revokedAt: null }],
    ] as const) {
      const dir = path.join(rootDir, ".harness", "runtime-handoffs", id);
      writeFileDurably(path.join(dir, "checkpoint.json"), JSON.stringify({ dispatchId: id, ...meta }), 0o600);
      writeFileDurably(path.join(dir, "rollout.jsonl"), '{"kind":"rollout"}\n', 0o600);
    }

    // 8. Leaked verification SQLite, legacy projections.sqlite, retired-dispatches, and preserved unrecognized files
    writeDummyFile(path.join(rootDir, ".harness", "cache", "completion-conversion-verification.sqlite"), 512);
    writeDummyFile(path.join(rootDir, ".harness", "cache", "completion-conversion-verification.sqlite-wal"), 64);
    writeDummyFile(path.join(rootDir, ".harness", "cache", "projections.sqlite"), 128);
    writeDummyFile(path.join(rootDir, ".harness", "runtime", "retired-dispatches", "old.jsonl"), 128);
    writeDummyFile(path.join(rootDir, ".harness", "wal.bricked-20260821-0940", "head.json"), 64);
    writeDummyFile(path.join(rootDir, ".harness", "settings.local.json"), 64);

    const lifecycleReader = lifecycleReadForSync([
      {
        dispatchId: settledStreamId,
        runtimeSessionId: `runtime-${settledStreamId}`,
        attemptSettled: true,
        groupSettled: true,
        outcome: "succeeded",
      },
      {
        dispatchId: liveStreamId,
        runtimeSessionId: "runtime-live",
        attemptSettled: false,
        groupSettled: false,
        process: "alive",
        stopProof: "unproven",
        outcome: null,
      },
      {
        dispatchId: pendingEvidenceId,
        runtimeSessionId: `runtime-${pendingEvidenceId}`,
        attemptSettled: true,
        groupSettled: true,
        outcome: "failed",
      },
    ]);

    const queryAdapter: Pick<
      TaskProjectionQueries,
      "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
    > = {
      read: (taskId) => projection.read(taskId),
      readDispatchLifecycle: (query) => lifecycleReader(query),
      readRuntimeDispatchByResumeSource: (dispatchId) =>
        dispatchId === handoffResumedId ? ({ event: {} } as never) : null,
      searchFacts: () => ({
        status: "ready",
        watermark: 2,
        sourceRevision: 2,
        facts: [
          {
            evidenceSource: `.harness/runtime/dispatches/archive/${factProtectedArchiveId}.jsonl`,
          } as never,
        ],
      }),
    };

    const result = reclaimLocalRootStorage({
      rootDir,
      projection: queryAdapter,
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs,
      liveRuntimeSessionIds: new Set(["runtime-live"]),
    });

    assert.equal(result.skippedReason, null);
    assert.equal(result.archivePruned, true);
    assert.equal(result.archivedDispatches, 2);
    assert.equal(result.removedOrphanSidecars, 1);
    assert.equal(result.removedHandoffRollouts, 3);
    assert.equal(result.removedRetiredDispatches, true);
    assert.ok(result.removedStaleCacheFiles >= 3);

    // Settled & legacy terminal streams moved to archive and dropped from live-index
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, settledStreamId))),
      "archive",
      "settled stream moved to archive",
    );
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, legacyTerminalId))),
      "archive",
      "legacy terminal stream moved to archive",
    );
    assert.deepEqual(
      readDispatchLiveIndex(rootDir, ["task_done"]).entries.map((entry) => entry.dispatchId),
      [pendingEvidenceId],
    );

    // In-flight runtime and pending evidence remain untouched in dispatches/
    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, liveStreamId))), "dispatches");
    assert.equal(existsSync(dispatchStreamPath(rootDir, liveStreamId)), true);
    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, pendingEvidenceId))), "dispatches");
    assert.equal(existsSync(dispatchEvidenceStatePath(rootDir, pendingEvidenceId)), true);

    // Fact-protected archive survives, expired archive pruned, orphan sidecar pruned
    assert.equal(existsSync(dispatchStreamPath(rootDir, factProtectedArchiveId)), true);
    assert.equal(existsSync(dispatchStreamPath(rootDir, expiredArchiveId)), false);
    assert.equal(existsSync(dispatchEvidenceStatePath(rootDir, orphanSidecarId)), false);

    // Handoff rollouts: terminal/revoked/resumed removed (checkpoint.json preserved); active rollout preserved
    for (const id of [handoffTerminalId, handoffRevokedId, handoffResumedId]) {
      assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", id, "rollout.jsonl")), false);
      assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", id, "checkpoint.json")), true);
    }
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "runtime-handoffs", handoffActiveId, "rollout.jsonl")),
      true,
    );

    // Leaked cache & retired-dispatches removed; active task.sqlite and unrecognized preserved
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "cache", "completion-conversion-verification.sqlite")),
      false,
    );
    assert.equal(existsSync(path.join(rootDir, ".harness", "cache", "projections.sqlite")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness", "runtime", "retired-dispatches", "old.jsonl")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness", "cache", "task.sqlite")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness", "wal.bricked-20260821-0940", "head.json")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness", "settings.local.json")), true);

    // Canonical ledger cold rebuild is 100% invariant before and after reclamation
    projection.close();
    rmSync(path.join(rootDir, ".harness", "cache", "task.sqlite"), { force: true });
    const coldProjection = makeTaskProjection({ rootDir, eventStore });
    const afterRebuild = coldProjection.rebuild();
    assert.equal(afterRebuild.watermark, beforeRebuild.watermark);
    assert.equal(afterRebuild.stateDigest, beforeRebuild.stateDigest);
    assert.equal(coldProjection.read("task_done").snapshot.task?.status, "done");
    assert.equal(coldProjection.read("task_active").snapshot.task?.status, "active");
    coldProjection.close();
  } finally {
    await eventStore.drain();
    cleanup();
  }
});

test("reclaimLocalRootStorage fails closed when projections are pending and isolates independent edge localRoots", () => {
  const edgeA = createTestRepo("ha-local-edge-a-");
  const edgeB = createTestRepo("ha-local-edge-b-");
  try {
    const dispatchA = "dispatch_cccccccccccccccccccccccc";
    const dispatchB = "dispatch_dddddddddddddddddddddddd";
    seedClosedDispatch(edgeA.rootDir, dispatchA, null, "2026-10-01T00:00:00.000Z");
    seedClosedDispatch(edgeB.rootDir, dispatchB, null, "2026-10-01T00:00:00.000Z");

    const pendingProjection: Pick<
      TaskProjectionQueries,
      "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
    > = {
      read: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }) as never,
      readDispatchLifecycle: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }),
      readRuntimeDispatchByResumeSource: () => null,
      searchFacts: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }),
    };

    const skipped = reclaimLocalRootStorage({
      rootDir: edgeA.rootDir,
      projection: pendingProjection,
      retention: { retentionDays: 60, retentionBytes: 0 },
    });
    assert.equal(skipped.archivedDispatches, 0);
    assert.equal(skipped.archivePruned, false);
    assert.equal(skipped.skippedReason, "dispatch lifecycle projection pending");
    assert.equal(path.basename(path.dirname(dispatchStreamPath(edgeA.rootDir, dispatchA))), "dispatches");

    const readyProjection: Pick<
      TaskProjectionQueries,
      "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
    > = {
      read: () => ({ status: "ready", watermark: 1, sourceRevision: 1, snapshot: { task: null } }) as never,
      readDispatchLifecycle: lifecycleReadForSync([
        {
          dispatchId: dispatchA,
          runtimeSessionId: `runtime-${dispatchA}`,
          attemptSettled: true,
          groupSettled: true,
          outcome: "succeeded",
        },
      ]),
      readRuntimeDispatchByResumeSource: () => null,
      searchFacts: () => ({ status: "ready", watermark: 1, sourceRevision: 1, facts: [] }),
    };

    const reclaimed = reclaimLocalRootStorage({
      rootDir: edgeA.rootDir,
      projection: readyProjection,
      retention: { retentionDays: 60, retentionBytes: 0 },
    });
    assert.equal(reclaimed.archivedDispatches, 1);
    assert.equal(path.basename(path.dirname(dispatchStreamPath(edgeA.rootDir, dispatchA))), "archive");
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(edgeB.rootDir, dispatchB))),
      "dispatches",
      "reclaiming edge A must not mutate edge B",
    );
    assert.equal(
      readdirSync(path.join(edgeB.rootDir, ".harness", "runtime", "dispatches")).includes(`${dispatchB}.jsonl`),
      true,
    );
  } finally {
    edgeA.cleanup();
    edgeB.cleanup();
  }
});
