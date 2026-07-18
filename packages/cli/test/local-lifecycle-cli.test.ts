// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { initializeNestedHarnessRepo, withTestHarnessRoot as withTempRoot } from "./helpers/git-fixtures.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { capabilityExcludedCommandKinds } from "../src/commands/core/capabilities.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";
import {
  assertGeneratedTaskId,
  runJson,
  runRawJson,
  runText,
  seedApprovedExecution,
  writeCodeDocAnchors,
  writeConflictMarker,
  writeFact,
  writeIndex,
  writeReview
} from "./helpers/local-lifecycle-fixtures.ts";

const executionTaskId = "task_01KX7H00000000000000000000";
const executionId = "exe_01KX7H00000000000000000001";
const executionActorEnv = { HARNESS_ACTOR: "agent:test" } as const;

test("CLI init creates authored harness and skips outer gitignore outside git repos", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["init"]);

    assert.equal(result.ok, true);
    assert.equal(result.path, "harness/harness.yaml");
    const config = readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8");
    assert.match(config, /idPolicy: random-ulid/);
    assert.match(config, /defaultVertical: software\/coding/);
    assert.match(config, /defaultPreset: standard-task/);
    assert.match(config, /defaultProfile: baseline/);
    assert.match(config, /locale: zh-CN/);
    assert.match(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8"), /harness\/harness.yaml/);
    assert.equal(existsSync(path.join(rootDir, ".gitignore")), false);
    assert.equal(result.report.isolation.outerGitignore.action, "skipped-not-git");
    assert.equal(existsSync(path.join(rootDir, "harness/legacy")), false);
  }, { identity: false });
});

test("CLI refuses untitled new tasks before creating task files", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "missing_title");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks")), false);
  });
});

test("CLI refuses default manual task IDs", () => {
  withTempRoot((rootDir) => {
    const positional = runJson(rootDir, ["new-task", "task-1", "--title", "Task One"], false);
    const option = runJson(rootDir, ["new-task", "--id", "task-1", "--title", "Task One"], false);

    assert.equal(positional.ok, false);
    assert.equal(positional.error?.code, "manual_task_id_forbidden");
    assert.equal(option.ok, false);
    assert.equal(option.error?.code, "manual_task_id_forbidden");
  });
});

test("CLI accepts manual task IDs only in controlled migration mode", () => {
  withTempRoot((rootDir) => {
    const result = runJson(rootDir, ["new-task", "--id", "legacy-task-1", "--migration", "--title", "Imported Task"]);

    assert.equal(result.ok, true);
    assert.equal(result.taskId, "legacy-task-1");
    assert.equal(result.packagePath, "harness/tasks/legacy-task-1-imported-task");
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/legacy-task-1-imported-task/INDEX.md"), "utf8"), /task_id: legacy-task-1/);
  });
});

test("CLI status set mutates local task state through the write journal", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    const result = runJson(rootDir, ["task", "status", "set", taskId, "active"]);

    assert.equal(result.ok, true);
    assert.equal(result.status, "active");
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8"), /status: active/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI rejects naked local review transitions with the Execution submission error", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const failure = runJson(rootDir, ["task", "status", "set", taskId, "in_review"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "execution_submission_required");
  });
});

test("CLI rejects generic exits from in_review without a changes_requested Execution Review", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const indexPath = path.join(rootDir, String(created.packagePath), "INDEX.md");
    const indexBody = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, indexBody.replace("  status: planned", "  status: in_review"), "utf8");

    for (const status of ["active", "blocked"] as const) {
      const failure = runJson(rootDir, ["task", "status", "set", taskId, status], false);
      assert.equal(failure.ok, false);
      assert.equal(failure.error?.code, "execution_review_required");
    }
    const forcedCancellation = runJson(rootDir, [
      "task", "status", "set", taskId, "cancelled", "--force", "--reason", "invalid review escape"
    ], false);
    assert.equal(forcedCancellation.ok, false);
    assert.equal(forcedCancellation.error?.code, "execution_review_required");
    assert.equal(existsSync(path.join(rootDir, String(created.packagePath), "progress.md")), false);
    assert.match(readFileSync(indexPath, "utf8"), /^  status: in_review$/mu);
  });
});

test("CLI never lets forced done bypass Execution completion and keeps audited cancellation for recovery", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const invalidForce = runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "invalid recovery"], false);
    assert.equal(invalidForce.ok, false);
    assert.equal(invalidForce.error?.code, "execution_completion_required");
    assert.match(invalidForce.error?.hint ?? "", /Execution.*approved Review.*task-complete/iu);
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`)), false);

    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    runJson(rootDir, ["task", "status", "set", taskId, "active"]);

    const doneFailure = runJson(rootDir, ["task", "status", "set", taskId, "done"], false);
    assert.equal(doneFailure.ok, false);
    assert.equal(doneFailure.error?.code, "terminal_status_requires_task_complete");

    const cancelFailure = runJson(rootDir, ["task", "status", "set", taskId, "cancelled"], false);
    assert.equal(cancelFailure.ok, false);
    assert.equal(cancelFailure.error?.code, "terminal_status_requires_task_complete");

    const missingReason = runJson(rootDir, ["task", "status", "set", taskId, "done", "--force"], false);
    assert.equal(missingReason.ok, false);
    assert.equal(missingReason.error?.code, "missing_force_reason");

    const forcedDone = runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "fixture recovery"], false);
    assert.equal(forcedDone.ok, false);
    assert.equal(forcedDone.error?.code, "execution_completion_required");
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`)), false);

    const forced = runJson(rootDir, ["task", "status", "set", taskId, "cancelled", "--force", "--reason", "fixture recovery"]);
    assert.equal(forced.ok, true);
    assert.equal(forced.status, "cancelled");
    assert.equal(forced.forced, true);
    assert.equal(forced.forceAudit.marker, "FORCE_STATUS_SET_AUDIT");
    const progressBody = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8");
    assert.match(progressBody, /FORCE_STATUS_SET_AUDIT: forced terminal status=cancelled; reason=fixture recovery/);

    const check = runJson(rootDir, ["check", "--profile", "target-project"], false);
    assert.equal(check.warnings.some((warning: Record<string, unknown>) => warning.code === "forced_terminal_status_set" && warning.severity === "warning"), true);
  });
});

test("CLI rejects unknown six-state lifecycle values", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const failure = runJson(rootDir, ["task", "transition", taskId, "shipping"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_status");
    assert.match(failure.error?.hint ?? "", /Valid statuses: planned, active, blocked, in_review, done, cancelled/u);
  });
});

test("CLI missing task errors do not leak local root paths", () => {
  withTempRoot((rootDir) => {
    const jsonFailure = runJson(rootDir, ["task", "status", "set", "missing-task", "active"], false);

    assert.equal(jsonFailure.ok, false);
    assert.equal(jsonFailure.error?.code, "task_not_found");
    assert.equal(JSON.stringify(jsonFailure).includes(rootDir), false);

    const humanFailure = runText(rootDir, ["task", "status", "set", "missing-task", "active"], false);
    assert.equal(humanFailure.includes(rootDir), false);
    assert.match(humanFailure, /task not found: missing-task/);
  });
});

test("CLI refuses to set status for non-local engine bindings", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "External Task", "active", { engine: "multica", ref: "FAI-1" });

    const failure = runJson(rootDir, ["task", "status", "set", "task-1", "done"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "engine_owns_status");
  });
});

test("CLI appends progress through the write journal", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const result = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "Implemented local CLI"]);

    assert.equal(result.ok, true);
    assert.equal(result.path, "progress.md");
    assert.equal(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), "# Progress\n\n## Entries\n\nImplemented local CLI\n");
    const payloadBodies = readdirSync(path.join(rootDir, ".harness/write-journal/payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".harness/write-journal/payloads", entry), "utf8"));
    assert.equal(payloadBodies.some((body) => body.includes("\"path\":\"progress.md\"")), true);
  });
});

test("CLI appends progress to an existing progress@1 document without rewriting its legacy structure", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const progressPath = path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`);
    const legacyBody = "# Progress\n\n## Log\n\n- Historical entry.\n\n## Evidence\n\n| Type | Path | Summary | Command |\n| --- | --- | --- | --- |\n";
    writeFileSync(progressPath, legacyBody, "utf8");

    runJson(rootDir, ["task", "progress", "append", taskId, "--text", "Compatible append"]);

    assert.equal(readFileSync(progressPath, "utf8"), `${legacyBody}Compatible append\n`);
  });
});

test("CLI task archive writes disposition through committed watermark", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const result = runJson(rootDir, ["task", "archive", taskId, "--reason", "superseded by newer plan"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-archive");
    const indexBody = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8");
    assert.match(indexBody, /packageDisposition: archived/);
    assert.match(indexBody, /superseded by newer plan/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /"projectionHash":"sha256:/);
  });
});

test("CLI task supersede archives old task and creates relation to new task", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Original Task"]);
    const oldTaskId = assertGeneratedTaskId(created.taskId);
    const result = runJson(rootDir, ["task", "supersede", oldTaskId, "--title", "Replacement Task", "--reason", "scope changed"]);
    const newTaskRef = String(result.path);
    const newTaskId = assertGeneratedTaskId(newTaskRef.replace("task/", ""));

    assert.equal(result.ok, true);
    assert.equal(result.command, "task-supersede");
    assert.equal(result.taskId, oldTaskId);
    assert.equal(result.packagePath, `harness/tasks/${newTaskId}-replacement-task`);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${oldTaskId}-original-task/INDEX.md`), "utf8"), /packageDisposition: archived/);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${newTaskId}-replacement-task/relations.md`), "utf8"), new RegExp(`type: supersedes[\\s\\S]*task/${oldTaskId}`));
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /"projectionHash":"sha256:/);
  });
});

test("CLI task delete rejects conflicting delete modes", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Mode Conflict"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const failure = runJson(rootDir, ["task", "delete", "--soft", "--hard", taskId, "--reason", "ambiguous"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "conflicting_delete_mode");
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}-mode-conflict/INDEX.md`)), true);
  });
});

test("CLI task reopen restores only non-terminal package disposition", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Reopenable"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    runJson(rootDir, ["task", "archive", taskId, "--reason", "paused"]);

    const reopened = runJson(rootDir, ["task", "reopen", taskId, "--reason", "resume"]);

    assert.equal(reopened.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-reopenable/INDEX.md`), "utf8"), /packageDisposition: active/);

    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    runJson(rootDir, ["task", "status", "set", taskId, "active"]);
    const indexPath = path.join(rootDir, `harness/tasks/${taskId}-reopenable/INDEX.md`);
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/^(  status:\s*).+$/mu, "$1done"), "utf8");
    const failure = runJson(rootDir, ["task", "reopen", taskId, "--reason", "more work"], false);
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "terminal_reopen_requires_supersede");
  });
});

test("CLI task list reads from rebuildable SQLite projection", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const result = runJson(rootDir, ["task", "list"]);

    assert.equal(result.ok, true);
    assert.equal(Array.isArray(result.tasks), true);
    assert.equal(result.tasks[0].taskId, taskId);
    assert.equal(result.tasks[0].canonicalStatus, "planned");
    assert.equal(result.tasks[0].sourcePath, `harness/tasks/${taskId}-task-one/INDEX.md`);
    assert.equal(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8").includes("projections.sqlite"), false);
  });
});

test("CLI task list fails conflict preflight before rebuilding projection", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "--title", "Task One"]);
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    rmSync(projectionPath, { force: true });
    writeConflictMarker(rootDir);

    const result = runJson(rootDir, ["task", "list"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "conflict_marker_present");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "conflict_marker_present" && warning.source === "collaboration-gate"), true);
    assert.equal(existsSync(projectionPath), false);
  });
});

test("CLI status --json returns local projection health envelope", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    runJson(rootDir, ["task", "archive", taskId, "--reason", "done elsewhere"]);

    const result = runJson(rootDir, ["status"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "status");
    assert.equal(result.rows, 1);
    assert.equal(result.projectionPath, ".harness/cache/projections.sqlite");
    assert.equal(result.summary.taskCount, 1);
    assert.equal(result.summary.byPackageDisposition.archived, 1);
    assert.equal(result.report.schema, "harness-check-report/v1");
    assert.equal(result.report.summary.warningCount, 0);
    assert.equal(result.report.axes.some((axis: Record<string, unknown>) => axis.axis === "generated-cache" && axis.warningCount === 0), true);
    assert.equal(result.report.axes.some((axis: Record<string, unknown>) => axis.axis === "collaboration-gate" && axis.warningCount === 0), true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "task-supersede" && entry.resultEnvelope === "command-receipt/v2"), true);
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "preset-validate" && entry.primary === "harness-anything preset validate <manifest> [--kernel-version <version>] [--json]"), true);
  });
});

test("CLI capabilities expose registry-derived entity operations through receipt v2", () => {
  withTempRoot((rootDir) => {
    const receipt = runRawJson(rootDir, ["decision", "capabilities"]);

    assert.equal(receipt.ok, true);
    assert.equal(receipt.schema, "command-receipt/v2");
    assert.equal(receipt.command, "capabilities");
    assert.equal(receipt.entity?.kind, "capabilities");
    assert.equal(receipt.rows > 0, true);
    assert.equal(Array.isArray(receipt.items), true);
    assert.equal(receipt.items.some((op: Record<string, any>) => op.action === "propose" && op.input?.schemaId === "harness://schema/cli/decision-propose-input/v1"), true);
    assert.equal(receipt.details?.report?.generatedFrom?.commandRegistry, "packages/cli/src/cli/command-registry.ts");
  });
});

test("CLI capabilities text output gives cold-start agents a useful summary", () => {
  withTempRoot((rootDir) => {
    const output = runText(rootDir, ["capabilities"]);

    assert.match(output, /ok command=capabilities/u);
    assert.match(output, /rows=\d+/u);
    assert.match(output, /kinds=/u);
    assert.match(output, /--json for full schema/u);
  });
});

test("CLI task complete help explains the resolved completion contract", () => {
  withTempRoot((rootDir) => {
    const output = runText(rootDir, ["task", "complete", "--help"]);

    assert.match(output, /exactly one submitted Execution and an approved typed Review/u);
    assert.match(output, /legacy review\.md is only a compatibility blocker check/u);
    assert.match(output, /Pass --ci only when the contract declares ci/u);
    assert.match(output, /Facts are never a quantity gate/u);
  });
});

test("CLI capabilities surface every registered command or explicitly exclude it", () => {
  withTempRoot((rootDir) => {
    const index = runRawJson(rootDir, ["capabilities"]);
    const surfaced = new Set<string>();
    const exactSet: Record<string, ReadonlyArray<string>> = {};
    for (const item of index.items as ReadonlyArray<{ readonly kind: string }>) {
      const detail = runRawJson(rootDir, ["capabilities", "--kind", item.kind]);
      exactSet[item.kind] = (detail.items as ReadonlyArray<{ readonly commandKind?: string }>)
        .flatMap((op) => op.commandKind ? [op.commandKind] : [])
        .sort();
      for (const op of detail.items as ReadonlyArray<{ readonly commandKind?: string }>) {
        if (op.commandKind) surfaced.add(op.commandKind);
      }
    }

    assert.deepEqual(exactSet, JSON.parse(readFileSync(
      path.resolve("packages/cli/test/snapshots/capabilities-command-kinds.json"),
      "utf8"
    )));

    for (const descriptor of commandDescriptors) {
      assert.equal(
        surfaced.has(descriptor.kind) || capabilityExcludedCommandKinds.has(descriptor.kind),
        true,
        `${descriptor.kind} must be surfaced in capabilities or explicitly excluded`
      );
    }
  });
});

test("CLI status --json fails conflict preflight before reading projection state", () => {
  withTempRoot((rootDir) => {
    writeConflictMarker(rootDir);
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    rmSync(projectionPath, { force: true });

    const result = runJson(rootDir, ["status"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "conflict_marker_present");
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "conflict_marker_present" && warning.source === "collaboration-gate"), true);
    assert.equal(result.report, undefined);
    assert.equal(existsSync(projectionPath), false);
  });
});

test("CLI write commands fail conflict preflight before mutating authored files", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const indexPath = path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`);
    const progressPath = path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`);
    writeConflictMarker(rootDir);

    const statusFailure = runJson(rootDir, ["task", "status", "set", taskId, "active"], false);
    assert.equal(statusFailure.ok, false);
    assert.equal(statusFailure.error?.code, "conflict_marker_present");
    assert.match(readFileSync(indexPath, "utf8"), /status: planned/);

    const progressFailure = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "should not write"], false);
    assert.equal(progressFailure.ok, false);
    assert.equal(progressFailure.error?.code, "conflict_marker_present");
    assert.equal(existsSync(progressPath), false);

    const newTaskFailure = runJson(rootDir, ["new-task", "--title", "Blocked Task"], false);
    assert.equal(newTaskFailure.ok, false);
    assert.equal(newTaskFailure.error?.code, "conflict_marker_present");
    assert.equal(readdirSync(path.join(rootDir, "harness/tasks")).some((entry) => entry.endsWith("-blocked-task")), false);
  });
});

test("CLI governance rebuild regenerates projection from authored markdown", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["new-task", "--title", "Task One"]);
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const result = runJson(rootDir, ["governance", "rebuild"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "governance-rebuild");
    assert.equal(result.rows, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/cache/projections.sqlite"), "latin1"), /SQLite format 3/);
  });
});

test("CLI check reports projection tampering as a stable JSON error", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    runJson(rootDir, ["task", "list"]);
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    execFileSync(process.execPath, ["--input-type=module", "-e", [
      "import { DatabaseSync } from 'node:sqlite';",
      `const db = new DatabaseSync(${JSON.stringify(projectionPath)});`,
      `db.prepare('UPDATE task_projection SET title = ? WHERE task_id = ?').run('Projection Edit', ${JSON.stringify(taskId)});`,
      "db.close();"
    ].join("\n")]);

    const result = runJson(rootDir, ["check"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "projection_check_failed");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(JSON.stringify(result).includes("Projection Edit"), false);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
  });
});

test("CLI task list does not emit tampered SQLite row content as task truth", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    runJson(rootDir, ["task", "list"]);
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    execFileSync(process.execPath, ["--input-type=module", "-e", [
      "import { DatabaseSync } from 'node:sqlite';",
      `const db = new DatabaseSync(${JSON.stringify(projectionPath)});`,
      `db.prepare('UPDATE task_projection SET title = ? WHERE task_id = ?').run('SQLite Lie', ${JSON.stringify(taskId)});`,
      "db.close();"
    ].join("\n")]);

    const result = runJson(rootDir, ["task", "list"]);

    assert.equal(result.ok, true);
    assert.equal(result.tasks[0].title, "Task One");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(JSON.stringify(result).includes("SQLite Lie"), false);
  });
});

test("CLI check reports corrupted projection without crashing or leaking root", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    runJson(rootDir, ["task", "list"]);
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    execFileSync(process.execPath, ["--input-type=module", "-e", [
      "import { DatabaseSync } from 'node:sqlite';",
      `const db = new DatabaseSync(${JSON.stringify(projectionPath)});`,
      `db.prepare("INSERT INTO entity_attribution_summary (entity_kind, entity_id, originator_json, latest_actor_json, trail_count, completeness) VALUES ('task', ?, NULL, ?, 1, 'complete') ON CONFLICT (entity_kind, entity_id) DO UPDATE SET latest_actor_json = excluded.latest_actor_json").run(${JSON.stringify(taskId)}, '{bad-json');`,
      "db.close();"
    ].join("\n")]);

    const result = runJson(rootDir, ["check"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "projection_check_failed");
    assert.equal(result.warnings.some((warning) => warning.code === "projection_tampered"), true);
    assert.equal(JSON.stringify(result).includes(rootDir), false);
  });
});

test("CLI check --post-merge does not mistake Markdown setext headings for conflicts", () => {
  withTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/standards"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/standards/repo.md"), "Heading\n=======\n", "utf8");

    const result = runJson(rootDir, ["check", "--post-merge"]);

    assert.equal(result.ok, true);
    assert.equal(result.warnings.some((warning) => warning.code === "conflict_marker_present"), false);
  });
});

test("CLI check --post-merge stores prefixed external EntityRefs without resolving them", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-a", "A", "planned");
    writeFileSync(path.join(rootDir, "harness/tasks/task-a/relations.md"), "external relation other-harness:task/missing-remote\n", "utf8");

    const result = runJson(rootDir, ["check", "--post-merge"]);

    assert.equal(result.ok, true);
    assert.equal(result.warnings.some((warning: Record<string, unknown>) => warning.code === "dangling_entity_ref"), false);
  });
});

test("CLI task-review fails closed on open release-blocking findings and emits pass contract when clean", () => {
  withTempRoot((rootDir) => {
    writeIndex(rootDir, "task-1", "Review Task", "in_review");
    writeFact(rootDir, "task-1");
    writeReview(rootDir, "task-1", [
      "| F-001 | P1 | Missing evidence. | diff | Add evidence. | yes | open | yes | none |"
    ]);

    const failure = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"], false);
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "release_blocking_findings");
    assert.equal(failure.issues[0]?.findingId, "F-001");

    writeReview(rootDir, "task-1", [
      "| F-001 | P1 | Missing evidence. | diff | Added evidence. | no | closed | yes | none |"
    ]);
    const passed = runJson(rootDir, ["task-review", "task-1", "--reviewer", "reviewer-a"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.reviewContract.schema, "verifier-backed-review/v1");
    assert.equal(passed.reviewContract.findingSummary.openBlocking, 0);
  });
});

test("CLI task-complete evaluates review, CI, and closeout readiness before setting status done", () => {
  withTempRoot((rootDir) => {
    initializeNestedHarnessRepo(rootDir);
    writeIndex(rootDir, executionTaskId, "Complete Task", "in_review");
    writeFact(rootDir, executionTaskId);
    writeReview(rootDir, executionTaskId, []);
    writeFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/closeout.md`), "# Closeout\n", "utf8");
    writeCodeDocAnchors(rootDir, executionTaskId);
    seedApprovedExecution(rootDir, executionTaskId, executionId);

    const failed = runJson(rootDir, ["task-complete", executionTaskId, "--ci", "failed"], false, executionActorEnv);
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "ci_not_passed");

    const missingCi = runJson(rootDir, ["task-complete", executionTaskId], false, executionActorEnv);
    assert.equal(missingCi.ok, false);
    assert.equal(missingCi.error?.code, "missing_ci_gate");

    const passed = runJson(rootDir, ["task-complete", executionTaskId, "--reviewer", "reviewer-a", "--ci", "passed"], true, executionActorEnv);
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.completionGate.axes, {
      coordinationStatus: "in_review",
      packageDisposition: "active",
      closeoutReadiness: "ready"
    });
    assert.equal(passed.executionId, executionId);
    assert.equal(passed.status, "done");
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${executionTaskId}/INDEX.md`), "utf8"), /status: done/);
  });
});
