import { taskEntityId, taskIdFromEntityId } from "../domain/index.ts";
import type { EntityId, TaskId } from "../domain/index.ts";

export class WriteRejectedError extends Error {
  readonly _tag = "WriteRejectedError";
  readonly reason: string;
  readonly entityId?: EntityId;
  readonly taskId?: TaskId;
  readonly code?: string;
  readonly currentWatermark?: string | null;
  readonly expectedWatermark?: string | null;
  readonly retryable?: boolean;

  constructor(
    reason: string,
    entityId?: EntityId,
    options: {
      readonly code?: string;
      readonly currentWatermark?: string | null;
      readonly expectedWatermark?: string | null;
      readonly retryable?: boolean;
    } = {}
  ) {
    super(reason);
    this.name = "WriteRejectedError";
    this.reason = reason;
    this.entityId = entityId;
    this.taskId = entityId ? taskIdFromEntityId(entityId) ?? undefined : undefined;
    this.code = options.code;
    this.currentWatermark = options.currentWatermark;
    this.expectedWatermark = options.expectedWatermark;
    this.retryable = options.retryable;
  }
}

export function rejectWrite(reason: string, entityId?: EntityId): never {
  throw new WriteRejectedError(reason, entityId);
}

export function rejectTaskWrite(reason: string, taskId: TaskId): never {
  throw new WriteRejectedError(reason, taskEntityId(taskId));
}

export function rejectCasWatermarkMismatch(input: {
  readonly entityId?: EntityId;
  readonly expectedWatermark?: string | null;
  readonly currentWatermark?: string | null;
}): never {
  throw new WriteRejectedError(
    `cas_watermark_mismatch: expected ${formatWatermark(input.expectedWatermark)} but current is ${formatWatermark(input.currentWatermark)}`,
    input.entityId,
    {
      code: "cas_watermark_mismatch",
      currentWatermark: input.currentWatermark ?? null,
      expectedWatermark: input.expectedWatermark ?? null,
      retryable: true
    }
  );
}

function formatWatermark(watermark: string | null | undefined): string {
  return watermark ?? "<none>";
}
