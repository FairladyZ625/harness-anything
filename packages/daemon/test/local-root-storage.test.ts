// harness-test-tier: fast
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyTransition,
  compileFactWrite,
  compileTaskProgress,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  REPLAY_TASK_GRAPH,
  sha256Bytes,
  taskLifecycleWritePlan,
  type ActorAxes,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskProjectionQueries,
  type FactEventDraftV1,
  type WriteSource,
} from "@harness-anything/kernel";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { writeFileDurably } from "../../storage/src/durable-file.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchLiveIndexPath,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchLiveIndex,
} from "../src/daemon-host/dispatch-stream.ts";
import { scheduleArchivedDispatchStreamCompaction } from "../src/daemon-host/dispatch-stream-archive.ts";
import { dispatchEvidenceStatePath, writeDispatchEvidenceState } from "../src/daemon-host/dispatch-evidence-state.ts";
import {
  measureLocalRootStorage,
  reclaimLocalRootStorage,
  scheduleLocalRootReclamation,
} from "../src/daemon-host/local-root-storage.ts";
import type { RepoCellActionContext } from "../src/daemon-host/repo-cell-types.ts";
import { admitHandoffDispatch, runRuntimeHandoffAction } from "../src/daemon-host/runtime-handoff-store.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const dirLinkType = process.platform === "win32" ? "junction" : "dir";

function createTestRepo(prefix: string): { readonly rootDir: string; readonly cleanup: () => void } {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  return { rootDir, cleanup: () => removeTempRepository(rootDir) };
}

function writeDummyFile(target: string, bytes: number): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.alloc(bytes, 0x61));
}

function seedClosedDispatch(
  rootDir: string,
  dispatchId: string,
  taskId: string | null,
  startedAt: string,
  options: {
    readonly outcome?: "succeeded" | "failed" | "stopped";
    readonly classification?: string;
    readonly emitExit?: boolean;
  } = {},
): void {
  const outcome = options.outcome ?? "succeeded";
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
    kind: "provider_event",
    occurredAt: startedAt,
    event: { type: "result", turnId: "t1", response: "hello world", is_error: outcome !== "succeeded" },
  });
  if (options.emitExit !== false) {
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_exit",
      exitCode: outcome === "succeeded" ? 0 : 1,
      occurredAt: startedAt,
    });
  }
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "terminal_outcome",
    occurredAt: startedAt,
    reason: outcome,
    body: outcome,
    payload: {
      runtimeSessionId: `runtime-${dispatchId}`,
      outcome,
      ...(options.classification ? { attempt: { classification: options.classification } } : {}),
      resultRef: `dispatch:${dispatchId}`,
      result: { text: "hello world" },
      endedAt: startedAt,
    },
  });
}

test("F6 regression: measureLocalRootStorage classifies mixed runtime subtrees by full leaf path and excludes manual requests subdirectories from request-log bytes", () => {
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
    writeDummyFile(path.join(rootDir, ".harness", "runtime", "retired-dispatches", "legacy.jsonl"), 200);
    writeDummyFile(path.join(rootDir, ".harness", "runtime", "custom-debug", "trace.log"), 300);
    writeDummyFile(path.join(rootDir, ".harness", "requests", "requests.jsonl"), 120);
    writeDummyFile(path.join(rootDir, ".harness", "requests", "requests.jsonl.1"), 80);
    writeDummyFile(path.join(rootDir, ".harness", "requests", "from-deli-ai-lab", "ha-requests-20261109.md"), 4000);
    writeDummyFile(path.join(rootDir, ".harness", "settings.local.json"), 32);
    writeDummyFile(path.join(rootDir, "outside.txt"), 8192);
    if (process.platform !== "win32") {
      symlinkSync(path.join(rootDir, "outside.txt"), path.join(rootDir, ".harness", "cache", "linked-outside"));
    }

    const report = measureLocalRootStorage(rootDir);
    assert.equal(report.exists, true);
    assert.equal(report.byClass.authoritative.bytes, 1024 + 64);
    assert.equal(
      report.byClass.unrecognized.bytes,
      32 + 200 + 300 + 120 + 80 + 4000,
      "unknown runtime siblings and requests/ files must classify as unrecognized, never derived",
    );
    assert.ok(report.byClass.derived.bytes >= 512 + 256 + 128);
    assert.ok(
      report.byClass.derived.bytes < 512 + 256 + 128 + 200,
      "derived bytes must exclude unknown runtime siblings, manual requests docs, and symlink targets",
    );

    const runtimeEntry = report.entries.find((entry) => entry.name === "runtime");
    assert.equal(
      runtimeEntry?.classification,
      "unrecognized",
      "mixed runtime directory holding non-derived siblings must not be labeled wholly derived",
    );

    const requestHighlight = report.highlights.find((h) => h.path.startsWith("requests"));
    assert.ok(requestHighlight, "writer-owned request logs highlight must be reported");
    assert.equal(
      requestHighlight.bytes,
      200,
      "request log highlight must count only requests.jsonl and numbered rotations, excluding from-deli-ai-lab/",
    );
    assert.equal(requestHighlight.files, 2);
  } finally {
    cleanup();
  }
});

test("F3 regression: reclaimLocalRootStorage preserves canonical ledger replay, in-flight runtimes, pending evidence, and unrecognized runtime/retired-dispatches files", async () => {
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
  const handoffDoneId = "dispatch_888888888888888888888888";
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

    seedClosedDispatch(rootDir, settledStreamId, "task_done", recentIso);
    writeDispatchEvidenceState(rootDir, settledStreamId, "not-required");
    seedClosedDispatch(rootDir, legacyTerminalId, "task_done", recentIso);

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

    seedClosedDispatch(rootDir, pendingEvidenceId, "task_done", oldIso, { outcome: "failed" });
    writeDispatchEvidenceState(rootDir, pendingEvidenceId, "pending");

    seedClosedDispatch(rootDir, factProtectedArchiveId, "task_done", oldIso);
    archiveDispatchStream(rootDir, factProtectedArchiveId);
    seedClosedDispatch(rootDir, expiredArchiveId, "task_done", oldIso);
    archiveDispatchStream(rootDir, expiredArchiveId);

    writeDispatchEvidenceState(rootDir, orphanSidecarId, "stored");

    for (const [id, meta] of [
      [handoffDoneId, { taskId: "task_done", revokedAt: null }],
      [handoffRevokedId, { taskId: "task_active", revokedAt: recentIso }],
      [handoffResumedId, { taskId: "task_active", revokedAt: null }],
      [handoffActiveId, { taskId: "task_active", revokedAt: null }],
    ] as const) {
      const dir = path.join(rootDir, ".harness", "runtime-handoffs", id);
      writeFileDurably(path.join(dir, "checkpoint.json"), JSON.stringify({ dispatchId: id, ...meta }), 0o600);
      writeFileDurably(path.join(dir, "rollout.jsonl"), '{"kind":"rollout"}\n', 0o600);
    }

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
        stopProof: "proven_stopped",
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
        stopProof: "proven_stopped",
        outcome: "failed",
      },
    ]);

    const queryAdapter: Pick<
      TaskProjectionQueries,
      | "read"
      | "readDispatchLifecycle"
      | "readRuntimeDispatchByResumeSource"
      | "searchFacts"
      | "readCut"
      | "readEventList"
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
      readCut: () => ({ status: "ready", watermark: 2, sourceRevision: 2 }),
      readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
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
    assert.equal(result.archivedDispatches, 1);
    assert.equal(result.removedOrphanSidecars, 1);
    assert.equal(result.removedHandoffRollouts, 3);
    assert.ok(result.removedStaleCacheFiles >= 3);

    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, settledStreamId))), "archive");
    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, legacyTerminalId))), "dispatches");
    assert.ok(existsSync(dispatchStreamPath(rootDir, legacyTerminalId)));
    assert.deepEqual(
      readDispatchLiveIndex(rootDir, ["task_done"]).entries.map((entry) => entry.dispatchId),
      [legacyTerminalId, pendingEvidenceId],
    );

    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, liveStreamId))), "dispatches");
    assert.equal(path.basename(path.dirname(dispatchStreamPath(rootDir, pendingEvidenceId))), "dispatches");
    assert.equal(existsSync(dispatchStreamPath(rootDir, factProtectedArchiveId)), true);
    assert.equal(existsSync(dispatchStreamPath(rootDir, expiredArchiveId)), false);
    assert.equal(existsSync(dispatchEvidenceStatePath(rootDir, orphanSidecarId)), false);

    for (const id of [handoffDoneId, handoffRevokedId, handoffResumedId]) {
      assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", id, "rollout.jsonl")), false);
      assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", id, "checkpoint.json")), true);
    }
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "runtime-handoffs", handoffActiveId, "rollout.jsonl")),
      true,
    );

    assert.equal(
      existsSync(path.join(rootDir, ".harness", "cache", "completion-conversion-verification.sqlite")),
      false,
    );
    assert.equal(existsSync(path.join(rootDir, ".harness", "cache", "projections.sqlite")), false);
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "runtime", "retired-dispatches", "old.jsonl")),
      true,
      "unrecognized runtime/retired-dispatches files must NEVER be auto-deleted",
    );
    assert.equal(existsSync(path.join(rootDir, ".harness", "cache", "task.sqlite")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness", "wal.bricked-20260821-0940", "head.json")), true);
    assert.equal(existsSync(path.join(rootDir, ".harness", "settings.local.json")), true);

    projection.close();
    rmSync(path.join(rootDir, ".harness", "cache", "task.sqlite"), { force: true });
    const coldProjection = makeTaskProjection({ rootDir, eventStore });
    const afterRebuild = coldProjection.rebuild();
    assert.equal(afterRebuild.watermark, beforeRebuild.watermark);
    assert.equal(afterRebuild.stateDigest, beforeRebuild.stateDigest);
    coldProjection.close();
  } finally {
    await eventStore.drain();
    cleanup();
  }
});

test("F1 regression: legacy abnormal failed stream without sidecar, unproven-stop attempt, and foreign-node attempt remain uncompacted in live dispatches", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-f1-");
  const nowMs = Date.parse("2026-11-19T00:00:00.000Z");
  const oldIso = new Date(nowMs - 90 * 86_400_000).toISOString();

  const legacyFailedId = "dispatch_f10000000000000000000001";
  const legacyAwaitingRulingId = "dispatch_f10000000000000000000003";
  const unprovenStopId = "dispatch_f10000000000000000000004";
  const foreignNodeId = "dispatch_f10000000000000000000005";
  const recoveryPendingId = "dispatch_f10000000000000000000006";
  const legacyUnprovenId = "dispatch_f10000000000000000000007";

  const eventStore = makeTaskEventStore({ rootDir, repoId: "f1-test" });
  const projection = makeTaskProjection({ rootDir, eventStore });
  try {
    for (const event of lifecycleFixture({ taskId: "task_done", executionId: "exec-done", reviewId: "rev-done" })
      .events) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
    }

    seedClosedDispatch(rootDir, legacyFailedId, "task_done", oldIso, {
      outcome: "failed",
      classification: "provider_fault",
    });
    const rawLegacyFailedPath = dispatchStreamPath(rootDir, legacyFailedId);
    const rawLegacyFailedBytes = readFileSync(rawLegacyFailedPath);

    seedClosedDispatch(rootDir, legacyAwaitingRulingId, "task_done", oldIso, {
      outcome: "failed",
      classification: "awaiting_ruling",
    });
    seedClosedDispatch(rootDir, unprovenStopId, "task_done", oldIso, { outcome: "succeeded" });
    writeDispatchEvidenceState(rootDir, unprovenStopId, "not-required");

    seedClosedDispatch(rootDir, foreignNodeId, "task_done", oldIso, { outcome: "succeeded" });
    writeDispatchEvidenceState(rootDir, foreignNodeId, "not-required");

    seedClosedDispatch(rootDir, recoveryPendingId, "task_done", oldIso, { outcome: "succeeded" });
    writeDispatchEvidenceState(rootDir, recoveryPendingId, "not-required");

    seedClosedDispatch(rootDir, legacyUnprovenId, "task_done", oldIso, { emitExit: false });
    const legacyUnprovenPath = dispatchStreamPath(rootDir, legacyUnprovenId);
    const legacyUnprovenBytes = readFileSync(legacyUnprovenPath);

    archiveDispatchStream(rootDir, legacyFailedId);
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, legacyFailedId))),
      "dispatches",
      "archiveDispatchStream must honor mustPreserveDispatch for legacy abnormal failed streams without sidecars",
    );

    const lifecycleReader = lifecycleReadForSync([
      {
        dispatchId: legacyAwaitingRulingId,
        runtimeSessionId: `runtime-${legacyAwaitingRulingId}`,
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped",
        outcome: "failed",
      },
      {
        dispatchId: unprovenStopId,
        runtimeSessionId: `runtime-${unprovenStopId}`,
        attemptSettled: true,
        groupSettled: true,
        process: "unknown",
        stopProof: "unproven",
        outcome: "succeeded",
      },
      {
        dispatchId: foreignNodeId,
        runtimeSessionId: `runtime-${foreignNodeId}`,
        owner: "node:edge-other",
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped",
        outcome: "succeeded",
      },
      {
        dispatchId: recoveryPendingId,
        runtimeSessionId: `runtime-${recoveryPendingId}`,
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped",
        outcome: "succeeded",
      },
    ]);

    reclaimLocalRootStorage({
      rootDir,
      projection: {
        read: (taskId) => projection.read(taskId),
        readDispatchLifecycle: (query) => lifecycleReader(query),
        readRuntimeDispatchByResumeSource: () => null,
        searchFacts: () => ({ status: "ready", watermark: 1, sourceRevision: 1, facts: [] }),
        readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
        readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
      },
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs,
      recoveryDispatchIds: [recoveryPendingId],
    });

    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, legacyFailedId))),
      "dispatches",
      "legacy abnormal failed stream must remain in live dispatches and survive 60d archive retention",
    );
    assert.deepEqual(
      readFileSync(dispatchStreamPath(rootDir, legacyFailedId)),
      rawLegacyFailedBytes,
      "legacy abnormal failed stream must remain uncompacted byte-for-byte",
    );
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, unprovenStopId))),
      "dispatches",
      "attempt without proven_stopped single-attempt proof must remain in live dispatches",
    );
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, foreignNodeId))),
      "dispatches",
      "attempt owned by another node must not be archived by local reclamation",
    );
    assert.equal(
      path.basename(path.dirname(dispatchStreamPath(rootDir, recoveryPendingId))),
      "dispatches",
      "dispatch still pending runtime adoption/recovery must remain in live dispatches",
    );
    assert.equal(
      readFileSync(legacyUnprovenPath).equals(legacyUnprovenBytes),
      true,
      "legacy terminal outcome without lifecycle stop proof must remain in live dispatches",
    );
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "runtime", "dispatches", `${legacyAwaitingRulingId}.jsonl`)),
      false,
    );
  } finally {
    projection.close();
    await eventStore.drain();
    cleanup();
  }
});

test("F2 regression: cancelled task handoff rollout survives attach reclamation through reinstate and real target-node claim", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-f2-");
  const eventStore = makeTaskEventStore({ rootDir, repoId: "f2-handoff-repo" });
  const projection = makeTaskProjection({ rootDir, eventStore });
  const ownerActor: ActorAxes = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } };
  const targetSource: WriteSource = { kind: "node", nodeId: "node-two" };
  const dispatchId = "dispatch_f20000000000000000000001";
  const runtimeSessionId = "runtime_f20000000000000000000001";
  const nativeSessionId = "019abcdef-1234-5678-9999-abcdef123456";
  const rolloutBytes = Buffer.from(
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: nativeSessionId, cli_version: "0.159.1", timestamp: "2026-10-01T00:00:00.000Z" },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "preserve-across-cancel" }] },
    })}\n`,
  );

  try {
    let snapshot = emptyTaskLifecycleSnapshot();
    let rev = 0;
    const appendLifecycle = (
      source: WriteSource,
      intent: Parameters<typeof normalizeTaskLifecycleCommand>[1],
      proof: unknown,
    ) => {
      rev += 1;
      const cmd: TaskLifecycleCommand = {
        ...normalizeTaskLifecycleCommand(
          { workspaceId: "f2-handoff-repo", actor: ownerActor, source, expectedRevision: rev - 1 },
          intent,
        ),
        eventId: `ev-f2-${rev}`,
        workspaceRevision: rev,
        occurredAt: `2026-11-19T00:0${rev}:00.000Z`,
      };
      const applied = applyTransition(snapshot, cmd, proof as never);
      snapshot = applied.snapshot;
      const plan = taskLifecycleWritePlan(applied.event as TaskEventV1);
      eventStore.append({ event: applied.event as TaskEventV1, plan, blobs: [] });
      projection.apply(applied.event as TaskEventV1, plan);
    };

    appendLifecycle(
      "local",
      {
        type: "CreateReplayTask",
        taskId: "task_cancel_handoff",
        title: "Recoverable handoff task",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: "sha256:" + "1".repeat(64),
      },
      { taskIdUnique: true, actorBinding: ownerActor },
    );
    appendLifecycle(
      "local",
      { type: "StartExecution", taskId: "task_cancel_handoff", executionId: "exec-1" },
      {
        actorBinding: ownerActor,
        deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
        reservation: {
          taskId: "task_cancel_handoff",
          executionId: "exec-1",
          expiresAt: "2026-11-19T02:00:00.000Z",
          ttlMs: 3_600_000,
          previousHolder: null,
          reason: "initial_claim",
          version: 0,
        },
      },
    );
    appendLifecycle(
      "local",
      {
        type: "ReleaseRuntimeLease",
        taskId: "task_cancel_handoff",
        executionId: "exec-1",
        leaseVersion: 0,
        reason: "source runtime settled",
      },
      {},
    );

    const uploadRef = "doc-sync-claims/handoff_f2_upload";
    writeFileDurably(path.join(rootDir, ".harness", uploadRef), rolloutBytes, 0o600);

    const exportAuditEvents = new Map<string, object>();
    const lifecycleReader = lifecycleReadForSync([
      {
        dispatchId,
        runtimeSessionId,
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped",
        outcome: "succeeded",
      },
    ]);
    const cell = {
      rootDir,
      now: () => "2026-11-19T00:10:00.000Z",
      requiredCellText: (value: unknown) => String(value),
      store: {
        readEvent: (opId: string) => exportAuditEvents.get(opId) ?? null,
      },
      projection: {
        ...projection,
        readDispatchLifecycle: (query: Parameters<typeof lifecycleReader>[0]) => lifecycleReader(query),
        readRuntimeDispatchById: (id: string) =>
          id === dispatchId
            ? {
                event: {
                  actor: ownerActor,
                  source: "local" as WriteSource,
                  payload: {
                    dispatchId,
                    runtimeSessionId,
                    handoffEnabled: true,
                    kindId: "codex",
                    taskId: "task_cancel_handoff",
                    executionId: "exec-1",
                    agentId: "codex-worker",
                    definitionSnapshot: { model: "gpt-5.6-sol" },
                  },
                },
              }
            : null,
        readRuntimeSession: (id: string) =>
          id === runtimeSessionId
            ? {
                runtimeSessionId,
                providerSessionId: nativeSessionId,
                outcome: "succeeded",
                endedAt: "2026-11-19T00:05:00.000Z",
                resultRef: "artifact:runtime-result/sha256/" + "c".repeat(64),
              }
            : null,
        readRuntimeDispatchByResumeSource: () => null,
      },
      appendAuxiliaryRuntimeIngress: (draft: { readonly opId: string }) => {
        exportAuditEvents.set(draft.opId, draft);
        return { outcome: "applied", opId: draft.opId };
      },
      receiptForOperation: (opId: string) => ({ outcome: "applied", opId, revision: rev, evidence: opId }),
    } as unknown as RepoCellActionContext;

    const exported = runRuntimeHandoffAction(
      cell,
      {
        kind: "runtime-handoff-export",
        dispatchId,
        commit: "a".repeat(40),
        candidate: {
          ref: uploadRef,
          sha256: sha256Bytes(rolloutBytes),
          size: rolloutBytes.byteLength,
          mediaType: "application/x-ndjson",
        },
      } as never,
      { actor: ownerActor, source: "local" } as never,
    );
    assert.equal(exported.outcome, "applied");

    // Cancel task -> attach reclamation runs -> reinstate -> start on target node -> claim
    appendLifecycle(
      "local",
      {
        type: "TransitionTask",
        taskId: "task_cancel_handoff",
        status: "cancelled",
        force: true,
        reason: "batch cancel",
      },
      {},
    );
    assert.equal(projection.read("task_cancel_handoff").snapshot.task?.status, "cancelled");

    const reclaimDuringCancel = reclaimLocalRootStorage({
      rootDir,
      projection: {
        read: (taskId) => projection.read(taskId),
        readDispatchLifecycle: (query) => lifecycleReader(query),
        readRuntimeDispatchByResumeSource: () => null,
        searchFacts: () => ({ status: "ready", watermark: rev, sourceRevision: rev, facts: [] }),
        readCut: () => ({ status: "ready", watermark: rev, sourceRevision: rev }),
        readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
      },
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs: Date.parse("2026-11-19T00:15:00.000Z"),
    });
    assert.equal(
      reclaimDuringCancel.removedHandoffRollouts,
      0,
      "cancelled task handoff rollout must NOT be deleted because cancelled tasks can be reinstated",
    );

    appendLifecycle(
      "local",
      {
        type: "TransitionTask",
        taskId: "task_cancel_handoff",
        status: "planned",
        reason: "reinstate cancelled task",
      },
      {},
    );
    assert.equal(projection.read("task_cancel_handoff").snapshot.task?.status, "planned");

    appendLifecycle(
      targetSource,
      { type: "StartExecution", taskId: "task_cancel_handoff", executionId: "exec-1" },
      {
        actorBinding: ownerActor,
        deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
        reservation: {
          taskId: "task_cancel_handoff",
          executionId: "exec-1",
          expiresAt: "2026-11-19T03:00:00.000Z",
          ttlMs: 3_600_000,
          previousHolder: null,
          reason: "initial_claim",
          version: 1,
        },
      },
    );
    assert.equal(projection.read("task_cancel_handoff").snapshot.task?.status, "active");

    const claimed = runRuntimeHandoffAction(
      cell,
      { kind: "runtime-handoff-claim", dispatchId, offset: 0 } as never,
      { actor: ownerActor, source: targetSource } as never,
    ) as { readonly dataBase64?: string; readonly done?: boolean };
    assert.equal(claimed.done, true);
    assert.deepEqual(Buffer.from(claimed.dataBase64!, "base64"), rolloutBytes);

    assert.doesNotThrow(() =>
      admitHandoffDispatch(
        cell,
        {
          resumedFromDispatchId: dispatchId,
          handoffCheckpointId: dispatchId,
          acceptedCommit: "a".repeat(40),
          resumeProviderSessionId: nativeSessionId,
          taskId: "task_cancel_handoff",
          executionId: "exec-1",
          kindId: "codex",
        },
        { actor: ownerActor, source: targetSource } as never,
      ),
    );

    const reclaimAfterConsume = reclaimLocalRootStorage({
      rootDir,
      projection: {
        read: (taskId) => projection.read(taskId),
        readDispatchLifecycle: (query) => lifecycleReader(query),
        readRuntimeDispatchByResumeSource: (id) => (id === dispatchId ? { dispatchId: "dispatch_resumed" } : null),
        searchFacts: () => ({ status: "ready", watermark: rev, sourceRevision: rev, facts: [] }),
        readCut: () => ({ status: "ready", watermark: rev, sourceRevision: rev }),
        readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
      },
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs: Date.parse("2026-11-19T00:30:00.000Z"),
    });
    assert.equal(reclaimAfterConsume.removedHandoffRollouts, 1);
    assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", dispatchId, "rollout.jsonl")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness", "runtime-handoffs", dispatchId, "checkpoint.json")), true);
  } finally {
    projection.close();
    await eventStore.drain();
    cleanup();
  }
});

test("F4 regression: root and intermediate directory symlinks never traverse or mutate external node storage", () => {
  const external = createTestRepo("ha-local-storage-ext-");
  const rootSymRepo = createTestRepo("ha-local-storage-rootsym-");
  const midSymRepo = createTestRepo("ha-local-storage-midsym-");
  const nowMs = Date.parse("2026-11-19T00:00:00.000Z");
  const oldIso = new Date(nowMs - 90 * 86_400_000).toISOString();
  const extLiveId = "dispatch_f40000000000000000000001";
  const extArchiveId = "dispatch_f40000000000000000000002";
  const extSidecarId = "dispatch_f40000000000000000000003";
  const extHandoffId = "dispatch_f40000000000000000000004";

  try {
    seedClosedDispatch(external.rootDir, extLiveId, "task_done", oldIso);
    writeDispatchEvidenceState(external.rootDir, extLiveId, "not-required");
    seedClosedDispatch(external.rootDir, extArchiveId, "task_done", oldIso);
    archiveDispatchStream(external.rootDir, extArchiveId);
    writeDispatchEvidenceState(external.rootDir, extSidecarId, "stored");
    writeFileDurably(
      path.join(external.rootDir, ".harness", "runtime-handoffs", extHandoffId, "checkpoint.json"),
      JSON.stringify({ dispatchId: extHandoffId, taskId: "task_done", revokedAt: oldIso }),
      0o600,
    );
    writeFileDurably(
      path.join(external.rootDir, ".harness", "runtime-handoffs", extHandoffId, "rollout.jsonl"),
      '{"kind":"external"}\n',
      0o600,
    );
    writeDummyFile(path.join(external.rootDir, ".harness", "cache", "completion-conversion-verification.sqlite"), 512);
    writeDummyFile(path.join(external.rootDir, ".harness", "requests", "requests.jsonl"), 256);

    // 1. Root localRoot (.harness) is itself a symlink to external/.harness
    removeTempRepository(path.join(rootSymRepo.rootDir, ".harness"));
    symlinkSync(path.join(external.rootDir, ".harness"), path.join(rootSymRepo.rootDir, ".harness"), dirLinkType);

    // 2. Intermediate directories under midSymRepo/.harness are symlinks to external/.harness/*
    mkdirSync(path.join(midSymRepo.rootDir, ".harness"), { recursive: true });
    for (const sub of ["runtime", "runtime-handoffs", "cache", "requests"]) {
      symlinkSync(
        path.join(external.rootDir, ".harness", sub),
        path.join(midSymRepo.rootDir, ".harness", sub),
        dirLinkType,
      );
    }

    const doneProjection: Pick<
      TaskProjectionQueries,
      | "read"
      | "readDispatchLifecycle"
      | "readRuntimeDispatchByResumeSource"
      | "searchFacts"
      | "readCut"
      | "readEventList"
    > = {
      read: () =>
        ({ status: "ready", watermark: 1, sourceRevision: 1, snapshot: { task: { status: "done" } } }) as never,
      readDispatchLifecycle: lifecycleReadForSync([
        {
          dispatchId: extLiveId,
          runtimeSessionId: `runtime-${extLiveId}`,
          attemptSettled: true,
          groupSettled: true,
          stopProof: "proven_stopped",
          outcome: "succeeded",
        },
      ]),
      readRuntimeDispatchByResumeSource: () => ({ event: {} }) as never,
      searchFacts: () => ({ status: "ready", watermark: 1, sourceRevision: 1, facts: [] }),
      readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
      readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
    };

    const rootSymMeasure = measureLocalRootStorage(rootSymRepo.rootDir);
    assert.equal(rootSymMeasure.totalBytes, 0, "symlinked localRoot must never be traversed");

    const midSymMeasure = measureLocalRootStorage(midSymRepo.rootDir);
    assert.equal(
      midSymMeasure.byClass.derived.bytes,
      0,
      "intermediate directory symlinks must not count external derived storage",
    );
    assert.equal(midSymMeasure.highlights.length, 0, "highlights must not follow intermediate directory symlinks");

    for (const candidateRoot of [rootSymRepo.rootDir, midSymRepo.rootDir]) {
      reclaimLocalRootStorage({
        rootDir: candidateRoot,
        projection: doneProjection,
        retention: { retentionDays: 60, retentionBytes: 0 },
        nowMs,
      });
      scheduleArchivedDispatchStreamCompaction(candidateRoot, () => {
        assert.fail("attach must not schedule compaction through a linked directory");
      });
    }

    // Every single file in external.rootDir must remain untouched in its original place
    assert.equal(
      existsSync(path.join(external.rootDir, ".harness", "runtime", "dispatches", `${extLiveId}.jsonl`)),
      true,
    );
    assert.equal(
      existsSync(path.join(external.rootDir, ".harness", "runtime", "dispatches", "archive", `${extArchiveId}.jsonl`)),
      true,
    );
    assert.equal(existsSync(dispatchEvidenceStatePath(external.rootDir, extSidecarId)), true);
    assert.equal(
      existsSync(path.join(external.rootDir, ".harness", "runtime-handoffs", extHandoffId, "rollout.jsonl")),
      true,
    );
    assert.equal(
      existsSync(path.join(external.rootDir, ".harness", "cache", "completion-conversion-verification.sqlite")),
      true,
    );
  } finally {
    midSymRepo.cleanup();
    rootSymRepo.cleanup();
    external.cleanup();
  }
});

test("F5 regression: heavy single-task reclamation bounds per-turn dispatches, batches live-index writes, and reads Fact projection once", () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-f5-");
  const nowMs = Date.parse("2026-11-19T00:00:00.000Z");
  const recentIso = new Date(nowMs - 86_400_000).toISOString();
  const totalDispatches = DISPATCH_LIFECYCLE_PAGE_LIMIT + 35;
  const dispatchIds: string[] = [];

  try {
    for (let i = 0; i < totalDispatches; i += 1) {
      const id = `dispatch_f5${i.toString(16).padStart(22, "0")}`;
      dispatchIds.push(id);
      seedClosedDispatch(rootDir, id, "task_heavy", recentIso);
      writeDispatchEvidenceState(rootDir, id, "not-required");
    }
    assert.equal(readDispatchLiveIndex(rootDir, ["task_heavy"]).entries.length, totalDispatches);

    let factReads = 0;
    let lifecycleQueries = 0;
    const lifecycleReader = lifecycleReadForSync(
      dispatchIds.map((dispatchId) => ({
        dispatchId,
        runtimeSessionId: `runtime-${dispatchId}`,
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped" as const,
        outcome: "succeeded" as const,
      })),
    );
    const projection: Pick<
      TaskProjectionQueries,
      | "read"
      | "readDispatchLifecycle"
      | "readRuntimeDispatchByResumeSource"
      | "searchFacts"
      | "readCut"
      | "readEventList"
    > = {
      read: () =>
        ({ status: "ready", watermark: 1, sourceRevision: 1, snapshot: { task: { status: "done" } } }) as never,
      readDispatchLifecycle: (query) => {
        lifecycleQueries += 1;
        return lifecycleReader(query);
      },
      readRuntimeDispatchByResumeSource: () => null,
      searchFacts: () => {
        factReads += 1;
        return { status: "ready", watermark: 1, sourceRevision: 1, facts: [] };
      },
      readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
      readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
    };

    const firstTurn = reclaimLocalRootStorage({
      rootDir,
      projection,
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs,
    });
    assert.equal(
      firstTurn.archivedDispatches,
      DISPATCH_LIFECYCLE_PAGE_LIMIT,
      "each reclamation turn must bound processed live dispatches to DISPATCH_LIFECYCLE_PAGE_LIMIT",
    );
    assert.equal(lifecycleQueries, 1, "one bounded turn must issue at most one lifecycle page query");
    assert.equal(factReads, 1, "Fact projection must be read once, not duplicated");
    assert.equal(readDispatchLiveIndex(rootDir, ["task_heavy"]).entries.length, 35);

    const secondTurn = reclaimLocalRootStorage({
      rootDir,
      projection,
      retention: { retentionDays: 60, retentionBytes: 0 },
      nowMs,
    });
    assert.equal(secondTurn.archivedDispatches, 35);
    assert.equal(readDispatchLiveIndex(rootDir, ["task_heavy"]).entries.length, 0);
  } finally {
    cleanup();
  }
});

test("scheduleLocalRootReclamation interleaves bounded maintenance turns with normal writer work", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-interleave-");
  const recentIso = "2026-11-18T00:00:00.000Z";
  const dispatchIds: string[] = [];
  try {
    for (let i = 0; i < 25; i += 1) {
      const id = `dispatch_10${i.toString(16).padStart(22, "0")}`;
      dispatchIds.push(id);
      seedClosedDispatch(rootDir, id, "task_interleave", recentIso);
      writeDispatchEvidenceState(rootDir, id, "not-required");
    }
    const order: string[] = [];
    const queue: { readonly label: string; readonly work: () => void | Promise<void> }[] = [];
    const shardPath = dispatchLiveIndexPath(rootDir, "task_interleave");
    const initialShard = readFileSync(shardPath);
    const liveDispatchId = "dispatch_100000000000000000000019";
    const expired = Array.from({ length: 35 }, (_, index) => {
      const id = `dispatch_${index.toString(16).padStart(8, "0")}aa${"0".repeat(14)}`;
      seedClosedDispatch(rootDir, id, null, "2020-01-01T00:00:00.000Z");
      archiveDispatchStream(rootDir, id);
      return dispatchStreamPath(rootDir, id);
    });
    const shardPaths = Array.from({ length: 25 }, (_, index) => {
      const task = `task_other_${index}`;
      const id = `dispatch_20${index.toString(16).padStart(22, "0")}`;
      seedClosedDispatch(rootDir, id, task, recentIso);
      dispatchIds.push(id);
      return dispatchLiveIndexPath(rootDir, task);
    });
    const lifecycleReader = lifecycleReadForSync(
      dispatchIds.map((dispatchId) => ({
        dispatchId,
        runtimeSessionId: `runtime-${dispatchId}`,
        attemptSettled: true,
        groupSettled: true,
        stopProof: "proven_stopped",
        outcome: "succeeded",
      })),
    );
    const facts = Array.from({ length: 1000 }, (_, index) => ({
      evidenceSource: `.harness/runtime/dispatches/archive/dispatch_${index.toString(16).padStart(8, "0")}${index === 0 ? "aa" : "bb"}*.jsonl`,
    })) as ReturnType<TaskProjectionQueries["searchFacts"]>["facts"];
    let factReads = 0,
      watermark = 1;
    scheduleLocalRootReclamation({
      rootDir,
      projection: () => ({
        read: () =>
          ({ status: "ready", watermark, sourceRevision: watermark, snapshot: { task: { status: "done" } } }) as never,
        readDispatchLifecycle: lifecycleReader,
        readRuntimeDispatchByResumeSource: () => null,
        searchFacts: () => {
          factReads += 1;
          return { status: "ready", watermark, sourceRevision: watermark, facts };
        },
        readCut: () => ({ status: "ready", watermark, sourceRevision: watermark }),
        readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
      }),
      readRetention: () => ({ retentionDays: 60, retentionBytes: 0 }),
      schedule: (work) => {
        queue.push({ label: "reclaim-turn", work });
      },
      maxDispatchesPerTurn: 10,
      onComplete: () => {
        order.push("compaction-scheduled");
      },
    });
    // Enqueue a normal writer operation right behind the first reclamation turn; it must execute
    // BEFORE subsequent reclamation turns rather than starving behind all 25 streams.
    queue.push({
      label: "user-write",
      work: () => {
        const remaining = dispatchIds.filter(
          (id) => path.basename(path.dirname(dispatchStreamPath(rootDir, id))) === "dispatches",
        );
        assert.deepEqual(readFileSync(shardPath), initialShard, "maintenance has not rewritten the task index yet");
        seedClosedDispatch(rootDir, liveDispatchId, "task_interleave", recentIso, { emitExit: false });
        order.push(`user-write(remaining=${remaining.length})`);
      },
    });

    const remainingExpired = () => expired.filter((file) => existsSync(file)).length;
    const remainingShards = () =>
      shardPaths.filter((file) => JSON.parse(readFileSync(file, "utf8")).entries.length > 0).length;
    let interleavedWithExpiry = false;
    while (queue.length > 0) {
      const next = queue.shift()!;
      const oldExpired = remainingExpired(),
        oldShards = remainingShards();
      await next.work();
      assert.ok(oldShards - remainingShards() <= 10, "index rewrites must fit in a writer turn");
      assert.ok(oldExpired - remainingExpired() <= 10, "archive deletions must fit in a writer turn");
      if (oldExpired !== remainingExpired() && !interleavedWithExpiry) {
        interleavedWithExpiry = true;
        queue.unshift({
          label: "ordinary-write-during-expiry",
          work: () => {
            assert.ok(remainingExpired() > 1, "ordinary write runs before the archive sweep ends");
            watermark += 1;
            order.push("write-during-expiry");
          },
        });
      }
    }

    assert.equal(factReads, 1);
    assert.match(order[0]!, /^user-write\(remaining=/u);
    assert.deepEqual(order.slice(1), ["write-during-expiry", "compaction-scheduled"]);
    assert.equal(remainingShards(), 0);
    assert.deepEqual(
      expired.filter((file) => existsSync(file)),
      [expired[0]],
    );
    assert.deepEqual(
      readDispatchLiveIndex(rootDir, ["task_interleave"]).entries.map(({ dispatchId }) => dispatchId),
      [liveDispatchId],
    );
  } finally {
    cleanup();
  }
});

test("scheduled reclamation pages a real SQLite Fact projection between ordinary writer turns", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-fact-pages-");
  const eventStore = makeTaskEventStore({ rootDir, repoId: "fact-page-reclaim-test" });
  const projection = makeTaskProjection({ rootDir, eventStore });
  try {
    assert.equal(projection.readCut().status, "ready");
    const database = new DatabaseSync(projection.path),
      seed = database.prepare(
        "INSERT INTO fact(task_id,fact_id,ref,statement,evidence_source,observed_at,confidence,memory_class,op_id,workspace_revision,row_json) VALUES (NULL,?,?,?,?,?,?,?,?,0,?)",
      ),
      search = database.prepare("INSERT INTO fact_fts(fact_id,statement,evidence_source) VALUES (?,?,?)");
    try {
      database.exec("BEGIN");
      for (let index = 0; index < 640; index += 1) {
        const occurredAt = "2026-11-19T00:00:00.000Z",
          factId = `F-${index.toString().padStart(8, "0")}`,
          evidenceSource = `.harness/runtime/dispatches/archive/dispatch_${index.toString(16).padStart(24, "0")}.jsonl`,
          statement = `Fact ${index}: ${"evidence detail ".repeat(12)}`,
          row = {
            schema: "fact-row/v1",
            ref: `fact/${factId}`,
            factId,
            statement,
            evidenceSource,
            observedAt: occurredAt,
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
            provenance: [],
            actor: { principal: { personId: "fact-page-test" }, executor: null },
            source: "local",
            occurredAt,
            workspaceRevision: 0,
            archived: false,
          };
        seed.run(
          factId,
          `fact/${factId}`,
          statement,
          evidenceSource,
          occurredAt,
          "high",
          "semantic",
          `op-fact-page-${index}`,
          JSON.stringify(row),
        );
        search.run(factId, statement, evidenceSource);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    const arrivingDispatchId = `dispatch_${(640).toString(16).padStart(24, "0")}`;
    seedClosedDispatch(rootDir, arrivingDispatchId, null, "2020-01-01T00:00:00.000Z");
    archiveDispatchStream(rootDir, arrivingDispatchId);

    const pageSize = 64,
      maintenanceQueue: (() => void | Promise<void>)[] = [],
      order: string[] = [];
    let factPages = 0,
      writerRan = false;
    const scheduleReclamation = () =>
      scheduleLocalRootReclamation({
        rootDir,
        projection: () => ({
          ...projection,
          searchFacts: (filters) => {
            const result = projection.searchFacts(filters);
            factPages += 1;
            assert.ok(result.facts.length <= pageSize, "each writer turn reads a bounded SQLite Fact page");
            return result;
          },
        }),
        readRetention: () => ({ retentionDays: 60, retentionBytes: 0 }),
        schedule: (work) => maintenanceQueue.push(work),
        maxDispatchesPerTurn: 10,
        onComplete: () => order.push("reclamation-complete"),
      });
    scheduleReclamation();
    maintenanceQueue.push(() => {
      assert.equal(factPages, 1, "ordinary writes run before the next Fact page is decoded");
      writerRan = true;
      const occurredAt = "2026-11-19T00:00:00.000Z",
        event: FactEventDraftV1 = {
          schema: "fact-event/v1",
          eventId: "event-fact-page-writer",
          workspaceRevision: 1,
          opId: "op-fact-page-writer",
          factId: "F-00000640",
          type: "fact_recorded",
          actor: { principal: { personId: "fact-page-writer" }, executor: null },
          source: "local",
          occurredAt,
          payload: {
            statement: "Fact from an interleaved regular writer.",
            evidenceSource: `.harness/runtime/dispatches/archive/${arrivingDispatchId}.jsonl`,
            observedAt: occurredAt,
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
            provenance: [
              {
                runtime: "codex",
                sessionId: "fact-page-writer",
                transcriptReachability: "by_session_id",
                boundAt: occurredAt,
              },
            ],
          },
        },
        compiled = compileFactWrite({ event });
      eventStore.append(compiled);
      projection.apply(compiled.event, compiled.plan);
      order.push("ordinary-writer");
    });

    while (maintenanceQueue.length > 0) await maintenanceQueue.shift()!();
    assert.equal(existsSync(dispatchStreamPath(rootDir, arrivingDispatchId)), true);
    scheduleReclamation();
    while (maintenanceQueue.length > 0) await maintenanceQueue.shift()!();

    assert.equal(writerRan, true);
    assert.equal(factPages, 13, "one interrupted scan reads two pages, then the stable scan reads exactly eleven");
    assert.deepEqual(order, ["ordinary-writer", "reclamation-complete", "reclamation-complete"]);
    assert.equal(existsSync(dispatchStreamPath(rootDir, arrivingDispatchId)), true);
    assert.equal(projection.searchFacts({}).facts.length, 641);
  } finally {
    projection.close();
    cleanup();
  }
});

test("scheduled reclamation completes SQLite Fact paging across an ordinary task-progress write", async () => {
  const { rootDir, cleanup } = createTestRepo("ha-local-storage-progress-pages-");
  const eventStore = makeTaskEventStore({ rootDir, repoId: "fact-progress-page-reclaim-test" });
  const projection = makeTaskProjection({ rootDir, eventStore });
  try {
    assert.equal(projection.readCut().status, "ready");
    const taskId = "task_progress_page_interleave",
      executionId = "execution_progress_page_interleave",
      lifecycleEvents = lifecycleFixture({ taskId, executionId }).events.slice(0, 2);
    for (const event of lifecycleEvents) {
      const plan = taskLifecycleWritePlan(event);
      eventStore.append({ event, plan, blobs: [] });
      projection.apply(event, plan);
    }
    const database = new DatabaseSync(projection.path),
      seed = database.prepare(
        "INSERT INTO fact(task_id,fact_id,ref,statement,evidence_source,observed_at,confidence,memory_class,op_id,workspace_revision,row_json) VALUES (NULL,?,?,?,?,?,?,?,?,0,?)",
      ),
      search = database.prepare("INSERT INTO fact_fts(fact_id,statement,evidence_source) VALUES (?,?,?)");
    try {
      database.exec("BEGIN");
      for (let index = 0; index < 65; index += 1) {
        const occurredAt = "2026-11-19T00:00:00.000Z",
          factId = `F-${index.toString().padStart(8, "0")}`,
          evidenceSource = `.harness/runtime/dispatches/archive/dispatch_${index.toString(16).padStart(24, "0")}.jsonl`,
          statement = `Fact ${index}: ${"evidence detail ".repeat(12)}`,
          row = {
            schema: "fact-row/v1",
            ref: `fact/${factId}`,
            factId,
            statement,
            evidenceSource,
            observedAt: occurredAt,
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
            provenance: [],
            actor: { principal: { personId: "fact-progress-page-test" }, executor: null },
            source: "local",
            occurredAt,
            workspaceRevision: 0,
            archived: false,
          };
        seed.run(
          factId,
          `fact/${factId}`,
          statement,
          evidenceSource,
          occurredAt,
          "high",
          "semantic",
          `op-fact-progress-page-${index}`,
          JSON.stringify(row),
        );
        search.run(factId, statement, evidenceSource);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    const expiringDispatchId = `dispatch_${(65).toString(16).padStart(24, "0")}`;
    seedClosedDispatch(rootDir, expiringDispatchId, null, "2020-01-01T00:00:00.000Z");
    archiveDispatchStream(rootDir, expiringDispatchId);

    const maintenanceQueue: (() => void | Promise<void>)[] = [];
    let factPages = 0,
      writerRan = false;
    scheduleLocalRootReclamation({
      rootDir,
      projection: () => ({
        ...projection,
        searchFacts: (filters) => {
          const result = projection.searchFacts(filters);
          factPages += 1;
          assert.ok(result.facts.length <= 64, "each Fact query stays within the page limit");
          return result;
        },
      }),
      readRetention: () => ({ retentionDays: 60, retentionBytes: 0 }),
      schedule: (work) => maintenanceQueue.push(work),
      maxDispatchesPerTurn: 10,
    });
    maintenanceQueue.push(() => {
      assert.equal(factPages, 1, "the ordinary writer interleaves after the first Fact page read");
      const actor = { principal: { personId: "person-owner" }, executor: null } as const,
        progress = compileTaskProgress({
          taskId,
          executionId,
          packagePath: projection.read(taskId).packagePath!,
          text: "ordinary non-Fact write between Fact pages",
          evidence: [],
          currentDocument: null,
          activeLease: null,
          startRecoveryAvailable: false,
          asOwner: true,
          taskCreatedBy: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex" } },
          actor,
          source: "local",
          eventId: "event-progress-page-interleave",
          opId: "op-progress-page-interleave",
          workspaceRevision: 3,
          occurredAt: "2026-11-19T00:00:01.000Z",
        });
      eventStore.append(progress);
      projection.apply(progress.event, progress.plan);
      writerRan = true;
    });

    while (maintenanceQueue.length > 0) await maintenanceQueue.shift()!();
    assert.equal(writerRan, true);
    assert.equal(factPages, 2, "both pages finish without restarting the Fact scan");
    assert.equal(existsSync(dispatchStreamPath(rootDir, expiringDispatchId)), false);
  } finally {
    projection.close();
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
    writeDispatchEvidenceState(edgeA.rootDir, dispatchA, "not-required");
    seedClosedDispatch(edgeB.rootDir, dispatchB, null, "2026-10-01T00:00:00.000Z");
    writeDispatchEvidenceState(edgeB.rootDir, dispatchB, "not-required");

    const pendingProjection: Pick<
      TaskProjectionQueries,
      | "read"
      | "readDispatchLifecycle"
      | "readRuntimeDispatchByResumeSource"
      | "searchFacts"
      | "readCut"
      | "readEventList"
    > = {
      read: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }) as never,
      readDispatchLifecycle: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }),
      readRuntimeDispatchByResumeSource: () => null,
      searchFacts: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }),
      readCut: () => ({ status: "pending", watermark: 0, sourceRevision: 1 }),
      readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
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
      | "read"
      | "readDispatchLifecycle"
      | "readRuntimeDispatchByResumeSource"
      | "searchFacts"
      | "readCut"
      | "readEventList"
    > = {
      read: () => ({ status: "ready", watermark: 1, sourceRevision: 1, snapshot: { task: null } }) as never,
      readDispatchLifecycle: lifecycleReadForSync([
        {
          dispatchId: dispatchA,
          runtimeSessionId: `runtime-${dispatchA}`,
          attemptSettled: true,
          groupSettled: true,
          stopProof: "proven_stopped",
          outcome: "succeeded",
        },
      ]),
      readRuntimeDispatchByResumeSource: () => null,
      searchFacts: () => ({ status: "ready", watermark: 1, sourceRevision: 1, facts: [] }),
      readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
      readEventList: () => ({ rows: [], hasMore: false, nextCursor: null }),
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
