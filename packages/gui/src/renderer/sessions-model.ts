import type {
  AgentRuntimeSessionDto,
  AgentRuntimeSessionGroupDto,
  AgentRuntimeSessionGroupStatus,
} from "../../../daemon/src/agent-runtime-contract.ts";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import type { RelationEdge } from "./model/types.ts";
import { t } from "./i18n/index.tsx";
import { formatTime } from "./model/time.ts";

/**
 * 会话页的纯数据模型(设计稿 §2–§5):组、轮次行、孤儿会话行全部是 daemon 读面的
 * 纯投影——组与检索在 daemon 侧完成(sessionGroups / squad.runs.list),前端不拉全会话、
 * 不做前端分组。这里只做展示级派生:状态词表映射、短码、相对时间、轮次编号。
 */
export type SessionGroupBy = "task" | "squad" | "agent" | "day";
export type SessionGroup = AgentRuntimeSessionGroupDto;
/** 单会话段的状态词表:daemon 语义状态 + 台账侧 unknown/lost,一个总映射,新词表必须落位。 */
export type SessionStatus = AgentRuntimeSessionGroupStatus;
export const sessionStatusDot: Readonly<Record<SessionStatus, "live" | "failed" | "idle">> = {
  running: "live",
  failed: "failed",
  lost: "failed",
  succeeded: "idle",
  cancelled: "idle",
  unknown: "idle",
  "ended-indeterminate": "idle",
  unavailable: "idle",
};
export const sessionStatusTone: Readonly<Record<SessionStatus, string>> = {
  succeeded: "text-status-done",
  failed: "text-status-blocked",
  cancelled: "text-status-cancelled",
  running: "text-status-active",
  unknown: "text-status-unknown",
  lost: "text-status-unknown",
  "ended-indeterminate": "text-status-unknown",
  unavailable: "text-text-faint",
};
export const sessionStatusKey: Readonly<Record<SessionStatus, string>> = {
  running: "agentRuntime.sessionStatusRunning",
  succeeded: "agentRuntime.sessionStatusSucceeded",
  failed: "agentRuntime.sessionStatusFailed",
  cancelled: "agentRuntime.sessionStatusCancelled",
  unknown: "agentRuntime.sessionStatusUnknown",
  lost: "agentRuntime.sessionStatusLost",
  "ended-indeterminate": "agentRuntime.sessionStatusEndedIndeterminate",
  unavailable: "agentRuntime.sessionStatusUnavailable",
};

/** 组展开行之一:一轮派工(一个 dispatchId 一轮),按 startedAt 倒序编号。 */
export type SessionRound = {
  readonly kind: "round";
  readonly roundIndex: number;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly squadId: string | null;
  readonly instanceId: string;
  readonly taskId: string;
  readonly taskTitle: string | null;
  readonly startedAt: string;
  readonly status: SessionStatus;
  readonly delegation: string | null;
};
/** 组展开行之二:绑定了任务但没有派工记录的会话(「无派工记录」小节)。 */
export type SessionOrphan = {
  readonly kind: "orphan";
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly taskId: string;
  readonly taskTitle: string | null;
  readonly startedAt: string;
  readonly status: SessionStatus;
};
export type SessionRow = SessionRound | SessionOrphan;

/** 委托链展示:`leader → worker`,无委托时为 null(与 dispatch 头同源,不推断)。 */
export function sessionDelegation(row: TaskDispatchProjectionRow): string | null {
  if (!row.delegatedByAgentId || !row.agentId) return null;
  const leader = row.delegatedByAgentName ?? row.delegatedByAgentId,
    worker = row.agentName ?? row.agentId;
  return `${leader} → ${worker}`;
}

/** 一个任务组的全部轮次行:dispatch 台账顺序(新→旧)即编号顺序,第 1 轮最新。 */
export function sessionRounds(
  taskId: string,
  taskTitle: string | null,
  dispatches: readonly TaskDispatchProjectionRow[],
): readonly SessionRound[] {
  const ordered = [...dispatches].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return ordered.map((row, index) => ({
    kind: "round" as const,
    roundIndex: ordered.length - index,
    runtimeSessionId: row.runtimeSessionId,
    dispatchId: row.dispatchId,
    agentId: row.agentId ?? null,
    agentName: row.agentName ?? row.agentId ?? null,
    squadId: row.squadId ?? null,
    instanceId: row.instanceId,
    taskId,
    taskTitle,
    startedAt: row.startedAt,
    status: row.status,
    delegation: sessionDelegation(row),
  }));
}

/** 与任务绑定但派工台账没有记录的会话:组尾「无派工记录」小节的来源。 */
export function sessionOrphans(
  taskId: string,
  taskTitle: string | null,
  sessions: readonly AgentRuntimeSessionDto[],
  rounds: readonly SessionRound[],
): readonly SessionOrphan[] {
  const dispatched = new Set(rounds.map((round) => round.runtimeSessionId));
  return sessions
    .filter(
      (session) =>
        !dispatched.has(session.runtimeSessionId) &&
        session.associations.some((association) => association.taskId === taskId),
    )
    .map((session) => ({
      kind: "orphan" as const,
      runtimeSessionId: session.runtimeSessionId,
      instanceId: session.instanceId,
      taskId,
      taskTitle,
      startedAt: session.activity.lastObservedAt,
      status: session.semanticState ?? "unavailable",
    }));
}

/** 该任务的 Decision 出口:全局关系里 decision→task 的 derives/relates 边(无边则空)。 */
export function sessionDecisionRefs(relations: readonly RelationEdge[], taskId: string): readonly string[] {
  const target = `task/${taskId}`;
  return relations
    .filter(
      (edge) =>
        edge.to === target && edge.from.startsWith("decision/") && (edge.kind === "derives" || edge.kind === "relates"),
    )
    .map((edge) => edge.from);
}

/** 短码展示:`task_1994…`。title 上已有完整 id 的场合(链接)不必再用。 */
export function shortRef(id: string, keep = 12): string {
  return id.length > keep ? `${id.slice(0, keep)}…` : id;
}

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前,更早回落日期。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t("agentRuntime.sessionsJustNow");
  if (seconds < 3600) return t("agentRuntime.sessionsMinutesAgo", { minutes: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("agentRuntime.sessionsHoursAgo", { hours: Math.floor(seconds / 3600) });
  if (seconds < 30 * 86_400) return t("agentRuntime.sessionsDaysAgo", { days: Math.floor(seconds / 86_400) });
  return formatTime(iso, { style: "date-time" }) ?? iso;
}
