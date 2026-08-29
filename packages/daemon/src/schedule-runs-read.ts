import { createHash } from "node:crypto";
import {
  isScheduleEvent,
  nextScheduleOccurrence,
  type CanonicalEventV1,
  type ScheduleActiveRunV1,
  type ScheduleLastRunV1,
  type ScheduleMissedReason,
  type ScheduleTriggerV1,
} from "../../kernel/src/index.ts";
import {
  validateScheduleRuns,
  type ScheduleRunRowDto,
  type ScheduleRunsResult,
} from "./protocol/schedule-runs-contract.ts";

export { validateScheduleRuns } from "./protocol/schedule-runs-contract.ts";
export type {
  ScheduleOccurrenceOutcome,
  ScheduleRunRowDto,
  ScheduleRunsResult,
} from "./protocol/schedule-runs-contract.ts";

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
