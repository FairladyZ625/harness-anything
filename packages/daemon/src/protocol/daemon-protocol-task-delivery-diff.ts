import { isJsonObject } from "./json-rpc-types.ts";

export interface DaemonTaskDeliveryDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly oldLineNo?: number;
  readonly newLineNo?: number;
  readonly text: string;
}

export interface DaemonTaskDeliveryDiffFile {
  readonly filePath: string;
  readonly lines: readonly DaemonTaskDeliveryDiffLine[];
}

export type DaemonTaskDeliveryDiffResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly taskId: string;
  readonly baseline: string | null;
  readonly commitSha: string | null;
  readonly files: readonly DaemonTaskDeliveryDiffFile[];
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
};

export function validateDaemonTaskDeliveryDiff(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return ["Invalid task delivery diff: result must be an object"];
  const line = (item: unknown) =>
    isJsonObject(item) &&
    ["context", "add", "remove"].includes(String(item.kind)) &&
    typeof item.text === "string" &&
    (item.oldLineNo === undefined || Number.isSafeInteger(item.oldLineNo)) &&
    (item.newLineNo === undefined || Number.isSafeInteger(item.newLineNo));
  const file = (item: unknown) =>
    isJsonObject(item) && typeof item.filePath === "string" && Array.isArray(item.lines) && item.lines.every(line);
  const valid =
    value.ok === true &&
    (value.status === "ready" || value.status === "pending") &&
    typeof value.taskId === "string" &&
    (value.baseline === null || typeof value.baseline === "string") &&
    (value.commitSha === null || typeof value.commitSha === "string") &&
    Array.isArray(value.files) &&
    value.files.every(file) &&
    typeof value.truncated === "boolean" &&
    Number.isSafeInteger(value.watermark) &&
    Number.isSafeInteger(value.sourceRevision);
  return valid ? [] : ["Invalid task delivery diff: result shape is not valid"];
}

export function serializeDaemonTaskDeliveryDiff(value: DaemonTaskDeliveryDiffResult): string {
  const errors = validateDaemonTaskDeliveryDiff(value);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return JSON.stringify(value);
}
