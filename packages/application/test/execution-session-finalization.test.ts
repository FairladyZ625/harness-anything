// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  finalizeExecutionSessionBindings,
  makeJournaledWriteCoordinator,
  type ExecutionRecord
} from "../src/index.ts";
import { writeContentAddressedBlob, writeSessionEntity } from "../../kernel/src/index.ts";
import { inspectRuntimeTranscript } from "../src/runtime-session-logs.ts";
import { recordRuntimeTranscriptInspection } from "../src/runtime-transcript-confirmation.ts";
import { writeAttribution } from "./test-attribution.ts";

function primarySessionBinding(sessionId: string): ExecutionRecord["session_bindings"][number] {
  const attachedAt = "2026-07-11T00:00:00.000Z";
  return {
    binding_id: `primary:${sessionId}`,
    session_ref: `session/${sessionId}`,
    role: "primary",
    archive_status: "pending",
    attached_at: attachedAt,
    session: { runtime: "codex", sessionId, source: "runtime", detectedAt: attachedAt },
    capture_range: {
      range_id: `primary:${sessionId}:${attachedAt}`,
      coordinate: "timestamp",
      start_at: attachedAt,
      end_at: null,
      bounds: "inclusive"
    }
  };
}

test("Session binding finalization exports when possible and marks only confirmed missing transcripts unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-session-finalization-"));
  try {
    const endedAt = "2026-07-11T00:05:00.000Z";
    const logsRoot = path.join(rootDir, "runtime-logs");
    mkdirSync(logsRoot, { recursive: true });
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      attribution: writeAttribution("alice", "codex")
    });

    const archivedId = "archived-session";
    const bodyRef = writeContentAddressedBlob(rootDir, "# finalized session\n", "text/markdown; charset=utf-8");
    Effect.runSync(writeSessionEntity(coordinator, rootDir, {
      schema: "session-entity/v1",
      sessionId: archivedId,
      lifecycle: "sealed",
      archiveStatus: "complete",
      runtime: "codex",
      source: "runtime",
      detectedAt: "2026-07-11T00:00:00.000Z",
      exportedAt: "2026-07-11T00:01:00.000Z",
      bodyRef: { store: "authored-cas/v1", ...bodyRef },
      snapshot: {
        capturedAt: "2026-07-11T00:01:00.000Z",
        completeness: "complete",
        captureRange: { messageCount: 1 },
        privacyScan: { scannerVersion: "test", passed: true, findings: [] }
      }
    }));
    const archived = finalizeExecutionSessionBindings(
      rootDir,
      [primarySessionBinding(archivedId)],
      endedAt
    );
    assert.equal(archived[0]?.archive_status, "complete");

    const exportableId = "exportable-session";
    writeFileSync(path.join(logsRoot, `${exportableId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-11T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "export me" }
    })}\n`, "utf8");
    const exportableBinding = primarySessionBinding(exportableId);
    const exportableInspection = await inspectRuntimeTranscript(exportableBinding.session!, {
      runtimeLogRoots: { codex: [logsRoot] }
    });
    recordRuntimeTranscriptInspection(exportableBinding.session!, exportableInspection.status);
    assert.throws(() => finalizeExecutionSessionBindings(
      rootDir,
      [exportableBinding],
      endedAt
    ), /snapshot is not finalized/u);

    const unavailableId = "confirmed-missing-session";
    const unavailableBinding = primarySessionBinding(unavailableId);
    const unavailableInspection = await inspectRuntimeTranscript(unavailableBinding.session!, {
      runtimeLogRoots: { codex: [logsRoot] }
    });
    recordRuntimeTranscriptInspection(unavailableBinding.session!, unavailableInspection.status);
    const unavailable = finalizeExecutionSessionBindings(
      rootDir,
      [unavailableBinding],
      endedAt
    );
    assert.deepEqual(unavailable[0], {
      ...primarySessionBinding(unavailableId),
      archive_status: "unavailable",
      capture_range: {
        ...primarySessionBinding(unavailableId).capture_range!,
        end_at: endedAt
      }
    });
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", `${unavailableId}.md`)), false);

    const invalidRoot = path.join(rootDir, "not-a-jsonl-source.txt");
    writeFileSync(invalidRoot, "not a transcript\n", "utf8");
    const indeterminateBinding = primarySessionBinding("indeterminate-session");
    const indeterminateInspection = await inspectRuntimeTranscript(indeterminateBinding.session!, {
      runtimeLogRoots: { codex: [invalidRoot] }
    });
    recordRuntimeTranscriptInspection(indeterminateBinding.session!, indeterminateInspection.status);
    assert.throws(() => finalizeExecutionSessionBindings(
      rootDir,
      [indeterminateBinding],
      endedAt
    ), /snapshot is not finalized/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
