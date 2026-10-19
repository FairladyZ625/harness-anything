import {
  agentRuntimeInstallationState,
  agentRuntimeSessionGroupStatusWords,
  type AgentRuntimeSessionDto,
  type AgentRuntimeSessionGroupDto,
  type AgentRuntimeSessionGroupStatus,
  type AgentRuntimeUnattributedGroupKey,
  type RuntimeInstallationState,
} from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import type { WorkIndex, WorkRef } from "./model/work-collections.ts";
import type { RelationEdge } from "./model/types.ts";

/**
 * 会话页的纯数据模型(设计稿 §2–§5):组、轮次行、孤儿会话行全部是 daemon 读面的
 * 纯投影——组与检索在 daemon 侧完成(sessionGroups / squad.runs.list),前端不拉全会话、
 * 不做前端分组。这里只做展示级派生:状态词表映射、短码、相对时间、轮次编号。
 */
/** `work` is a GUI-only grouping: the daemon read stays `groupBy=task` and the page buckets by the
 *  resident work index (dec_5F7E74F1). Never pass `work` to `sessionGroups`. */
export type SessionGroupBy = "work" | "task" | "squad" | "agent" | "day";
export type DaemonSessionGroupBy = Exclude<SessionGroupBy, "work">;
export type SessionGroup = AgentRuntimeSessionGroupDto;

export function daemonSessionGroupBy(groupBy: SessionGroupBy): DaemonSessionGroupBy {
  return groupBy === "work" ? "task" : groupBy;
}

/** 可钻入的组头:只有台账带真实 agentId/squadId 的组才有「看它的全部会话」读面。 */
export type SessionDrillTarget = {
  readonly kind: "agent" | "squad";
  readonly id: string;
  readonly label: string;
};

export function sessionDrillTarget(group: SessionGroup): SessionDrillTarget | null {
  if (group.kind === "agent" && group.agentId !== undefined)
    return { kind: "agent", id: group.agentId, label: group.label };
  if (group.kind === "squad" && group.squadId !== undefined)
    return { kind: "squad", id: group.squadId, label: group.label };
  return null;
}

/** 工作层的一个桶:一个工作根,或「散件」/Decision 评审两个诚实特例。 */
export type SessionWorkGroup = {
  /** `work:<taskId>` / `loose` / `decision-review`. */
  readonly key: string;
  readonly kind: "work" | "loose" | "decision";
  /** 工作标题;`loose` 与 `decision` 桶留给视图按 i18n 命名。 */
  readonly label: string;
  readonly workTaskId: string | null;
  readonly taskGroups: readonly SessionGroup[];
  readonly taskCount: number;
  readonly sessionCount: number;
  readonly roundCount: number;
  readonly runningCount: number;
  readonly latestStatus: SessionStatus;
  readonly latestActivityAt: string;
};

const LOOSE_WORK_KEY = "loose",
  DECISION_WORK_KEY = "decision-review";

/**
 * 把 daemon 的 task 组按常驻工作索引归桶(方案 A / task_4b83acdd):
 * 工作 → 任务 → 会话。无工作归属的任务组落「散件」,Decision 评审组没有 taskId,
 * 单独成桶而不是冒充任务。桶按「有在跑优先 → 最新活动」排,两个特例桶殿后。
 */
export function sessionWorkGroups(groups: readonly SessionGroup[], works: WorkIndex): readonly SessionWorkGroup[] {
  const byWork = new Map<string, { readonly work: WorkRef; readonly groups: SessionGroup[] }>(),
    loose: SessionGroup[] = [],
    decisions: SessionGroup[] = [];
  for (const group of groups) {
    if (group.kind === "decision") {
      decisions.push(group);
      continue;
    }
    const work = group.taskId === undefined ? null : works.workOf(group.taskId);
    if (work === null) {
      loose.push(group);
      continue;
    }
    const bucket = byWork.get(work.taskId) ?? { work, groups: [] };
    bucket.groups.push(group);
    byWork.set(work.taskId, bucket);
  }
  const summarize = (
    key: string,
    kind: SessionWorkGroup["kind"],
    label: string,
    workTaskId: string | null,
    taskGroups: readonly SessionGroup[],
  ): SessionWorkGroup => {
    let sessionCount = 0,
      roundCount = 0,
      runningCount = 0,
      latestActivityAt = "",
      latestStatus: SessionStatus = "unknown";
    for (const group of taskGroups) {
      sessionCount += group.sessionCount;
      roundCount += group.roundCount;
      runningCount += group.runningCount;
      if (group.latestActivityAt > latestActivityAt) {
        latestActivityAt = group.latestActivityAt;
        latestStatus = group.latestStatus;
      }
    }
    return {
      key,
      kind,
      label,
      workTaskId,
      taskGroups,
      taskCount: taskGroups.length,
      sessionCount,
      roundCount,
      runningCount: runningCount,
      latestStatus: runningCount > 0 ? "running" : latestStatus,
      latestActivityAt,
    };
  };
  const workBuckets = [...byWork.values()]
    .map(({ work, groups: taskGroups }) =>
      summarize(`work:${work.taskId}`, "work", work.title, work.taskId, taskGroups),
    )
    .sort(
      (left, right) =>
        Number(right.runningCount > 0) - Number(left.runningCount > 0) ||
        right.latestActivityAt.localeCompare(left.latestActivityAt) ||
        left.key.localeCompare(right.key),
    );
  return [
    ...workBuckets,
    ...(decisions.length > 0 ? [summarize(DECISION_WORK_KEY, "decision", "", null, decisions)] : []),
    ...(loose.length > 0 ? [summarize(LOOSE_WORK_KEY, "loose", "", null, loose)] : []),
  ];
}

/** 一个任务属于哪个工作桶(搜索命中单组时用来展开它的工作)。 */
export function sessionWorkKeyForTask(works: WorkIndex, taskId: string | undefined): string | null {
  if (taskId === undefined) return LOOSE_WORK_KEY;
  const work = works.workOf(taskId);
  return work === null ? LOOSE_WORK_KEY : `work:${work.taskId}`;
}
/** 单会话段的状态词表:daemon 语义状态 + 台账侧 unknown/lost,一个总映射,新词表必须落位。 */
export type SessionStatus = AgentRuntimeSessionGroupStatus;
export const sessionStatusDot: Readonly<Record<SessionStatus, "live" | "failed" | "idle">> = {
  running: "live",
  failed: "failed",
  lost: "failed",
  succeeded: "idle",
  cancelled: "idle",
  stopped: "idle",
  blocked: "failed",
  unknown: "idle",
  "ended-indeterminate": "idle",
  unavailable: "idle",
};
export const sessionStatusTone: Readonly<Record<SessionStatus, string>> = {
  succeeded: "text-status-done",
  failed: "text-status-blocked",
  cancelled: "text-status-cancelled",
  stopped: "text-status-unknown",
  blocked: "text-status-blocked",
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
  stopped: "agentRuntime.sessionStatusStopped",
  blocked: "agentRuntime.sessionStatusBlocked",
  unknown: "agentRuntime.sessionStatusUnknown",
  lost: "agentRuntime.sessionStatusLost",
  "ended-indeterminate": "agentRuntime.sessionStatusEndedIndeterminate",
  unavailable: "agentRuntime.sessionStatusUnavailable",
};
/** 状态筛选控件的词序:与 daemon 的状态词表同一份,前端不另立顺序或分类。 */
export const sessionStatusFilterWords = agentRuntimeSessionGroupStatusWords;
/**
 * 未归属桶按缺失原因分名:daemon 侧一个桶三种成因(无任务绑定 / 无小队 / 无派工记录),
 * 前端此前把三者一律显示成「未归属」。key 是 daemon 给的稳定判别式,label 走 i18n。
 */
export const sessionUnattributedKey: Readonly<Record<AgentRuntimeUnattributedGroupKey, string>> = {
  "unattributed:no-task": "agentRuntime.unattributedNoTask",
  "unattributed:no-squad": "agentRuntime.unattributedNoSquad",
  "unattributed:no-dispatch": "agentRuntime.unattributedNoDispatch",
};

export const sessionInstallationBadgeKey: Readonly<
  Record<RuntimeInstallationState, "agentRuntime.installationMissing" | null>
> = {
  present: null,
  missing: "agentRuntime.installationMissing",
};

export function sessionInstallationBadge(session: Pick<AgentRuntimeSessionDto, "installationState">) {
  return sessionInstallationBadgeKey[agentRuntimeInstallationState(session)];
}

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
  readonly classification: TaskDispatchProjectionRow["classification"];
  readonly resume: TaskDispatchProjectionRow["resume"] | null;
  readonly nextAction: string | null;
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
    classification: row.classification,
    resume: row.resume ?? null,
    nextAction: row.nextAction ?? null,
    delegation: sessionDelegation(row),
  }));
}

/** 钻入读面已批量取回该执行者的派工行:按任务组分好轮次,组头一展开即有行,不再二次读。 */
export function sessionRoundsByTask(
  groups: readonly SessionGroup[],
  dispatches: readonly TaskDispatchProjectionRow[],
): ReadonlyMap<string, readonly SessionRound[]> {
  const byTask = new Map<string, TaskDispatchProjectionRow[]>();
  for (const row of dispatches) {
    const rows = byTask.get(row.taskId);
    if (rows === undefined) byTask.set(row.taskId, [row]);
    else rows.push(row);
  }
  const result = new Map<string, readonly SessionRound[]>();
  for (const group of groups)
    if (group.taskId !== undefined)
      result.set(group.taskId, sessionRounds(group.taskId, group.label, byTask.get(group.taskId) ?? []));
  return result;
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
