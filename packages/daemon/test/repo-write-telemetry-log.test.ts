// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  DaemonLogAppendInput,
  DaemonLogEntryV1,
  DaemonLogService
} from "@harness-anything/application";
import { createRepoWriteTelemetryLogObservers } from "../src/observability/repo-write-telemetry-log-observers.ts";
import {
  decodeRepoWriteTelemetryLog,
  encodeRepoWriteTelemetryBatchLog
} from "../src/observability/repo-write-telemetry-log.ts";
import {
  repoWriteProtocolType,
  type RepoWriteTelemetryBatchFrame
} from "../src/runtime/repo-write-protocol.ts";

test("compact telemetry log batches round-trip every phase and detail", () => {
  const scriptPhases = [
    "script-manifest",
    "script-scope",
    "script-stage",
    "script-syntax",
    "script-execute",
    "script-ingest"
  ] as const;
  const frame: RepoWriteTelemetryBatchFrame = {
    protocol: repoWriteProtocolType,
    repoId: "canonical",
    generation: 7,
    kind: "telemetry-batch",
    requestId: "request-compact",
    opId: "op-compact",
    spans: Array.from({ length: 140 }, (_, index) => ({
      phase: index === 139 ? "child-terminal-response" : scriptPhases[index % scriptPhases.length]!,
      elapsedMs: index + 0.125,
      details: { index, fingerprint: `${index}`.padStart(64, "a") }
    }))
  };

  const message = encodeRepoWriteTelemetryBatchLog(frame);
  const decoded = decodeRepoWriteTelemetryLog(message);

  assert.equal(JSON.parse(message).phaseTable, "repo-write-telemetry-phases/v1");
  assert.deepEqual(decoded, {
    requestId: frame.requestId,
    opId: frame.opId,
    spans: frame.spans
  });
});

test("legacy single-frame telemetry remains readable", () => {
  assert.deepEqual(decodeRepoWriteTelemetryLog(JSON.stringify({
    schema: "repo-write-request-telemetry/v1",
    requestId: "request-legacy",
    phase: "git",
    elapsedMs: 12,
    details: { pathCount: 3 }
  })), {
    requestId: "request-legacy",
    spans: [{ phase: "git", elapsedMs: 12, details: { pathCount: 3 } }]
  });
});

test("a batch-aware daemon observer appends one NDJSON entry per request", () => {
  const appended: DaemonLogAppendInput[] = [];
  const daemonLogService: DaemonLogService = {
    append: async (input) => {
      appended.push(input);
      return { ...input, schema: "daemon-log-entry/v1", timestamp: "2026-08-10T00:00:00.000Z", sequence: 0,
        repoId: "canonical", redaction: { policy: "runtime-log-redaction/v1", fieldsRemoved: [], truncated: false }
      } as DaemonLogEntryV1;
    },
    list: async () => ({
      schema: "daemon-log-page/v1",
      entries: [],
      nextCursor: null,
      truncated: false,
      droppedCount: 0
    })
  };
  const observers = createRepoWriteTelemetryLogObservers({
    daemonLogService,
    context: { repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" } },
    authoredGitRoot: "/tmp/canonical/harness"
  });
  observers.onTelemetryBatch({
    protocol: repoWriteProtocolType,
    repoId: "canonical",
    generation: 7,
    kind: "telemetry-batch",
    requestId: "request-one-line",
    spans: Array.from({ length: 140 }, (_, elapsedMs) => ({ phase: "git", elapsedMs }))
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.event, "repo-write.request.telemetry-batch");
  assert.equal(decodeRepoWriteTelemetryLog(appended[0]?.message ?? "")?.spans.length, 140);
});
