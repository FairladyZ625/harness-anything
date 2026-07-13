// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Option } from "effect";
import { auditTaskProvenance, checkTaskProjection, hashTaskProjectionRows, queryDecisionProjection, queryTaskExecutionTrace, readTaskProjection, rebuildTaskProjection } from "../../src/index.ts";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("markdown artifact store remains the rebuildable source of truth without SQLite", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "task_plan.md", "# Task")));
    Effect.runSync(coordinator.flush("explicit"));

    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const store = makeMarkdownArtifactStore({ rootDir });
    const taskPackage = Effect.runSync(store.readTaskPackage("task-1"));

    assert.equal(taskPackage.disposition, "active");
    assert.deepEqual(taskPackage.documents.map((document) => document.path), ["task_plan.md"]);
    assert.equal(taskPackage.documents[0]?.body, "# Task");
  });
});

test("markdown artifact store reads package disposition from INDEX frontmatter", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-active", "Task Active", "active", "active");
    writeIndex(rootDir, "task-missing", "Task Missing", "active", null);
    writeIndex(rootDir, "task-archived", "Task Archived", "done", "archived");
    writeIndex(rootDir, "task-tombstoned", "Task Tombstoned", "cancelled", "tombstoned");

    const store = makeMarkdownArtifactStore({ rootDir });

    assert.equal(Effect.runSync(store.readTaskPackage("task-active")).disposition, "active");
    assert.equal(Effect.runSync(store.readTaskPackage("task-missing")).disposition, "active");
    assert.equal(Effect.runSync(store.readTaskPackage("task-archived")).disposition, "archived");
    assert.equal(Effect.runSync(store.readTaskPackage("task-tombstoned")).disposition, "tombstoned");
  });
});

test("markdown artifact store resolves lifecycle bindings by external ref", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-bound", "Task Bound", "active", "active", {
      engine: "linear",
      ref: "LIN-123"
    });
    writeIndex(rootDir, "task-other", "Task Other", "active", "active", {
      engine: "linear",
      ref: "LIN-999"
    });

    const store = makeMarkdownArtifactStore({ rootDir });

    assert.equal(Option.getOrNull(Effect.runSync(store.findBindingByExternalRef("linear", "LIN-123"))), "task-bound");
    assert.equal(Option.isNone(Effect.runSync(store.findBindingByExternalRef("linear", "LIN-missing"))), true);
  });
});


test("markdown artifact store rejects invalid package disposition", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-invalid", "Task Invalid", "active", "typo");

    const store = makeMarkdownArtifactStore({ rootDir });

    assert.throws(
      () => Effect.runSync(store.readTaskPackage("task-invalid")),
      /invalid package disposition/
    );
  });
});

test("SQLite task projection rebuild is deterministic after cache deletion", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeIndex(rootDir, "task-2", "Task Two", "done");
    writeFileSync(path.join(rootDir, "harness/tasks/task-2/closeout.md"), "# Closeout\n");

    const first = rebuildTaskProjection({ rootDir }).rows;
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });
    const second = rebuildTaskProjection({ rootDir }).rows;

    assert.deepEqual(second, first);
    assert.equal(second[0]?.sourcePath, "harness/tasks/task-1/INDEX.md");
    assert.equal(second[0]?.source, "local-document");
    assert.equal(second[1]?.closeoutReadiness, "ready");
  });
});

test("SQLite projection rebuild treats a missing authored root as an empty source", () => {
  withTempStore((rootDir) => {
    assert.deepEqual(rebuildTaskProjection({ rootDir }).rows, []);
    assert.deepEqual(readTaskProjection({ rootDir }).rows, []);
  });
});

test("SQLite projection rebuild materializes declared session execution and review tables deterministically", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task_01J00000000000000000000000", "Projected entities", "in_review");
    writeProjectionEntities(rootDir);

    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const first = readEntityProjectionTables(projectionPath);

    rmSync(projectionPath, { force: true });
    rebuildTaskProjection({ rootDir });

    assert.deepEqual(readEntityProjectionTables(projectionPath), first);
    assert.equal(first.sessions[0]?.session_id, "ses_projection_1");
    assert.equal(first.executions[0]?.execution_id, "exe_01J00000000000000000000000");
    assert.equal(first.reviews[0]?.review_id, "rev_01J00000000000000000000000");
  });
});

test("SQLite projection reads rebuild when an authored entity changes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task_01J00000000000000000000000", "Projected entities", "in_review");
    writeProjectionEntities(rootDir);
    rebuildTaskProjection({ rootDir });

    const executionPath = path.join(rootDir, "harness/tasks/task_01J00000000000000000000000/executions/exe_01J00000000000000000000000.md");
    const execution = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    writeFileSync(executionPath, `${JSON.stringify({ ...execution, state: "accepted" }, null, 2)}\n`);

    const result = readTaskProjection({ rootDir });
    const rows = readEntityProjectionTables(path.join(rootDir, ".harness/cache/projections.sqlite"));
    assert.equal(rows.executions[0]?.state, "accepted");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

test("SQLite projection reads discard tampered declared entity rows", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task_01J00000000000000000000000", "Projected entities", "in_review");
    writeProjectionEntities(rootDir);
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE execution_projection SET state = 'accepted'").run();
    } finally {
      db.close();
    }

    const result = readTaskProjection({ rootDir });

    assert.equal(readEntityProjectionTables(projectionPath).executions[0]?.state, "submitted");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
  });
});

test("task execution trace reads the complete task execution session review and output chain from projection", () => {
  withTempStore((rootDir) => {
    const taskId = "task_01J00000000000000000000000";
    writeIndex(rootDir, taskId, "Projected entities", "in_review");
    writeProjectionEntities(rootDir);

    const trace = queryTaskExecutionTrace({ rootDir, taskId });

    assert.equal(trace.taskId, taskId);
    assert.equal(trace.executions.length, 1);
    assert.equal(trace.executions[0]?.sessions[0]?.sessionId, "ses_projection_1");
    assert.equal(trace.executions[0]?.sessionBindings[0]?.capture_range?.start_at, "2026-07-11T01:00:00.000Z");
    assert.equal(trace.executions[0]?.reviews[0]?.reviewId, "rev_01J00000000000000000000000");
    assert.equal(trace.executions[0]?.outputs[0]?.evidence_id, "ev_projection_1");
  });
});

test("provenance audit reports missing partial and dangling execution coverage", () => {
  withTempStore((rootDir) => {
    const taskId = "task_01J00000000000000000000000";
    writeIndex(rootDir, taskId, "Projected entities", "in_review");
    writeProjectionEntities(rootDir);
    const taskRoot = path.join(rootDir, `harness/tasks/${taskId}`);
    const executionPath = path.join(taskRoot, "executions/exe_01J00000000000000000000000.md");
    const execution = JSON.parse(readFileSync(executionPath, "utf8")) as Record<string, unknown>;
    writeFileSync(executionPath, `${JSON.stringify({ ...execution, session_bindings: [] }, null, 2)}\n`);
    const reviewPath = path.join(taskRoot, "reviews/rev_01J00000000000000000000000.md");
    const review = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
    writeFileSync(reviewPath, `${JSON.stringify({
      ...review,
      execution_ref: "execution/task_01J00000000000000000000000/exe_01J00000000000000000000099"
    }, null, 2)}\n`);

    const audit = auditTaskProvenance({ rootDir, taskId });

    assert.deepEqual(audit.findings.map((finding) => [finding.coverage, finding.kind]), [
      ["dangling", "review_execution_missing"],
      ["missing", "execution_session_binding_missing"],
      ["partial", "submitted_execution_review_missing"]
    ]);
  });
});

test("SQLite projection rebuild materializes decision rows for query readers", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeDecision(rootDir, "dec_M5_E72_SELFHOST", "wm-1");

    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT decision_id, legacy_id, state, risk_tier, urgency, vertical, preset, proposed_at, provenance_json FROM decision_projection WHERE legacy_id = ?").get("E72") as Record<string, unknown>;
      assert.equal(row.decision_id, "dec_M5_E72_SELFHOST");
      assert.equal(row.legacy_id, "E72");
      assert.equal(row.state, "active");
      assert.equal(row.risk_tier, "medium");
      assert.equal(row.urgency, "medium");
      assert.equal(row.vertical, "software/coding");
      assert.equal(row.preset, "architecture-decision");
      assert.equal(row.proposed_at, "2026-07-04T00:00:00.000Z");
      assert.deepEqual(JSON.parse(String(row.provenance_json)), [{ runtime: "human", sessionId: "human-cli-1", boundAt: "2026-07-04T00:00:00.000Z" }]);
      const columns = (db.prepare("PRAGMA table_info(decision_projection)").all() as ReadonlyArray<{ readonly name: string }>).map((column) => column.name);
      assert.equal(columns.includes("proposed_by_json"), false);
      assert.equal(columns.includes("arbiter_json"), false);
    } finally {
      db.close();
    }
  });
});

test("SQLite projection rebuilds stale schema versions before serving decision DTO rows", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeDecision(rootDir, "dec_M5_E72_SELFHOST", "wm-1");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE projection_meta SET value = ? WHERE key = 'version'").run("entity-projection/d4-v1");
    } finally {
      db.close();
    }

    const result = queryDecisionProjection({ rootDir, filters: {} });

    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
    assert.equal(result.rows[0]?.attribution.completeness, "unresolved");
    assert.deepEqual(result.rows[0]?.provenance, [{ runtime: "human", sessionId: "human-cli-1", boundAt: "2026-07-04T00:00:00.000Z" }]);
  });
});

test("SQLite task projection metadata comes only from task frontmatter", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active", "active", {
      workKind: "docs",
      riskTier: "low",
      urgency: "medium"
    });
    writeDecision(rootDir, "dec_TASK_SOURCE_SHOULD_NOT_WIN", "wm-task-source");

    const rows = rebuildTaskProjection({ rootDir }).rows;

    assert.equal(rows[0]?.workKind, "docs");
    assert.equal(rows[0]?.riskTier, "low");
    assert.equal(rows[0]?.urgency, "medium");
  });
});

test("SQLite task projection hash survives metadata row round-trip", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active", "active", {
      workKind: "docs",
      riskTier: "high",
      urgency: "medium"
    });

    rebuildTaskProjection({ rootDir });
    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), false);
    assert.equal(result.rows[0]?.riskTier, "high");
  });
});

test("SQLite task projection row hash is deterministic and content-addressed", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-2", "Task Two", "done");
    writeIndex(rootDir, "task-1", "Task One", "active");

    const first = rebuildTaskProjection({ rootDir }).rows;
    const second = [...first].reverse();

    assert.equal(hashTaskProjectionRows(second), hashTaskProjectionRows(first));
    const indexPath = path.join(rootDir, "harness/tasks/task-1/INDEX.md");
    utimesSync(indexPath, new Date("2026-06-12T01:00:00.000Z"), new Date("2026-06-12T01:00:00.000Z"));
    assert.equal(hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows), hashTaskProjectionRows(first));

    writeIndex(rootDir, "task-1", "Renamed Task One", "active");
    assert.notEqual(hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows), hashTaskProjectionRows(first));
  });
});

test("task projection auto-rebuilds when markdown source changes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "planned");
    rebuildTaskProjection({ rootDir });
    writeIndex(rootDir, "task-1", "Task One", "active");

    const result = readTaskProjection({ rootDir });

    assert.equal(result.rows[0]?.canonicalStatus, "active");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_stale"), true);
  });
});

test("generated SQLite edits are reported and rebuilt from markdown truth", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET title = ? WHERE task_id = ?").run("Edited In Projection", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows[0]?.title, "Task One");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(result.warnings.every((warning) => typeof warning.source === "string" && typeof warning.severity === "string"), true);
    assert.equal(result.report.axes.some((axis) => axis.axis === "generated-cache" && axis.hardFailCount === 1), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8").includes("Edited In Projection"), false);
  });
});

test("generated SQLite timestamp edits are reported even though projection hashes ignore mtimes", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET updated_at = ? WHERE task_id = ?").run("1999-01-01T00:00:00.000Z", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.notEqual(result.rows[0]?.updatedAt, "1999-01-01T00:00:00.000Z");
  });
});

test("corrupted SQLite projection is reported with a stable warning and rebuilt from markdown", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    const db = new DatabaseSync(projectionPath);
    try {
      db.prepare("UPDATE task_projection SET attribution_json = ? WHERE task_id = ?").run("{bad-json", "task-1");
    } finally {
      db.close();
    }

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows[0]?.title, "Task One");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
  });
});

test("malformed task source is a checker error and not authored by projection reads", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/bad-task"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/tasks/bad-task/INDEX.md"), "# Missing frontmatter\n");

    const result = checkTaskProjection({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.rows.length, 0);
    assert.equal(result.warnings.some((warning) => warning.code === "source_malformed"), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/bad-task/INDEX.md"), "utf8"), "# Missing frontmatter\n");
  });
});

test("post-merge check reports missing and duplicate decision coordinator watermarks", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, "task-1", "Task One", "active");
    writeDecision(rootDir, "dec_MISSING", "");
    writeDecision(rootDir, "dec_DUPLICATE_A", "wm-duplicate");
    writeDecision(rootDir, "dec_DUPLICATE_B", "wm-duplicate");

    const result = checkTaskProjection({ rootDir, postMerge: true });

    assert.equal(result.ok, false);
    assert.equal(result.warnings.some((warning) => warning.code === "decision_watermark_missing"), true);
    assert.equal(result.warnings.some((warning) => warning.code === "decision_watermark_duplicate"), true);
  });
});

function writeIndex(
  rootDir: string,
  taskId: string,
  title: string,
  status: string,
  packageDisposition: string | null = "active",
  metadata: { readonly workKind?: string; readonly riskTier?: string; readonly urgency?: string; readonly engine?: string; readonly ref?: string } = {}
): void {
  const dispositionLines = packageDisposition === null ? [] : [`packageDisposition: ${packageDisposition}`];
  mkdirSync(path.join(rootDir, "harness/tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", taskId, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    `  engine: ${metadata.engine ?? "local"}`,
    `  status: ${status}`,
    `  ref: ${metadata.ref ?? ""}`,
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    ...dispositionLines,
    ...(metadata.workKind ? [`workKind: ${metadata.workKind}`] : []),
    ...(metadata.riskTier ? [`riskTier: ${metadata.riskTier}`] : []),
    ...(metadata.urgency ? [`urgency: ${metadata.urgency}`] : []),
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, watermark: string): void {
  const lines = [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    ...(watermark ? [`_coordinatorWatermark: ${watermark}`] : []),
    "title: Test decision",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"m5-circulation\"]",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"test\" }",
    "proposedAt: \"2026-07-04T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"ZeyuLi\" }",
    "decidedAt: \"2026-07-04T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"human\", sessionId: \"human-cli-1\", boundAt: \"2026-07-04T00:00:00.000Z\" }",
    "question: \"Should projection materialize decisions?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Use D4 projection\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Use markdown scans\", why_not: \"Query path must align\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Decision projection exists\" }",
    "relations:",
    "---",
    "",
    "# Test decision",
    ""
  ];
  const decisionRoot = path.join(rootDir, "harness/decisions", `decision-${decisionId}`);
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(path.join(decisionRoot, "decision.md"), lines.join("\n"));
}

function writeProjectionEntities(rootDir: string): void {
  mkdirSync(path.join(rootDir, "harness/sessions"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/sessions/ses_projection_1.md"), `${JSON.stringify({
    schema: "session-entity/v1",
    sessionId: "ses_projection_1",
    lifecycle: "sealed",
    archiveStatus: "complete",
    runtime: "codex",
    source: "runtime",
    detectedAt: "2026-07-11T01:00:00.000Z",
    exportedAt: "2026-07-11T01:05:00.000Z",
    bodyRef: {
      store: "authored-cas/v1",
      ref: `objects/${"a".repeat(64).slice(0, 2)}/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      mediaType: "text/markdown",
      size: 10
    },
    snapshot: {
      capturedAt: "2026-07-11T01:05:00.000Z",
      completeness: "complete",
      captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
    }
  }, null, 2)}\n`);
  const taskRoot = path.join(rootDir, "harness/tasks/task_01J00000000000000000000000");
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  mkdirSync(path.join(taskRoot, "reviews"), { recursive: true });
  writeFileSync(path.join(taskRoot, "executions/exe_01J00000000000000000000000.md"), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: "exe_01J00000000000000000000000",
    task_ref: "task/task_01J00000000000000000000000",
    state: "submitted",
    primary_actor: {
      principal: { personId: "person:test" },
      executor: { kind: "agent", id: "agent:test" },
      responsibleHuman: "person:test"
    },
    claimed_at: "2026-07-11T01:00:00.000Z",
    submitted_at: "2026-07-11T01:10:00.000Z",
    closed_at: null,
    session_bindings: [{
      binding_id: "primary:ses_projection_1",
      session_ref: "session/ses_projection_1",
      role: "primary",
      archive_status: "complete",
      attached_at: "2026-07-11T01:00:00.000Z",
      session: null,
      capture_range: {
        range_id: "primary:ses_projection_1:range",
        coordinate: "timestamp",
        start_at: "2026-07-11T01:00:00.000Z",
        end_at: "2026-07-11T01:10:00.000Z",
        bounds: "inclusive"
      }
    }],
    outputs: [{
      evidence_id: "ev_projection_1",
      execution_ref: "execution/task_01J00000000000000000000000/exe_01J00000000000000000000000",
      locator: { substrate: "inline", text: "abc123" }
    }],
    submission: { completion_claim: "ready", deliverables: [], evidence_refs: ["ev_projection_1"], verification_notes: [], known_gaps: [], residual_risks: [] }
  }, null, 2)}\n`);
  writeFileSync(path.join(taskRoot, "reviews/rev_01J00000000000000000000000.md"), `${JSON.stringify({
    schema: "review/v2",
    review_id: "rev_01J00000000000000000000000",
    task_ref: "task/task_01J00000000000000000000000",
    execution_ref: "execution/task_01J00000000000000000000000/exe_01J00000000000000000000000",
    reviewer_actor: {
      principal: { personId: "person:reviewer" },
      executor: null,
      responsibleHuman: "person:reviewer"
    },
    reviewer_session_ref: "session/ses_projection_1",
    findings: "ready",
    evidence_checked: ["ev_projection_1"],
    rationale: "The projected evidence supports approval.",
    verdict: "approved",
    archive_warnings_acknowledged: false,
    reviewed_at: "2026-07-11T01:15:00.000Z"
  }, null, 2)}\n`);
}

function readEntityProjectionTables(projectionPath: string): {
  readonly sessions: ReadonlyArray<Record<string, unknown>>;
  readonly executions: ReadonlyArray<Record<string, unknown>>;
  readonly reviews: ReadonlyArray<Record<string, unknown>>;
} {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    return {
      sessions: db.prepare("SELECT * FROM session_projection ORDER BY session_id").all() as Record<string, unknown>[],
      executions: db.prepare("SELECT * FROM execution_projection ORDER BY execution_id").all() as Record<string, unknown>[],
      reviews: db.prepare("SELECT * FROM review_projection ORDER BY review_id").all() as Record<string, unknown>[]
    };
  } finally {
    db.close();
  }
}
