import {
  agentRuntimeInstallationState,
  agentRuntimeSessionGroupStatusWords,
  type AgentRuntimeEventsResult,
  type AgentRuntimeSessionDto,
  type AgentRuntimeSessionGroupDto,
  type AgentRuntimeSessionGroupStatus,
  type AgentRuntimeUnattributedGroupKey,
  type RuntimeInstallationState,
} from "@harness-anything/daemon/protocol";
import type { AgendaAwaitsRow } from "../api/renderer-dto.ts";
import type { TaskDispatchProjectionRow } from "../api/renderer-dto.ts";
import type { WorkIndex, WorkRef } from "./model/work-collections.ts";
import type { RelationEdge } from "./model/types.ts";
import {
  classifySmartAttention,
  computePromptCacheTtlState,
  mostUrgentPromptCacheTtl,
  type PromptCacheTtlState,
  type SmartClass,
} from "./model/smart-attention.ts";

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

// ---- 五级智能注意力与 Prompt Cache TTL(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3) ----

/** ISO 时间串 → epoch ms;缺失/不可解析返回 null,绝不虚构时间。 */
export function epochMsOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 生命周期事件(protocol 未单独再导出,从 events 读面结果取元素类型,不另立镜像)。 */
export type SessionLifecycleEvent = AgentRuntimeEventsResult["events"][number];
export type SessionLifecycleEventType = SessionLifecycleEvent["type"];

/**
 * 「等你处理」的源实体引用集:active awaits 边指向读者的 task/<id>、decision/<id>
 * (dec_DF67F23066BAFE444190A191B5),加上待审批(评审中)的 decision。会话侧 needsYou
 * 全部从这个集合命中,模型层不重复判断审批语义。
 */
export function needsYouRefs(
  awaitingYou: readonly Pick<AgendaAwaitsRow, "sourceRef">[],
  pendingDecisionIds: readonly string[] = [],
): ReadonlySet<string> {
  const refs = new Set<string>(awaitingYou.map((row) => row.sourceRef));
  for (const decisionId of pendingDecisionIds) refs.add(`decision/${decisionId}`);
  return refs;
}

/** 组级命中:任务组对 task/<taskId>,Decision 组对 decision/<decisionId>;未归属组不可能是 Needs you。 */
export function sessionGroupNeedsYou(group: SessionGroup, refs: ReadonlySet<string>): boolean {
  if (group.taskId !== undefined && refs.has(`task/${group.taskId}`)) return true;
  return group.decisionId !== undefined && refs.has(`decision/${group.decisionId}`);
}

/**
 * 生命周期事件里能证明「provider 上下文刚被触达」的类型:会话启动(首轮 prompt 建立
 * 缓存)与结果观测(一轮收口,该轮最后一次模型调用刚发生)。工具循环内的中间调用在
 * 生命周期读面不可见,这是该层最细的诚实代理。
 */
const CACHE_TOUCH_EVENT_TYPES: ReadonlySet<SessionLifecycleEventType> = new Set([
  "runtime_session_started",
  "runtime_session_outcome_observed",
]);

/** 从增量生命周期事件派生两个注意力时间戳(epoch ms,未知 null)。 */
export type SessionEventTimeline = {
  /** 最近一轮活动:最后一条生命周期事件的 occurredAt。 */
  readonly lastTurnActivityAt: number | null;
  /** 最近一次 Prompt Cache 触达(口径见 CACHE_TOUCH_EVENT_TYPES)。 */
  readonly lastCacheTouchAt: number | null;
};
export function sessionEventTimeline(events: readonly SessionLifecycleEvent[]): SessionEventTimeline {
  let lastTurnActivityAt: number | null = null,
    lastCacheTouchAt: number | null = null;
  for (const event of events) {
    const at = epochMsOf(event.occurredAt);
    if (at === null) continue;
    if (lastTurnActivityAt === null || at > lastTurnActivityAt) lastTurnActivityAt = at;
    if (CACHE_TOUCH_EVENT_TYPES.has(event.type) && (lastCacheTouchAt === null || at > lastCacheTouchAt))
      lastCacheTouchAt = at;
  }
  return { lastTurnActivityAt, lastCacheTouchAt };
}

/** 会话侧完整注意力投影:五级分类 + 缓存 TTL,时钟由调用方注入。 */
export type SessionAttention = {
  readonly smartClass: SmartClass;
  readonly needsYou: boolean;
  readonly lastTurnActivityAt: number | null;
  readonly lastCacheTouchAt: number | null;
  readonly cacheTtl: PromptCacheTtlState | null;
};

/** 单会话:session DTO 有 liveness 与 outcome 证据,是五级分级最精确的输入。 */
export function sessionAttention(
  session: AgentRuntimeSessionDto,
  refs: ReadonlySet<string>,
  timeline: SessionEventTimeline = EMPTY_EVENT_TIMELINE,
  nowMs: number,
): SessionAttention {
  const needsYou = session.associations.some((association) => refs.has(`task/${association.taskId}`)),
    observedAt = epochMsOf(session.activity.lastObservedAt),
    lastTurnActivityAt = timeline.lastTurnActivityAt ?? observedAt;
  return {
    smartClass: classifySmartAttention(
      {
        status: session.semanticState ?? "unavailable",
        liveness: session.liveness,
        needsYou,
        lastTurnActivityAt,
        settledAt: session.activity.outcome === null ? null : observedAt,
      },
      nowMs,
    ),
    needsYou,
    lastTurnActivityAt,
    lastCacheTouchAt: timeline.lastCacheTouchAt,
    cacheTtl: computePromptCacheTtlState(timeline.lastCacheTouchAt, nowMs),
  };
}
const EMPTY_EVENT_TIMELINE: SessionEventTimeline = { lastTurnActivityAt: null, lastCacheTouchAt: null };

/** 组级终态词表(新鲜度窗口的适用范围);running/unknown/blocked/lost/unavailable 不是收口。 */
const GROUP_TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "stopped",
  "ended-indeterminate",
]);

/** 组级投影:组没有 liveness 与收口时间戳,终态以 latestActivityAt 近似收口时刻;缓存触达按组成员会话给入,取最早失效。 */
export function sessionGroupAttention(
  group: SessionGroup,
  refs: ReadonlySet<string>,
  memberCacheTouches: readonly (number | null)[] = [],
  nowMs: number,
): SessionAttention {
  const needsYou = sessionGroupNeedsYou(group, refs),
    lastTurnActivityAt = epochMsOf(group.latestActivityAt);
  return {
    smartClass: classifySmartAttention(
      {
        status: group.latestStatus,
        needsYou,
        lastTurnActivityAt,
        settledAt: GROUP_TERMINAL_STATUSES.has(group.latestStatus) ? lastTurnActivityAt : null,
      },
      nowMs,
    ),
    needsYou,
    lastTurnActivityAt,
    lastCacheTouchAt: earliestCacheTouch(memberCacheTouches),
    cacheTtl: mostUrgentPromptCacheTtl(memberCacheTouches, nowMs),
  };
}

/** 轮次级投影:dispatch 行自带 endedAt,终态新鲜度有真实收口时刻;轮次读面没有缓存触达时间,不虚构。 */
export function sessionRoundAttention(round: SessionRound, refs: ReadonlySet<string>, nowMs: number): SessionAttention {
  const needsYou = refs.has(`task/${round.taskId}`),
    lastTurnActivityAt = epochMsOf(round.endedAt) ?? epochMsOf(round.startedAt);
  return {
    smartClass: classifySmartAttention(
      {
        status: round.status,
        needsYou,
        lastTurnActivityAt,
        settledAt: epochMsOf(round.endedAt),
      },
      nowMs,
    ),
    needsYou,
    lastTurnActivityAt,
    lastCacheTouchAt: null,
    cacheTtl: null,
  };
}

function earliestCacheTouch(touches: readonly (number | null)[]): number | null {
  let earliest: number | null = null;
  for (const touch of touches) {
    if (touch === null || !Number.isFinite(touch)) continue;
    if (earliest === null || touch < earliest) earliest = touch;
  }
  return earliest;
}

/** 任务 → 组内各会话的缓存触达时间(组级 TTL 的输入);没有事件证据的会话不进桶。 */
export function sessionCacheTouchesByTask(
  sessions: readonly AgentRuntimeSessionDto[],
  touchBySessionId: ReadonlyMap<string, number | null>,
): ReadonlyMap<string, readonly (number | null)[]> {
  const byTask = new Map<string, (number | null)[]>();
  for (const session of sessions) {
    const touch = touchBySessionId.get(session.runtimeSessionId);
    if (touch === undefined) continue;
    for (const association of session.associations) {
      const bucket = byTask.get(association.taskId) ?? [];
      bucket.push(touch);
      byTask.set(association.taskId, bucket);
    }
  }
  return byTask;
}

/**
 * 生命周期事件能无歧义决定的状态转换。outcome_observed 不在表里:该事件 DTO 不带
 * payload,succeeded/failed 无法分辨,终态词留给下一次 daemon 投影读,增量层只推时间戳。
 */
const LIFECYCLE_STATUS_TRANSITIONS: Readonly<Partial<Record<SessionLifecycleEventType, SessionStatus>>> = {
  runtime_session_started: "running",
  runtime_session_cancelled: "cancelled",
  runtime_session_exited: "ended-indeterminate",
};

/**
 * 会话 DTO 的增量补丁:只改命中会话、只改事件能决定的字段(时间戳推进 + 三个无歧义
 * 转换);无命中事件原样返回同一个引用,避免 React Query 缓存无谓重渲。
 */
export function applyLifecycleEventsToSession(
  session: AgentRuntimeSessionDto,
  events: readonly SessionLifecycleEvent[],
): AgentRuntimeSessionDto {
  let current = session;
  for (const event of events) {
    if (event.runtimeSessionId !== current.runtimeSessionId) continue;
    const lastObservedAt =
      event.occurredAt > current.activity.lastObservedAt ? event.occurredAt : current.activity.lastObservedAt;
    if (event.type === "runtime_session_started")
      current = {
        ...current,
        liveness: "live",
        semanticState: "running",
        activity: { ...current.activity, lastObservedAt },
      };
    else if (event.type === "runtime_session_cancelled")
      current = {
        ...current,
        semanticState: "cancelled",
        activity: { ...current.activity, lastObservedAt, outcome: "cancelled" },
      };
    else if (event.type === "runtime_session_exited")
      current = {
        ...current,
        liveness: "exited",
        // 与 kernel runtimeSessionSemanticState 同一条规则:outcome 已知用 outcome 词,缺失/unknown 是 ended-indeterminate。
        semanticState:
          current.activity.outcome !== null && current.activity.outcome !== "unknown"
            ? current.activity.outcome
            : "ended-indeterminate",
        activity: { ...current.activity, lastObservedAt },
      };
    else if (lastObservedAt !== current.activity.lastObservedAt)
      current = { ...current, activity: { ...current.activity, lastObservedAt } };
  }
  return current;
}

/**
 * 组级增量补丁:组 DTO 不携带成员会话清单,只有组头 latestRound 的会话能定位到组,
 * 补丁限定在该会话上——推进 latestActivityAt、按无歧义转换改 latestStatus 并重算
 * runningCount(该轮在 running↔终态间翻转时 ±1)。
 */
export function applyLifecycleEventsToSessionGroups(
  groups: readonly SessionGroup[],
  events: readonly SessionLifecycleEvent[],
): readonly SessionGroup[] {
  return groups.map((group) => {
    const round = group.latestRound;
    if (round === null) return group;
    const owned = events.filter((event) => event.runtimeSessionId === round.runtimeSessionId);
    if (owned.length === 0) return group;
    let latestActivityAt = group.latestActivityAt,
      latestStatus = group.latestStatus,
      runningCount = group.runningCount;
    for (const event of owned) {
      if (event.occurredAt > latestActivityAt) latestActivityAt = event.occurredAt;
      const next = LIFECYCLE_STATUS_TRANSITIONS[event.type];
      if (next !== undefined && next !== latestStatus) {
        runningCount += Number(next === "running") - Number(latestStatus === "running");
        latestStatus = next;
      }
    }
    return { ...group, latestActivityAt, latestStatus, runningCount, latestRound: { ...round, status: latestStatus } };
  });
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
  /** dispatch 行的收口时刻;终态新鲜度窗口(Done 级)的真实判据,未收口为 null。 */
  readonly endedAt: string | null;
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
    endedAt: row.endedAt ?? null,
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
