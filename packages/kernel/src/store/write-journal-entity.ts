import type { EntityId, TaskId } from "../domain/index.ts";
import { taskIdFromEntityId } from "../domain/index.ts";
import type { WriteOp } from "../ports/write-coordinator.ts";
import type { JournalRecord } from "./write-journal-types.ts";

export class NonTaskWriteEntityError extends Error {
  readonly _tag = "NonTaskWriteEntityError";
  readonly entityId: EntityId;

  constructor(entityId: EntityId) {
    super(`task write op requires task entity: ${entityId}`);
    this.name = "NonTaskWriteEntityError";
    this.entityId = entityId;
  }
}

export function requireTaskIdForWriteEntity(entityId: EntityId): TaskId {
  const taskId = taskIdFromEntityId(entityId);
  if (!taskId) throw new NonTaskWriteEntityError(entityId);
  return taskId;
}

export function taskIdForJournalRecord(record: Pick<JournalRecord, "entityId">): TaskId {
  return requireTaskIdForWriteEntity(record.entityId);
}

export function taskIdForWriteOp(op: Pick<WriteOp, "entityId">): TaskId {
  return requireTaskIdForWriteEntity(op.entityId);
}
