import type { ScheduleMissedReason, ScheduleRunOutcome } from "../../../kernel/src/index.ts";
import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";

export type ScheduleOccurrenceOutcome = ScheduleRunOutcome | "running" | "missed";

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
  readonly missedReason: ScheduleMissedReason | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
}

export interface ScheduleRunsResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly scheduleId: string;
  readonly runs: readonly ScheduleRunRowDto[];
  readonly totals: { readonly runs: number; readonly missed: number };
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
    !nonEmpty(value.scheduleId) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(validRunRow) ||
    !isJsonObject(value.totals) ||
    !exactFields(value.totals, ["runs", "missed"]) ||
    !count(value.totals.runs) ||
    !count(value.totals.missed) ||
    typeof value.truncated !== "boolean" ||
    !count(value.watermark) ||
    !count(value.sourceRevision)
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
      "missedReason",
      "dispatchId",
      "runtimeSessionId",
    ]) &&
    nonEmpty(value.occurrenceId) &&
    ["scheduled", "manual"].includes(String(value.kind)) &&
    utc(value.scheduledFor) &&
    nullableUtc(value.claimedAt) &&
    nullableUtc(value.endedAt) &&
    nullableText(value.nodeId) &&
    nullableText(value.assignmentId) &&
    ["running", "missed", "succeeded", "failed", "unknown", "cancelled"].includes(String(value.outcome)) &&
    (value.durationMs === null || count(value.durationMs)) &&
    (value.reportRef === null ||
      (typeof value.reportRef === "string" &&
        /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u.test(value.reportRef))) &&
    (value.missedReason === null || ["scheduler_unavailable", "single_flight"].includes(String(value.missedReason))) &&
    nullableText(value.dispatchId) &&
    nullableText(value.runtimeSessionId) &&
    (value.outcome === "missed" ? value.missedReason !== null && value.nodeId === null : value.missedReason === null)
  );
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableText(value: unknown): boolean {
  return value === null || nonEmpty(value);
}

function utc(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
}

function nullableUtc(value: unknown): boolean {
  return value === null || utc(value);
}

function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
