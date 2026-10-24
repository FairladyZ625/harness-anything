// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStream,
} from "../src/dispatch-stream.ts";
import {
  pruneDispatchStreamArchive,
  scheduleArchivedDispatchStreamCompaction,
} from "../src/dispatch-stream-archive.ts";

const ROOT = tmpdir();

test("archiving merges provider deltas, marks once, and preserves lifecycle reads", () => {
  const rootDir = mkdtempSync(path.join(ROOT, "ha-dispatch-compact-")),
    dispatchId = "dispatch_111111111111111111111111";
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-compact",
      instanceId: "instance-compact",
      startedAt: "2026-10-23T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      pid: 42,
      occurredAt: "2026-10-23T00:00:00.100Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:01.000Z",
      event: { type: "model.streaming", turnId: "turn-1", payload: { kind: "reasoning_delta", delta: "Thinking " } },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:02.000Z",
      event: { type: "model.streaming", turnId: "turn-1", payload: { kind: "reasoning_delta", delta: "carefully." } },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:03.000Z",
      event: {
        type: "model.streaming",
        turnId: "turn-1",
        payload: { kind: "text_delta", delta: "A complete answer." },
      },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:04.000Z",
      event: { type: "result", turnId: "turn-1", response: "A complete answer.", is_error: false },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_exit",
      exitCode: 0,
      occurredAt: "2026-10-23T00:00:05.000Z",
    });

    const before = readDispatchStream(rootDir, dispatchId)!,
      livePath = dispatchStreamPath(rootDir, dispatchId);
    assert.equal(before.header.transcriptCompactionVersion, undefined);
    assert.equal(statSync(livePath).size > 0, true);
    assert.equal(readFileSync(livePath, "utf8").includes("A complete answer."), true);

    archiveDispatchStream(rootDir, dispatchId);

    const archivedPath = dispatchStreamPath(rootDir, dispatchId),
      after = readDispatchStream(rootDir, dispatchId)!,
      archiveBytes = readFileSync(archivedPath);
    assert.equal(after.header.transcriptCompactionVersion, 1);
    assert.deepEqual(after.process, before.process);
    assert.deepEqual(after.terminalOutcome, before.terminalOutcome);
    assert.deepEqual(
      after.records.filter((record) => record.kind !== "provider_event"),
      before.records.filter((record) => record.kind !== "provider_event"),
    );
    assert.equal(
      after.records.filter((record) => record.kind === "provider_event").length,
      before.records.filter((record) => record.kind === "provider_event").length - 1,
    );
    assert.equal(after.records.filter((record) => record.transcriptCompactionSegment).length, 1);
    const reasoning = after.records
      .filter((record) => record.kind === "provider_event")
      .map((record) => record.event as Record<string, unknown>)
      .filter((event) => event.type === "model.streaming")
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.kind === "reasoning_delta");
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0]?.delta, "Thinking carefully.");

    archiveDispatchStream(rootDir, dispatchId);
    assert.deepEqual(readFileSync(archivedPath), archiveBytes);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("startup compaction queues only local archives and leaves live streams alone", () => {
  const rootDir = mkdtempSync(path.join(ROOT, "ha-dispatch-archive-scan-")),
    archivedId = "dispatch_222222222222222222222222",
    liveId = "dispatch_333333333333333333333333";
  try {
    openDispatchStream(rootDir, {
      dispatchId: archivedId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-legacy-archive",
      instanceId: "instance-compact",
      startedAt: "2026-10-23T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, archivedId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:01.000Z",
      event: {
        type: "acp.update",
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old archive." } },
      },
    });
    const archivedLivePath = dispatchStreamPath(rootDir, archivedId),
      archiveDirectory = path.join(path.dirname(archivedLivePath), "archive");
    mkdirSync(archiveDirectory, { recursive: true });
    renameSync(archivedLivePath, path.join(archiveDirectory, archivedId + ".jsonl"));

    openDispatchStream(rootDir, {
      dispatchId: liveId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-still-live",
      instanceId: "instance-compact",
      startedAt: "2026-10-23T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, liveId, {
      kind: "provider_event",
      occurredAt: "2026-10-23T00:00:01.000Z",
      event: { type: "model.streaming", turnId: "turn-1", payload: { kind: "text_delta", delta: "Live bytes." } },
    });
    const livePath = dispatchStreamPath(rootDir, liveId),
      liveBefore = readFileSync(livePath),
      jobs: (() => void | Promise<void>)[] = [];

    scheduleArchivedDispatchStreamCompaction(rootDir, (work) => jobs.push(work));
    assert.equal(jobs.length, 1);
    assert.equal(readDispatchStream(rootDir, liveId)?.header.transcriptCompactionVersion, undefined);
    assert.deepEqual(readFileSync(livePath), liveBefore);

    while (jobs.length > 0) jobs.shift()!();

    assert.equal(readDispatchStream(rootDir, archivedId)?.header.transcriptCompactionVersion, 1);
    assert.equal(readDispatchStream(rootDir, liveId)?.header.transcriptCompactionVersion, undefined);
    assert.deepEqual(readFileSync(livePath), liveBefore);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function archiveStreamFixture(
  rootDir: string,
  dispatchId: string,
  ageDays: number,
  fill: string,
): { readonly file: string; readonly sizeBytes: number } {
  const at = new Date(Date.parse("2026-10-24T00:00:00.000Z") - ageDays * 86_400_000);
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: `runtime-${dispatchId}`,
    instanceId: "instance-prune",
    startedAt: at.toISOString(),
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "provider_event",
    occurredAt: at.toISOString(),
    event: { type: "model.streaming", turnId: "turn-1", payload: { kind: "text_delta", delta: fill } },
  });
  const live = dispatchStreamPath(rootDir, dispatchId),
    archive = path.join(path.dirname(live), "archive"),
    archived = path.join(archive, `${dispatchId}.jsonl`);
  mkdirSync(archive, { recursive: true });
  renameSync(live, archived);
  utimesSync(archived, at, at);
  return { file: archived, sizeBytes: statSync(archived).size };
}

test("retention deletes archived streams past the day limit, keeps the boundary, and never touches live streams", () => {
  const rootDir = mkdtempSync(path.join(ROOT, "ha-dispatch-archive-prune-age-")),
    now = Date.parse("2026-10-24T00:00:00.000Z"),
    liveId = "dispatch_444444444444444444444444";
  try {
    const expired = archiveStreamFixture(rootDir, "dispatch_555555555555555555555555", 61, "Past retention."),
      boundary = archiveStreamFixture(rootDir, "dispatch_666666666666666666666666", 60, "Exactly at retention."),
      fresh = archiveStreamFixture(rootDir, "dispatch_777777777777777777777777", 59, "Inside retention.");
    openDispatchStream(rootDir, {
      dispatchId: liveId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-still-live",
      instanceId: "instance-prune",
      startedAt: "2026-10-23T00:00:00.000Z",
    });

    pruneDispatchStreamArchive(rootDir, { retentionDays: 60, retentionBytes: 0 }, now);
    // Re-running the same pass stays idempotent once the expired file is already gone.
    pruneDispatchStreamArchive(rootDir, { retentionDays: 60, retentionBytes: 0 }, now);

    assert.equal(existsSync(expired.file), false);
    assert.equal(existsSync(boundary.file), true);
    assert.equal(existsSync(fresh.file), true);
    assert.equal(existsSync(dispatchStreamPath(rootDir, liveId)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("retention evicts oldest archived streams past the byte cap, emptying the archive when even one stream exceeds it", () => {
  const now = Date.parse("2026-10-24T00:00:00.000Z"),
    capRoot = mkdtempSync(path.join(ROOT, "ha-dispatch-archive-prune-size-"));
  try {
    const oldest = archiveStreamFixture(capRoot, "dispatch_888888888888888888888888", 10, "Ten-day-old bytes."),
      newest = archiveStreamFixture(capRoot, "dispatch_999999999999999999999999", 1, "One-day-old bytes.");

    pruneDispatchStreamArchive(capRoot, { retentionDays: 0, retentionBytes: newest.sizeBytes }, now);
    assert.equal(existsSync(oldest.file), false, "the oldest stream is evicted to reach the cap");
    assert.equal(existsSync(newest.file), true, "the newest stream fits under the cap and stays");
  } finally {
    rmSync(capRoot, { recursive: true, force: true });
  }

  const emptyRoot = mkdtempSync(path.join(ROOT, "ha-dispatch-archive-prune-empty-"));
  try {
    const lone = archiveStreamFixture(emptyRoot, "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", 2, "A single oversized stream."),
      newer = archiveStreamFixture(emptyRoot, "dispatch_999999999999999999999999", 1, "One-day-old bytes.");

    pruneDispatchStreamArchive(
      emptyRoot,
      { retentionDays: 0, retentionBytes: Math.min(lone.sizeBytes, newer.sizeBytes) - 1 },
      now,
    );
    assert.equal(existsSync(lone.file), false, "a cap no single stream satisfies empties the archive");
    assert.equal(existsSync(newer.file), false, "the remaining stream also exceeds that cap");
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("retention with both limits disabled keeps every archived stream", () => {
  const rootDir = mkdtempSync(path.join(ROOT, "ha-dispatch-archive-prune-off-")),
    now = Date.parse("2026-10-24T00:00:00.000Z");
  try {
    const ancient = archiveStreamFixture(rootDir, "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb", 400, "Older than any default.");
    pruneDispatchStreamArchive(rootDir, { retentionDays: 0, retentionBytes: 0 }, now);
    assert.equal(existsSync(ancient.file), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
