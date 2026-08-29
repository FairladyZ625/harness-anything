import { createHash } from "node:crypto";
import {
  isScheduleEvent,
  nextScheduleOccurrence,
  type CanonicalEventV1,
  type ScheduleActiveRunV1,
  type ScheduleLastRunV1,
  type ScheduleMissedReason,
  type ScheduleRunOutcome,
  type ScheduleTriggerV1,
} from "../../kernel/src/index.ts";
import { isJsonObject, rejectSecretKeys } from "./protocol/json-rpc-types.ts";

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

export interface ScheduleRunsReadContext {
  readonly projection: {
    readonly getEntity: (entityKind: string, entityId: string) => unknown;
    readonly readCanonicalEvents: (
      afterRevision: number,
      limit: number,
    ) => {
      readonly status: "ready" | "pending";
      readonly events: readonly CanonicalEventV1[];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
  };
}

export function readScheduleRuns(context: ScheduleRunsReadContext, scheduleId: string, limit = 50): ScheduleRunsResult {
  if (!scheduleId.trim()) throw scheduleRunsError("invalid_command", "Schedule id must be non-empty.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw scheduleRunsError("invalid_command", "Schedule run limit must be an integer from 1 to 200.");
  if (!context.projection.getEntity("schedule", scheduleId))
    throw scheduleRunsError("entity_not_found", `Schedule ${scheduleId} does not exist.`);

  const read = readAllCanonicalEvents(context.projection),
    rows = projectScheduleRuns(read.events, scheduleId),
    runs = rows.slice(0, limit);
  return {
    ok: true,
    status: read.status,
    scheduleId,
    runs,
    totals: { runs: rows.length, missed: rows.filter(({ outcome }) => outcome === "missed").length },
    truncated: runs.length < rows.length,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
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

export function serializeScheduleRuns(value: unknown): string {
  const errors = validateScheduleRuns(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

function readAllCanonicalEvents(projection: ScheduleRunsReadContext["projection"]): {
  readonly status: "ready" | "pending";
  readonly events: readonly CanonicalEventV1[];
  readonly watermark: number;
  readonly sourceRevision: number;
} {
  const events: CanonicalEventV1[] = [];
  let cursor = 0,
    status: "ready" | "pending" = "ready";
  while (true) {
    const page = projection.readCanonicalEvents(cursor, 500);
    status = page.status === "pending" ? "pending" : status;
    if (!page.events.length)
      return {
        status,
        events,
        watermark: page.watermark,
        sourceRevision: page.sourceRevision,
      };
    events.push(...page.events);
    const nextCursor = page.events.at(-1)!.workspaceRevision;
    if (nextCursor <= cursor) throw new Error("canonical Schedule run projection did not advance");
    cursor = nextCursor;
    if (page.events.length < 500)
      return {
        status,
        events,
        watermark: page.watermark,
        sourceRevision: page.sourceRevision,
      };
  }
}

function projectScheduleRuns(events: readonly CanonicalEventV1[], scheduleId: string): readonly ScheduleRunRowDto[] {
  const claims = new Map<string, ScheduleActiveRunV1>(),
    rows = new Map<string, ScheduleRunRowDto>();
  for (const event of events) {
    if (!isScheduleEvent(event) || event.entity.id !== scheduleId) continue;
    const schedule = event.payload.schedule;
    if (event.type === "schedule_occurrence_claimed" || event.type === "schedule_occurrence_dispatched") {
      const active = schedule.status.activeRun;
      if (!active) continue;
      claims.set(active.occurrenceId, active);
      rows.set(active.occurrenceId, activeRow(active));
      continue;
    }
    if (event.type === "schedule_dispatch_failed" || event.type === "schedule_run_settled") {
      const last = schedule.status.lastRun;
      if (!last) continue;
      rows.set(last.occurrenceId, settledRow(last, claims.get(last.occurrenceId) ?? null));
      continue;
    }
    if (event.type === "schedule_occurrences_missed" && event.payload.missed) {
      const missed = event.payload.missed;
      for (const scheduledFor of missedOccurrences(schedule.spec.trigger, missed.from, missed.to, missed.count)) {
        const occurrenceId = missedOccurrenceId(scheduleId, scheduledFor, missed.reason);
        rows.set(occurrenceId, missedRow(occurrenceId, scheduledFor, missed.reason));
      }
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.scheduledFor.localeCompare(left.scheduledFor) || right.occurrenceId.localeCompare(left.occurrenceId),
  );
}

function activeRow(active: ScheduleActiveRunV1): ScheduleRunRowDto {
  return {
    occurrenceId: active.occurrenceId,
    kind: active.kind,
    scheduledFor: active.scheduledFor,
    claimedAt: active.claimedAt,
    endedAt: null,
    nodeId: active.nodeId,
    assignmentId: active.assignmentId,
    outcome: "running",
    durationMs: null,
    reportRef: null,
    missedReason: null,
    dispatchId: active.dispatchId ?? null,
    runtimeSessionId: active.runtimeSessionId ?? null,
  };
}

function settledRow(last: ScheduleLastRunV1, claim: ScheduleActiveRunV1 | null): ScheduleRunRowDto {
  return {
    occurrenceId: last.occurrenceId,
    kind: claim?.kind ?? "scheduled",
    scheduledFor: last.scheduledFor,
    claimedAt: claim?.claimedAt ?? null,
    endedAt: last.endedAt,
    nodeId: last.nodeId,
    assignmentId: last.assignmentId,
    outcome: last.outcome,
    durationMs: claim === null ? null : Math.max(0, Date.parse(last.endedAt) - Date.parse(claim.claimedAt)),
    reportRef: scheduleReportRef(last.detail),
    missedReason: null,
    dispatchId: last.dispatchId ?? null,
    runtimeSessionId: last.runtimeSessionId ?? null,
  };
}

function missedRow(occurrenceId: string, scheduledFor: string, reason: ScheduleMissedReason): ScheduleRunRowDto {
  return {
    occurrenceId,
    kind: "scheduled",
    scheduledFor,
    claimedAt: null,
    endedAt: null,
    nodeId: null,
    assignmentId: null,
    outcome: "missed",
    durationMs: null,
    reportRef: null,
    missedReason: reason,
    dispatchId: null,
    runtimeSessionId: null,
  };
}

function missedOccurrences(trigger: ScheduleTriggerV1, from: string, to: string, count: number): readonly string[] {
  const occurrences = [from];
  while (occurrences.length < count) occurrences.push(nextScheduleOccurrence(trigger, occurrences.at(-1)!));
  if (occurrences.at(-1) !== to)
    throw new Error("missed Schedule occurrence evidence does not match its trigger cadence");
  return occurrences;
}

function missedOccurrenceId(scheduleId: string, scheduledFor: string, reason: ScheduleMissedReason): string {
  const digest = createHash("sha256").update(`${scheduleId}\0${scheduledFor}\0${reason}`).digest("hex");
  return `missed_${digest.slice(0, 24)}`;
}

function scheduleReportRef(detail: string | undefined): string | null {
  return detail && /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u.test(detail) ? detail : null;
}

function scheduleRunsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
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
