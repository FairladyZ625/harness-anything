import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";
import { createHash } from "node:crypto";
import {
  isScheduleEvent,
  nextScheduleOccurrence,
  type CanonicalEventV1,
  type ScheduleActiveRunV1,
  type ScheduleLastRunV1,
  type ScheduleMissedReason,
  type ScheduleTriggerV1,
} from "@harness-anything/kernel";
import {
  validateScheduleRuns,
  type ScheduleRunOutputsDto,
  type ScheduleRunRowDto,
  type ScheduleRunsResult,
} from "./protocol/schedule-runs-contract.ts";

export { validateScheduleRuns } from "./protocol/schedule-runs-contract.ts";
export type {
  ScheduleOccurrenceOutcome,
  ScheduleRunOutputsDto,
  ScheduleRunRowDto,
  ScheduleRunsResult,
} from "./protocol/schedule-runs-contract.ts";

export interface ScheduleRunsReadContext {
  readonly projection: {
    readonly getEntity: (entityKind: string, entityId: string) => unknown;
    readonly readScheduleEvents: (scheduleId: string) => {
      readonly status: "ready" | "pending";
      readonly events: readonly CanonicalEventV1[];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
    readonly readScheduleOutputEvents: (runtimeSessionIds: readonly string[]) => readonly CanonicalEventV1[];
  };
  /** 同 cut 的 runtime-result 内容读；存在引用时必须提供存储且 bytes 完整。 */
  readonly store?: {
    readonly readContentBlob: (sha256: string) => Uint8Array | null;
  };
}

export function readScheduleRuns(context: ScheduleRunsReadContext, scheduleId: string, limit = 50): ScheduleRunsResult {
  if (!scheduleId.trim()) throw scheduleRunsError("invalid_command", "Schedule id must be non-empty.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw scheduleRunsError("invalid_command", "Schedule run limit must be an integer from 1 to 200.");
  if (!context.projection.getEntity("schedule", scheduleId))
    throw scheduleRunsError("entity_not_found", `Schedule ${scheduleId} does not exist.`);

  const read = context.projection.readScheduleEvents(scheduleId),
    rows = projectScheduleRuns(read.events, scheduleId),
    runtimeSessionIds = [
      ...new Set(rows.flatMap(({ runtimeSessionId }) => (runtimeSessionId === null ? [] : [runtimeSessionId]))),
    ],
    outputs = scheduleRunOutputs(
      context.projection.readScheduleOutputEvents(runtimeSessionIds),
      new Set(runtimeSessionIds),
    ),
    runs = rows.slice(0, limit).map((row) => ({
      ...row,
      reportText: reportTextOf(context, row.reportRef),
      outputs: row.runtimeSessionId === null ? emptyOutputs() : (outputs.get(row.runtimeSessionId) ?? emptyOutputs()),
    }));
  return {
    ok: true,
    status: read.status,
    scheduleId,
    runs,
    totals: {
      runs: rows.length,
      missed: rows.filter(({ outcome }) => outcome === "missed").length,
      failed: rows.filter(({ outcome }) => outcome === "failed").length,
    },
    truncated: runs.length < rows.length,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

function emptyOutputs(): ScheduleRunOutputsDto {
  return { facts: [], decisions: [], tasks: [] };
}

/** A referenced result must belong to the complete cut; absent bytes are a failed read. */
function reportTextOf(context: ScheduleRunsReadContext, reportRef: string | null): string | null {
  if (reportRef === null) return null;
  if (context.store === undefined)
    throw Object.assign(new Error("Runtime result store is unavailable."), { code: "replica_unavailable" });
  return readCanonicalRuntimeResult(context.store, reportRef);
}

/**
 * occurrence 产出反查:该 occurrence 派工的 runtime session 以 executor 身份写入的
 * fact/decision/task(写事件的 actor.executor.id = `runtime-session:<id>`)。一次事件
 * 扫描按 first-seen 去重;没有 runtime session 的 occurrence 不做反查。schema 判别
 * 与 kernel 的 isFactEvent/isTaskEvent 同式(fact/task 顶层带 id 字段,decision 同)。
 */
function scheduleRunOutputs(
  events: readonly CanonicalEventV1[],
  runtimeSessionIds: ReadonlySet<string | null>,
): ReadonlyMap<string, ScheduleRunOutputsDto> {
  if (runtimeSessionIds.size === 0 || (runtimeSessionIds.size === 1 && runtimeSessionIds.has(null))) return new Map();
  const outputs = new Map<string, { facts: string[]; decisions: string[]; tasks: string[] }>();
  const authoredSession = (event: CanonicalEventV1): string | null => {
    const executor = event.actor?.executor;
    if (executor?.kind !== "agent") return null;
    const id = executor.id,
      prefix = "runtime-session:";
    return id.startsWith(prefix) && runtimeSessionIds.has(id.slice(prefix.length)) ? id.slice(prefix.length) : null;
  };
  const record = (runtimeSessionId: string, kind: "facts" | "decisions" | "tasks", id: string): void => {
    const current = outputs.get(runtimeSessionId) ?? { facts: [], decisions: [], tasks: [] };
    if (!current[kind].includes(id)) current[kind].push(id);
    outputs.set(runtimeSessionId, current);
  };
  for (const event of events) {
    const runtimeSessionId = authoredSession(event);
    if (runtimeSessionId === null) continue;
    if (event.schema === "fact-event/v1") record(runtimeSessionId, "facts", event.factId);
    else if (event.schema === "decision-event/v1") record(runtimeSessionId, "decisions", event.decisionId);
    else if (event.schema === "task-event/v1") record(runtimeSessionId, "tasks", event.taskId);
  }
  return outputs;
}

export function serializeScheduleRuns(value: unknown): string {
  const errors = validateScheduleRuns(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
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
    claimFence: active.claimFence,
    outcome: "running",
    durationMs: null,
    reportRef: null,
    reportText: null,
    detail: null,
    missedReason: null,
    dispatchId: active.dispatchId ?? null,
    runtimeSessionId: active.runtimeSessionId ?? null,
    attemptIndex: active.attemptIndex,
    outputs: emptyOutputs(),
  };
}

function settledRow(last: ScheduleLastRunV1, claim: ScheduleActiveRunV1 | null): ScheduleRunRowDto {
  const reportRef = scheduleReportRef(last.detail);
  return {
    occurrenceId: last.occurrenceId,
    kind: claim?.kind ?? "scheduled",
    scheduledFor: last.scheduledFor,
    claimedAt: claim?.claimedAt ?? null,
    endedAt: last.endedAt,
    nodeId: last.nodeId,
    claimFence: last.claimFence,
    outcome: last.outcome,
    durationMs: claim === null ? null : Math.max(0, Date.parse(last.endedAt) - Date.parse(claim.claimedAt)),
    reportRef,
    reportText: null,
    // settle detail = 结果 artifact 引用(成功路径)或失败原因;前者已在 reportRef,
    // detail 只保留真实失败细节,不重复引用串。
    detail: reportRef === null ? (last.detail ?? null) : null,
    missedReason: null,
    dispatchId: last.dispatchId ?? null,
    runtimeSessionId: last.runtimeSessionId ?? null,
    attemptIndex: last.attemptIndex,
    outputs: emptyOutputs(),
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
    claimFence: null,
    outcome: "missed",
    durationMs: null,
    reportRef: null,
    reportText: null,
    detail: null,
    missedReason: reason,
    dispatchId: null,
    runtimeSessionId: null,
    attemptIndex: null,
    outputs: emptyOutputs(),
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
