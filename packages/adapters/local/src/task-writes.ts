import { Effect } from "effect";
import type { TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import type { WriteOpKind } from "../../../kernel/src/ports/write-coordinator.ts";
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

export function writeSupersedeTaskDocuments(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  writes: ReadonlyArray<SupersedeDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    yield* writeCoordinatedPayload(coordinator, hashPayload, {
      taskId: writes[0]?.taskId ?? "unknown",
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
      taskId,
      kind: "package_delete_hard",
      payload: { reason }
    });
  });
}
