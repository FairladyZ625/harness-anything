import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI init creates shared authored harness and ignored local state root", () => {
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
    assert.match(readFileSync(path.join(rootDir, ".gitignore"), "utf8"), /^\.harness\/$/m);
    assert.equal(existsSync(path.join(rootDir, "harness/legacy")), false);
  });
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
    const result = runJson(rootDir, ["task", "status", "set", taskId, "active"]);

    assert.equal(result.ok, true);
    assert.equal(result.status, "active");
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/INDEX.md`), "utf8"), /status: active/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /write-watermark\/v1/);
  });
});

test("CLI rejects invalid local lifecycle transitions with a stable error code", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const failure = runJson(rootDir, ["task", "status", "set", taskId, "in_review"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_transition");
  });
});

test("CLI blocks ordinary terminal status-set and requires audited force for recovery", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const invalidForce = runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "invalid recovery"], false);
    assert.equal(invalidForce.ok, false);
    assert.equal(invalidForce.error?.code, "invalid_transition");
    assert.equal(existsSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`)), false);

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

    const forced = runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "fixture recovery"]);
    assert.equal(forced.ok, true);
    assert.equal(forced.status, "done");
    assert.equal(forced.forced, true);
    assert.equal(forced.forceAudit.marker, "FORCE_STATUS_SET_AUDIT");
    const progressBody = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8");
    assert.match(progressBody, /FORCE_STATUS_SET_AUDIT: forced terminal status=done; reason=fixture recovery/);

    const check = runJson(rootDir, ["check", "--profile", "target-project"], false);
    assert.equal(check.warnings.some((warning: Record<string, unknown>) => warning.code === "forced_terminal_status_set" && warning.severity === "warning"), true);
  });
});

test("CLI rejects unknown six-state lifecycle values", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);
    const failure = runJson(rootDir, ["task", "status", "set", taskId, "shipping"], false);

    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "invalid_status");
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
    assert.equal(readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8"), "Implemented local CLI\n");
    const payloadBodies = readdirSync(path.join(rootDir, ".harness/write-journal/payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".harness/write-journal/payloads", entry), "utf8"));
    assert.equal(payloadBodies.some((body) => body.includes("\"path\":\"progress.md\"")), true);
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

test("CLI task delete soft tombstones and hard delete rejects archived terminal or related tasks", () => {
  withTempRoot((rootDir) => {
    const hard = runJson(rootDir, ["new-task", "--title", "Hard Delete"]);
    const hardTaskId = assertGeneratedTaskId(hard.taskId);
    const hardPackagePath = path.join(rootDir, `harness/tasks/${hardTaskId}-hard-delete`);
    assert.equal(existsSync(hardPackagePath), true);
    const missingConfirm = runJson(rootDir, ["task", "delete", "--hard", hardTaskId, "--reason", "mistaken local package"], false);
    assert.equal(missingConfirm.ok, false);
    assert.equal(missingConfirm.error?.code, "delete_confirm_required");

    const hardResult = runJson(rootDir, ["task", "delete", "--hard", hardTaskId, "--reason", "mistaken local package", "--confirm", hardTaskId]);
    assert.equal(hardResult.ok, true);
    assert.equal(hardResult.mode, "hard");
    assert.equal(existsSync(hardPackagePath), false);
    const journalBody = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(journalBody, /"schema":"delete-audit\/v1"/);
    assert.match(journalBody, /"kind":"package_delete_hard_applied"/);
    const hardDeletePayloads = readdirSync(path.join(rootDir, ".harness/write-journal/payloads"))
      .map((entry) => readFileSync(path.join(rootDir, ".harness/write-journal/payloads", entry), "utf8"));
    assert.equal(hardDeletePayloads.some((body) => body.includes("mistaken local package")), true);

    const soft = runJson(rootDir, ["new-task", "--title", "Soft Delete"]);
    const softTaskId = assertGeneratedTaskId(soft.taskId);
    const softResult = runJson(rootDir, ["task", "delete", "--soft", softTaskId, "--reason", "not needed"]);
    assert.equal(softResult.ok, true);
    assert.match(readFileSync(path.join(rootDir, `harness/tasks/${softTaskId}-soft-delete/INDEX.md`), "utf8"), /packageDisposition: tombstoned/);

    const archived = runJson(rootDir, ["new-task", "--title", "Archived Delete"]);
    const archivedTaskId = assertGeneratedTaskId(archived.taskId);
    runJson(rootDir, ["task", "archive", archivedTaskId, "--reason", "keep audit"]);
    const archivedFailure = runJson(rootDir, ["task", "delete", "--hard", archivedTaskId, "--reason", "remove", "--confirm", archivedTaskId], false);
    assert.equal(archivedFailure.ok, false);
    assert.equal(archivedFailure.error?.code, "archived_hard_delete_forbidden");

    const terminal = runJson(rootDir, ["new-task", "--title", "Done Delete"]);
    const terminalTaskId = assertGeneratedTaskId(terminal.taskId);
    runJson(rootDir, ["task", "status", "set", terminalTaskId, "active"]);
    runJson(rootDir, ["task", "status", "set", terminalTaskId, "done", "--force", "--reason", "terminal fixture"]);
    const terminalFailure = runJson(rootDir, ["task", "delete", "--hard", terminalTaskId, "--reason", "remove", "--confirm", terminalTaskId], false);
    assert.equal(terminalFailure.ok, false);
    assert.equal(terminalFailure.error?.code, "terminal_hard_delete_forbidden");

    const related = runJson(rootDir, ["new-task", "--title", "Related Delete"]);
    const relatedTaskId = assertGeneratedTaskId(related.taskId);
    writeFileSync(path.join(rootDir, `harness/tasks/${relatedTaskId}-related-delete/relations.md`), `target: task/${softTaskId}\n`, "utf8");
    const relatedFailure = runJson(rootDir, ["task", "delete", "--hard", relatedTaskId, "--reason", "remove", "--confirm", relatedTaskId], false);
    assert.equal(relatedFailure.ok, false);
    assert.equal(relatedFailure.error?.code, "related_task_hard_delete_forbidden");
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

    runJson(rootDir, ["task", "status", "set", taskId, "active"]);
    runJson(rootDir, ["task", "status", "set", taskId, "done", "--force", "--reason", "terminal fixture"]);
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
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "task-supersede" && entry.resultEnvelope === "CommandReceipt/v1"), true);
    assert.equal(result.commands.some((entry: Record<string, unknown>) => entry.kind === "preset-validate" && entry.primary === "harness-anything preset validate <manifest> [--kernel-version <version>] [--json]"), true);
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
      `const row = JSON.parse(db.prepare('SELECT row_json FROM task_projection WHERE task_id = ?').get(${JSON.stringify(taskId)}).row_json);`,
      "row.title = 'Projection Edit';",
      `db.prepare('UPDATE task_projection SET row_json = ? WHERE task_id = ?').run(JSON.stringify(row), ${JSON.stringify(taskId)});`,
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
      `const row = JSON.parse(db.prepare('SELECT row_json FROM task_projection WHERE task_id = ?').get(${JSON.stringify(taskId)}).row_json);`,
      "row.title = 'SQLite Lie';",
      `db.prepare('UPDATE task_projection SET row_json = ? WHERE task_id = ?').run(JSON.stringify(row), ${JSON.stringify(taskId)});`,
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
      `db.prepare('UPDATE task_projection SET row_json = ? WHERE task_id = ?').run('{bad-json', ${JSON.stringify(taskId)});`,
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
    writeIndex(rootDir, "task-1", "Complete Task", "in_review");
    writeReview(rootDir, "task-1", []);
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/closeout.md"), "# Closeout\n", "utf8");

    const passed = runJson(rootDir, ["task-complete", "task-1", "--reviewer", "reviewer-a", "--ci", "passed"]);
    assert.equal(passed.ok, true);
    assert.deepEqual(passed.completionGate.axes, {
      coordinationStatus: "in_review",
      packageDisposition: "active",
      closeoutReadiness: "ready"
    });
    assert.equal(passed.status, "done");
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8"), /status: done/);

    const failed = runJson(rootDir, ["task-complete", "task-1", "--ci", "failed"], false);
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "ci_not_passed");

    const missingCi = runJson(rootDir, ["task-complete", "task-1"], false);
    assert.equal(missingCi.ok, false);
    assert.equal(missingCi.error?.code, "missing_ci_gate");
  });
});

test("CLI gui command delegates to the local desktop controller without importing GUI", () => {
  const result = runJson(process.cwd(), ["gui"], true, { HARNESS_GUI_DRY_RUN: "1" });

  assert.equal(result.ok, true);
  assert.equal(result.command, "gui");
  assert.deepEqual(result.launchPlan, {
    packageName: "@harness-anything/gui",
    mode: "local-desktop-controller",
    apiHost: "127.0.0.1",
    delegated: true,
    dryRun: true,
    command: ["npm", "--workspace", "@harness-anything/gui", "run", "dev"]
  });
});

function writeIndex(
  rootDir: string,
  directoryName: string,
  title: string,
  status: string,
  options: {
    readonly taskId?: string;
    readonly engine?: string;
    readonly ref?: string;
    readonly bindingFingerprint?: string;
    readonly packageDisposition?: string;
  } = {}
): void {
  const taskId = options.taskId ?? directoryName;
  const engine = options.engine ?? "local";
  const ref = options.ref ?? "";
  const bindingCreatedAt = "2026-06-12T00:00:00.000Z";
  const bindingFingerprint = options.bindingFingerprint ?? (engine === "local" && ref === ""
    ? "sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7"
    : "sha256:fixture");
  mkdirSync(path.join(rootDir, "harness/tasks", directoryName), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    `  engine: ${engine}`,
    `  status: ${status}`,
    `  ref: ${ref}`,
    `  titleSnapshot: ${title}`,
    "  url: ",
    `  bindingCreatedAt: ${bindingCreatedAt}`,
    `  bindingFingerprint: ${bindingFingerprint}`,
    `packageDisposition: ${options.packageDisposition ?? "active"}`,
    "vertical: default",
    "preset: default",
    "provenance:",
    `  - {runtime: "human", sessionId: "human-cli-${Date.parse(bindingCreatedAt)}", boundAt: "${bindingCreatedAt}"}`,
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n"), "utf8");
}

function writeReview(rootDir: string, directoryName: string, findingRows: ReadonlyArray<string>): void {
  writeFileSync(path.join(rootDir, "harness/tasks", directoryName, "review.md"), [
    "# Review",
    "",
    "| ID | Severity | Finding | Evidence Checked | Required Action | Open | Disposition | Blocks Release | Follow-up |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...findingRows,
    ""
  ].join("\n"), "utf8");
}

function writeConflictMarker(rootDir: string): void {
  const filePath = path.join(rootDir, "harness/standards/repo.md");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n", "utf8");
}

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true, env: Readonly<Record<string, string>> = {}): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function runText(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): string {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return stdout;
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stderr?: string };
    return failure.stderr ?? "";
  }
}
