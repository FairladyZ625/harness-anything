import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../../adapters/local/src/index.ts";
import { evaluateCompletionGate, evaluateReviewGate, parseReviewMarkdown } from "../../../application/src/index.ts";
import type { ArtifactStoreError, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import { createTaskPackagePath, generateTaskId, resolveHarnessLayout, taskDocumentPath } from "../../../kernel/src/layout/index.ts";
import { checkTaskProjection, readTaskProjection } from "../../../kernel/src/index.ts";
import { commandRegistry } from "../cli/command-registry.ts";
import { runCheckProfile } from "./check.ts";
import { runGovernanceRebuild } from "./governance.ts";
import { runLessonPromote, runLessonSediment } from "./lesson.ts";
import { runAdoptMultica, runSnapshotMultica } from "./adopt.ts";
import { runGitDiffEvidence } from "./git-diff.ts";
import { runMigratePlan, runMigrateRun, runMigrateStructure, runMigrateVerify } from "./migration.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

export function runCommand(
  engine: ReturnType<typeof makeLocalLifecycleEngine>,
  command: ParsedCommand
): Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError> {
  if (command.action.kind === "init") {
    return Effect.sync(() => initializeHarness(command.rootDir));
  }

  if (command.action.kind === "new-task") {
    const action = command.action;
    const taskId = action.taskId ?? generateTaskId();
    return engine.createTask({
      taskId,
      title: action.title,
      slug: action.slug,
      allowManualId: action.allowManualId
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "new-task",
      taskId: result.taskId,
      slug: action.slug,
      status: result.status,
      packagePath: path.relative(command.rootDir, createTaskPackagePath(command.rootDir, result.taskId, action.slug)).split(path.sep).join("/")
    })));
  }

  if (command.action.kind === "status-set") {
    return engine.setStatus({
      taskId: command.action.taskId,
      status: command.action.status
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status
    })));
  }

  if (command.action.kind === "progress-append") {
    return engine.appendProgress({
      taskId: command.action.taskId,
      text: command.action.text
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "progress-append",
      taskId: result.taskId,
      path: result.path
    })));
  }

  if (command.action.kind === "task-archive") {
    return engine.archiveTask({
      taskId: command.action.taskId,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-archive",
      taskId: result.taskId,
      status: result.status,
      path: "INDEX.md"
    })));
  }

  if (command.action.kind === "task-supersede") {
    const action = command.action;
    const newTaskId = generateTaskId();
    return engine.supersedeTask({
      oldTaskId: action.oldTaskId,
      newTaskId,
      title: action.title,
      slug: action.slug,
      reason: action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-supersede",
      taskId: result.oldTaskId,
      path: `task/${result.newTaskId}`,
      packagePath: path.relative(command.rootDir, createTaskPackagePath(command.rootDir, result.newTaskId, action.slug)).split(path.sep).join("/")
    })));
  }

  if (command.action.kind === "task-delete") {
    return engine.deleteTask({
      taskId: command.action.taskId,
      mode: command.action.mode,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-delete",
      taskId: result.taskId,
      mode: result.mode,
      path: result.mode
    })));
  }

  if (command.action.kind === "task-reopen") {
    return engine.reopenTask({
      taskId: command.action.taskId,
      reason: command.action.reason
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-reopen",
      taskId: result.taskId,
      status: result.status,
      path: "INDEX.md"
    })));
  }

  if (command.action.kind === "task-list") {
    return Effect.sync(() => {
      const result = readTaskProjection({ rootDir: command.rootDir });
      return {
        ok: true,
        command: "task-list",
        tasks: result.rows,
        warnings: result.warnings
      } satisfies CliResult;
    });
  }

  if (command.action.kind === "status") {
    return Effect.sync(() => {
      const result = checkTaskProjection({ rootDir: command.rootDir, postMerge: true });
      return {
        ok: result.ok,
        command: "status",
        rows: result.rows.length,
        warnings: result.warnings,
        report: result.report,
        summary: summarizeStatus(result.rows),
        commands: commandRegistry,
        projectionPath: path.relative(command.rootDir, result.projectionPath).split(path.sep).join("/"),
        error: result.ok ? undefined : {
          code: "status_check_failed",
          hint: "Harness status has warnings that require attention."
        }
      } satisfies CliResult;
    });
  }

  if (command.action.kind === "governance-rebuild") {
    const action = command.action;
    return Effect.sync(() => runGovernanceRebuild(command.rootDir, action.mode));
  }

  if (command.action.kind === "lesson-promote") {
    const action = command.action;
    return Effect.sync(() => runLessonPromote(command.rootDir, action.taskId, action.candidateId, action.mode));
  }

  if (command.action.kind === "lesson-sediment") {
    const action = command.action;
    return Effect.sync(() => runLessonSediment(command.rootDir, action.taskId, action.candidateId, action.title));
  }

  if (command.action.kind === "adopt-multica") {
    return runAdoptMultica(command.rootDir, command.action);
  }

  if (command.action.kind === "snapshot-multica") {
    return runSnapshotMultica(command.action);
  }

  if (command.action.kind === "migrate-plan") {
    const action = command.action;
    return Effect.sync(() => runMigratePlan(command.rootDir, action));
  }

  if (command.action.kind === "migrate-structure") {
    const action = command.action;
    return Effect.sync(() => runMigrateStructure(command.rootDir, action));
  }

  if (command.action.kind === "migrate-run") {
    const action = command.action;
    return Effect.sync(() => runMigrateRun(command.rootDir, action));
  }

  if (command.action.kind === "migrate-verify") {
    const action = command.action;
    return Effect.sync(() => runMigrateVerify(command.rootDir, action));
  }

  if (command.action.kind === "git-diff") {
    const action = command.action;
    return Effect.sync(() => runGitDiffEvidence(command.rootDir, action.baseRef));
  }

  if (command.action.kind === "task-review") {
    const action = command.action;
    return Effect.sync(() => runTaskReview(command.rootDir, action.taskId, action.reviewerId));
  }

  if (command.action.kind === "task-complete") {
    const action = command.action;
    return Effect.sync(() => runTaskComplete(command.rootDir, action.taskId, action.reviewerId, action.ciGate));
  }

  return Effect.sync(() => runCheckProfile(command.rootDir, command.action.kind === "check"
    ? command.action
    : { kind: "check", profile: "source-package", strict: false, postMerge: false }));
}

function initializeHarness(rootDir: string): CliResult {
  const layout = resolveHarnessLayout(rootDir);
  for (const directory of [
    layout.authoredRoot,
    layout.standardsRoot,
    layout.contextRoot,
    path.join(layout.contextRoot, "architecture"),
    layout.planningRoot,
    layout.tasksRoot,
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.payloadsRoot,
    layout.locksRoot
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  writeIfMissing(path.join(layout.authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "name: harness-anything",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "tasks:",
    "  root: harness/planning/tasks",
    "  idPolicy: random-ulid",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.standardsRoot, "repo-governance.md"), [
    "# Repository Governance",
    "",
    "- Authored shared state lives under `harness/`.",
    "- Generated local state lives under `.harness/` and must remain untracked.",
    "- Task identities use random `task_<ULID>` values; titles and slugs are display metadata.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "AGENTS.md"), [
    "# Harness Agent Entry",
    "",
    "Read `harness/harness.yaml` and `harness/standards/repo-governance.md` before changing task state.",
    "",
    "Generated state under `.harness/` is local-only and must not be committed.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "CLAUDE.md"), [
    "# Claude Harness Entry",
    "",
    "Follow `AGENTS.md` and the shared authored harness under `harness/`.",
    ""
  ].join("\n"));
  ensureGitignoreEntry(path.join(layout.rootDir, ".gitignore"), ".harness/");

  return {
    ok: true,
    command: "init",
    path: "harness/harness.yaml"
  };
}

function summarizeStatus(
  rows: ReadonlyArray<{ readonly packageDisposition: string; readonly coordinationStatus: string }>
): NonNullable<CliResult["summary"]> {
  return {
    taskCount: rows.length,
    byPackageDisposition: countBy(rows.map((row) => row.packageDisposition)),
    byCoordinationStatus: countBy(rows.map((row) => row.coordinationStatus))
  };
}

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function runTaskReview(rootDir: string, taskId: string, reviewerId: string): CliResult {
  const reviewPath = taskDocumentPath(rootDir, taskId, "review.md");
  if (!existsSync(reviewPath)) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      error: {
        code: "review_document_missing",
        hint: "Task review requires review.md in the task package."
      }
    };
  }

  const parsed = parseReviewMarkdown(readFileSync(reviewPath, "utf8"));
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      issues: parsed.issues,
      error: {
        code: "review_schema_invalid",
        hint: "review.md material findings table failed validation."
      }
    };
  }

  const gate = evaluateReviewGate({
    taskId,
    reviewerId,
    submittedAt: new Date().toISOString(),
    findings: parsed.findings
  });
  if (!gate.ok) {
    return {
      ok: false,
      command: "task-review",
      taskId,
      report: gate,
      issues: gate.issues,
      error: {
        code: "release_blocking_findings",
        hint: "Open release-blocking findings must be closed before review passes."
      }
    };
  }

  return {
    ok: true,
    command: "task-review",
    taskId,
    report: gate,
    reviewContract: gate.contract
  };
}

function runTaskComplete(rootDir: string, taskId: string, reviewerId: string, ciGate: "passed" | "failed"): CliResult {
  const review = runTaskReview(rootDir, taskId, reviewerId);
  if (!review.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      report: review.report,
      issues: review.issues,
      error: {
        code: "review_not_passed",
        hint: "Task completion requires a passed task-review gate."
      }
    };
  }

  const projection = readTaskProjection({ rootDir });
  const row = projection.rows.find((item) => item.taskId === taskId);
  if (!row) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      error: {
        code: "task_not_found",
        hint: `task not found: ${taskId}`
      }
    };
  }

  const completionGate = evaluateCompletionGate({
    taskId,
    coordinationStatus: row.coordinationStatus,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    reviewGate: "passed",
    ciGate
  });
  if (!completionGate.ok) {
    return {
      ok: false,
      command: "task-complete",
      taskId,
      completionGate,
      issues: completionGate.issues,
      error: {
        code: completionGate.issues[0]?.code ?? "completion_gate_failed",
        hint: "Task completion gate failed."
      }
    };
  }

  return {
    ok: true,
    command: "task-complete",
    taskId,
    completionGate,
    reviewContract: review.reviewContract
  };
}

function writeIfMissing(filePath: string, body: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function ensureGitignoreEntry(filePath: string, entry: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing.split(/\r?\n/u).map((line) => line.trim());
  if (lines.includes(entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${prefix}${entry}\n`, "utf8");
}
