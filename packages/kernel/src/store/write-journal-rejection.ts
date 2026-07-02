import { taskEntityId, taskIdFromEntityId } from "../domain/index.ts";
import type { EntityId, TaskId } from "../domain/index.ts";

export class WriteRejectedError extends Error {
  readonly _tag = "WriteRejectedError";
  readonly reason: string;
  readonly entityId?: EntityId;
  readonly taskId?: TaskId;

  constructor(reason: string, entityId?: EntityId) {
    super(reason);
    this.name = "WriteRejectedError";
    this.reason = reason;
    this.entityId = entityId;
    this.taskId = entityId ? taskIdFromEntityId(entityId) ?? undefined : undefined;
  }
}

export function rejectWrite(reason: string, entityId?: EntityId): never {
  throw new WriteRejectedError(reason, entityId);
}

export function rejectTaskWrite(reason: string, taskId: TaskId): never {
  throw new WriteRejectedError(reason, taskEntityId(taskId));
}
