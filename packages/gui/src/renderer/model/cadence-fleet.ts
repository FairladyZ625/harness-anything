import type { AgentRuntimeSessionGroupDto, AgentRuntimeSessionGroupStatus } from "@harness-anything/daemon/protocol";
import type { TaskRow } from "./types.ts";

/**
 * 执行概况的纯派生:一条 sessionGroups 有界读面(groupBy=task,不带成员级 status
 * 筛选)按「正在执行 / 最近异常执行 / 最近运行结果」收成三组行。判定只用组自身的
 * `runningCount + latestStatus`——成员级筛选读回的 latestStatus 是匹配成员里的
 * 最新,不是组现状,「当前需处理」不能从筛选读面推(检查点实测:未筛选 running 的组,
 * 按 failed 筛选读回却显示 failed/0 在跑)。
 *
 * 任务侧的「别误读」声明来自 App 传入的任务投影:done/cancelled/archived 的任务不
 * 因旧会话失败被当成待办(行上带「任务已完成」);投影缺行标「任务状态未知」;
 * submitted/in_review 才说「待验收」。succeeded 会话只说「已成功」,不叫「已交付」。
 */

export type FleetHistoryRange = "24h" | "7d" | "30d";
export const FLEET_HISTORY_RANGES: readonly FleetHistoryRange[] = ["24h", "7d", "30d"] as const;
export const FLEET_HISTORY_RANGE_MS: Readonly<Record<FleetHistoryRange, number>> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};
/** 与会话页同一上限、同一读面家族:概况页不建第二条翻页/轮询,截断由 footer 如实标注。 */
export const FLEET_GROUPS_LIMIT = 1000;
/** 概况只答「最近」,长列表的完整落点是会话页;渲染行数有界,footer 标注显示条数。 */
export const FLEET_RESULT_ROWS = 50;

/** latestStatus 里视为「异常记录」的词:failed 定性,lost/unavailable/ended-indeterminate 结果不明。 */
export const FLEET_ANOMALY_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "lost",
  "unavailable",
  "ended-indeterminate",
]);

/** 任务当前投影给行的声明:null = 正常推进中,不占标签(标准 §3 正常状态不占标签)。 */
export type FleetTaskClaim = "awaiting" | "done" | "cancelled" | "archived" | "unknown" | null;

export function fleetTaskClaimOf(task: TaskRow | undefined): FleetTaskClaim {
  if (task === undefined) return "unknown";
  const status = task.canonicalStatus ?? task.coordinationStatus;
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (status === "archived" || task.packageDisposition === "archived") return "archived";
  if (status === "submitted" || status === "in_review") return "awaiting";
  if (status === "unknown") return "unknown";
  return null;
}

export interface FleetExecutionRow {
  readonly key: string;
  readonly kind: "task" | "decision" | "other";
  /** 人话标题:任务/决策投影标题,未归属桶给可译的判别式 key。 */
  readonly title: string;
  readonly unattributedKey: string | null;
  readonly taskId: string | null;
  readonly decisionId: string | null;
  /** latestRound 的会话:行点击与会话详情的落点。 */
  readonly runtimeSessionId: string | null;
  readonly agentName: string | null;
  readonly instanceId: string | null;
  /** 最新一轮是否就是 running 会话:只有 true 才能把 agentName 指为当前执行人。 */
  readonly currentExecutor: boolean;
  readonly runningCount: number;
  readonly roundCount: number;
  readonly latestStatus: AgentRuntimeSessionGroupStatus;
  readonly latestActivityAt: string;
  readonly taskClaim: FleetTaskClaim;
}

export interface FleetExecutionSnapshot {
  readonly executing: readonly FleetExecutionRow[];
  readonly anomalies: readonly FleetExecutionRow[];
  readonly results: readonly FleetExecutionRow[];
  readonly totals: { readonly groups: number; readonly sessions: number };
  readonly loadedGroups: number;
  readonly truncated: boolean;
}

function toRow(
  group: AgentRuntimeSessionGroupDto,
  tasks: ReadonlyMap<string, TaskRow>,
  decisionTitles: ReadonlyMap<string, string>,
): FleetExecutionRow {
  const taskId = group.kind === "task" && group.taskId !== undefined ? group.taskId : null,
    decisionId = group.kind === "decision" && group.decisionId !== undefined ? group.decisionId : null,
    unattributed = group.kind === "unattributed" ? group.key : null,
    latest = group.latestRound;
  return {
    key: group.key,
    kind: taskId !== null ? "task" : decisionId !== null ? "decision" : "other",
    title:
      decisionId !== null
        ? (decisionTitles.get(decisionId) ?? group.label)
        : unattributed !== null
          ? unattributed
          : group.label,
    unattributedKey: unattributed,
    taskId,
    decisionId,
    runtimeSessionId: latest?.runtimeSessionId ?? null,
    agentName: latest?.agentName ?? null,
    instanceId: latest?.instanceId ?? null,
    // latestStatus 即 latestRound 的状态(finishGroup 同源),running 说明最新一轮就是
    // 在跑会话;runningCount>0 但最新一轮已结束时不得指名执行人。
    currentExecutor: latest !== null && group.latestStatus === "running",
    runningCount: group.runningCount,
    roundCount: group.roundCount,
    latestStatus: group.latestStatus,
    latestActivityAt: group.latestActivityAt,
    // 非任务组(decision/未归属)没有任务投影可言,不声明「任务状态未知」。
    taskClaim: taskId === null ? null : fleetTaskClaimOf(tasks.get(taskId)),
  };
}

function byActivityDesc(left: FleetExecutionRow, right: FleetExecutionRow): number {
  const leftAt = Date.parse(left.latestActivityAt),
    rightAt = Date.parse(right.latestActivityAt);
  // 时间瞬值比较而非字符串:同流上毫秒/秒精度 ISO 共存,字典序会判反(agent-runtime 的教训)。
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
  if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1;
  return left.key.localeCompare(right.key);
}

export function deriveFleetExecution(input: {
  readonly groups: readonly AgentRuntimeSessionGroupDto[];
  readonly tasks: readonly TaskRow[];
  readonly decisions?: readonly { readonly decisionId: string; readonly title: string }[];
  readonly totals: { readonly groups: number; readonly sessions: number };
  readonly truncated: boolean;
}): FleetExecutionSnapshot {
  const tasks = new Map(input.tasks.map((task) => [task.taskId, task])),
    decisionTitles = new Map((input.decisions ?? []).map((decision) => [decision.decisionId, decision.title])),
    rows = input.groups.map((group) => toRow(group, tasks, decisionTitles)),
    executing = rows.filter((row) => row.runningCount > 0).sort(byActivityDesc),
    finished = rows.filter((row) => row.runningCount === 0).sort(byActivityDesc);
  return {
    executing,
    // 异常是「记录」不是「待办」:任务已 done/cancelled/archived 的行照列,但行上声明
    // 任务当前状态,不叫人处理;是否可恢复交会话详情判断。
    anomalies: finished.filter((row) => FLEET_ANOMALY_STATUSES.has(row.latestStatus)),
    results: finished,
    totals: input.totals,
    loadedGroups: input.groups.length,
    truncated: input.truncated,
  };
}
