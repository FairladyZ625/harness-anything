import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { DomainStatus, EngineError, TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import { isTerminalStatus } from "../../../kernel/src/domain/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/store/index.ts";
import { stablePayloadHash } from "../../../kernel/src/store/hash.ts";
import { resolveTaskCreatedBy } from "./created-by.ts";
import { hasTaskRelations, renderSupersedesRelation } from "./task-relations.ts";
import { indexPath, makeIndex, readIndexEffect, renderIndex, taskDocumentPath, validateGeneratedTaskId, validateTaskId } from "./task-index.ts";
import { deleteTaskPackage, writeSupersedeTaskDocuments, writeTaskDocument } from "./task-writes.ts";
import type {
  AppendProgressInput,
  CreateLocalTaskInput,
  DeleteTaskInput,
  LocalDeleteResult,
  LocalLifecycleEngine,
  LocalLifecycleOptions,
  LocalProgressResult,
  LocalSupersedeResult,
  LocalTaskResult,
  LocalWriteCoordinatorOptions,
  SetLocalStatusInput,
  SupersedeTaskInput,
  TaskReasonInput
} from "./types.ts";

export { collectGitDiffEvidence } from "./git-diff-evidence.ts";
export type { GitDiffEvidenceFile, GitDiffEvidenceOptions, GitDiffEvidenceReport } from "./git-diff-evidence.ts";
export type {
  AppendProgressInput,
  CreateLocalTaskInput,
  DeleteMode,
  DeleteTaskInput,
  LocalDeleteResult,
  LocalLifecycleEngine,
  LocalLifecycleOptions,
  LocalProgressResult,
  LocalSupersedeResult,
  LocalTaskResult,
  LocalWriteCoordinatorOptions,
  SetLocalStatusInput,
  SupersedeTaskInput,
  TaskReasonInput
} from "./types.ts";

export function makeLocalWriteCoordinator(options: LocalWriteCoordinatorOptions): WriteCoordinator {
  return makeJournaledWriteCoordinator(options);
}

export function makeLocalLifecycleEngine(options: LocalLifecycleOptions): LocalLifecycleEngine {
  const rootDir = path.resolve(options.rootDir);
  const coordinator = options.coordinator ?? makeJournaledWriteCoordinator({ rootDir, actor: { kind: "agent", id: "local-lifecycle" } });
  const clock = options.clock ?? (() => new Date());

  return {
    createTask: (input) => createTask(rootDir, coordinator, clock, input),
    setStatus: (input) => setStatus(rootDir, coordinator, input),
    appendProgress: (input) => appendProgress(rootDir, coordinator, input),
    archiveTask: (input) => archiveTask(rootDir, coordinator, input),
    supersedeTask: (input) => supersedeTask(rootDir, coordinator, clock, input),
    deleteTask: (input) => deleteTask(rootDir, coordinator, input),
    reopenTask: (input) => reopenTask(rootDir, coordinator, input)
  };
}

function createTask(
  rootDir: string,
  coordinator: WriteCoordinator,
  clock: () => Date,
  input: CreateLocalTaskInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    if (!input.allowManualId) {
      const error = validateGeneratedTaskId(input.taskId);
      if (error) return yield* Effect.fail(error);
    } else {
      validateTaskId(input.taskId);
    }
    if (existsSync(indexPath(rootDir, input.taskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId: input.taskId } satisfies EngineError);
    }
    const index = makeIndex({
      taskId: input.taskId,
      title: input.title,
      status: "planned",
      bindingCreatedAt: clock().toISOString(),
      vertical: input.vertical ?? "default",
      preset: input.preset ?? "default",
      createdBy: resolveTaskCreatedBy(rootDir, input.createdBy)
    }, stablePayloadHash);
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex(index), {
      kind: "package_create",
      slug: input.slug
    });
    return { taskId: input.taskId, status: "planned", engine: "local" } satisfies LocalTaskResult;
  });
}

function setStatus(
  rootDir: string,
  coordinator: WriteCoordinator,
  input: SetLocalStatusInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootDir, input.taskId);
    if (index.engine !== "local") {
      return yield* Effect.fail({
        _tag: "EngineOwnsStatus",
        engine: index.engine,
        ref: index.ref ?? input.taskId
      } satisfies EngineError);
    }
    if (!canTransition(index.status, input.status)) {
      return yield* Effect.fail({
        _tag: "InvalidTransition",
        taskId: input.taskId,
        from: index.status,
        to: input.status
      } satisfies EngineError);
    }
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, status: input.status }), { kind: "transition_local" });
    return { taskId: input.taskId, status: input.status, engine: "local" } satisfies LocalTaskResult;
  });
}

function appendProgress(
  rootDir: string,
  coordinator: WriteCoordinator,
  input: AppendProgressInput
): Effect.Effect<LocalProgressResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootDir, input.taskId);
    const existingPath = taskDocumentPath(rootDir, input.taskId, "progress.md");
    const existing = existsSync(existingPath) ? readFileSync(existingPath, "utf8") : "";
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "progress.md", `${existing}${separator}${input.text}\n`, { kind: "progress_append" });
    return { taskId: input.taskId, path: "progress.md" } satisfies LocalProgressResult;
  });
}

function archiveTask(
  rootDir: string,
  coordinator: WriteCoordinator,
  input: TaskReasonInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootDir, input.taskId);
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, packageDisposition: "archived" }, input.reason), { kind: "package_archive" });
    return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "archived" } satisfies LocalTaskResult;
  });
}

function supersedeTask(
  rootDir: string,
  coordinator: WriteCoordinator,
  clock: () => Date,
  input: SupersedeTaskInput
): Effect.Effect<LocalSupersedeResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const error = validateGeneratedTaskId(input.newTaskId);
    if (error) return yield* Effect.fail(error);
    if (existsSync(indexPath(rootDir, input.newTaskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId: input.newTaskId } satisfies EngineError);
    }
    const oldIndex = yield* readIndexEffect(rootDir, input.oldTaskId);
    const newIndex = makeIndex({
      taskId: input.newTaskId,
      title: input.title,
      status: "planned",
      bindingCreatedAt: clock().toISOString(),
      vertical: oldIndex.vertical,
      preset: oldIndex.preset,
      profile: oldIndex.profile,
      createdBy: resolveTaskCreatedBy(rootDir)
    }, stablePayloadHash);
    yield* writeSupersedeTaskDocuments(coordinator, stablePayloadHash, [
      { taskId: input.oldTaskId, path: "INDEX.md", body: renderIndex({ ...oldIndex, packageDisposition: "archived" }, input.reason) },
      { taskId: input.newTaskId, path: "INDEX.md", body: renderIndex(newIndex), packageSlug: input.slug },
      { taskId: input.newTaskId, path: "relations.md", body: renderSupersedesRelation(input.newTaskId, input.oldTaskId, input.reason), packageSlug: input.slug }
    ]);
    return { oldTaskId: input.oldTaskId, newTaskId: input.newTaskId, packageDisposition: "archived" } satisfies LocalSupersedeResult;
  });
}

function deleteTask(
  rootDir: string,
  coordinator: WriteCoordinator,
  input: DeleteTaskInput
): Effect.Effect<LocalDeleteResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootDir, input.taskId);
    if (input.mode === "soft") {
      yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, packageDisposition: "tombstoned" }, input.reason), { kind: "package_tombstone" });
      return { taskId: input.taskId, mode: "soft", packageDisposition: "tombstoned" } satisfies LocalDeleteResult;
    }
    if (index.packageDisposition === "archived") {
      return yield* Effect.fail({ _tag: "ArchivedHardDeleteForbidden", taskId: input.taskId } satisfies EngineError);
    }
    if (isTerminalStatus(index.status)) {
      return yield* Effect.fail({ _tag: "TerminalHardDeleteForbidden", taskId: input.taskId, status: index.status } satisfies EngineError);
    }
    if (hasTaskRelations(rootDir, input.taskId)) {
      return yield* Effect.fail({ _tag: "RelatedTaskHardDeleteForbidden", taskId: input.taskId } satisfies EngineError);
    }
    yield* deleteTaskPackage(coordinator, stablePayloadHash, input.taskId, input.reason);
    return { taskId: input.taskId, mode: "hard" } satisfies LocalDeleteResult;
  });
}

function reopenTask(
  rootDir: string,
  coordinator: WriteCoordinator,
  input: TaskReasonInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootDir, input.taskId);
    if (isTerminalStatus(index.status)) {
      return yield* Effect.fail({ _tag: "TerminalReopenRequiresSupersede", taskId: input.taskId, status: index.status } satisfies EngineError);
    }
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, packageDisposition: "active" }, input.reason), { kind: "package_reopen" });
    return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "active" } satisfies LocalTaskResult;
  });
}

function canTransition(from: DomainStatus, to: DomainStatus): boolean {
  if (from === to) return true;
  if (isTerminalStatus(from)) return false;
  if (from === "planned") return to === "active" || to === "blocked" || to === "cancelled";
  if (from === "active") return to === "blocked" || to === "in_review" || to === "done" || to === "cancelled";
  if (from === "blocked") return to === "active" || to === "cancelled";
  if (from === "in_review") return to === "active" || to === "blocked" || to === "done" || to === "cancelled";
  return false;
}
