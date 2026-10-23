// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
import { scheduleArchivedDispatchStreamCompaction } from "../src/dispatch-stream-archive.ts";

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
