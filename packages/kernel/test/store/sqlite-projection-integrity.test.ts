// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readAttributionEventSource } from "../../src/local/attribution-event-source.ts";
import { localProjectionSourceFileSystem } from "../../src/local/local-layout-file-system.ts";
import {
  queryDecisionProjection,
  readTaskProjection,
  rebuildTaskProjection
} from "../../src/projection/sqlite-task-projection.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { withTempStore } from "./helpers.ts";

test("incremental task and decision edits preserve authored attribution", () => {
  withTempStore((rootDir) => {
    const taskPath = writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    const decisionPath = writeIntegrityDecision(rootDir, "Original decision");
    writeIntegrityAttribution(rootDir, "event-task", "task/task-a", "progress_append");
    writeIntegrityAttribution(rootDir, "event-decision", "decision/dec_INTEGRITY", "decision_propose");
    rebuildTaskProjection({ rootDir });

    let previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegrityTask(rootDir, "task-a", "Task A updated", "done");
    assert.equal(updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [taskPath],
      previousSourceFingerprint
    }).mode, "incremental");
    assert.equal(readTaskProjection({ rootDir }).rows[0]?.attribution.latestActor?.principal.personId, "person_integrity");

    previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegrityDecision(rootDir, "Updated decision");
    assert.equal(updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [decisionPath],
      previousSourceFingerprint
    }).mode, "incremental");
    assert.equal(queryDecisionProjection({ rootDir, filters: {} }).rows[0]?.attribution.latestActor?.principal.personId, "person_integrity");
  });
});

test("projection reads reject valid-looking attribution tampering", () => {
  withTempStore((rootDir) => {
    writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    writeIntegrityAttribution(rootDir, "event-task", "task/task-a", "progress_append");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET attribution_json = ? WHERE task_id = ?").run(JSON.stringify({
        originator: { principal: { kind: "person", personId: "attacker" }, executor: null },
        latestActor: { principal: { kind: "person", personId: "attacker" }, executor: null },
        trailCount: 99,
        completeness: "complete"
      }), "task-a");
    } finally {
      db.close();
    }

    const rejected = readTaskProjection({ rootDir });
    assert.equal(rejected.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.notEqual(rejected.rows[0]?.attribution.latestActor?.principal.personId, "attacker");
    assert.equal(readTaskProjection({ rootDir }).rows[0]?.attribution.latestActor?.principal.personId, "person_integrity");
  });
});

test("projection reads reject attribution event table tampering", () => {
  withTempStore((rootDir) => {
    writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    writeIntegrityAttribution(rootDir, "event-task", "task/task-a", "progress_append");
    rebuildTaskProjection({ rootDir });
    const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"));
    try {
      db.prepare("UPDATE attribution_events SET principal_person_id = ? WHERE event_id = ?")
        .run("attacker", "event-task");
    } finally {
      db.close();
    }

    const rejected = readTaskProjection({ rootDir });
    assert.equal(rejected.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.notEqual(rejected.rows[0]?.attribution.latestActor?.principal.personId, "attacker");
  });
});

test("projection reads reject persisted source cache tampering", () => {
  withTempStore((rootDir) => {
    writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    writeIntegrityAttribution(rootDir, "event-task", "task/task-a", "progress_append");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE projection_source_cache_metadata SET payload_json = ? WHERE cache_kind = 'task'")
        .run(JSON.stringify({ schema: "task-source-cache-metadata/v1", warnings: [] }));
    } finally {
      db.close();
    }

    const rejected = readTaskProjection({ rootDir });

    assert.equal(rejected.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(rejected.rows[0]?.taskId, "task-a");
    const rebuilt = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      assert.equal(rebuilt.prepare("SELECT COUNT(*) AS count FROM projection_source_cache_metadata").get()?.count, 2);
    } finally {
      rebuilt.close();
    }
  });
});

test("legacy sessions coexist with incremental execution updates", () => {
  withTempStore((rootDir) => {
    const taskId = "task_00000000000000000000000001";
    const executionId = "exe_00000000000000000000000001";
    writeIntegrityTask(rootDir, taskId, "Execution task", "active");
    const legacySessionPath = path.join(rootDir, "harness/sessions/legacy-session.md");
    mkdirSync(path.dirname(legacySessionPath), { recursive: true });
    writeFileSync(legacySessionPath, "schema: provenance-session/v1\n");
    const executionPath = writeIntegrityExecution(rootDir, taskId, executionId, "submitted");
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegrityExecution(rootDir, taskId, executionId, "accepted");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [executionPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT state FROM execution_projection WHERE execution_id = ?").get(executionId)?.state, "accepted");
      assert.equal(db.prepare("SELECT primary_key FROM declared_source_manifest WHERE source_path = ?")
        .get("sessions/legacy-session.md")?.primary_key, "");
    } finally {
      db.close();
    }
  });
});

test("session and review edits update only their declared projections", () => {
  withTempStore((rootDir) => {
    const taskId = "task_00000000000000000000000001";
    const executionId = "exe_00000000000000000000000001";
    const reviewId = "rev_00000000000000000000000001";
    writeIntegrityTask(rootDir, taskId, "Review task", "in_review");
    writeIntegrityExecution(rootDir, taskId, executionId, "submitted");
    const sessionPath = writeIntegritySession(rootDir, "complete");
    const reviewPath = writeIntegrityReview(rootDir, taskId, executionId, reviewId, "approved");
    rebuildTaskProjection({ rootDir });

    let previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegritySession(rootDir, "partial");
    assert.equal(updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [sessionPath],
      previousSourceFingerprint
    }).mode, "incremental");

    previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegrityReview(rootDir, taskId, executionId, reviewId, "dismissed");
    assert.equal(updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [reviewPath],
      previousSourceFingerprint
    }).mode, "incremental");

    const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT archive_status FROM session_projection WHERE session_id = ?").get("ses_integrity")?.archive_status, "partial");
      assert.equal(db.prepare("SELECT verdict FROM review_projection WHERE review_id = ?").get(reviewId)?.verdict, "dismissed");
    } finally {
      db.close();
    }
  });
});

test("a stale projection baseline cannot hide an untouched authored task change", () => {
  withTempStore((rootDir) => {
    const taskAPath = writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    writeIntegrityTask(rootDir, "task-b", "Task B", "active");
    rebuildTaskProjection({ rootDir });
    writeIntegrityTask(rootDir, "task-b", "Task B changed externally", "done");
    const authoredBeforeWrite = captureProjectionSourceSnapshot(rootDir).fingerprint;
    writeIntegrityTask(rootDir, "task-a", "Task A changed", "done");

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [taskAPath],
      previousSourceFingerprint: authoredBeforeWrite
    });

    assert.equal(result.mode, "rebuild");
    assert.equal(readTaskProjection({ rootDir }).rows.find((row) => row.taskId === "task-b")?.title, "Task B changed externally");
  });
});

test("declared entity path identity must match the document identity", () => {
  withTempStore((rootDir) => {
    const taskId = "task_00000000000000000000000001";
    writeIntegrityTask(rootDir, taskId, "Identity task", "active");
    const executionPath = writeIntegrityExecution(
      rootDir,
      taskId,
      "exe_00000000000000000000000001",
      "submitted"
    );
    const mismatched = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    mismatched.execution_id = "exe_00000000000000000000000002";
    writeFileSync(executionPath, `${JSON.stringify(mismatched)}\n`);

    assert.throws(() => rebuildTaskProjection({ rootDir }), /path identity .* does not match projected identity/u);
  });
});

test("attribution source cache reuses unchanged bodies and reloads only a changed shard", () => {
  withTempStore((rootDir) => {
    for (let index = 0; index < 5; index += 1) {
      writeIntegrityAttribution(rootDir, `event-cache-${index}`, "task/task-a", "progress_append");
    }
    const originalReadStableText = localProjectionSourceFileSystem.readStableText;
    let attributionBodyReads = 0;
    localProjectionSourceFileSystem.readStableText = (inputPath) => {
      if (inputPath.includes(`${path.sep}attribution-events${path.sep}`)) attributionBodyReads += 1;
      return originalReadStableText(inputPath);
    };
    try {
      const initial = readAttributionEventSource(rootDir);
      assert.equal(initial.inputs.length, 5);
      assert.equal(attributionBodyReads, 5);

      const unchanged = readAttributionEventSource(rootDir);
      assert.equal(unchanged.hash, initial.hash);
      assert.equal(attributionBodyReads, 5);

      writeIntegrityAttribution(rootDir, "event-cache-2", "task/task-a", "progress_append");
      const refreshed = readAttributionEventSource(rootDir);
      assert.equal(refreshed.hash, initial.hash);
      assert.equal(attributionBodyReads, 6);
    } finally {
      localProjectionSourceFileSystem.readStableText = originalReadStableText;
    }
  });
});

test("attribution discovery retries when a shard disappears", () => {
  withTempStore((rootDir) => {
    writeIntegrityAttribution(rootDir, "event-keep", "task/task-a", "progress_append");
    const disappearingPath = path.join(rootDir, "harness/attribution-events/event-disappears.jsonl");
    writeIntegrityAttribution(rootDir, "event-disappears", "task/task-a", "progress_append");
    const originalReadStableText = localProjectionSourceFileSystem.readStableText;
    let removed = false;
    localProjectionSourceFileSystem.readStableText = (inputPath) => {
      if (!removed && inputPath === disappearingPath) {
        removed = true;
        rmSync(inputPath);
      }
      return originalReadStableText(inputPath);
    };
    try {
      const source = readAttributionEventSource(rootDir);
      assert.equal(removed, true);
      assert.deepEqual(source.inputs.map((input) => input.relativePath), ["event-keep.jsonl"]);
    } finally {
      localProjectionSourceFileSystem.readStableText = originalReadStableText;
    }
  });
});

test("incremental publish falls back to a stable rebuild after a cross-generation decision edit", () => {
  withTempStore((rootDir) => {
    writeIntegrityTask(rootDir, "task-a", "Task A", "active");
    const decisionPath = writeIntegrityDecision(rootDir, "Decision A");
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    mkdirSync(path.join(rootDir, "harness/sessions"), { recursive: true });
    writeIntegrityDecision(rootDir, "Decision B");

    const sessionsRoot = path.join(rootDir, "harness/sessions");
    const originalReadStableDirents = localProjectionSourceFileSystem.readStableDirents;
    let mutated = false;
    localProjectionSourceFileSystem.readStableDirents = (inputPath) => {
      const result = originalReadStableDirents(inputPath);
      if (!mutated && inputPath === sessionsRoot) {
        mutated = true;
        writeIntegrityDecision(rootDir, "Decision C");
      }
      return result;
    };
    let result: ReturnType<typeof updateTaskProjectionIncrementally>;
    try {
      result = updateTaskProjectionIncrementally({
        rootDir,
        touchedPaths: [decisionPath],
        previousSourceFingerprint
      });
    } finally {
      localProjectionSourceFileSystem.readStableDirents = originalReadStableDirents;
    }

    assert.equal(mutated, true);
    assert.equal(result.mode, "rebuild");
    assert.equal(queryDecisionProjection({ rootDir, filters: {} }).rows[0]?.title, "Decision C");
  });
});

function writeIntegrityTask(rootDir: string, taskId: string, title: string, status: string): string {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const taskPath = path.join(taskRoot, "INDEX.md");
  writeFileSync(taskPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-13T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  return taskPath;
}

function writeIntegrityDecision(rootDir: string, title: string): string {
  const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_INTEGRITY/decision.md");
  mkdirSync(path.dirname(decisionPath), { recursive: true });
  writeFileSync(decisionPath, [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_INTEGRITY",
    `_coordinatorWatermark: wm-${title.replaceAll(" ", "-")}`,
    `title: ${title}`,
    "state: active",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "question: \"Keep projection attribution?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Yes\" }",
    "rejected: []",
    "claims: []",
    "relations:",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
  return decisionPath;
}

function writeIntegrityAttribution(rootDir: string, eventId: string, entityId: string, kind: string): void {
  const eventRoot = path.join(rootDir, "harness/attribution-events");
  mkdirSync(eventRoot, { recursive: true });
  writeFileSync(path.join(eventRoot, `${eventId}.jsonl`), `${JSON.stringify({
    schema: "attribution-event/v1",
    eventId,
    opId: `op-${eventId}`,
    journalRecordSchema: "write-journal/v2",
    entityId,
    kind,
    actor: {
      principal: { kind: "person", personId: "person_integrity" },
      executor: { kind: "agent", id: "agent_integrity" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: `sha256:${"0".repeat(64)}`
    },
    executorSource: "client-asserted",
    at: "2026-07-13T00:00:00.000Z",
    recordedAt: "2026-07-13T00:00:01.000Z",
    payloadHash: `sha256:${"1".repeat(64)}`,
    payloadRef: { path: `.harness/payloads/${eventId}.json`, sha256: `sha256:${"1".repeat(64)}` }
  })}\n`);
}

function writeIntegrityExecution(
  rootDir: string,
  taskId: string,
  executionId: string,
  state: "submitted" | "accepted"
): string {
  const executionPath = path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`);
  mkdirSync(path.dirname(executionPath), { recursive: true });
  writeFileSync(executionPath, `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state,
    primary_actor: {
      principal: { personId: "person_integrity" },
      executor: { kind: "agent", id: "agent_integrity" },
      responsibleHuman: "person_integrity"
    },
    claimed_at: "2026-07-13T00:00:00.000Z",
    submitted_at: "2026-07-13T00:01:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: null
  }, null, 2)}\n`);
  return executionPath;
}

function writeIntegritySession(rootDir: string, archiveStatus: "complete" | "partial"): string {
  const sessionPath = path.join(rootDir, "harness/sessions/ses_integrity.md");
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify({
    schema: "session-entity/v1",
    sessionId: "ses_integrity",
    lifecycle: "sealed",
    archiveStatus,
    runtime: "codex",
    source: "runtime",
    detectedAt: "2026-07-13T00:00:00.000Z",
    exportedAt: "2026-07-13T00:01:00.000Z",
    bodyRef: {
      store: "authored-cas/v1",
      ref: `objects/aa/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      mediaType: "text/markdown",
      size: 10
    },
    snapshot: {
      capturedAt: "2026-07-13T00:01:00.000Z",
      completeness: archiveStatus === "complete" ? "complete" : "partial",
      captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
    }
  }, null, 2)}\n`);
  return sessionPath;
}

function writeIntegrityReview(
  rootDir: string,
  taskId: string,
  executionId: string,
  reviewId: string,
  verdict: "approved" | "dismissed"
): string {
  const reviewPath = path.join(rootDir, "harness/tasks", taskId, "reviews", `${reviewId}.md`);
  mkdirSync(path.dirname(reviewPath), { recursive: true });
  writeFileSync(reviewPath, `${JSON.stringify({
    schema: "review/v2",
    review_id: reviewId,
    task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`,
    reviewer_actor: {
      principal: { personId: "person_reviewer" },
      executor: null,
      responsibleHuman: "person_reviewer"
    },
    reviewer_session_ref: "session/ses_integrity",
    findings: "Integrity review",
    evidence_checked: [],
    rationale: "Projection remains consistent.",
    verdict,
    archive_warnings_acknowledged: false,
    reviewed_at: "2026-07-13T00:02:00.000Z"
  }, null, 2)}\n`);
  return reviewPath;
}
