import type { ScheduleMissedReason, ScheduleRunOutcome } from "../../../kernel/src/index.ts";
import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";

export type ScheduleOccurrenceOutcome = ScheduleRunOutcome | "running" | "missed";

/** 该 occurrence 的 runtime session 写入的实体产出(fact/decision/task 反查,任务 GUI 详情页链接用)。 */
export interface ScheduleRunOutputsDto {
  readonly facts: readonly string[];
  readonly decisions: readonly string[];
  readonly tasks: readonly string[];
}

export interface ScheduleRunRowDto {
  readonly occurrenceId: string;
  readonly kind: "scheduled" | "manual";
  readonly scheduledFor: string;
  readonly claimedAt: string | null;
  readonly endedAt: string | null;
  readonly nodeId: string | null;
  readonly assignmentId: string | null;
  readonly outcome: ScheduleOccurrenceOutcome;
  readonly durationMs: number | null;
  readonly reportRef: string | null;
  /** report artifact 的完整正文(runtime-result 内容读);无报告或内容未就绪为 null,不截断。 */
  readonly reportText: string | null;
  /** settle detail 中不属于报告引用的部分——失败原因等真实细节;成功且仅有报告时为 null。 */
  readonly detail: string | null;
  readonly missedReason: ScheduleMissedReason | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly attemptIndex: number | null;
  readonly outputs: ScheduleRunOutputsDto;
}

export interface ScheduleRunsResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly scheduleId: string;
  readonly runs: readonly ScheduleRunRowDto[];
  readonly totals: { readonly runs: number; readonly missed: number; readonly failed: number };
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
}

export function validateScheduleRuns(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    !exactFields(value, ["ok", "status", "scheduleId", "runs", "totals", "truncated", "watermark", "sourceRevision"]) ||
    value.ok !== true ||
    !["ready", "pending"].includes(String(value.status)) ||
    !nonEmptyText(value.scheduleId) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(validRunRow) ||
    !isJsonObject(value.totals) ||
    !exactFields(value.totals, ["runs", "missed", "failed"]) ||
    !nonNegInt(value.totals.runs) ||
    !nonNegInt(value.totals.missed) ||
    !nonNegInt(value.totals.failed) ||
    typeof value.truncated !== "boolean" ||
    !nonNegInt(value.watermark) ||
    !nonNegInt(value.sourceRevision)
  )
    return ["schedule runs result is invalid"];
  return rejectSecretKeys(value);
}

function validRunRow(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    exactFields(value, [
      "occurrenceId",
      "kind",
      "scheduledFor",
      "claimedAt",
      "endedAt",
      "nodeId",
      "assignmentId",
      "outcome",
      "durationMs",
      "reportRef",
      "reportText",
      "detail",
      "missedReason",
      "dispatchId",
      "runtimeSessionId",
      "attemptIndex",
      "outputs",
    ]) &&
    nonEmptyText(value.occurrenceId) &&
    ["scheduled", "manual"].includes(String(value.kind)) &&
    utc(value.scheduledFor) &&
    nullableUtc(value.claimedAt) &&
    nullableUtc(value.endedAt) &&
    nullableText(value.nodeId) &&
    nullableText(value.assignmentId) &&
    ["running", "missed", "succeeded", "failed", "unknown", "cancelled"].includes(String(value.outcome)) &&
    (value.durationMs === null || nonNegInt(value.durationMs)) &&
    (value.reportRef === null ||
      (typeof value.reportRef === "string" &&
        /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u.test(value.reportRef))) &&
    (value.reportText === null || typeof value.reportText === "string") &&
    nullableText(value.detail) &&
    (value.missedReason === null || ["scheduler_unavailable", "single_flight"].includes(String(value.missedReason))) &&
    nullableText(value.dispatchId) &&
    nullableText(value.runtimeSessionId) &&
    (value.attemptIndex === null || nonNegInt(value.attemptIndex)) &&
    validOutputs(value.outputs) &&
    (value.outcome === "missed" ? value.missedReason !== null && value.nodeId === null : value.missedReason === null)
  );
}

function validOutputs(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    exactFields(value, ["facts", "decisions", "tasks"]) &&
    ["facts", "decisions", "tasks"].every(
      (field) => Array.isArray(value[field]) && (value[field] as readonly unknown[]).every(nonEmptyText),
    )
  );
}

export function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableText(value: unknown): boolean {
  return value === null || nonEmptyText(value);
}

function utc(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
}

function nullableUtc(value: unknown): boolean {
  return value === null || utc(value);
}

function nonNegInt(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
