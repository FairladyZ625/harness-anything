import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../../adapters/local/src/index.ts";
import { evaluateCompletionGate, evaluateReviewGate, parseReviewMarkdown } from "../../../application/src/index.ts";
import type { ArtifactStoreError, DomainStatus, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import { isDomainStatus, isTerminalStatus } from "../../../kernel/src/domain/index.ts";
import { createTaskPackagePath, generateTaskId, readFrontmatter, readScalar, taskDocumentPath } from "../../../kernel/src/layout/index.ts";
import { checkTaskProjection, readTaskProjection } from "../../../kernel/src/index.ts";
import { commandRegistry } from "../cli/command-registry.ts";
import { runCheckProfile } from "./check.ts";
import { runGovernanceRebuild } from "./governance.ts";
import { runLessonPromote, runLessonSediment } from "./lesson.ts";
import { runAdoptMultica, runSnapshotMultica } from "./adopt.ts";
import { runDoctor } from "./doctor.ts";
import { runGitDiffEvidence } from "./git-diff.ts";
import { initializeHarness } from "./init.ts";
import { runNewTaskFromLegacy } from "./legacy-rebuild.ts";
import { runNewTaskWithPreset, shouldUsePresetAwareNewTask } from "./preset-task.ts";
import { readProjectHarnessSettings, shouldUseSettingsPresetAwareNewTask } from "./settings.ts";
import { runLegacyCopySafeDocs, runLegacyIndex, runLegacyIntakePlan, runLegacyScan, runLegacyVerify, runMigratePlan, runMigrateRun, runMigrateStructure, runMigrateVerify } from "./migration.ts";
import { filterTaskProjectionRows } from "./task-list-filter.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

export const FORCE_STATUS_AUDIT_MARKER = "FORCE_STATUS_SET_AUDIT";

export function runCommand(
  engine: ReturnType<typeof makeLocalLifecycleEngine>,
  command: ParsedCommand
): Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError> {
  if (command.action.kind === "init") {
    const action = command.action;
    return Effect.sync(() => initializeHarness(command.rootDir, action.addNpmScripts));
  }

  if (command.action.kind === "new-task") {
    const action = command.action;
    if (action.fromLegacyId) {
      return runNewTaskFromLegacy(command.rootDir, action);
    }
    const settingsResult = readProjectHarnessSettings(command.rootDir, "new-task");
    if (!settingsResult.ok) return Effect.succeed(settingsResult.result);
    if (shouldUsePresetAwareNewTask(action) || shouldUseSettingsPresetAwareNewTask(settingsResult.settings)) {
      return runNewTaskWithPreset(command.rootDir, action, settingsResult.settings);
    }
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
    const action = command.action;
    return runStatusSet(engine, command.rootDir, action.taskId, action.status, action.force, action.reason);
  }

  if (command.action.kind === "progress-append") {
    const action = command.action;
    const text = action.evidence
      ? `${action.text}\n\nEvidence: ${action.evidence.type}:${action.evidence.path}:${action.evidence.summary}`
      : action.text;
    return engine.appendProgress({
      taskId: action.taskId,
      text
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "progress-append",
      taskId: result.taskId,
      path: result.path,
      report: action.evidence ? { schema: "progress-evidence/v1", evidence: action.evidence } : undefined
    })));
  }

  if (command.action.kind === "task-archive") {
    const action = command.action;
    return engine.archiveTask({
      taskId: action.taskId,
      reason: lifecycleReason(action.reason, {
        archivedBy: action.archivedBy,
        archiveField: action.archiveField
      })
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-archive",
      taskId: result.taskId,
      status: result.status,
      path: "INDEX.md",
      report: {
        schema: "task-archive-report/v1",
        archivedBy: action.archivedBy,
        archiveField: action.archiveField
      }
    })));
  }

  if (command.action.kind === "task-supersede") {
    const action = command.action;
    if (action.confirm && action.confirm !== action.oldTaskId) {
      return Effect.succeed({
        ok: false,
        command: "task-supersede",
        taskId: action.oldTaskId,
        error: { code: "supersede_confirm_mismatch", hint: "The --confirm value must match the superseded task id." }
      } satisfies CliResult);
    }
    if (action.byTaskId) {
      if (!action.confirm) {
        return Effect.succeed({
          ok: false,
          command: "task-supersede",
          taskId: action.oldTaskId,
          error: { code: "supersede_confirm_required", hint: "Use --confirm <old-task-id> when superseding by an existing task." }
        } satisfies CliResult);
      }
      if (!existsSync(taskDocumentPath(command.rootDir, action.byTaskId, "INDEX.md"))) {
        return Effect.succeed({
          ok: false,
          command: "task-supersede",
          taskId: action.oldTaskId,
          error: { code: "supersede_target_not_found", hint: "The --by task id must resolve to an existing task package." }
        } satisfies CliResult);
      }
      return engine.archiveTask({
        taskId: action.oldTaskId,
        reason: lifecycleReason(action.reason, {
          supersededBy: action.byTaskId,
          deletedBy: action.deletedBy,
          allowOpenFindings: action.allowOpenFindings ? "true" : undefined
        })
      }).pipe(Effect.map((result): CliResult => ({
        ok: true,
        command: "task-supersede",
        taskId: result.taskId,
        path: "INDEX.md",
        report: {
          schema: "task-supersede-existing-report/v1",
          supersededBy: action.byTaskId,
          allowOpenFindings: action.allowOpenFindings,
          deletedBy: action.deletedBy,
          relationSemantics: "not-created"
        }
      })));
    }
    const newTaskId = generateTaskId();
    return engine.supersedeTask({
      oldTaskId: action.oldTaskId,
      newTaskId,
      title: action.title ?? "Replacement Task",
      slug: action.slug ?? "replacement-task",
      reason: lifecycleReason(action.reason, {
        deletedBy: action.deletedBy,
        allowOpenFindings: action.allowOpenFindings ? "true" : undefined
      })
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-supersede",
      taskId: result.oldTaskId,
      path: `task/${result.newTaskId}`,
      packagePath: path.relative(command.rootDir, createTaskPackagePath(command.rootDir, result.newTaskId, action.slug ?? "replacement-task")).split(path.sep).join("/")
    })));
  }

  if (command.action.kind === "task-delete") {
    const action = command.action;
    if (action.confirm && action.confirm !== action.taskId) {
      return Effect.succeed({
        ok: false,
        command: "task-delete",
        taskId: action.taskId,
        mode: action.mode,
        error: { code: "delete_confirm_mismatch", hint: "The --confirm value must match the deleted task id." }
      } satisfies CliResult);
    }
    if (action.mode === "hard" && !action.confirm) {
      return Effect.succeed({
        ok: false,
        command: "task-delete",
        taskId: action.taskId,
        mode: action.mode,
        error: { code: "delete_confirm_required", hint: "Use --confirm <task-id> for hard delete." }
      } satisfies CliResult);
    }
    return engine.deleteTask({
      taskId: action.taskId,
      mode: action.mode,
      reason: lifecycleReason(action.reason, { deletedBy: action.deletedBy })
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-delete",
      taskId: result.taskId,
      mode: result.mode,
      path: result.mode,
      report: action.deletedBy ? { schema: "task-delete-report/v1", deletedBy: action.deletedBy } : undefined
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
    const filters = command.action.filters;
    return Effect.sync(() => {
      const result = readTaskProjection({ rootDir: command.rootDir });
      return {
        ok: true,
        command: "task-list",
        tasks: filterTaskProjectionRows(result.rows, filters),
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
  if (command.action.kind === "legacy-scan") {
    const action = command.action;
    return Effect.sync(() => runLegacyScan(command.rootDir, action));
  }
  if (command.action.kind === "legacy-intake-plan") {
    const action = command.action;
    return Effect.sync(() => runLegacyIntakePlan(command.rootDir, action));
  }
  if (command.action.kind === "legacy-copy-safe-docs") {
    const action = command.action;
    return Effect.sync(() => runLegacyCopySafeDocs(command.rootDir, action));
  }
  if (command.action.kind === "legacy-index") {
    const action = command.action;
    return Effect.sync(() => runLegacyIndex(command.rootDir, action));
  }
  if (command.action.kind === "legacy-verify") {
    const action = command.action;
    return Effect.sync(() => runLegacyVerify(command.rootDir, action));
  }

  if (command.action.kind === "git-diff") {
    const action = command.action;
    return Effect.sync(() => runGitDiffEvidence(command.rootDir, action.baseRef));
  }

  if (command.action.kind === "doctor") {
    return Effect.sync(() => runDoctor(command.rootDir));
  }

  if (command.action.kind === "task-review") {
    const action = command.action;
    return Effect.sync(() => runTaskReview(command.rootDir, action.taskId, action.reviewerId));
  }

  if (command.action.kind === "task-complete") {
    const action = command.action;
    return Effect.gen(function* () {
      const gate = runTaskComplete(command.rootDir, action.taskId, action.reviewerId, action.ciGate);
      if (!gate.ok) return gate;
      const result = yield* engine.setStatus({ taskId: action.taskId, status: "done" });
      return {
        ...gate,
        status: result.status
      } satisfies CliResult;
    });
  }

  return Effect.sync(() => runCheckProfile(command.rootDir, command.action.kind === "check"
    ? command.action
    : { kind: "check", profile: "source-package", strict: false, postMerge: false }));
}

function runStatusSet(
  engine: ReturnType<typeof makeLocalLifecycleEngine>,
  rootDir: string,
  taskId: string,
  status: DomainStatus,
  force: boolean,
  reason?: string
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (!isTerminalStatus(status)) {
    return engine.setStatus({ taskId, status }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status
    })));
  }

  const taskPolicy = readTaskStatusPolicy(rootDir, taskId);
  if (taskPolicy?.engine === "local") {
    if (!force) {
      return Effect.sync(() => ({
        ok: false,
        command: "status-set",
        taskId,
        status,
        error: {
          code: "terminal_status_requires_task_complete",
          hint: status === "done"
            ? "Use task-complete after review, CI, and closeout gates pass. Use --force --reason only for recovery."
            : "Terminal cancellation must be audited. Use --force --reason only for recovery."
        }
      } satisfies CliResult));
    }

    if (taskPolicy.status && !canStructurallyTransition(taskPolicy.status, status)) {
      return Effect.sync(() => ({
        ok: false,
        command: "status-set",
        taskId,
        status,
        error: {
          code: "invalid_transition",
          hint: `invalid transition: ${taskPolicy.status} -> ${status}`
        }
      } satisfies CliResult));
    }

    const auditText = renderForceStatusAudit(status, reason ?? "unspecified");
    return Effect.gen(function* () {
      const audit = yield* engine.appendProgress({ taskId, text: auditText });
      const result = yield* engine.setStatus({ taskId, status });
      return {
        ok: true,
        command: "status-set",
        taskId: result.taskId,
        status: result.status,
        path: audit.path,
        forced: true,
        forceAudit: {
          path: audit.path,
          marker: FORCE_STATUS_AUDIT_MARKER
        }
      } satisfies CliResult;
    });
  }

  return engine.setStatus({ taskId, status }).pipe(Effect.map((result): CliResult => ({
    ok: true,
    command: "status-set",
    taskId: result.taskId,
    status: result.status
  })));
}

function readTaskStatusPolicy(rootDir: string, taskId: string): { readonly engine: string; readonly status: DomainStatus | null } | null {
  const indexPath = taskDocumentPath(rootDir, taskId, "INDEX.md");
  if (!existsSync(indexPath)) return null;
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) return null;
  const status = readScalar(frontmatter, "  status");
  return {
    engine: readScalar(frontmatter, "  engine") || "",
    status: isDomainStatus(status) ? status : null
  };
}

function renderForceStatusAudit(status: string, reason: string): string {
  return `${FORCE_STATUS_AUDIT_MARKER}: forced terminal status=${status}; reason=${reason}; recordedAt=${new Date().toISOString()}`;
}

function lifecycleReason(reason: string, fields: Readonly<Record<string, string | undefined>>): string {
  const suffix = Object.entries(fields)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  return suffix ? `${reason}\n\nMetadata: ${suffix}` : reason;
}

function canStructurallyTransition(from: DomainStatus, to: DomainStatus): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  if (from === "planned") return to === "active" || to === "blocked" || to === "cancelled";
  if (from === "active") return to === "blocked" || to === "in_review" || to === "done" || to === "cancelled";
  if (from === "blocked") return to === "active" || to === "cancelled";
  if (from === "in_review") return to === "active" || to === "blocked" || to === "done" || to === "cancelled";
  return false;
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
