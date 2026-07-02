import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import type { DomainStatus, EngineError, WriteError } from "../../../../kernel/src/domain/index.ts";
import { explainStatusTransition, isDomainStatus, isTerminalStatus } from "../../../../kernel/src/domain/index.ts";
import { readFrontmatter, readScalar, taskDocumentPath } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { lifecycleReason } from "./task-lifecycle-shared.ts";
import { runTaskSupersede } from "./task-supersede.ts";

export const FORCE_STATUS_AUDIT_MARKER = "FORCE_STATUS_SET_AUDIT";

type TaskLifecycleAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "status-set" | "progress-append" | "task-archive" | "task-supersede" | "task-delete" | "task-reopen" }
>;

export const runTaskLifecycleCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskLifecycleAction;
  switch (action.kind) {
    case "status-set":
      return runStatusSet(context, action.taskId, action.status, action.force, action.reason);
    case "progress-append":
      return runProgressAppend(context, action);
    case "task-archive":
      return context.engine.archiveTask({
        taskId: action.taskId,
        reason: lifecycleReason(action.reason, { archivedBy: action.archivedBy, archiveField: action.archiveField })
      }).pipe(Effect.map((result): CliResult => ({
        ok: true,
        command: "task-archive",
        taskId: result.taskId,
        status: result.status,
        path: "INDEX.md",
        report: { schema: "task-archive-report/v1", archivedBy: action.archivedBy, archiveField: action.archiveField }
      })));
    case "task-supersede":
      return runTaskSupersede(context, action);
    case "task-delete":
      return runTaskDelete(context, action);
    case "task-reopen":
      return context.engine.reopenTask({ taskId: action.taskId, reason: action.reason }).pipe(Effect.map((result): CliResult => ({
        ok: true,
        command: "task-reopen",
        taskId: result.taskId,
        status: result.status,
        path: "INDEX.md"
      })));
  }
};

function runProgressAppend(
  context: CommandRunnerContext,
  action: Extract<TaskLifecycleAction, { readonly kind: "progress-append" }>
): Effect.Effect<CliResult, EngineError | WriteError> {
  const text = action.evidence
    ? `${action.text}\n\nEvidence: ${action.evidence.type}:${action.evidence.path}:${action.evidence.summary}`
    : action.text;
  return context.engine.appendProgress({ taskId: action.taskId, text }).pipe(Effect.map((result): CliResult => ({
    ok: true,
    command: "progress-append",
    taskId: result.taskId,
    path: result.path,
    report: action.evidence ? { schema: "progress-evidence/v1", evidence: action.evidence } : undefined
  })));
}

function runStatusSet(
  context: CommandRunnerContext,
  taskId: string,
  status: DomainStatus,
  force: boolean,
  reason?: string
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (!isTerminalStatus(status)) {
    return context.engine.setStatus({ taskId, status }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status
    })));
  }

  const taskPolicy = readTaskStatusPolicy(context, taskId);
  if (taskPolicy?.engine !== "local") {
    return context.engine.setStatus({ taskId, status }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status
    })));
  }
  if (!force) {
    return Effect.sync(() => ({
      ok: false,
      command: "status-set",
      taskId,
      status,
      error: cliError(
        CliErrorCode.TerminalStatusRequiresTaskComplete,
        status === "done"
          ? "Use task-complete after review, CI, and closeout gates pass. Use --force --reason only for recovery."
          : "Terminal cancellation must be audited. Use --force --reason only for recovery."
      )
    } satisfies CliResult));
  }
  if (taskPolicy.status && !explainStatusTransition(taskPolicy.status, status).allowed) {
    return Effect.sync(() => ({
      ok: false,
      command: "status-set",
      taskId,
      status,
      error: cliError(CliErrorCode.InvalidTransition, `invalid transition: ${taskPolicy.status} -> ${status}`)
    } satisfies CliResult));
  }

  const auditText = renderForceStatusAudit(status, reason ?? "unspecified");
  return Effect.gen(function* () {
    const audit = yield* context.engine.appendProgress({ taskId, text: auditText });
    const result = yield* context.engine.setStatus({ taskId, status });
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      path: audit.path,
      forced: true,
      forceAudit: { path: audit.path, marker: FORCE_STATUS_AUDIT_MARKER }
    } satisfies CliResult;
  });
}

function runTaskDelete(
  context: CommandRunnerContext,
  action: Extract<TaskLifecycleAction, { readonly kind: "task-delete" }>
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (action.confirm && action.confirm !== action.taskId) {
    return Effect.succeed({
      ok: false,
      command: "task-delete",
      taskId: action.taskId,
      mode: action.mode,
      error: cliError(CliErrorCode.DeleteConfirmMismatch, "The --confirm value must match the deleted task id.")
    } satisfies CliResult);
  }
  if (action.mode === "hard" && !action.confirm) {
    return Effect.succeed({
      ok: false,
      command: "task-delete",
      taskId: action.taskId,
      mode: action.mode,
      error: cliError(CliErrorCode.DeleteConfirmRequired, "Use --confirm <task-id> for hard delete.")
    } satisfies CliResult);
  }
  return context.engine.deleteTask({
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

function readTaskStatusPolicy(context: CommandRunnerContext, taskId: string): { readonly engine: string; readonly status: DomainStatus | null } | null {
  const indexPath = taskDocumentPath(context.layoutInput, taskId, "INDEX.md");
  if (!existsSync(indexPath)) return null;
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) return null;
  const status = readScalar(frontmatter, "  status");
  return { engine: readScalar(frontmatter, "  engine") || "", status: isDomainStatus(status) ? status : null };
}

function renderForceStatusAudit(status: string, reason: string): string {
  return `${FORCE_STATUS_AUDIT_MARKER}: forced terminal status=${status}; reason=${reason}; recordedAt=${new Date().toISOString()}`;
}
