import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaRulingRow,
  AgendaTaskRow,
  AgendaAttentionItem,
  TaskDispatchProjectionRow,
  WorkIndexRead,
} from "../../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult, AgentRuntimeSessionGroupDto } from "@harness-anything/daemon/protocol";
import type { AgendaSuccess } from "../api-client.ts";
import type { CadenceFeedEvent } from "../model/cadence.ts";
import type { AttestationPoolLanes } from "../model/attestation-pool.ts";
import { runtimeModelShortLabel } from "../model/runtime-models.ts";
import type { SnapshotStatus } from "../model/types";
import type { WorkDayGroup, WorkStepKind } from "../model/workspace-narrative.ts";
import { workDayGroups } from "../model/workspace-narrative.ts";
import type { AgentActivity } from "../components/agent-ui/AgentTree.tsx";
import type { AgentHandoff, AgentLane, AgentLaneTask } from "../components/agent-ui/AgentLanes.tsx";

/**
 * 总览的纯派生层(2026-10-04 重构:注意力优先;2026-10-20 W2-T1 接入 Orca 五级序数与
 * Agent 泳道):从已挂载的读面(repo.agenda.read 的 attentionItems 与各分组、
 * repo.works.index、repo.agentRuntime.overview、observe.tail 事件页、repo.tasks.wip、
 * runtime-session-groups 与活跃 agent 的派工成员页)推出首块「需要你处理」、主区
 * 「关注的工作」与 Agent 泳道的行模型。不做任何取数,不重推 daemon 的判据——注意力分、
 * 分组全部透传 S1;这里只做「行怎么显示、落在哪个块、动作给谁」的投影。
 */

/** 注意力类别的显示档(label 走 i18n,tone 决定标签色)。 */
export type AttentionTone = "bad" | "wait" | "done" | "neutral";
export const ATTENTION_META: Readonly<
  Record<AgendaAttentionItem["kind"], { readonly tone: AttentionTone; readonly rank: number }>
> = {
  "awaiting-you": { tone: "bad", rank: 1 },
  rework: { tone: "bad", rank: 2 },
  adjudication: { tone: "wait", rank: 3 },
  decision: { tone: "wait", rank: 4 },
  blocked: { tone: "bad", rank: 5 },
  stalled: { tone: "wait", rank: 6 },
  answered: { tone: "wait", rank: 7 },
  archive: { tone: "neutral", rank: 8 },
  "audit-finding": { tone: "wait", rank: 9 },
  "unsubmitted-delivery": { tone: "bad", rank: 2 },
  // 无人值守派工停下等裁决:和 awaiting-you 同为「球在你手里」,用同一档橙(不是待评审的琥珀)。
  ruling: { tone: "bad", rank: 1 },
  // 守卫拒绝的升级:要 CEO 处理,但不是提问,同样顶置。
  "needs-handling": { tone: "bad", rank: 1 },
};

/** 注意力行接回源行:行上的动作(答复/裁决/跳转)需要源读面的完整行。 */
export type AttentionSource =
  | { readonly kind: "awaits"; readonly row: AgendaAwaitsRow }
  | { readonly kind: "answered"; readonly row: AgendaAnsweredRow }
  | { readonly kind: "rework"; readonly row: AgendaTaskRow }
  | { readonly kind: "adjudication"; readonly row: AgendaExecutionRow }
  | { readonly kind: "decision"; readonly row: AgendaDecisionRow }
  | { readonly kind: "ruling"; readonly row: AgendaRulingRow }
  | { readonly kind: "task"; readonly row: AgendaTaskRow };

export interface AttentionEntry {
  readonly item: AgendaAttentionItem;
  /** 行右侧的等待/停滞时长(源行的时间字段;接不回源行时为 null,只显示分数)。 */
  readonly since: string | null;
  readonly source: AttentionSource | null;
}

/** 把 attentionItems 的 ref 接回各源分组;同一 ref 在 daemon 侧已按分最高者去重。 */
export function attentionSources(agenda: AgendaSuccess): Map<string, AttentionSource> {
  const sources = new Map<string, AttentionSource>();
  for (const row of agenda.awaitingYou) sources.set(`relation/${row.relationId}`, { kind: "awaits", row });
  for (const row of agenda.answeredForYou) sources.set(`relation/${row.relationId}`, { kind: "answered", row });
  for (const row of agenda.awaitingRework) sources.set(`task/${row.taskId}`, { kind: "rework", row });
  for (const row of agenda.awaitingAdjudication)
    sources.set(`execution/${row.executionId}`, { kind: "adjudication", row });
  for (const row of agenda.awaitingDecision) sources.set(`decision/${row.decisionId}`, { kind: "decision", row });
  for (const row of agenda.awaitingRuling ?? []) sources.set(`dispatch/${row.dispatchId}`, { kind: "ruling", row });
  for (const row of agenda.waitingOnOthers) sources.set(`task/${row.taskId}`, { kind: "task", row });
  for (const row of agenda.stalled) sources.set(`task/${row.taskId}`, { kind: "task", row });
  return sources;
}

/** 行右侧时长的来源字段:每类源行携带自己的时间(askedAt/answeredAt/submittedAt/…)。 */
function sinceOf(source: AttentionSource): string | null {
  switch (source.kind) {
    case "awaits":
      return source.row.askedAt;
    case "answered":
      return source.row.answeredAt;
    case "adjudication":
      return source.row.submittedAt;
    case "decision":
      return source.row.proposedAt;
    case "ruling":
      return source.row.askedAt;
    case "rework":
    case "task":
      return source.row.updatedAt;
  }
}

export function attentionEntries(
  agenda: AgendaSuccess,
  region: AgendaAttentionItem["region"],
  sources: Map<string, AttentionSource> = attentionSources(agenda),
): readonly AttentionEntry[] {
  return (agenda.attentionItems ?? [])
    .filter((item) => item.region === region)
    .map((item) => {
      const source = sources.get(item.ref) ?? null;
      return { item, since: source === null ? null : sinceOf(source), source };
    });
}

/**
 * 首块「需要你处理」的两类:真实要本人动手的 awaits 边(question/acceptance/consent/
 * reopen 问的人)与待点头的 decision(裁决带人工同意通道)。待初审的 execution 不在此:
 * 提交自动派评审,changes_requested 自动重开返工,只有预算耗尽的切面才等业主处置
 * (dec_E369B861 CH3),都住「跟进与返工」。已答复跟进(answered)与阻塞/停滞
 * (blocked/stalled)同样不冒充需要用户。
 */
export type DecisionKind = "awaiting-you" | "decision" | "ruling" | "needs-handling";

export interface DecisionRow {
  /** attentionItem 的 ref(relation/<id> · execution/<id> · decision/<id>)。 */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly title: string;
  readonly workTaskId: string | null;
  /** awaiting-you / ruling 源行的问句;其余为 null(问题由类别的固定说明承担)。 */
  readonly question: string | null;
  /** ruling 源行的可选项;答复即从其中选一条(或自拟)。 */
  readonly options: readonly string[];
  /** awaiting-you 源行的请求类别(question/acceptance/consent/reopen)。 */
  readonly askKind: AgendaAwaitsRow["askKind"] | null;
  /** decision 源行的风险档。 */
  readonly riskTier: AgendaDecisionRow["riskTier"] | null;
  readonly since: string | null;
  readonly source: AttentionSource | null;
  /** daemon 注意力分(排序透传 S1,不在 GUI 重算)。 */
  readonly score: number;
}

export const isDecisionKind = (kind: AgendaAttentionItem["kind"]): kind is DecisionKind =>
  kind === "awaiting-you" || kind === "decision" || kind === "ruling" || kind === "needs-handling";

export function decisionRows(agenda: AgendaSuccess | undefined): readonly DecisionRow[] {
  if (agenda === undefined) return [];
  return attentionEntries(agenda, "mine")
    .flatMap(({ item, since, source }) => {
      if (!isDecisionKind(item.kind)) return [];
      return [
        {
          id: item.ref,
          kind: item.kind,
          title: item.title,
          workTaskId: item.workTaskId,
          question:
            source?.kind === "awaits" ? source.row.question : source?.kind === "ruling" ? source.row.question : null,
          options: source?.kind === "ruling" ? source.row.options : [],
          askKind: source?.kind === "awaits" ? source.row.askKind : null,
          riskTier: source?.kind === "decision" ? source.row.riskTier : null,
          since,
          source,
          score: item.attention.score,
        },
      ];
    })
    .sort(
      (left, right) =>
        // Orca 五级序数(dec_C0AF8CBBFFECF71F4F34FB76F9/CH4):Needs you(class 1)绝对顶置——
        // awaiting-you(提问阻塞,橙 tone)与 ruling(派工停下等裁决)排在 decision(待点头)
        // 之前;同级内才轮到注意力分。
        Number(left.kind === "decision") - Number(right.kind === "decision") ||
        right.score - left.score ||
        left.id.localeCompare(right.id),
    );
}

/** 有 Needs you 项的工作根集合(侧栏置顶区与总览关注工作行共用的「等你处理」判据)。 */
export function needsYouWorkIds(agenda: AgendaSuccess | undefined): ReadonlySet<string> {
  if (agenda === undefined) return new Set();
  return new Set(decisionRows(agenda).flatMap(({ workTaskId }) => (workTaskId === null ? [] : [workTaskId])));
}

/**
 * 「等你处理的事」第三类:任务侧的人签(待我签门禁 / 待我同意收口 / 阻断需特批)。
 * 判据不在这里重推——直接消费 model/attestation-pool.ts 的同一条派生(与侧栏角标、
 * 待办签发总池同一读面同一判据),每任务收敛成一行,行上给真实动作。
 * 2026-10-21 冷眼评估指出的矛盾:「没有等你处理的事项」与侧栏「待办签发 4」并存;
 * 两类事项同属「等人动手」,总览必须一起呈现,空态才有资格说「没有」。
 */
export interface AttestationPendingRow {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  /** 三类动作之一:签门禁 / 特批放行 / 同意收口。 */
  readonly kind: "gate" | "breakGlass" | "consent";
  /** 具体门名(gate/breakGlass);consent 为 null。 */
  readonly gateId: string | null;
  /** 同一任务上还有几项同类动作(一行收敛,计数如实)。 */
  readonly more: number;
}

export function attestationPendingRows(lanes: AttestationPoolLanes): readonly AttestationPendingRow[] {
  // 每任务一行:动作都落在同一个任务详情,门名保留第一项,其余只在 more 里如实计数。
  const byTask = new Map<string, { row: AttestationPendingRow; count: number }>();
  const add = (row: AttestationPendingRow): void => {
    const held = byTask.get(row.taskId);
    if (held === undefined) byTask.set(row.taskId, { row, count: 1 });
    else held.count += 1;
  };
  for (const gate of lanes.gates)
    add({
      id: `${gate.taskId}:${gate.gateId}`,
      taskId: gate.taskId,
      title: gate.taskTitle,
      kind: "gate",
      gateId: gate.gateId,
      more: 0,
    });
  for (const gate of lanes.breakGlass)
    add({
      id: `${gate.taskId}:${gate.gateId}`,
      taskId: gate.taskId,
      title: gate.taskTitle,
      kind: "breakGlass",
      gateId: gate.gateId,
      more: 0,
    });
  for (const consent of lanes.consents)
    add({
      id: `${consent.taskId}:consent`,
      taskId: consent.taskId,
      title: consent.taskTitle,
      kind: "consent",
      gateId: null,
      more: 0,
    });
  return [...byTask.values()].map(({ row, count }) => ({ ...row, more: count - 1 }));
}

/** live 会话一行(who = kind · model):关注工作卡的「处理者」与安静状态行的计数来源。 */
export interface RunRow {
  readonly runtimeSessionId: string;
  readonly who: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly lastObservedAt: string;
}

export function runRows(
  overview: AgentRuntimeOverviewResult | undefined,
  agenda: AgendaSuccess | undefined,
): readonly RunRow[] {
  if (overview === undefined) return [];
  // 会话关联的任务不一定还在「在飞」里(评审中、刚提交的也有 live 会话):从议程所有带标题的行里找标题。
  const titleOf = new Map<string, string>();
  for (const rows of Object.values(agenda ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows as readonly { readonly taskId?: unknown; readonly title?: unknown }[]) {
      if (typeof row?.taskId === "string" && typeof row.title === "string" && !titleOf.has(row.taskId))
        titleOf.set(row.taskId, row.title);
    }
  }
  return overview.sessions
    .filter((session) => session.liveness === "live")
    .map((session) => {
      const taskId = session.associations[0]?.taskId ?? null,
        definition = session.definitionSnapshot,
        // 会话型运行时把候选清单写进 model(JSON 数组文本):列表行只给短标签,完整
        // 候选悬停可见,元组字符串不进正文(解析单点在 model/runtime-models.ts)。
        model = runtimeModelShortLabel(definition?.model);
      return {
        runtimeSessionId: session.runtimeSessionId,
        who: model === null ? session.kindId : `${session.kindId} · ${model}`,
        taskId,
        taskTitle: taskId === null ? null : (titleOf.get(taskId) ?? null),
        lastObservedAt: session.activity.lastObservedAt,
      };
    })
    .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
}

/** 工作区域:每个工作一行,注意力 = 名下 attentionItems 的最高分(同一套分数)。 */
export interface WorkRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly counts: Readonly<Partial<Record<SnapshotStatus, number>>>;
  readonly mineCount: number;
  readonly topScore: number;
  readonly lastActivityAt: string;
}

const SEG_STATUS: Readonly<Record<string, SnapshotStatus>> = {
  done: "done",
  executing: "active",
  pending: "submitted",
  blocked: "blocked",
  planned: "planned",
  cancelled: "cancelled",
};

/** 已结束的工作不再需要注意力:排序时一律沉到非终态工作之后。 */
const TERMINAL_WORK: ReadonlySet<SnapshotStatus> = new Set(["done", "cancelled"]);

export function workRows(works: WorkIndexRead | undefined, agenda: AgendaSuccess | undefined): readonly WorkRow[] {
  if (works === undefined) return [];
  const byWork = new Map<string, { mine: number; top: number }>();
  for (const item of agenda?.attentionItems ?? []) {
    if (item.workTaskId === null) continue;
    const held = byWork.get(item.workTaskId) ?? { mine: 0, top: 0 };
    if (item.region === "mine") held.mine += 1;
    held.top = Math.max(held.top, item.attention.score);
    byWork.set(item.workTaskId, held);
  }
  return works.works
    .map((work): WorkRow => {
      const counts: Partial<Record<SnapshotStatus, number>> = {};
      for (const [key, count] of Object.entries(work.counts)) {
        const status = SEG_STATUS[key] ?? "unknown";
        counts[status] = (counts[status] ?? 0) + count;
      }
      const attention = byWork.get(work.taskId) ?? { mine: 0, top: 0 };
      return {
        taskId: work.taskId,
        title: work.title,
        status: (work.status as SnapshotStatus) ?? "unknown",
        counts,
        mineCount: attention.mine,
        topScore: attention.top,
        lastActivityAt: work.lastActivityAt,
      };
    })
    .sort(
      (left, right) =>
        Number(TERMINAL_WORK.has(left.status)) - Number(TERMINAL_WORK.has(right.status)) ||
        right.topScore - left.topScore ||
        right.mineCount - left.mineCount ||
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
}

/**
 * 主区「关注的工作」(2026-10-11 业主意见 4; 2026-10-14 活跃执行置顶与最新活动倒序;
 * 2026-10-20 W2-T1 接入 Orca 五级序数):排序准则:
 * 0. Needs you 绝对顶置:名下任务有 awaiting-you/待点头项的工作排在一切之前(它卡在等人);
 * 1. 活跃执行优先:名下任务当前有 live 会话在跑(handlers.length > 0,呈现层挂脉冲波呼吸条)的工作置顶在待命工作之前;
 * 2. 静止待命中置顶优先:均无 live 会话在跑时,显式置顶的非终态工作保留在前,近期活跃工作列于其后;
 * 3. 最新活动倒序:同等状态组内(同为在跑、同为待命置顶、同为待命近期),按最近活动时间(lastActivityAt)倒序排列(新活动在前);
 * 4. 稳定兜底:时间相同时平滑回退至注意力最高分降序、本人卡点数与 taskId 定序。
 * 此外:处于活跃执行状态的工作即使超出活动窗口天数,也绝不被截断隐藏;已收尾的置顶工作
 * 仍然列出(业主 2026-10-21:不管 pin 什么,总览上都要能看到),只是按终态沉到后面。
 */
export interface WatchedWork {
  readonly work: WorkRow;
  readonly source: "pinned" | "recent";
  /** 该工作名下的任务(根除外;repo.works.index 的归属,不在 GUI 重推)。 */
  readonly memberTaskIds: readonly string[];
}

/** 「关注的工作活动天数」的声明默认值;设置面读到别的值时以设置为准。 */
export const WATCHED_ACTIVITY_DAYS_DEFAULT = 3;

export function watchedWorks(
  works: WorkIndexRead | undefined,
  agenda: AgendaSuccess | undefined,
  activity?: { readonly days: number; readonly now: string },
  runtime?: AgentRuntimeOverviewResult | undefined,
): readonly WatchedWork[] {
  const rows = workRows(works, agenda);
  const members = new Map((works?.works ?? []).map((work) => [work.taskId, work.memberTaskIds] as const));
  const needsYouIds = needsYouWorkIds(agenda);
  const pinnedIds = new Set(
    (agenda?.pinnedEntities ?? [])
      .filter((entity) => entity.kind === "task")
      .map((entity) => entity.ref.replace(/^task\//u, "")),
  );
  const cutoff = activity === undefined ? null : Date.parse(activity.now) - Math.max(1, activity.days) * 86_400_000;
  const runningOf = (taskId: string, memberTaskIds: readonly string[]): number =>
    workHandlers(runtime, taskId, memberTaskIds).length > 0 ? 1 : 0;
  const entryOf = (source: WatchedWork["source"]) => (work: WorkRow) => ({
    work,
    source,
    memberTaskIds: members.get(work.taskId) ?? [],
  });

  // 置顶的工作根一律列出,含已收尾的:pin 是业主的显式承诺,终态只影响排序,不隐藏。
  const pinnedEntries = rows.filter((row) => pinnedIds.has(row.taskId)).map(entryOf("pinned"));
  const recentEntries = rows
    .filter((row) => {
      if (pinnedIds.has(row.taskId) || TERMINAL_WORK.has(row.status)) return false;
      const memberTasks = members.get(row.taskId) ?? [];
      const isRunning = runningOf(row.taskId, memberTasks) > 0;
      return isRunning || cutoff === null || Date.parse(row.lastActivityAt) >= cutoff;
    })
    .map(entryOf("recent"));

  const watched = [...pinnedEntries, ...recentEntries].sort((left, right) => {
    // -1. 已收尾的置顶工作仍列出,但沉到非终态之后:它们不再需要注意力,只是仍被 pin 住。
    const leftTerminal = TERMINAL_WORK.has(left.work.status) ? 1 : 0;
    const rightTerminal = TERMINAL_WORK.has(right.work.status) ? 1 : 0;
    if (rightTerminal !== leftTerminal) return leftTerminal - rightTerminal;

    // 0. Needs you 绝对顶置(Orca 五级序数的第 1 级,dec_C0AF8CBBFFECF71F4F34FB76F9/CH4):
    //    名下有 awaiting-you/待点头项的工作排在一切运行态之前——它卡在等人,不是在干活。
    const leftNeedsYou = needsYouIds.has(left.work.taskId) ? 1 : 0;
    const rightNeedsYou = needsYouIds.has(right.work.taskId) ? 1 : 0;
    if (rightNeedsYou !== leftNeedsYou) return rightNeedsYou - leftNeedsYou;

    // 1. 活跃执行优先置顶 (live 会话处理者非空,挂脉冲波呼吸光条)
    const leftRunning = runningOf(left.work.taskId, left.memberTaskIds);
    const rightRunning = runningOf(right.work.taskId, right.memberTaskIds);
    if (rightRunning !== leftRunning) return rightRunning - leftRunning;

    // 2. 静止待命中,置顶优先于近期
    if (leftRunning === 0 && rightRunning === 0) {
      const leftPinned = left.source === "pinned" ? 1 : 0;
      const rightPinned = right.source === "pinned" ? 1 : 0;
      if (rightPinned !== leftPinned) return rightPinned - leftPinned;
    }

    // 3. 最新活动时间倒序(新活动在前、旧在后)
    const leftTime = Date.parse(left.work.lastActivityAt) || 0;
    const rightTime = Date.parse(right.work.lastActivityAt) || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;

    // 4. 同为在跑且活动时间相同时,置顶优先
    const leftPinned = left.source === "pinned" ? 1 : 0;
    const rightPinned = right.source === "pinned" ? 1 : 0;
    if (rightPinned !== leftPinned) return rightPinned - leftPinned;

    // 5. 稳定兜底(注意力最高分、本人卡点数、taskId)
    return (
      right.work.topScore - left.work.topScore ||
      right.work.mineCount - left.work.mineCount ||
      left.work.taskId.localeCompare(right.work.taskId)
    );
  });

  return watched;
}

/**
 * 工作卡的处理者:该工作名下任务(含根)关联的 live 会话执行者去重(who = kind · model)。
 * 非空 = 活跃执行(呈现层挂呼吸光条);空 = 静止待命,安静排版,不输出消极文本。
 */
export function workHandlers(
  runtime: AgentRuntimeOverviewResult | undefined,
  rootTaskId: string,
  memberTaskIds: readonly string[],
): readonly string[] {
  const tasks = new Set([rootTaskId, ...memberTaskIds]);
  const handlers: string[] = [];
  for (const run of runRows(runtime, undefined)) {
    if (run.taskId === null || !tasks.has(run.taskId) || handlers.includes(run.who)) continue;
    handlers.push(run.who);
  }
  return handlers;
}

/** taskId → 议程注意力分(repo.tasks.wip 的行自己没有分数,从 attentionItems 的 task/ 引用取)。
 * 同一任务命中多条注意力项时取最高分;排序透传 S1,不在 GUI 重算。 */
export function taskAttentionScores(agenda: AgendaSuccess | undefined): Map<string, number> {
  const scores = new Map<string, number>();
  for (const item of agenda?.attentionItems ?? []) {
    if (!item.ref.startsWith("task/")) continue;
    const taskId = item.ref.slice("task/".length);
    scores.set(taskId, Math.max(scores.get(taskId) ?? 0, item.attention.score));
  }
  return scores;
}

/** taskId → 该任务上未决 awaits 的问句源行(泳道块「待拍板」动作与问句提示的数据源)。 */
export function awaitsByTask(agenda: AgendaSuccess | undefined): ReadonlyMap<string, AgendaAwaitsRow> {
  const byTask = new Map<string, AgendaAwaitsRow>();
  for (const row of agenda?.awaitingYou ?? []) {
    if (!row.sourceRef.startsWith("task/")) continue;
    const taskId = row.sourceRef.slice("task/".length);
    if (!byTask.has(taskId)) byTask.set(taskId, row);
  }
  return byTask;
}

/* ------------------------------------------------------------------ Agent 泳道(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2/CH4,替换旧 WIP 平铺名单) */

/** 泳道读窗:最近 6 小时内有会话的 agent 才进泳道(战情总览看「现在」,历史归会话页)。 */
export const AGENT_LANES_WINDOW_MS = 6 * 3_600_000;
/** 每条泳道最多画的任务块数(成员页按 startedAt 新→旧取前 N)。 */
export const AGENT_LANES_BLOCKS_PER_LANE = 8;
/** 最多读成员页的活跃 agent 数(超出按 runningCount 降序取前 N,截断如实不猜)。 */
export const AGENT_LANES_ACTIVE_AGENTS = 6;
/** 活跃 agent 成员页的派工行上限(daemon 端 limit,1..500)。 */
export const AGENT_LANES_MEMBER_PAGE = 12;

/**
 * 派工行状态词 → 泳道块状态(AgentActivity 五词)。lost/unverifiable 在原语词表里没有
 * 独立档,按「不可证运行」落 idle 灰——不冒充失败,也不冒充在跑。
 */
const LANE_ACTIVITY_OF_DISPATCH: Readonly<Record<TaskDispatchProjectionRow["status"], AgentActivity>> = {
  running: "running",
  blocked: "awaiting",
  succeeded: "done",
  failed: "failed",
  unknown: "idle",
  cancelled: "idle",
  stopped: "idle",
  lost: "idle",
};

/** 派工行的这一步:reviewTarget 是 daemon 对「这次派工在评审什么」的直接读法。 */
function stageOfDispatch(row: TaskDispatchProjectionRow): AgentLaneStage {
  if (row.reviewTarget?.kind === "decision") return "review-decision";
  if (row.reviewTarget?.kind === "task") return "review-task";
  return "implementation";
}

/** 组轮次状态词(session 词表)→ 泳道块状态。 */
const LANE_ACTIVITY_OF_ROUND: Readonly<Record<AgentRuntimeSessionGroupDto["latestStatus"], AgentActivity>> = {
  running: "running",
  blocked: "awaiting",
  succeeded: "done",
  failed: "failed",
  unknown: "idle",
  cancelled: "idle",
  stopped: "idle",
  lost: "idle",
  "ended-indeterminate": "idle",
  unavailable: "idle",
};

/** 组级 latestStatus 的终态集合(非 running 即视为已收口,块给确定的 endAt)。 */
const GROUP_RUNNING: ReadonlySet<AgentRuntimeSessionGroupDto["latestStatus"]> = new Set(["running"]);

/** 块在生命周期的哪一步:实现(普通派工)或评审(派工头带 reviewTarget)。 */
export type AgentLaneStage = "implementation" | "review-task" | "review-decision";

export interface AgentLaneBlockSource {
  /** 块归属任务的 id(待拍板动作的落点)。 */
  readonly taskId: string;
  /** 块背后的会话(缓存触达读面按它订阅);latestRound 兜底块可能没有对应运行会话。 */
  readonly runtimeSessionId: string | null;
  /** 该块当前挂未决 awaits(动作开答复面板而不是跳任务)。 */
  readonly awaiting: boolean;
  /** 这一步是派工行 reviewTarget 的直接读法;兜底块没有派工行时为 null(不猜)。 */
  readonly stage: AgentLaneStage | null;
}

export interface OverviewAgentLanes {
  readonly lanes: readonly AgentLane[];
  readonly handoffs: readonly AgentHandoff[];
  /** blockId → 源信息:视图层据此接「待拍板」动作与块内 CacheTimer。 */
  readonly blockOf: ReadonlyMap<string, AgentLaneBlockSource>;
  /** 运行中块的会话 id 集合(视图层按它读增量事件流,算 Prompt Cache 触达)。 */
  readonly runningSessionIds: readonly string[];
}

/**
 * 「执行与下钻 → 进行中的任务」的泳道数据(dec_C0AF8CBBFFECF71F4F34FB76F9 CH4 原位替换
 * 旧 WIP 静态平铺名单):一条泳道一个 agent(sessionGroups 按 agent 分组),任务块来自该
 * agent 的成员派工页(真 startedAt/endedAt/status);活跃 agent 的成员页缺失时用组头
 * latestRound 兜底一块。跨 Agent 交接边来自派工行的 delegatedByAgentId/parentRuntimeSessionId,
 * 源块不在窗口内的边如实不画。纯函数,时钟由调用方注入 nowMs。
 */
export function agentLanesOf(input: {
  /** sessionGroups(groupBy=agent) 当前窗口内的组。 */
  readonly groups: readonly AgentRuntimeSessionGroupDto[];
  /** 活跃 agent 的成员派工页(agentId → 派工行 + 任务标题)。 */
  readonly memberPages: ReadonlyMap<
    string,
    {
      readonly rows: readonly TaskDispatchProjectionRow[];
      readonly titleOf: ReadonlyMap<string, string>;
    }
  >;
  /** 任务标题兜底(议程标题,memberPages 的 taskLabels 之外)。 */
  readonly taskTitles: ReadonlyMap<string, string>;
  /** taskId → 未决 awaits 行(awaitsByTask 的产物)。 */
  readonly awaits: ReadonlyMap<string, AgendaAwaitsRow>;
  /** blocked 但无 awaits 问句时的兜底提示(视图层传 i18n 文案,模型保持纯)。 */
  readonly awaitingFallbackQuestion: string;
  readonly nowMs: number;
}): OverviewAgentLanes {
  const blockOf = new Map<string, AgentLaneBlockSource>();
  const runningSessionIds: string[] = [];
  if (input.groups.length === 0) return { lanes: [], handoffs: [], blockOf, runningSessionIds };

  const lanes: AgentLane[] = [];
  const dispatchRows: TaskDispatchProjectionRow[] = [];
  for (const group of input.groups) {
    // 泳道只画 agent:未归属 agent 的 Direct/no-task 会话没有「并行 Agent」语义,
    // 放进来只会把泳道变成另一份会话列表。
    if (group.agentId === undefined) continue;
    const agentId = group.agentId;
    const page = input.memberPages.get(agentId);
    const tasks: AgentLaneTask[] = [];
    const labelOf = (taskId: string): string => page?.titleOf.get(taskId) ?? input.taskTitles.get(taskId) ?? taskId;
    if (page !== undefined) {
      const rows = [...page.rows]
        // 战情总览只看当前窗口(6h):成员页会带出该 agent 更早的已收口轮次,收口块
        // 太老就不画(运行中/阻塞中的块无论起点都留,它们仍是「现在」)。
        .filter(
          (row) =>
            row.status === "running" ||
            row.status === "blocked" ||
            Date.parse(row.endedAt ?? row.startedAt) >= input.nowMs - AGENT_LANES_WINDOW_MS,
        )
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, AGENT_LANES_BLOCKS_PER_LANE);
      for (const row of rows) {
        const awaitingRow = input.awaits.get(row.taskId);
        const isAwaiting = row.status === "blocked" || awaitingRow !== undefined;
        const running = row.status === "running";
        tasks.push({
          id: row.dispatchId,
          taskId: row.taskId,
          label: labelOf(row.taskId),
          startAt: Date.parse(row.startedAt),
          // CEO 派工注记第 8 条:已收口或阻塞的块必须给 endAt(只有运行中的块随 now 生长)。
          endAt: row.endedAt !== null ? Date.parse(row.endedAt) : running ? null : input.nowMs,
          status: LANE_ACTIVITY_OF_DISPATCH[row.status],
          ...(isAwaiting
            ? {
                awaiting: {
                  question: awaitingRow?.question ?? row.reason ?? input.awaitingFallbackQuestion,
                },
              }
            : {}),
        });
        blockOf.set(row.dispatchId, {
          taskId: row.taskId,
          runtimeSessionId: row.runtimeSessionId,
          awaiting: awaitingRow !== undefined,
          stage: stageOfDispatch(row),
        });
        if (running) runningSessionIds.push(row.runtimeSessionId);
        dispatchRows.push(row);
      }
    } else if (group.latestRound !== null) {
      // 活跃 agent 之外:组头 latestRound 给最近一块上下文(确定终点,不生长)。窗口外的
      // 已收口块不画——否则时间轴会被 19 天前的历史轮次撑开,不再是「现在」。
      const round = group.latestRound,
        running = GROUP_RUNNING.has(round.status),
        inWindow = Date.parse(round.startedAt) >= input.nowMs - AGENT_LANES_WINDOW_MS;
      if (running || inWindow) {
        const awaitingRow = group.taskId !== undefined ? input.awaits.get(group.taskId) : undefined;
        const isAwaiting = round.status === "blocked" || group.latestStatus === "blocked" || awaitingRow !== undefined;
        const blockId = round.dispatchId ?? round.runtimeSessionId;
        tasks.push({
          id: blockId,
          ...(group.taskId === undefined ? {} : { taskId: group.taskId }),
          label: group.taskId === undefined ? group.label : (input.taskTitles.get(group.taskId) ?? group.label),
          startAt: Date.parse(round.startedAt),
          endAt: running ? null : Date.parse(group.latestActivityAt),
          status: LANE_ACTIVITY_OF_ROUND[round.status],
          ...(isAwaiting
            ? {
                awaiting: {
                  question: awaitingRow?.question ?? round.reason ?? input.awaitingFallbackQuestion,
                },
              }
            : {}),
        });
        if (group.taskId !== undefined) {
          blockOf.set(blockId, {
            taskId: group.taskId,
            runtimeSessionId: round.runtimeSessionId,
            awaiting: awaitingRow !== undefined,
            // 组头轮次没有 reviewTarget(它只在派工行上):没读面就不给这一步,不猜。
            stage: null,
          });
        }
      }
    }
    if (tasks.length > 0) lanes.push({ agentId, role: group.label, tasks });
  }

  // 跨 Agent 交接:worker 派工行的 parentRuntimeSessionId 指向 leader 会话;leader 的派工行
  // 在窗口内才画边(接不回源块的边不虚构)。
  const rowBySession = new Map(dispatchRows.map((row) => [row.runtimeSessionId, row] as const));
  const handoffs: AgentHandoff[] = [];
  for (const row of dispatchRows) {
    if (!row.parentRuntimeSessionId || !row.delegatedByAgentId) continue;
    const source = rowBySession.get(row.parentRuntimeSessionId);
    if (source === undefined || source.dispatchId === row.dispatchId) continue;
    handoffs.push({
      fromTaskId: source.dispatchId,
      toTaskId: row.dispatchId,
      ...(row.delegatedByAgentName === undefined ? {} : { label: `${row.delegatedByAgentName} →` }),
    });
  }
  return { lanes, handoffs, blockOf, runningSessionIds };
}

/* ------------------------------------------------------------------ 在跑的任务(2026-10-21 总览四块) */

/** 「在跑的任务」的行(窄行高密度):标题、谁在跑、起点、卡点问句。 */
export interface RunningTaskRow {
  /** 泳道块 id(dispatchId 或兜底会话 id);行上「待拍板」动作经 blockOf 接回源。 */
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  /** 执行 agent 的可读名(泳道 role,sessionGroups 的分组标签)。 */
  readonly agent: string;
  /** 模型短标签(成员派工页的 provider.model,候选清单已收短);无派工行时为 null。 */
  readonly model: string | null;
  /** 块起点(ms):「跑了多久」的分母。 */
  readonly startedAt: number;
  /** 卡点问句(blocked 且挂未决 awaits 时);null = 正在运行。 */
  readonly awaiting: string | null;
  /** 这一步:实现或评审(派工行 reviewTarget);兜底块没有派工行时为 null。 */
  readonly stage: AgentLaneStage | null;
}

/**
 * 「在跑的任务」的窄行名单(2026-10-21 业主 13:50 定案):从 agentLanesOf 的产物派生,
 * 不另立第二份窗口/兜底/awaits 拼装——泳道(任务弹层/现场页)与名单是同一份块模型的
 * 两个视图。同一任务多 agent 并行时收敛为一行(卡点优先于运行,再比起始新者),列表
 * 本身按同一准则排序:卡住的在前(业主要看「卡在哪」),其余按起始倒序。
 */
export function runningTaskRows(
  model: OverviewAgentLanes,
  modelOf: ReadonlyMap<string, string | null>,
): readonly RunningTaskRow[] {
  const byTask = new Map<string, RunningTaskRow>();
  // 行序:卡点(挂未决 awaits/blocked)优先于运行,同级按起始时间倒序(新的在前)。
  const comesBefore = (left: RunningTaskRow, right: RunningTaskRow): boolean =>
    (left.awaiting === null) !== (right.awaiting === null) ? left.awaiting !== null : left.startedAt > right.startedAt;
  for (const lane of model.lanes) {
    for (const task of lane.tasks) {
      // 已收口/失败的块不是「在跑」;无任务归属的兜底块没有落点,不进名单。
      const source = model.blockOf.get(task.id);
      if (source === undefined) continue;
      if (task.status !== "running" && task.status !== "awaiting") continue;
      const row: RunningTaskRow = {
        id: task.id,
        taskId: source.taskId,
        title: task.label,
        agent: lane.role,
        model: modelOf.get(task.id) ?? null,
        startedAt: task.startAt,
        awaiting: task.awaiting?.question ?? null,
        stage: source.stage,
      };
      const held = byTask.get(row.taskId);
      if (held === undefined || comesBefore(row, held)) byTask.set(row.taskId, row);
    }
  }
  return [...byTask.values()].sort((left, right) => (comesBefore(left, right) ? -1 : comesBefore(right, left) ? 1 : 0));
}

/** 最近变化:与工作页 DayDigest 同一派生(model/workspace-narrative.ts 的 workDayGroups)
 * ——按天收束、每任务一条路径;只有对人有意义的步骤进步骤,runtime_* 与 documents_written
 * 这类内部事件不在派生的 curated 集里。这里只做总览侧的窗口裁剪:丢没有可收束步骤的
 * 天,天序倒排(新的一天在前)。 */
export function recentDayGroups(input: {
  readonly events: readonly CadenceFeedEvent[];
  readonly titles: ReadonlyMap<string, string>;
  readonly dateKeyOf: (iso: string) => string | null;
}): readonly WorkDayGroup[] {
  return workDayGroups(input)
    .filter((group) => group.paths.length > 0)
    .reverse();
}

/**
 * 近期变化限关注工作(任务包第 3 点):收束后的路径只留关注工作名下任务,每个关注工作
 * 取最新一条;关注工作之外的事件留在原页(检修页/工作页),不进总览。
 */
export interface WorkRecentPath {
  readonly workTaskId: string;
  readonly taskId: string;
  readonly title: string | null;
  readonly firstAt: string;
  readonly steps: readonly WorkStepKind[];
}

export function watchedRecentPaths(
  recentDays: readonly WorkDayGroup[],
  watched: readonly { readonly work: { readonly taskId: string }; readonly memberTaskIds: readonly string[] }[],
): readonly WorkRecentPath[] {
  const ownerOf = new Map<string, string>();
  for (const entry of watched) {
    ownerOf.set(entry.work.taskId, entry.work.taskId);
    for (const id of entry.memberTaskIds) ownerOf.set(id, entry.work.taskId);
  }
  const latest = new Map<string, WorkRecentPath>();
  for (const group of recentDays) {
    for (const path of group.paths) {
      const workTaskId = ownerOf.get(path.taskId);
      if (workTaskId === undefined || latest.has(workTaskId)) continue;
      latest.set(workTaskId, {
        workTaskId,
        taskId: path.taskId,
        title: path.title,
        firstAt: path.firstAt,
        steps: path.steps,
      });
    }
  }
  return watched.flatMap(({ work }) => {
    const path = latest.get(work.taskId);
    return path === undefined ? [] : [path];
  });
}

/** 置顶承诺的行:置顶的非工作任务(工作根住侧栏置顶块,总览不重复列);判据用 daemon
 * 工作索引(repo.works.index),不在 GUI 里沿父链推。可派的在前,行可取消置顶。 */
export interface PinnedTaskRow {
  readonly taskId: string;
  readonly title: string;
  /** daemon 任务状态词 → 状态标签;认不出的词不猜,落 unknown 档。 */
  readonly status: SnapshotStatus;
  /** 可派的承诺(读面 dispatchable 里置顶的行):排在前面,行上保留「承诺未开工」档。 */
  readonly dispatchable: boolean;
  /** 可派行的更新时间(行右侧年龄);非可派行没有比状态更关键的量,不显示时间。 */
  readonly updatedAt: string | null;
}

const PINNED_STATUS: Readonly<Record<string, SnapshotStatus>> = {
  planned: "planned",
  active: "active",
  submitted: "submitted",
  blocked: "blocked",
  in_review: "in_review",
  done: "done",
  cancelled: "cancelled",
};

export function pinnedTaskRows(
  agenda: AgendaSuccess | undefined,
  works: WorkIndexRead | undefined,
): readonly PinnedTaskRow[] {
  if (agenda === undefined) return [];
  const workRoots = new Set((works?.works ?? []).map((work) => work.taskId));
  const dispatchable = new Map(
    agenda.dispatchable.filter((row) => row.pinned).map((row) => [row.taskId, row] as const),
  );
  // 可派的在前(承诺未开工要先派);其余按议程注意力分降序(2026-10-07 起内联名单同序)。
  const scores = taskAttentionScores(agenda);
  return agenda.pinnedEntities
    .filter((entity) => entity.kind === "task" && !workRoots.has(entity.ref.replace(/^task\//u, "")))
    .map((entity): PinnedTaskRow => {
      const taskId = entity.ref.replace(/^task\//u, ""),
        dispatch = dispatchable.get(taskId);
      return {
        taskId,
        title: entity.title,
        status: PINNED_STATUS[entity.status] ?? "unknown",
        dispatchable: dispatch !== undefined,
        updatedAt: dispatch?.updatedAt ?? null,
      };
    })
    .sort(
      (left, right) =>
        Number(right.dispatchable) - Number(left.dispatchable) ||
        (scores.get(right.taskId) ?? 0) - (scores.get(left.taskId) ?? 0),
    );
}

/** 置顶区的非任务实体行(Decision、Schedule…):daemon agenda 投影原序,行上可就地取消置顶
 * (实体级 entity-unpin 写路)。kind 用协议原词,不在 GUI 里另造词表。 */
export interface PinnedEntityRow {
  readonly ref: string;
  readonly kind: string;
  readonly title: string;
}

export function pinnedEntityRows(agenda: AgendaSuccess | undefined): readonly PinnedEntityRow[] {
  if (agenda === undefined) return [];
  return agenda.pinnedEntities
    .filter((entity) => entity.kind !== "task")
    .map((entity) => ({ ref: entity.ref, kind: entity.kind, title: entity.title }));
}
