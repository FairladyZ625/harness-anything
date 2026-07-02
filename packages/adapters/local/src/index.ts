import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import { explainStatusTransition, isTerminalStatus } from "../../../kernel/src/domain/index.ts";
import { stablePayloadHash } from "../../../kernel/src/integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext, harnessRuntimeRoot } from "../../../kernel/src/layout/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import { makeJournaledWriteCoordinator } from "../../../kernel/src/store/index.ts";
import { resolveTaskCreatedBy } from "./created-by.ts";
import { hasTaskRelations, renderSupersedesRelation } from "./task-relations.ts";
import { indexPath, makeIndex, readIndexEffect, renderIndex, validateGeneratedTaskId, validateTaskId } from "./task-index.ts";
import { appendProgressDelta, deleteTaskPackage, writeSupersedeTaskDocuments, writeTaskDocument } from "./task-writes.ts";
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
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const coordinator = options.coordinator ?? makeJournaledWriteCoordinator({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    actor: { kind: "agent", id: "local-lifecycle" }
  });
  const clock = options.clock ?? (() => new Date());

  return {
    createTask: (input) => createTask(runtimeContext, coordinator, clock, input),
    setStatus: (input) => setStatus(runtimeContext, coordinator, input),
    appendProgress: (input) => appendProgress(runtimeContext, coordinator, input),
    archiveTask: (input) => archiveTask(runtimeContext, coordinator, input),
    supersedeTask: (input) => supersedeTask(runtimeContext, coordinator, clock, input),
    deleteTask: (input) => deleteTask(runtimeContext, coordinator, input),
    reopenTask: (input) => reopenTask(runtimeContext, coordinator, input)
  };
}

function createTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  clock: () => Date,
  input: CreateLocalTaskInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const rootDir = harnessRuntimeRoot(rootInput);
    if (!input.allowManualId) {
      const error = validateGeneratedTaskId(input.taskId);
      if (error) return yield* Effect.fail(error);
    } else {
      validateTaskId(input.taskId);
    }
    if (existsSync(indexPath(rootInput, input.taskId))) {
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
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: SetLocalStatusInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootInput, input.taskId);
    if (index.engine !== "local") {
      return yield* Effect.fail({
        _tag: "EngineOwnsStatus",
        engine: index.engine,
        ref: index.ref ?? input.taskId
      } satisfies EngineError);
    }
    if (!explainStatusTransition(index.status, input.status).allowed) {
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
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: AppendProgressInput
): Effect.Effect<LocalProgressResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootInput, input.taskId);
    // ADR-0016 D2: journal only stores the append delta. flush/replay reads the
    // on-disk progress.md at apply time and appends, so crash recovery no longer
    // rolls back hand-edits with a stale full-file snapshot.
    yield* appendProgressDelta(coordinator, stablePayloadHash, input.taskId, input.text);
    return { taskId: input.taskId, path: "progress.md" } satisfies LocalProgressResult;
  });
}

function archiveTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: TaskReasonInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootInput, input.taskId);
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, packageDisposition: "archived" }, input.reason), { kind: "package_archive" });
    return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "archived" } satisfies LocalTaskResult;
  });
}

function supersedeTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  clock: () => Date,
  input: SupersedeTaskInput
): Effect.Effect<LocalSupersedeResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const rootDir = harnessRuntimeRoot(rootInput);
    const error = validateGeneratedTaskId(input.newTaskId);
    if (error) return yield* Effect.fail(error);
    if (existsSync(indexPath(rootInput, input.newTaskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId: input.newTaskId } satisfies EngineError);
    }
    const oldIndex = yield* readIndexEffect(rootInput, input.oldTaskId);
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
    yield* writeSupersedeTaskDocuments(coordinator, stablePayloadHash, input.oldTaskId, [
      { taskId: input.oldTaskId, path: "INDEX.md", body: renderIndex({ ...oldIndex, packageDisposition: "archived" }, input.reason) },
      { taskId: input.newTaskId, path: "INDEX.md", body: renderIndex(newIndex), packageSlug: input.slug },
      { taskId: input.newTaskId, path: "relations.md", body: renderSupersedesRelation(input.newTaskId, input.oldTaskId, input.reason), packageSlug: input.slug }
    ]);
    return { oldTaskId: input.oldTaskId, newTaskId: input.newTaskId, packageDisposition: "archived" } satisfies LocalSupersedeResult;
  });
}

function deleteTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: DeleteTaskInput
): Effect.Effect<LocalDeleteResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootInput, input.taskId);
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
    if (hasTaskRelations(rootInput, input.taskId)) {
      return yield* Effect.fail({ _tag: "RelatedTaskHardDeleteForbidden", taskId: input.taskId } satisfies EngineError);
    }
    yield* deleteTaskPackage(coordinator, stablePayloadHash, input.taskId, input.reason);
    return { taskId: input.taskId, mode: "hard" } satisfies LocalDeleteResult;
  });
}

function reopenTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: TaskReasonInput
): Effect.Effect<LocalTaskResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const index = yield* readIndexEffect(rootInput, input.taskId);
    if (isTerminalStatus(index.status)) {
      return yield* Effect.fail({ _tag: "TerminalReopenRequiresSupersede", taskId: input.taskId, status: index.status } satisfies EngineError);
    }
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex({ ...index, packageDisposition: "active" }, input.reason), { kind: "package_reopen" });
    return { taskId: input.taskId, status: index.status, engine: "local", packageDisposition: "active" } satisfies LocalTaskResult;
  });
}
