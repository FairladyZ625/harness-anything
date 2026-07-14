import { Effect } from "effect";
import { taskEntityId } from "../../../kernel/src/index.ts";
import type { TaskId, WriteError } from "../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import type { WriteOpKind } from "../../../kernel/src/index.ts";
import { writeCoordinatedPayload, writeCoordinatedTaskDocuments } from "../../../kernel/src/write-coordination/write-helpers.ts";
import type { HashPayload } from "./task-index.ts";

export interface TaskDocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly kind: WriteOpKind;
  readonly packageSlug?: string;
}

export interface SupersedeDocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export interface TaskPackageDocumentWrite {
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export function writeTaskDocument(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  documentPath: string,
  body: string,
  options: {
    readonly kind?: WriteOpKind;
    readonly slug?: string;
  } = {}
): Effect.Effect<void, WriteError> {
  return writeTaskDocuments(coordinator, hashPayload, [{
    taskId,
    path: documentPath,
    body,
    kind: options.kind ?? "doc_write",
    packageSlug: options.slug
  }]);
}

export function writeTaskDocuments(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  writes: ReadonlyArray<TaskDocumentWrite>
): Effect.Effect<void, WriteError> {
  return writeCoordinatedTaskDocuments(coordinator, hashPayload, writes);
}

export function writeTaskPackageDocuments(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  writes: ReadonlyArray<TaskPackageDocumentWrite>
): Effect.Effect<void, WriteError> {
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: taskEntityId(taskId),
    kind: "package_create",
    payload: {
      writes: writes.map((write) => ({ taskId, ...write }))
    }
  });
}

export const PROGRESS_DOCUMENT_PATH = "progress.md";

export function appendProgressDelta(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  text: string
): Effect.Effect<void, WriteError> {
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: taskEntityId(taskId),
    kind: "progress_append",
    payload: { path: PROGRESS_DOCUMENT_PATH, append: text }
  });
}

export function stageTaskDocument(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  documentPath: string
): Effect.Effect<void, WriteError> {
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: taskEntityId(taskId),
    kind: "doc_stage",
    payload: { path: documentPath }
  });
}

export function stageTaskTree(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId
): Effect.Effect<void, WriteError> {
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: taskEntityId(taskId),
    kind: "task_tree_stage",
    payload: { scope: "task-package" }
  });
}

export function writeSupersedeTaskDocuments(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  writes: ReadonlyArray<SupersedeDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    yield* writeCoordinatedPayload(coordinator, hashPayload, {
      entityId: taskEntityId(taskId),
      kind: "package_supersede",
      payload: { writes }
    });
  });
}

export function deleteTaskPackage(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  reason: string
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    yield* writeCoordinatedPayload(coordinator, hashPayload, {
      entityId: taskEntityId(taskId),
      kind: "package_delete_hard",
      payload: { reason }
    });
  });
}
