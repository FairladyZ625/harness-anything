import {
  isScheduleEvent,
  nextScheduleOccurrence,
  validateScheduleV1,
  type CanonicalEventV1,
  type ScheduleRunOutcome,
  type ScheduleTriggerV1,
  type ScheduleV1,
} from "../../kernel/src/index.ts";

type ProjectedScheduleRow = {
  readonly id: string;
  readonly workspaceRevision: number;
  readonly value: Readonly<Record<string, unknown>>;
};

export type InvalidScheduleProjection = {
  readonly scheduleId: string;
  readonly state: "invalid";
  readonly invalidReason: string;
  readonly definitionRevision: number;
};

export type InspectedScheduleProjection =
  | {
      readonly valid: true;
      readonly schedule: ScheduleV1;
      readonly revision: number;
    }
  | {
      readonly valid: false;
      readonly value: Readonly<Record<string, unknown>>;
      readonly revision: number;
      readonly errors: readonly string[];
      readonly invalid: InvalidScheduleProjection;
    };

export function inspectScheduleProjection(row: ProjectedScheduleRow): InspectedScheduleProjection {
  const errors = validateScheduleV1(row.value);
  if (errors.length === 0)
    return { valid: true, schedule: row.value as unknown as ScheduleV1, revision: row.workspaceRevision };
  return {
    valid: false,
    value: row.value,
    revision: row.workspaceRevision,
    errors,
    invalid: {
      scheduleId: row.id,
      state: "invalid",
      invalidReason: errors.join("; "),
      definitionRevision: row.workspaceRevision,
    },
  };
}

// ---------------------------------------------------------------------------
// Health rollup (task schedule GUI): daemon-side aggregation over the same
// canonical run events the run-history read folds. The renderer formats this
// DTO only — bucket/counts/failure detail are decided here so no view re-derives
// health from outcomes (dec_8DCD52E98BAB268B0194B1E399: status judgments are
// daemon-side).
// ---------------------------------------------------------------------------

export type ScheduleHealthOutcomeWord = ScheduleRunOutcome | "running" | "missed";

export interface ScheduleHealthRollup {
  /** 最近若干次 occurrence 的 outcome,旧 → 新;运行中的 occurrence 是最后一段。 */
  readonly recent: readonly ScheduleHealthOutcomeWord[];
  /** daemon 的分类:最近窗口内出现 failed/missed/unknown 即 degraded,cancelled 不算异常。 */
  readonly bucket: "degraded" | "clean";
  /** 最近窗口内 failed 的次数。 */
  readonly failedCount: number;
  /** 最近一次 failed occurrence 的 settle detail(错误原因或结果 artifact 引用)。 */
  readonly lastFailureDetail: string | null;
}

/** 健康度窗口:超过这个长度的 spark 只是密度,不是信号。 */
export const SCHEDULE_HEALTH_WINDOW = 10;

interface RollupEntry {
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly outcome: ScheduleHealthOutcomeWord;
  readonly detail: string | null;
}

/**
 * 一次 canonical 事件扫描为**每个** schedule 各折一份健康度 rollup(列表读一次调用,
 * 不做 N+1)。折法与运行历史读同一事件语义:claim/dispatch 打一段 running,settle 覆写
 * 为终态,missed 证据按触发节奏展开为逐个 occurrence;同 occurrence 幂等。
 */
export function scheduleHealthRollupsFromEvents(
  events: readonly CanonicalEventV1[],
): ReadonlyMap<string, ScheduleHealthRollup> {
  const entries = new Map<string, Map<string, RollupEntry>>();
  for (const event of events) {
    if (!isScheduleEvent(event)) continue;
    const schedule = event.payload.schedule,
      rows = entries.get(event.entity.id) ?? new Map<string, RollupEntry>();
    entries.set(event.entity.id, rows);
    if (event.type === "schedule_occurrence_claimed" || event.type === "schedule_occurrence_dispatched") {
      const active = schedule.status.activeRun;
      if (!active) continue;
      rows.set(active.occurrenceId, {
        occurrenceKey: active.occurrenceId,
        scheduledFor: active.scheduledFor,
        outcome: "running",
        detail: null,
      });
      continue;
    }
    if (event.type === "schedule_dispatch_failed" || event.type === "schedule_run_settled") {
      const last = schedule.status.lastRun;
      if (!last) continue;
      rows.set(last.occurrenceId, {
        occurrenceKey: last.occurrenceId,
        scheduledFor: last.scheduledFor,
        outcome: last.outcome,
        detail: last.detail ?? null,
      });
      continue;
    }
    if (event.type === "schedule_occurrences_missed" && event.payload.missed) {
      const missed = event.payload.missed;
      for (const scheduledFor of missedOccurrenceTimes(schedule.spec.trigger, missed)) {
        rows.set(`missed:${scheduledFor}`, {
          occurrenceKey: `missed:${scheduledFor}`,
          scheduledFor,
          outcome: "missed",
          detail: null,
        });
      }
    }
  }
  const rollups = new Map<string, ScheduleHealthRollup>();
  for (const [scheduleId, rows] of entries)
    rollups.set(scheduleId, rollupOf([...rows.values()].sort(byNewestFirst).slice(0, SCHEDULE_HEALTH_WINDOW)));
  return rollups;
}

/** 无运行历史的 schedule 也有 rollup(全空窗口)——GUI 不需要为它保留占位态。 */
export function emptyScheduleHealthRollup(): ScheduleHealthRollup {
  return { recent: [], bucket: "clean", failedCount: 0, lastFailureDetail: null };
}

function missedOccurrenceTimes(
  trigger: ScheduleTriggerV1,
  missed: { readonly from: string; readonly to: string; readonly count: number },
): readonly string[] {
  const occurrences = [missed.from];
  while (occurrences.length < missed.count) occurrences.push(nextScheduleOccurrence(trigger, occurrences.at(-1)!));
  // 与运行历史读同一条证据校验:missed 证据必须与触发节奏吻合,fail closed。
  if (occurrences.at(-1) !== missed.to)
    throw new Error("missed Schedule occurrence evidence does not match its trigger cadence");
  return occurrences;
}

function byNewestFirst(left: RollupEntry, right: RollupEntry): number {
  return right.scheduledFor.localeCompare(left.scheduledFor) || right.occurrenceKey.localeCompare(left.occurrenceKey);
}

function rollupOf(window: readonly RollupEntry[]): ScheduleHealthRollup {
  const failed = window.filter(({ outcome }) => outcome === "failed");
  return {
    recent: window.map(({ outcome }) => outcome),
    bucket: window.some(({ outcome }) => outcome === "failed" || outcome === "missed" || outcome === "unknown")
      ? "degraded"
      : "clean",
    failedCount: failed.length,
    lastFailureDetail: failed[0]?.detail ?? null,
  };
}
