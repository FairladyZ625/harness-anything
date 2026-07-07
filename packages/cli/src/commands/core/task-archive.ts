import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { readTaskLifecyclePolicy } from "../../../../application/src/index.ts";
import type { DomainStatus, EngineError, WriteError } from "../../../../kernel/src/index.ts";
import { parseEntityRef, queryTaskProjection, resolveHarnessLayout, taskDocumentPath, validateRelationGraphRecords } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { writeDistillCandidate } from "./distill.ts";
import { lifecycleReason } from "./task-lifecycle-shared.ts";

type TaskArchiveAction = {
  readonly kind: "task-archive";
  readonly taskId?: string;
  readonly ids?: ReadonlyArray<string>;
  readonly filter?: string;
  readonly before?: string;
  readonly reason: string;
  readonly archivedBy?: string;
  readonly archiveField?: string;
};

export function runTaskArchive(
  context: CommandRunnerContext,
  action: TaskArchiveAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  const taskIds = resolveArchiveTaskIds(context, action);
  if (!taskIds.ok) return Effect.succeed(taskIds.result);

  return Effect.gen(function* () {
    const preflightFailure = yield* preflightArchiveBatch(context, taskIds.value);
    if (preflightFailure) return preflightFailure;
    const archived: Array<{ readonly taskId: string; readonly status: DomainStatus; readonly candidatePath?: string }> = [];
    for (const taskId of taskIds.value) {
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

function preflightArchiveBatch(
  context: CommandRunnerContext,
  taskIds: ReadonlyArray<string>
): Effect.Effect<CliResult | null> {
  return Effect.gen(function* () {
    for (const taskId of taskIds) {
      const referenceGuard = archiveReferenceGuard(context, taskId);
      if (!referenceGuard.ok) return referenceGuard.result;
      const taskPolicy = yield* readTaskLifecyclePolicy(context.artifactStore, taskId);
      if (!taskPolicy) {
        return {
          ok: false,
          command: "task-archive",
          taskId,
          error: cliError(CliErrorCode.TaskNotFound, `task not found: ${taskId}`)
        } satisfies CliResult;
      }
    }
    return null;
  });
}

function resolveArchiveTaskIds(
  context: CommandRunnerContext,
  action: TaskArchiveAction
): { readonly ok: true; readonly value: ReadonlyArray<string> } | { readonly ok: false; readonly result: CliResult } {
  if (action.taskId) return { ok: true, value: [action.taskId] };
  if (action.ids && action.ids.length > 0) return { ok: true, value: [...new Set(action.ids)] };

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
