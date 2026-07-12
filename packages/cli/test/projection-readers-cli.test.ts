// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeContentAddressedBlob } from "../../kernel/src/index.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskId = "task_01J00000000000000000000000";
const executionId = "exe_01J00000000000000000000000";
const reviewId = "rev_01J00000000000000000000000";
const sessionId = "ses_projection_cli";

test("CLI exposes the projection-backed session execution task review and audit read surface", () => {
  withTempRoot((rootDir) => {
    writeTask(rootDir, taskId, "in_review");
    writeEntities(rootDir);

    const session = runJson(rootDir, ["session", "show", sessionId]).report;
    assert.equal(session.body, "# private transcript\n");
    assert.deepEqual(session.session.attribution, unresolvedAttribution());
    assert.equal(runJson(rootDir, ["session", "trace", sessionId]).report.trace.executions[0].executionId, executionId);
    const execution = runJson(rootDir, ["execution", "show", executionId]).report.execution;
    assert.equal(execution.executionId, executionId);
    assert.deepEqual(execution.attribution, unresolvedAttribution());
    assert.equal(runJson(rootDir, ["execution", "list", "--task", taskId]).rows, 1);
    assert.equal(runJson(rootDir, ["task", "trace", taskId]).report.trace.executions[0].reviews[0].reviewId, reviewId);
    const review = runJson(rootDir, ["review", "show", reviewId]).report.review;
    assert.equal(review.verdict, "approved");
    assert.deepEqual(review.attribution, unresolvedAttribution());
    assert.equal(runJson(rootDir, ["audit", "provenance", "--task", taskId]).report.audit.coverage, "complete");
  });
});

test("projection-backed task readers report missing coverage for tasks without execution entities", () => {
  withTempRoot((rootDir) => {
    writeTask(rootDir, taskId, "active");

    assert.deepEqual(runJson(rootDir, ["task", "trace", taskId]).report.trace.executions, []);
    assert.equal(runJson(rootDir, ["execution", "list", "--task", taskId]).rows, 0);
    const audit = runJson(rootDir, ["audit", "provenance", "--task", taskId]).report.audit;
    assert.equal(audit.coverage, "incomplete");
    assert.deepEqual(audit.findings, [{
      coverage: "missing",
      kind: "task_execution_missing",
      taskId,
      detail: `Task ${taskId} has no Execution provenance.`
    }]);
  });
});

function writeEntities(rootDir: string): void {
  const blob = writeContentAddressedBlob(rootDir, "# private transcript\n", "text/markdown; charset=utf-8");
  mkdirSync(path.join(rootDir, "harness/sessions"), { recursive: true });
  writeFileSync(path.join(rootDir, `harness/sessions/${sessionId}.md`), `${JSON.stringify({
    schema: "session-entity/v1",
    sessionId,
    lifecycle: "sealed",
    archiveStatus: "complete",
    runtime: "codex",
    source: "runtime",
    detectedAt: "2026-07-11T01:00:00.000Z",
    exportedAt: "2026-07-11T01:05:00.000Z",
    bodyRef: { store: "authored-cas/v1", ...blob },
    snapshot: {
      capturedAt: "2026-07-11T01:05:00.000Z",
      completeness: "complete",
      captureRange: { messageCount: 1 },
      privacyScan: { scannerVersion: "publish-redaction/v1", passed: true, findings: [] }
    }
  }, null, 2)}\n`);
  const taskRoot = path.join(rootDir, `harness/tasks/${taskId}`);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  mkdirSync(path.join(taskRoot, "reviews"), { recursive: true });
  writeFileSync(path.join(taskRoot, `executions/${executionId}.md`), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
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
      binding_id: `primary:${sessionId}`,
      session_ref: `session/${sessionId}`,
      role: "primary",
      archive_status: "complete",
      attached_at: "2026-07-11T01:00:00.000Z",
      session: null,
      capture_range: {
        range_id: `primary:${sessionId}`,
        coordinate: "timestamp",
        start_at: "2026-07-11T01:00:00.000Z",
        end_at: "2026-07-11T01:10:00.000Z",
        bounds: "inclusive"
      }
    }],
    outputs: [{ evidence_id: "ev_trace", execution_ref: `execution/${taskId}/${executionId}`, locator: { substrate: "inline", text: "abc123" } }],
    submission: { completion_claim: "ready", deliverables: [], evidence_refs: ["ev_trace"], verification_notes: ["tests"], known_gaps: [], residual_risks: [] }
  }, null, 2)}\n`);
  writeFileSync(path.join(taskRoot, `reviews/${reviewId}.md`), `${JSON.stringify({
    schema: "review/v2",
    review_id: reviewId,
    task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`,
    reviewer_actor: {
      principal: { personId: "person:reviewer" },
      executor: null,
      responsibleHuman: "person:reviewer"
    },
    reviewer_session_ref: `session/${sessionId}`,
    findings: "approved",
    evidence_checked: ["ev_trace"],
    rationale: "The trace evidence supports approval.",
    verdict: "approved",
    archive_warnings_acknowledged: false,
    reviewed_at: "2026-07-11T01:15:00.000Z"
  }, null, 2)}\n`);
}

function unresolvedAttribution(): Record<string, unknown> {
  return { originator: null, latestActor: null, trailCount: 0, completeness: "unresolved" };
}

function writeTask(rootDir: string, id: string, status: string): void {
  const taskRoot = path.join(rootDir, `harness/tasks/${id}`);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${id}`,
    "title: Projection CLI",
    `status: ${status}`,
    "createdAt: 2026-07-11T00:00:00.000Z",
    "updatedAt: 2026-07-11T00:00:00.000Z",
    "lifecycle:",
    "  engine: local",
    "  ref: local",
    "  bindingCreatedAt: 2026-07-11T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "vertical: default",
    "preset: default",
    "---",
    "",
    "# Projection CLI",
    ""
  ].join("\n"));
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:test",
      ANTIGRAVITY_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      ZCODE_SESSION_ID: ""
    }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-readers-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
