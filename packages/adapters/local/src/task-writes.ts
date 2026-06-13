import { Effect } from "effect";
import type { TaskId, WriteError } from "../../../kernel/src/domain/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import type { WriteOpKind } from "../../../kernel/src/ports/write-coordinator.ts";
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
  return Effect.gen(function* () {
    for (const write of writes) {
      const opId = `${Date.now()}-${hashPayload(write).slice(0, 16)}`;
      yield* coordinator.enqueue({
        opId,
        taskId: write.taskId,
        kind: write.kind,
        payload: {
          path: write.path,
          body: write.body,
          ...(write.packageSlug ? { packageSlug: write.packageSlug } : {})
        }
      });
    }
    yield* coordinator.flush("explicit");
  });
}

export function writeSupersedeTaskDocuments(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  writes: ReadonlyArray<SupersedeDocumentWrite>
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${Date.now()}-${hashPayload({ kind: "package_supersede", writes }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId: writes[0]?.taskId ?? "unknown",
      kind: "package_supersede",
      payload: { writes }
    });
    yield* coordinator.flush("explicit");
  });
}

export function deleteTaskPackage(
  coordinator: WriteCoordinator,
  hashPayload: HashPayload,
  taskId: TaskId,
  reason: string
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    const opId = `${Date.now()}-${hashPayload({ taskId, reason, kind: "package_delete_hard" }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId,
      kind: "package_delete_hard",
      payload: { reason }
    });
    yield* coordinator.flush("explicit");
  });
}
