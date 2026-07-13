// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { queryExecutionEvidencePage } from "../../src/projection/sqlite-execution-evidence-reader.ts";
import { captureProjectionSourceSnapshot } from "../../src/projection/projection-source-snapshot.ts";
import { updateTaskProjectionIncrementally } from "../../src/projection/sqlite-task-incremental-projection.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";

test("full projection normalizes execution outputs into queryable SQL rows", () => {
  withHarness((rootDir) => {
    const first = ids(1);
    writeTask(rootDir, first.taskId, "First task");
    writeExecution(rootDir, first.taskId, first.executionId, "2026-07-13T00:01:00.000Z", [
      inlineOutput(first, "ev-inline", "Delivered file"),
      checkerOutput(first, "ev-receipt", "ev-inline", "pass")
    ]);

    rebuildTaskProjection({ rootDir });

    const db = openProjection(rootDir);
    try {
      assert.deepEqual(db.prepare(`
        SELECT execution_id, task_ref, executor_id, executor_kind,
               responsible_human, latest_at, archival
        FROM execution_evidence_projection
      `).all().map((row) => ({ ...row })), [{
        execution_id: first.executionId,
        task_ref: `task/${first.taskId}`,
        executor_id: "codex",
        executor_kind: "agent",
        responsible_human: "person_test",
        latest_at: "2026-07-13T00:01:00.000Z",
        archival: 0
      }]);
      assert.deepEqual(db.prepare(`
        SELECT execution_id, ordinal, evidence_id, substrate, inline_text,
               receipt_result, checker_receipt_ref
        FROM execution_output_projection
        ORDER BY execution_id, ordinal
      `).all().map((row) => ({ ...row })), [
        {
          execution_id: first.executionId,
          ordinal: 0,
          evidence_id: "ev-inline",
          substrate: "inline",
          inline_text: "Delivered file",
          receipt_result: null,
          checker_receipt_ref: "ev-receipt"
        },
        {
          execution_id: first.executionId,
          ordinal: 1,
          evidence_id: "ev-receipt",
          substrate: "checker_receipt",
          inline_text: null,
          receipt_result: "pass",
          checker_receipt_ref: null
        }
      ]);
    } finally {
      db.close();
    }
  });
});

test("incremental execution changes replace only that execution output rows", () => {
  withHarness((rootDir) => {
    const first = ids(1);
    const second = ids(2);
    writeTask(rootDir, first.taskId, "First task");
    writeTask(rootDir, second.taskId, "Second task");
    const changedPath = writeExecution(rootDir, first.taskId, first.executionId, "2026-07-13T00:01:00.000Z", [
      inlineOutput(first, "ev-first", "Before")
    ]);
    writeExecution(rootDir, second.taskId, second.executionId, "2026-07-13T00:02:00.000Z", [
      inlineOutput(second, "ev-second", "Untouched")
    ]);
    rebuildTaskProjection({ rootDir });
    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const db = openProjection(rootDir, false);
    try {
      db.exec(`
        CREATE TRIGGER preserve_untouched_execution_outputs
        BEFORE DELETE ON execution_output_projection
        WHEN OLD.execution_id = '${second.executionId}'
        BEGIN SELECT RAISE(ABORT, 'untouched output deleted'); END
      `);
      db.exec(`
        CREATE TRIGGER preserve_untouched_execution_summary
        BEFORE DELETE ON execution_evidence_projection
        WHEN OLD.execution_id = '${second.executionId}'
        BEGIN SELECT RAISE(ABORT, 'untouched summary deleted'); END
      `);
    } finally {
      db.close();
    }
    writeExecution(rootDir, first.taskId, first.executionId, "2026-07-13T00:03:00.000Z", [
      inlineOutput(first, "ev-first-updated", "After")
    ]);

    const result = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [changedPath],
      previousSourceFingerprint
    });

    assert.equal(result.mode, "incremental");
    const updated = openProjection(rootDir);
    try {
      assert.deepEqual(updated.prepare(`
        SELECT execution_id, evidence_id, inline_text
        FROM execution_output_projection
        ORDER BY execution_id, ordinal
      `).all().map((row) => ({ ...row })), [
        { execution_id: first.executionId, evidence_id: "ev-first-updated", inline_text: "After" },
        { execution_id: second.executionId, evidence_id: "ev-second", inline_text: "Untouched" }
      ]);
      assert.equal(updated.prepare(`
        SELECT COUNT(*) AS count
        FROM execution_evidence_projection
      `).get()?.count, 2);
    } finally {
      updated.close();
    }
  });
});

test("execution evidence uses stable execution keyset pages and SQL aggregate stats", () => {
  withHarness((rootDir) => {
    for (let index = 1; index <= 3; index += 1) {
      const identity = ids(index);
      writeTask(rootDir, identity.taskId, `Task ${index}`);
      writeExecution(rootDir, identity.taskId, identity.executionId, `2026-07-13T00:0${index}:00.000Z`, [
        inlineOutput(identity, `ev-${index}`, `Evidence ${index}`),
        ...(index === 3 ? [checkerOutput(identity, "ev-3-receipt", "ev-3", "pass")] : [])
      ], index === 2 ? "fact-execution-migration" : "codex");
    }
    const newest = { taskId: ids(3).taskId, executionId: ids(4).executionId };
    writeExecution(rootDir, newest.taskId, newest.executionId, "2026-07-13T00:04:00.000Z", [
      inlineOutput(newest, "ev-4", "Evidence 4")
    ]);
    rebuildTaskProjection({ rootDir });

    const firstPage = queryExecutionEvidencePage({ rootDir, limit: 2 });

    assert.deepEqual(firstPage.groups.map((group) => group.taskId), [ids(3).taskId]);
    assert.deepEqual(firstPage.groups[0]?.executions.map((execution) => execution.executionId), [
      newest.executionId,
      ids(3).executionId
    ]);
    assert.equal(firstPage.groups[0]?.executions[0]?.outputs[0]?.text, "Evidence 4");
    assert.deepEqual(firstPage.stats, {
      totalExecutions: 4,
      archivalExecutions: 1,
      realExecutions: 3,
      totalOutputs: 5,
      passingReceiptOutputs: 1,
      tasksWithExecutions: 3
    });
    assert.equal(firstPage.nextCursor?.latestAt, "2026-07-13T00:03:00.000Z");
    assert.equal(firstPage.nextCursor?.executionId, ids(3).executionId);
    assert.ok(firstPage.nextCursor?.generation);

    const secondPage = queryExecutionEvidencePage({ rootDir, limit: 2, cursor: firstPage.nextCursor! });
    assert.deepEqual(secondPage.groups.map((group) => group.taskId), [ids(2).taskId, ids(1).taskId]);
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(secondPage.stats, firstPage.stats);

    const previousSourceFingerprint = captureProjectionSourceSnapshot(rootDir).fingerprint;
    const movedPath = writeExecution(rootDir, ids(1).taskId, ids(1).executionId, "2026-07-13T00:05:00.000Z", [
      inlineOutput(ids(1), "ev-1", "Evidence 1")
    ]);
    const updated = updateTaskProjectionIncrementally({
      rootDir,
      touchedPaths: [movedPath],
      previousSourceFingerprint
    });
    assert.equal(updated.mode, "incremental");
    assert.throws(
      () => queryExecutionEvidencePage({ rootDir, limit: 2, cursor: firstPage.nextCursor! }),
      /cursor generation changed/
    );
  });
});

test("execution evidence rebuilds normalized SQL rows after generated-cache tampering", () => {
  withHarness((rootDir) => {
    const identity = ids(1);
    writeTask(rootDir, identity.taskId, "Tamper check");
    writeExecution(rootDir, identity.taskId, identity.executionId, "2026-07-13T00:01:00.000Z", [
      inlineOutput(identity, "ev-original", "Original evidence")
    ]);
    rebuildTaskProjection({ rootDir });

    const db = openProjection(rootDir, false);
    try {
      db.prepare("UPDATE execution_output_projection SET inline_text = 'TAMPERED'").run();
    } finally {
      db.close();
    }

    const page = queryExecutionEvidencePage({ rootDir, limit: 1 });
    assert.equal(page.groups[0]?.executions[0]?.outputs[0]?.text, "Original evidence");
  });
});

test("execution evidence page caps output previews without losing total counts", () => {
  withHarness((rootDir) => {
    const identity = ids(1);
    writeTask(rootDir, identity.taskId, "Many outputs");
    writeExecution(
      rootDir,
      identity.taskId,
      identity.executionId,
      "2026-07-13T00:01:00.000Z",
      [
        inlineOutput(identity, "ev-inline-large", "😀".repeat(300_000)),
        fileOutput(identity, "ev-file-large", "界".repeat(300_000)),
        ...Array.from({ length: 6 }, (_, index) => inlineOutput(identity, `ev-${index}`, `Evidence ${index}`))
      ]
    );
    rebuildTaskProjection({ rootDir });

    const page = queryExecutionEvidencePage({ rootDir, limit: 1 });
    const execution = page.groups[0]?.executions[0];

    assert.equal(execution?.outputs.length, 5);
    assert.ok(Buffer.byteLength(execution?.outputs[0]?.text ?? "", "utf8") <= 1_027);
    assert.ok(Buffer.byteLength(execution?.outputs[1]?.text ?? "", "utf8") <= 1_050);
    assert.match(execution?.outputs[0]?.text ?? "", /…$/u);
    assert.match(execution?.outputs[1]?.text ?? "", /…$/u);
    assert.equal(execution?.outputCount, 8);
    assert.equal(execution?.hasMoreOutputs, true);
    assert.equal(page.stats.totalOutputs, 8);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 250 * 1024);
  });
});

interface Identity {
  readonly taskId: string;
  readonly executionId: string;
}

function ids(index: number): Identity {
  const suffix = String(index).padStart(26, "0");
  return { taskId: `task_${suffix}`, executionId: `exe_${suffix}` };
}

function withHarness(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-evidence-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeTask(rootDir: string, taskId: string, title: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
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
  ].join("\n"), "utf8");
}

function writeExecution(
  rootDir: string,
  taskId: string,
  executionId: string,
  submittedAt: string,
  outputs: ReadonlyArray<unknown>,
  executorId = "codex"
): string {
  const executionRoot = path.join(rootDir, "harness/tasks", taskId, "executions");
  mkdirSync(executionRoot, { recursive: true });
  const executionPath = path.join(executionRoot, `${executionId}.md`);
  writeFileSync(executionPath, `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: {
      principal: { personId: "person_test" },
      executor: { kind: "agent", id: executorId },
      responsibleHuman: "person_test"
    },
    claimed_at: submittedAt,
    submitted_at: submittedAt,
    closed_at: null,
    session_bindings: [],
    outputs,
    submission: null
  }, null, 2)}\n`, "utf8");
  return executionPath;
}

function inlineOutput(identity: Identity, evidenceId: string, text: string): unknown {
  return {
    evidence_id: evidenceId,
    execution_ref: `execution/${identity.taskId}/${identity.executionId}`,
    locator: { substrate: "inline", text },
    checker_receipt_ref: `${evidenceId.includes("first") ? "" : evidenceId === "ev-inline" ? "ev-receipt" : ""}` || undefined
  };
}

function fileOutput(identity: Identity, evidenceId: string, filePath: string): unknown {
  return {
    evidence_id: evidenceId,
    execution_ref: `execution/${identity.taskId}/${identity.executionId}`,
    locator: { substrate: "file", path: filePath }
  };
}

function checkerOutput(identity: Identity, evidenceId: string, targetEvidenceId: string, result: "pass" | "fail"): unknown {
  return {
    evidence_id: evidenceId,
    execution_ref: `execution/${identity.taskId}/${identity.executionId}`,
    locator: {
      substrate: "checker_receipt",
      receipt: {
        checker_id: "test-checker",
        checker_version: "1",
        target_evidence_id: targetEvidenceId,
        target_sha256: null,
        checked_at: "2026-07-13T00:10:00.000Z",
        result
      }
    }
  };
}

function openProjection(rootDir: string, readOnly = true): DatabaseSync {
  return new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly });
}
