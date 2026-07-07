import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "../../../../application/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../../../kernel/src/index.ts";
import { explainStatusTransition, isTerminalStatus, parseEntityRef, queryTaskProjection, queryTaskSubtree, resolveHarnessLayout, taskDocumentPath, validateRelationGraphRecords } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { writeDistillCandidate } from "./distill.ts";
import { runTaskAmend } from "./task-amend.ts";
import { lifecycleReason } from "./task-lifecycle-shared.ts";
import { runTaskRelate } from "./task-relations.ts";
import { runTaskSupersede } from "./task-supersede.ts";

export const FORCE_STATUS_AUDIT_MARKER = "FORCE_STATUS_SET_AUDIT";

type TaskLifecycleAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "status-set" | "progress-append" | "task-amend" | "task-archive" | "task-supersede" | "task-delete" | "task-reopen" | "task-relate" }
>;

export const runTaskLifecycleCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskLifecycleAction;
  switch (action.kind) {
    case "status-set":
      return runStatusSet(context, action.taskId, action.status, action.force, action.reason);
    case "progress-append":
      return runProgressAppend(context, action);
    case "task-amend":
      return runTaskAmend(context, action);
    case "task-archive":
      return runTaskArchive(context, action);
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
    case "task-relate":
      return runTaskRelate(context, action);
  }
};

function runTaskArchive(
  context: CommandRunnerContext,
  action: Extract<TaskLifecycleAction, { readonly kind: "task-archive" }>
): Effect.Effect<CliResult, EngineError | WriteError> {
  const taskIds = resolveArchiveTaskIds(context, action);
  if (!taskIds.ok) return Effect.succeed(taskIds.result);

  return Effect.gen(function* () {
    const archived: Array<{ readonly taskId: string; readonly status: DomainStatus; readonly candidatePath?: string }> = [];
    for (const taskId of taskIds.value) {
      const referenceGuard = archiveReferenceGuard(context, taskId);
      if (!referenceGuard.ok) return referenceGuard.result;
      const candidatePath = yield* ensureArchiveDistillCandidate(context, taskId);
      const result = yield* context.engine.archiveTask({
        taskId,
        reason: lifecycleReason(action.reason, { archivedBy: action.archivedBy, archiveField: action.archiveField })
      });
      archived.push({ taskId: result.taskId, status: result.status, ...(candidatePath ? { candidatePath } : {}) });
    }

    if (archived.length === 1) {
      const [single] = archived;
      return {
        ok: true,
        command: "task-archive",
        taskId: single?.taskId,
        status: single?.status,
        report: {
          schema: "task-archive-report/v1",
          archivedBy: action.archivedBy,
          archiveField: action.archiveField,
          archivedCount: archived.length,
          ...(single?.candidatePath ? { candidatePath: single.candidatePath } : {})
        }
      } satisfies CliResult;
    }

    return {
      ok: true,
      command: "task-archive",
      rows: archived.length,
      tasks: archived,
      report: {
        schema: "task-archive-report/v1",
        archivedBy: action.archivedBy,
        archiveField: action.archiveField,
        archivedCount: archived.length,
        candidateCount: archived.filter((entry) => entry.candidatePath).length
      }
    } satisfies CliResult;
  });
}

function resolveArchiveTaskIds(
  context: CommandRunnerContext,
  action: Extract<TaskLifecycleAction, { readonly kind: "task-archive" }>
): { readonly ok: true; readonly value: ReadonlyArray<string> } | { readonly ok: false; readonly result: CliResult } {
  if (action.taskId) return { ok: true, value: [action.taskId] };
  if (action.ids && action.ids.length > 0) return { ok: true, value: unique(action.ids) };

  const state = action.filter?.startsWith("state:") ? action.filter.slice("state:".length) : undefined;
  const beforeTime = action.before ? Date.parse(action.before) : undefined;
  const projection = queryTaskProjection({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    filters: {
      ...(state ? { state } : {}),
      includeArchived: false
    }
  });
  const rows = projection.rows.filter((row) => beforeTime === undefined || Date.parse(row.updatedAt) < beforeTime);
  const taskIds = rows.map((row) => row.taskId).sort();
  if (taskIds.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "task-archive",
        error: cliError(CliErrorCode.TaskNotFound, "No active tasks matched the archive selector.")
      } satisfies CliResult
    };
  }
  return { ok: true, value: taskIds };
}

function archiveReferenceGuard(
  context: CommandRunnerContext,
  taskId: string
): { readonly ok: true } | { readonly ok: false; readonly result: CliResult } {
  const unresolved = validateRelationGraphRecords(context.layoutInput)
    .filter(({ issue }) => issue.code === "relation_endpoint_unknown")
    .filter(({ entry }) => endpointOwnedByTask(entry.record.source, taskId) || endpointOwnedByTask(entry.record.target, taskId));
  if (unresolved.length === 0) return { ok: true };
  return {
    ok: false,
    result: {
      ok: false,
      command: "task-archive",
      taskId,
      error: cliError(
        CliErrorCode.ArchiveReferenceUnresolved,
        `Archive refused because ${taskId} has unresolved relation endpoint(s): ${unresolved.map(({ entry }) => entry.record.relation_id).join(", ")}. Restore the referenced task, decision anchor, or fact before archiving.`
      )
    } satisfies CliResult
  };
}

function endpointOwnedByTask(refText: string, taskId: string): boolean {
  const ref = parseEntityRef(refText);
  if (!ref || ref.externalHarness) return false;
  if (ref.kind === "task") return ref.id === taskId;
  if (ref.kind === "fact") return ref.ownerTaskId === taskId;
  return false;
}

function ensureArchiveDistillCandidate(
  context: CommandRunnerContext,
  taskId: string
): Effect.Effect<string | undefined, WriteError> {
  const inputPath = archiveDistillInputPath(context, taskId);
  if (!inputPath || hasDistillCandidate(context, taskId)) return Effect.succeed(undefined);
  return writeDistillCandidate(context, { taskId, inputPath }, "ha task archive").pipe(
    Effect.map((result) => result.ok ? result.path : undefined)
  );
}

function archiveDistillInputPath(context: CommandRunnerContext, taskId: string): string | undefined {
  for (const documentPath of ["closeout.md", "facts.md"]) {
    const absolutePath = taskDocumentPath(context.layoutInput, taskId, documentPath);
    if (!existsSync(absolutePath)) continue;
    const body = readFileSync(absolutePath, "utf8");
    if (hasSubstantiveDistillContent(body)) return taskRelativePath(context, absolutePath);
  }
  return undefined;
}

function hasDistillCandidate(context: CommandRunnerContext, taskId: string): boolean {
  const layout = resolveHarnessLayout(context.layoutInput);
  const candidateDir = path.join(layout.generatedRoot, "distill", taskId);
  if (!existsSync(candidateDir)) return false;
  return readdirSync(candidateDir).some((entry) => /^distill_[^/]+\.json$/u.test(entry));
}

function hasSubstantiveDistillContent(body: string): boolean {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !/^[-*]\s*TODO\b/iu.test(line))
    .some((line) => !/placeholder|replace this|todo: record a fact/iu.test(line));
}

function taskRelativePath(context: CommandRunnerContext, absolutePath: string): string {
  return path.relative(context.rootDir, absolutePath).split(path.sep).join("/");
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

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
    return Effect.gen(function* () {
      const result = yield* context.engine.setStatus({ taskId, status });
      if (status === "in_review") {
        yield* context.engine.stageTaskTree({ taskId });
      }
      return {
        ok: true,
        command: "status-set",
        taskId: result.taskId,
        status: result.status
      } satisfies CliResult;
    });
  }

  return Effect.gen(function* () {
    const taskPolicy = yield* readTaskLifecyclePolicy(context.artifactStore, taskId);
    if (taskPolicy?.engine !== "local") {
      const result = yield* context.engine.setStatus({ taskId, status });
      return {
        ok: true,
        command: "status-set",
        taskId: result.taskId,
        status: result.status
      } satisfies CliResult;
    }
    if (!force) {
      return {
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
      } satisfies CliResult;
    }
    if (taskPolicy.status && !explainStatusTransition(taskPolicy.status, status).allowed) {
      return {
        ok: false,
        command: "status-set",
        taskId,
        status,
        error: cliError(CliErrorCode.InvalidTransition, `invalid transition: ${taskPolicy.status} -> ${status}`)
      } satisfies CliResult;
    }

    const auditText = renderForceStatusAudit(status, reason ?? "unspecified");
    const audit = yield* context.engine.appendProgress({ taskId, text: auditText });
    const result = yield* context.engine.setStatus({ taskId, status });
    return {
      ok: true,
      command: "status-set",
      taskId: result.taskId,
      status: result.status,
      path: audit.path,
      forced: true,
      forceAudit: { path: audit.path, marker: FORCE_STATUS_AUDIT_MARKER },
      warnings: taskTreeSoftGateWarnings(context, taskId)
    } satisfies CliResult;
  });
}

export function taskTreeSoftGateWarnings(
  context: Pick<CommandRunnerContext, "rootDir" | "layoutOverrides">,
  taskId: string
): ReadonlyArray<{ readonly severity: "warning"; readonly code: "open_child_tasks"; readonly message: string; readonly taskIds: ReadonlyArray<string> }> | undefined {
  const children = queryTaskSubtree({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides, rootTaskId: taskId }).rows
    .filter((row) => row.taskId !== taskId)
    .filter((row) => row.coordinationStatus !== "terminal")
    .map((row) => row.taskId)
    .sort();
  if (children.length === 0) return undefined;
  return [{
    severity: "warning",
    code: "open_child_tasks",
    message: `WARNING: closing ${taskId} with open child tasks: ${children.join(", ")}`,
    taskIds: children
  }];
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
    report: action.deletedBy ? { schema: "task-delete-report/v1", deletedBy: action.deletedBy } : undefined
  })));
}

function renderForceStatusAudit(status: string, reason: string): string {
  return `${FORCE_STATUS_AUDIT_MARKER}: forced terminal status=${status}; reason=${reason}; recordedAt=${new Date().toISOString()}`;
}
