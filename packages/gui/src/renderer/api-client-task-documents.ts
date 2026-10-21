import type { TaskDocumentListProjectionRead } from "../api/renderer-dto.ts";
import { isRendererRecord, localErrorHint } from "./result-validation.ts";

export function readTaskDocumentListResult(value: unknown): TaskDocumentListProjectionRead {
  const result = value as Partial<TaskDocumentListProjectionRead>;
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    typeof result.taskId !== "string" ||
    !Array.isArray(result.documents) ||
    result.documents.some(
      (doc) =>
        !isRendererRecord(doc) ||
        typeof doc.path !== "string" ||
        typeof doc.blobSha256 !== "string" ||
        !Number.isInteger(doc.size) ||
        typeof doc.mediaType !== "string" ||
        typeof doc.uncommitted !== "boolean",
    ) ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task document list bridge returned an invalid result."));
  return result as TaskDocumentListProjectionRead;
}
