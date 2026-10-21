import type { TaskDeliveryDiffRead } from "../api/renderer-dto.ts";
import { isRendererRecord, localErrorHint } from "./result-validation.ts";

export function readTaskDeliveryDiffResult(value: unknown): TaskDeliveryDiffRead {
  const result = value as Partial<TaskDeliveryDiffRead>;
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    typeof result.taskId !== "string" ||
    (result.baseline !== null && typeof result.baseline !== "string") ||
    (result.commitSha !== null && typeof result.commitSha !== "string") ||
    !Array.isArray(result.files) ||
    result.files.some(
      (file) =>
        !isRendererRecord(file) ||
        typeof file.filePath !== "string" ||
        !Array.isArray(file.lines) ||
        file.lines.some(
          (line) =>
            !isRendererRecord(line) ||
            !["context", "add", "remove"].includes(String(line.kind)) ||
            typeof line.text !== "string" ||
            (line.oldLineNo !== undefined && !Number.isSafeInteger(line.oldLineNo)) ||
            (line.newLineNo !== undefined && !Number.isSafeInteger(line.newLineNo)),
        ),
    ) ||
    typeof result.truncated !== "boolean" ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Task delivery diff bridge returned an invalid result."));
  return result as TaskDeliveryDiffRead;
}
