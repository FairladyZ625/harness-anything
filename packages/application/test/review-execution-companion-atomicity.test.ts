// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as applicationPublic from "../src/index.ts";
import {
  makeJournaledWriteCoordinator,
  projectTaskCompletionEvidence,
  readTaskCompletionEvidenceProjection,
  taskCompletionEvidenceDeclaration,
  taskHolderActor,
  type TaskCompletionEvidence
} from "../src/index.ts";
import {
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ExecutionRecord,
  type ReviewRecord
} from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";
import { writeAttribution } from "./test-attribution.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";

const taskId = "task_01KXT7PXRADN9575XFZC321PRV";
const executionId = "exe_01KXT7PXRADN9575XFZC321PRW";
const reviewId = "rev_01KXT7PXRADN9575XFZC321PRX";
const reviewedAt = "2026-07-18T09:00:00.000Z";
const actor = taskHolderActor({ personId: "alice", displayName: "Alice" }, { kind: "agent", id: "codex" });

test("changes_requested review rolls back review and prior companions when either companion write fails", async () => {
  for (const killpoint of ["execution-companion", "task-companion"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-review-cr-${killpoint}-`));
    const taskRoot = path.join(rootDir, "harness/tasks", taskId);
    const executionRoot = path.join(taskRoot, "executions");
    const reviewRoot = path.join(taskRoot, "reviews");
    try {
      mkdirSync(executionRoot, { recursive: true });
      mkdirSync(reviewRoot, { recursive: true });
      const currentExecution = execution("submitted");
      const nextExecution = execution("changes_requested");
      const executionPath = path.join(executionRoot, `${executionId}.md`);
      const indexPath = path.join(taskRoot, "INDEX.md");
      const reviewPath = path.join(reviewRoot, `${reviewId}.md`);
      const currentExecutionBody = executionDeclaration.documentCodec.encode(currentExecution);
      const currentIndex = taskIndex(taskId, "in_review");
      writeFileSync(executionPath, currentExecutionBody, "utf8");
      writeFileSync(indexPath, currentIndex, "utf8");
      const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "codex") });
      if (killpoint === "execution-companion") chmodSync(executionRoot, 0o500);
      if (killpoint === "task-companion") chmodSync(taskRoot, 0o500);

      await assert.rejects(runEffect(writeDeclaredEntityTransaction(
        coordinator,
        stablePayloadHash,
        reviewDeclaration,
        { taskId, reviewId },
        review(),
        [
          { taskId, path: `executions/${executionId}.md`, body: executionDeclaration.documentCodec.encode(nextExecution) },
          { taskId, path: "INDEX.md", body: currentIndex.replace(/^(  status:\s*).+$/mu, "$1active") }
        ],
        [
          { taskId, path: `executions/${executionId}.md`, bodySha256: sha256Text(currentExecutionBody) },
          { taskId, path: `reviews/${reviewId}.md`, bodySha256: null },
          { taskId, path: "INDEX.md", bodySha256: sha256Text(currentIndex) }
        ]
      )), /EACCES|permission denied|operation not permitted/iu);

      if (killpoint === "execution-companion") chmodSync(executionRoot, 0o700);
      if (killpoint === "task-companion") chmodSync(taskRoot, 0o700);
      assert.equal(existsSync(reviewPath), false, killpoint);
      assert.equal(readFileSync(executionPath, "utf8"), currentExecutionBody, killpoint);
      assert.equal(readFileSync(indexPath, "utf8"), currentIndex, killpoint);
    } finally {
      chmodSync(taskRoot, 0o700);
      if (existsSync(executionRoot)) chmodSync(executionRoot, 0o700);
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test("declared document-set CAS rejects concurrent Execution creation before companion publication", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-document-set-cas-"));
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  const executionRoot = path.join(taskRoot, "executions");
  const reviewRoot = path.join(taskRoot, "reviews");
  const indexPath = path.join(taskRoot, "INDEX.md");
  const reviewPath = path.join(reviewRoot, `${reviewId}.md`);
  try {
    mkdirSync(executionRoot, { recursive: true });
    mkdirSync(reviewRoot, { recursive: true });
    const currentIndex = taskIndex(taskId, "in_review");
    writeFileSync(indexPath, currentIndex, "utf8");
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "codex") });
    const expectedEmptyHistory = stablePayloadHash({
      schema: "declared-document-set/v1",
      pathPrefixes: ["executions/", "reviews/"],
      entries: []
    });
    writeFileSync(path.join(executionRoot, `${executionId}.md`), executionDeclaration.documentCodec.encode(execution("submitted")), "utf8");

    await assert.rejects(runEffect(writeDeclaredEntityTransaction(
      coordinator,
      stablePayloadHash,
      reviewDeclaration,
      { taskId, reviewId },
      review(),
      [{ taskId, path: "INDEX.md", body: currentIndex.replace(/^(  status:\s*).+$/mu, "$1done") }],
      [{ taskId, pathPrefixes: ["executions/", "reviews/"], documentSetSha256: expectedEmptyHistory }]
    )), /document-set precondition changed/u);

    assert.equal(existsSync(reviewPath), false);
    assert.equal(readFileSync(indexPath, "utf8"), currentIndex);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("declared body CAS rejects code-doc replacement without partial companion publication", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-code-doc-cas-"));
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  const reviewRoot = path.join(taskRoot, "reviews");
  const indexPath = path.join(taskRoot, "INDEX.md");
  const codeDocPath = path.join(taskRoot, "code-doc-anchors.json");
  const reviewPath = path.join(reviewRoot, `${reviewId}.md`);
  try {
    mkdirSync(reviewRoot, { recursive: true });
    const currentIndex = taskIndex(taskId, "in_review");
    const judgedCodeDoc = "{\"schema\":\"code-doc-reconciliation/v1\"}\n";
    writeFileSync(indexPath, currentIndex, "utf8");
    writeFileSync(codeDocPath, judgedCodeDoc, "utf8");
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: writeAttribution("alice", "codex") });
    writeFileSync(codeDocPath, "{\"schema\":\"replacement\"}\n", "utf8");

    await assert.rejects(runEffect(writeDeclaredEntityTransaction(
      coordinator,
      stablePayloadHash,
      reviewDeclaration,
      { taskId, reviewId },
      review(),
      [{ taskId, path: "INDEX.md", body: currentIndex.replace(/^(  status:\s*).+$/mu, "$1done") }],
      [{ taskId, path: "code-doc-anchors.json", bodySha256: sha256Text(judgedCodeDoc) }]
    )), /declared entity precondition changed/u);

    assert.equal(existsSync(reviewPath), false);
    assert.equal(readFileSync(indexPath, "utf8"), currentIndex);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("commit completion compensates failures at both evidence and INDEX publication points", () => {
  for (const target of ["completion-evidence.json", "INDEX.md"] as const) {
    const fixture = completionTransactionFixture(`ha-completion-failure-${target.replace(/\W/gu, "-")}-`);
    try {
      const failed = runCompletionTransactionWorker(fixture.rootDir, target, "failure");

      assert.notEqual(failed.status, 0, `${target}\n${failed.stdout}\n${failed.stderr}`);
      assert.match(failed.stderr, /injected recoverable document transaction failure/u, target);
      assert.equal(existsSync(fixture.evidencePath), false, target);
      assert.equal(readFileSync(fixture.indexPath, "utf8"), fixture.currentIndex, target);
    } finally {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  }
});

test("commit completion recovery converges after process death at both evidence and INDEX publication points", async () => {
  for (const target of ["completion-evidence.json", "INDEX.md"] as const) {
    const fixture = completionTransactionFixture(`ha-completion-kill-${target.replace(/\W/gu, "-")}-`);
    try {
      const killed = runCompletionTransactionWorker(fixture.rootDir, target, "kill");

      assert.equal(killed.signal, "SIGTERM", `${target}\n${killed.stdout}\n${killed.stderr}`);
      if (target === "completion-evidence.json") {
        assert.equal(existsSync(fixture.evidencePath), true, target);
        assert.equal(readFileSync(fixture.indexPath, "utf8"), fixture.currentIndex, target);
      } else {
        assert.equal(existsSync(fixture.evidencePath), true, target);
        assert.match(readFileSync(fixture.indexPath, "utf8"), /^  status: done$/mu, target);
      }

      const recovery = makeJournaledWriteCoordinator({
        rootDir: fixture.rootDir,
        attribution: writeAttribution("alice", "recovery")
      });
      await runEffect(recovery.recover);
      assert.deepEqual(
        taskCompletionEvidenceDeclaration.documentCodec.decode(readFileSync(fixture.evidencePath, "utf8")),
        completionEvidence()
      );
      assert.match(readFileSync(fixture.indexPath, "utf8"), /^  status: done$/mu);
      await runEffect(recovery.recover);
      assert.deepEqual(
        taskCompletionEvidenceDeclaration.documentCodec.decode(readFileSync(fixture.evidencePath, "utf8")),
        completionEvidence()
      );
    } finally {
      rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  }
});

test("completion evidence public declaration writes, projects, and reads its declared row", async () => {
  const fixture = completionTransactionFixture("ha-completion-projection-");
  try {
    assert.equal(applicationPublic.taskCompletionEvidenceDeclaration, taskCompletionEvidenceDeclaration);
    assert.equal(applicationPublic.projectTaskCompletionEvidence, projectTaskCompletionEvidence);
    assert.equal(applicationPublic.readTaskCompletionEvidenceProjection, readTaskCompletionEvidenceProjection);
    const completedIndex = fixture.currentIndex.replace(/^(  status:\s*).+$/mu, "$1done");
    const coordinator = makeJournaledWriteCoordinator({
      rootDir: fixture.rootDir,
      attribution: writeAttribution("alice", "codex")
    });

    await runEffect(writeDeclaredEntityTransaction(
      coordinator,
      stablePayloadHash,
      taskCompletionEvidenceDeclaration,
      { taskId },
      completionEvidence(),
      [{ taskId, path: "INDEX.md", body: completedIndex }],
      [{ taskId, path: "INDEX.md", bodySha256: sha256Text(fixture.currentIndex) }]
    ));

    const projectionPath = path.join(fixture.rootDir, ".harness/cache/completion-projection.sqlite");
    const projected = projectTaskCompletionEvidence(fixture.rootDir, projectionPath);
    assert.deepEqual(projected.rows, [{ task_id: taskId }]);
    assert.deepEqual(readTaskCompletionEvidenceProjection(projectionPath), projected.rows);
  } finally {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function execution(state: "submitted" | "changes_requested"): ExecutionRecord {
  return {
    schema: "execution/v2", execution_id: executionId, task_ref: `task/${taskId}`, state,
    primary_actor: actor, claimed_at: "2026-07-18T08:00:00.000Z",
    submitted_at: "2026-07-18T08:30:00.000Z", closed_at: state === "changes_requested" ? reviewedAt : null,
    session_bindings: [], outputs: [],
    submission: { completion_claim: "Probe delivery", deliverables: [], evidence_refs: [], verification_notes: [], known_gaps: [], residual_risks: [] }
  };
}

function review(): ReviewRecord {
  return {
    schema: "review/v3", review_id: reviewId, task_ref: `task/${taskId}`,
    execution_ref: `execution/${taskId}/${executionId}`, reviewer_actor: actor,
    reviewer_session_ref: "session/reviewer", findings: "Changes required", evidence_checked: [],
    rationale: "The delivery needs another round.", verdict: "changes_requested",
    archive_warnings_acknowledged: false, approval_basis: null, reviewed_at: reviewedAt
  };
}

function completionTransactionFixture(prefix: string): {
  readonly rootDir: string;
  readonly currentIndex: string;
  readonly indexPath: string;
  readonly evidencePath: string;
} {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  const currentIndex = taskIndex(taskId, "active");
  const indexPath = path.join(taskRoot, "INDEX.md");
  writeFileSync(indexPath, currentIndex, "utf8");
  return {
    rootDir,
    currentIndex,
    indexPath,
    evidencePath: path.join(taskRoot, "completion-evidence.json")
  };
}

function runCompletionTransactionWorker(
  rootDir: string,
  target: "completion-evidence.json" | "INDEX.md",
  mode: "failure" | "kill"
) {
  const worker = fileURLToPath(new URL("./fixtures/completion-evidence-transaction-worker.ts", import.meta.url));
  return spawnSync(process.execPath, [worker, rootDir, taskId], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(mode === "failure"
        ? { HARNESS_TEST_DECLARED_TRANSACTION_FAILURE_AFTER_WRITE: target }
        : { HARNESS_TEST_DECLARED_TRANSACTION_KILLPOINT_AFTER_WRITE: target })
    }
  });
}

function completionEvidence(): TaskCompletionEvidence {
  return {
    schema: "task-completion-evidence/v1",
    taskId,
    mode: "commit-anchor",
    anchor: {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repository: "workspace",
      codeDocRecordIds: ["cdr_completion_atomicity"],
      codeDocDocumentSha256: `sha256:${"b".repeat(64)}`
    },
    judgment: {
      actor: {
        principal: { kind: "person", personId: "alice" },
        executor: { kind: "agent", id: "codex" }
      },
      sessionRef: "session/completion-atomicity",
      rationale: "The workspace commit implements and verifies the task.",
      judgedAt: reviewedAt
    },
    gateReceipt: {
      applicableGates: ["check:local"],
      ci: "passed",
      closeout: "passed",
      codeDoc: "passed"
    }
  };
}
