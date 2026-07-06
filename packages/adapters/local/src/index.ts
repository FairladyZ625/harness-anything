import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../../kernel/src/index.ts";
import { explainStatusTransition, isTerminalStatus } from "../../../kernel/src/index.ts";
import { evaluateEntityDisposition } from "../../../kernel/src/index.ts";
import { stablePayloadHash } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, harnessRuntimeRoot, taskPackagePath } from "../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import { makeJournaledWriteCoordinator, runLedgerMaterializer } from "../../../kernel/src/store/index.ts";
import { resolveTaskCreatedBy } from "./created-by.ts";
import { renderSupersedesRelation } from "./task-relations.ts";
import { assertValidParentBinding, indexPath, makeIndex, readIndexEffect, renderIndex, validateGeneratedTaskId, validateTaskId } from "./task-index.ts";
import { appendProgressDelta, deleteTaskPackage, stageTaskDocument, stageTaskTree, writeSupersedeTaskDocuments, writeTaskDocument } from "./task-writes.ts";
import type {
  AppendProgressInput,
  CreateLocalTaskInput,
  DeleteTaskInput,
  LocalDeleteResult,
  LocalLifecycleEngine,
  LocalLifecycleOptions,
  LocalProgressResult,
  LocalSupersedeResult,
  LocalTaskTreeStatusResult,
  LocalTaskResult,
  LocalWriteCoordinatorOptions,
  SetLocalStatusInput,
  StageTaskDocumentInput,
  StageTaskTreeInput,
  SupersedeTaskInput,
  TaskReasonInput,
  WriteTaskDocumentInput
} from "./types.ts";

export { collectGitDiffEvidence } from "./git-diff-evidence.ts";
export type { GitDiffEvidenceFile, GitDiffEvidenceOptions, GitDiffEvidenceReport } from "./git-diff-evidence.ts";
export { runLedgerMaterializer };
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
  LocalTaskTreeStatusResult,
  LocalTaskResult,
  LocalWriteCoordinatorOptions,
  SetLocalStatusInput,
  StageTaskDocumentInput,
  StageTaskTreeInput,
  SupersedeTaskInput,
  TaskReasonInput,
  WriteTaskDocumentInput
} from "./types.ts";

export function makeLocalWriteCoordinator(options: LocalWriteCoordinatorOptions): WriteCoordinator {
  return makeJournaledWriteCoordinator({
    ...options,
    lockConflictRetry: localLockConflictRetry
  });
}

export function makeLocalLifecycleEngine(options: LocalLifecycleOptions): LocalLifecycleEngine {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const coordinator = options.coordinator ?? makeLocalWriteCoordinator({
    rootDir,
    layoutOverrides: options.layoutOverrides,
    actor: { kind: "agent", id: "local-lifecycle" }
  });
  const clock = options.clock ?? (() => new Date());

  return {
    createTask: (input) => createTask(runtimeContext, coordinator, clock, input, options.bindCreateProvenance),
    setStatus: (input) => setStatus(runtimeContext, coordinator, input),
    appendProgress: (input) => appendProgress(runtimeContext, coordinator, input),
    stageDocument: (input) => stageDocument(runtimeContext, coordinator, input),
    stageTaskTree: (input) => stageTaskPackageTree(runtimeContext, coordinator, input),
    taskTreeStatus: (input) => taskTreeStatus(runtimeContext, input),
    replaceTaskDocument: (input) => replaceTaskDocument(runtimeContext, coordinator, input),
    archiveTask: (input) => archiveTask(runtimeContext, coordinator, input),
    supersedeTask: (input) => supersedeTask(runtimeContext, coordinator, clock, input, options.bindCreateProvenance),
    deleteTask: (input) => deleteTask(runtimeContext, coordinator, input),
    reopenTask: (input) => reopenTask(runtimeContext, coordinator, input)
  };
}

const localLockConflictRetry = {
  maxWaitMs: 5_000,
  initialDelayMs: 25,
  maxDelayMs: 250
} as const;

function createTask(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  clock: () => Date,
  input: CreateLocalTaskInput,
  bindProvenance: LocalLifecycleOptions["bindCreateProvenance"] = defaultCreateProvenance
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
    if (input.parent) {
      const parentValidation = assertValidParentBinding(rootInput, input.taskId, input.parent);
      if (!parentValidation.ok) return yield* Effect.fail({ _tag: "WriteRejected", taskId: input.taskId, reason: parentValidation.reason } satisfies WriteError);
    }
    const createdAt = clock().toISOString();
    const provenance = yield* bindProvenance(createdAt).pipe(
      Effect.mapError((error) => ({ _tag: "WriteRejected", taskId: input.taskId, reason: error.reason } satisfies WriteError))
    );
    const index = makeIndex({
      taskId: input.taskId,
      title: input.title,
      parent: input.parent,
      status: "planned",
      bindingCreatedAt: createdAt,
      workKind: input.workKind,
      riskTier: input.riskTier,
      urgency: input.urgency,
      vertical: input.vertical ?? "default",
      preset: input.preset ?? "default",
      provenance: provenance ? [provenance] : [defaultHumanProvenance(createdAt)],
      createdBy: resolveTaskCreatedBy(rootDir, input.createdBy)
    }, stablePayloadHash);
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, "INDEX.md", renderIndex(index), {
      kind: "package_create",
      slug: input.slug
    });
    return { taskId: input.taskId, status: "planned", engine: "local" } satisfies LocalTaskResult;
  });
}

function defaultCreateProvenance(boundAt: string) {
  return Effect.succeed(defaultHumanProvenance(boundAt));
}

function defaultHumanProvenance(boundAt: string) {
  return {
    runtime: "human" as const,
    sessionId: `human-cli-${Date.parse(boundAt)}`,
    boundAt
  };
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

function stageDocument(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: StageTaskDocumentInput
): Effect.Effect<LocalProgressResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootInput, input.taskId);
    yield* stageTaskDocument(coordinator, stablePayloadHash, input.taskId, input.path);
    return { taskId: input.taskId, path: input.path } satisfies LocalProgressResult;
  });
}

function stageTaskPackageTree(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: StageTaskTreeInput
): Effect.Effect<LocalProgressResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootInput, input.taskId);
    yield* stageTaskTree(coordinator, stablePayloadHash, input.taskId);
    return { taskId: input.taskId, path: "." } satisfies LocalProgressResult;
  });
}

function taskTreeStatus(
  rootInput: HarnessLayoutInput,
  input: StageTaskTreeInput
): Effect.Effect<LocalTaskTreeStatusResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootInput, input.taskId);
    return yield* Effect.try({
      try: () => readTaskTreeStatus(rootInput, input.taskId),
      catch: (cause): WriteError => ({ _tag: "JournalUnavailable", cause })
    });
  });
}

function replaceTaskDocument(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: WriteTaskDocumentInput
): Effect.Effect<LocalProgressResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    yield* readIndexEffect(rootInput, input.taskId);
    yield* writeTaskDocument(coordinator, stablePayloadHash, input.taskId, input.path, input.body, { kind: "doc_write" });
    return { taskId: input.taskId, path: input.path } satisfies LocalProgressResult;
  });
}

const gitMaxBuffer = 256 * 1024 * 1024;

function readTaskTreeStatus(rootInput: HarnessLayoutInput, taskId: string): LocalTaskTreeStatusResult {
  const packagePath = taskPackagePath(rootInput, taskId);
  if (!gitTopLevel(packagePath)) return { taskId, dirty: false, entries: [] };
  const output = execFileSync("git", ["-C", packagePath, "status", "--porcelain", "-uall", "--", "."], {
    encoding: "utf8",
    maxBuffer: gitMaxBuffer,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const entries = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !statusEntryPath(entry).endsWith(".log"));
  return { taskId, dirty: entries.length > 0, entries };
}

function gitTopLevel(inputPath: string): string | null {
  try {
    return execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return null;
  }
}

function statusEntryPath(entry: string): string {
  const renamedSeparator = " -> ";
  const pathText = entry.slice(3);
  const renamedIndex = pathText.indexOf(renamedSeparator);
  return renamedIndex >= 0 ? pathText.slice(renamedIndex + renamedSeparator.length) : pathText;
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
  input: SupersedeTaskInput,
  bindProvenance: LocalLifecycleOptions["bindCreateProvenance"] = defaultCreateProvenance
): Effect.Effect<LocalSupersedeResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const rootDir = harnessRuntimeRoot(rootInput);
    const error = validateGeneratedTaskId(input.newTaskId);
    if (error) return yield* Effect.fail(error);
    if (existsSync(indexPath(rootInput, input.newTaskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId: input.newTaskId } satisfies EngineError);
    }
    const oldIndex = yield* readIndexEffect(rootInput, input.oldTaskId);
    const createdAt = clock().toISOString();
    const provenance = yield* bindProvenance(createdAt).pipe(
      Effect.mapError((error) => ({ _tag: "WriteRejected", taskId: input.newTaskId, reason: error.reason } satisfies WriteError))
    );
    const newIndex = makeIndex({
      taskId: input.newTaskId,
      title: input.title,
      status: "planned",
      bindingCreatedAt: createdAt,
      vertical: oldIndex.vertical,
      preset: oldIndex.preset,
      provenance: provenance ? [provenance] : [defaultHumanProvenance(createdAt)],
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
    const disposition = evaluateEntityDisposition({
      rootDir: harnessRuntimeRoot(rootInput),
      layoutOverrides: typeof rootInput === "string" ? undefined : rootInput.layoutOverrides,
      entityRef: `task/${input.taskId}`,
      action: "hard-delete"
    });
    if (!disposition.allowed) {
      return yield* Effect.fail({
        _tag: "RelatedTaskHardDeleteForbidden",
        taskId: input.taskId,
        reason: disposition.reason
      } satisfies EngineError);
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
