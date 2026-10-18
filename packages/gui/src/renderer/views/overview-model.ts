import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaTaskRow,
  AgendaAttentionItem,
  TaskWipRead,
  WorkIndexRead,
} from "../../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { AgendaSuccess } from "../api-client.ts";
import type { CadenceFeedEvent } from "../model/cadence.ts";
import type { SnapshotStatus } from "../model/types";
import type { WorkDayGroup, WorkStepKind } from "../model/workspace-narrative.ts";
import { workDayGroups } from "../model/workspace-narrative.ts";
import { WIP_STATUS_ORDER } from "./OverviewTaskWip.tsx";

/**
 * 总览的纯派生层(2026-10-04 重构:注意力优先):从已挂载的读面(repo.agenda.read 的
 * attentionItems 与各分组、repo.works.index、repo.agentRuntime.overview、repo.ci.observatory.read、
 * observe.tail 事件页、repo.tasks.wip)推出首块「需要你处理」、主区「关注的工作」与紧凑
 * 下钻入口的行模型。不做任何取数,不重推 daemon 的判据——注意力分、分组全部透传 S1;
 * 这里只做「行怎么显示、落在哪个块、动作给谁」的投影。
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
};

/** 注意力行接回源行:行上的动作(答复/裁决/跳转)需要源读面的完整行。 */
export type AttentionSource =
  | { readonly kind: "awaits"; readonly row: AgendaAwaitsRow }
  | { readonly kind: "answered"; readonly row: AgendaAnsweredRow }
  | { readonly kind: "rework"; readonly row: AgendaTaskRow }
  | { readonly kind: "adjudication"; readonly row: AgendaExecutionRow }
  | { readonly kind: "decision"; readonly row: AgendaDecisionRow }
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
 * `ha task adjudicate --forward/--return` 是 owning CEO 的机器双闸(CLI 帮助原文),不是
 * 用户动作,住「跟进与返工」。已答复跟进(answered)、评审打回(rework)与阻塞/停滞
 * (blocked/stalled)同样不冒充需要用户。
 */
export type DecisionKind = "awaiting-you" | "decision";

export interface DecisionRow {
  /** attentionItem 的 ref(relation/<id> · execution/<id> · decision/<id>)。 */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly title: string;
  readonly workTaskId: string | null;
  /** awaiting-you 源行的问句;其余为 null(问题由类别的固定说明承担)。 */
  readonly question: string | null;
  /** awaiting-you 源行的请求类别(question/acceptance/consent/reopen)。 */
  readonly askKind: AgendaAwaitsRow["askKind"] | null;
  /** decision 源行的风险档。 */
  readonly riskTier: AgendaDecisionRow["riskTier"] | null;
  readonly since: string | null;
  readonly source: AttentionSource | null;
  /** daemon 注意力分(排序透传 S1,不在 GUI 重算)。 */
  readonly score: number;
}

const isDecisionKind = (kind: AgendaAttentionItem["kind"]): kind is DecisionKind =>
  kind === "awaiting-you" || kind === "decision";

export function decisionRows(agenda: AgendaSuccess | undefined): readonly DecisionRow[] {
  if (agenda === undefined) return [];
  return attentionEntries(agenda, "mine").flatMap(({ item, since, source }) => {
    if (!isDecisionKind(item.kind)) return [];
    return [
      {
        id: item.ref,
        kind: item.kind,
        title: item.title,
        workTaskId: item.workTaskId,
        question: source?.kind === "awaits" ? source.row.question : null,
        askKind: source?.kind === "awaits" ? source.row.askKind : null,
        riskTier: source?.kind === "decision" ? source.row.riskTier : null,
        since,
        source,
        score: item.attention.score,
      },
    ];
  });
}

/**
 * 「跟进与返工」下钻入口的行:不需要本人动手的五类。tone 一律 wait/neutral——机器/
 * owning CEO 可处理的阻塞与初审不亮红,避免视觉上冒充需要用户;返工的文案只陈述事实
 * (评审打回、待返工),不断言归属,是否需要人由看的人判断。
 */
export type FollowUpKind = "answered" | "adjudication" | "rework" | "blocked" | "stalled" | "audit-finding";

export interface FollowUpRow {
  readonly id: string;
  readonly kind: FollowUpKind;
  readonly title: string;
  readonly workTaskId: string | null;
  readonly since: string | null;
  readonly source: AttentionSource | null;
}

const isFollowUpKind = (kind: AgendaAttentionItem["kind"]): kind is FollowUpKind =>
  kind === "answered" ||
  kind === "adjudication" ||
  kind === "rework" ||
  kind === "blocked" ||
  kind === "stalled" ||
  kind === "audit-finding";

export function followUpRows(agenda: AgendaSuccess | undefined): readonly FollowUpRow[] {
  if (agenda === undefined) return [];
  return [...attentionEntries(agenda, "mine"), ...attentionEntries(agenda, "stuck")].flatMap(
    ({ item, since, source }) => {
      if (!isFollowUpKind(item.kind)) return [];
      return [{ id: item.ref, kind: item.kind, title: item.title, workTaskId: item.workTaskId, since, source }];
    },
  );
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
        definition = session.definitionSnapshot;
      return {
        runtimeSessionId: session.runtimeSessionId,
        who: definition === null ? session.kindId : `${session.kindId} · ${definition.model}`,
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
 * 主区「关注的工作」(2026-10-11 业主意见 4; 2026-10-14 活跃执行置顶与最新活动倒序):
 * 排序准则:
 * 1. 活跃执行优先:名下任务当前有 live 会话在跑(handlers.length > 0,呈现层挂脉冲波呼吸条)的工作严格置顶在待命工作之前;
 * 2. 静止待命中置顶优先:均无 live 会话在跑时,显式置顶的非终态工作保留在前,近期活跃工作列于其后;
 * 3. 最新活动倒序:同等状态组内(同为在跑、同为待命置顶、同为待命近期),按最近活动时间(lastActivityAt)倒序排列(新活动在前);
 * 4. 稳定兜底:时间相同时平滑回退至注意力最高分降序、本人卡点数与 taskId 定序。
 * 此外:处于活跃执行状态的工作即使超出活动窗口天数,也绝不被截断隐藏。已收尾的置顶工作不进列表,只计数提及。
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
): { readonly watched: readonly WatchedWork[]; readonly pinnedClosed: number } {
  const rows = workRows(works, agenda);
  const members = new Map((works?.works ?? []).map((work) => [work.taskId, work.memberTaskIds] as const));
  const pinnedIds = new Set(
    (agenda?.pinnedEntities ?? [])
      .filter((entity) => entity.kind === "task")
      .map((entity) => entity.ref.replace(/^task\//u, "")),
  );
  const pinnedClosed = [...pinnedIds].filter((id) => {
    const row = rows.find((entry) => entry.taskId === id);
    return row !== undefined && TERMINAL_WORK.has(row.status);
  }).length;
  const cutoff = activity === undefined ? null : Date.parse(activity.now) - Math.max(1, activity.days) * 86_400_000;
  const runningOf = (taskId: string, memberTaskIds: readonly string[]): number =>
    workHandlers(runtime, taskId, memberTaskIds).length > 0 ? 1 : 0;
  const entryOf = (source: WatchedWork["source"]) => (work: WorkRow) => ({
    work,
    source,
    memberTaskIds: members.get(work.taskId) ?? [],
  });

  const pinnedEntries = rows
    .filter((row) => pinnedIds.has(row.taskId) && !TERMINAL_WORK.has(row.status))
    .map(entryOf("pinned"));
  const recentEntries = rows
    .filter((row) => {
      if (pinnedIds.has(row.taskId) || TERMINAL_WORK.has(row.status)) return false;
      const memberTasks = members.get(row.taskId) ?? [];
      const isRunning = runningOf(row.taskId, memberTasks) > 0;
      return isRunning || cutoff === null || Date.parse(row.lastActivityAt) >= cutoff;
    })
    .map(entryOf("recent"));

  const watched = [...pinnedEntries, ...recentEntries].sort((left, right) => {
    // 1. 活跃执行优先置顶 (live 会话处理者非空,挂脉冲呼吸光条)
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

  return { watched, pinnedClosed };
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

/**
 * 「执行与下钻 → 进行中的任务」的内联名单行(2026-10-11 合并在飞任务流;2026-10-14 执行中置顶与最新活动倒序):
 * 排序准则:
 * 1. 活跃执行优先:当前有 live 会话在跑(handlers.length > 0,呈现层挂脉冲波呼吸条)的任务严格置顶在待命任务之前;
 * 2. 最新活动倒序:同为执行中或同为待命中时,按最新可观察活动时间(since)倒序排列(新活动在前、旧在后);
 * 3. 稳定兜底:活动时间相同或均缺失时,平滑回退到议程注意力分降序、状态生命周期序与 taskId 定序。
 */
export interface DrillWipRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskWipRead["counted"][number]["status"];
  readonly score: number;
  /** 该任务名下 live 会话的执行者去重(who = kind · model);空 = 静止待命。 */
  readonly handlers: readonly string[];
  /** 最近一次可观察活动(live 会话的 lastObservedAt,兜底议程行 updatedAt);null = 未知。 */
  readonly since: string | null;
}

export function drillWipRows(
  wip: TaskWipRead | undefined,
  runtime: AgentRuntimeOverviewResult | undefined,
  agenda: AgendaSuccess | undefined,
): readonly DrillWipRow[] {
  if (wip === undefined) return [];
  const scores = taskAttentionScores(agenda);
  const sessions = new Map<string, { handlers: string[]; latest: string }>();
  for (const run of runRows(runtime, agenda)) {
    if (run.taskId === null) continue;
    const held = sessions.get(run.taskId) ?? { handlers: [], latest: run.lastObservedAt };
    if (!held.handlers.includes(run.who)) held.handlers.push(run.who);
    if (Date.parse(run.lastObservedAt) > Date.parse(held.latest)) held.latest = run.lastObservedAt;
    sessions.set(run.taskId, held);
  }
  // 议程里全部带 taskId 的任务行都能给 updatedAt(在飞/停滞/待返工/可派…),做年龄兜底。
  const agendaUpdatedAt = new Map<string, string>();
  for (const row of agenda?.inFlight ?? []) agendaUpdatedAt.set(row.taskId, row.updatedAt);
  for (const row of agenda?.stalled ?? []) agendaUpdatedAt.set(row.taskId, row.updatedAt);
  for (const row of agenda?.waitingOnOthers ?? []) agendaUpdatedAt.set(row.taskId, row.updatedAt);
  for (const row of agenda?.awaitingRework ?? []) agendaUpdatedAt.set(row.taskId, row.updatedAt);
  for (const row of agenda?.dispatchable ?? []) agendaUpdatedAt.set(row.taskId, row.updatedAt);
  return wip.counted
    .map((entry) => {
      const session = sessions.get(entry.taskId);
      return {
        ...entry,
        score: scores.get(entry.taskId) ?? 0,
        handlers: session?.handlers ?? [],
        since: session?.latest ?? agendaUpdatedAt.get(entry.taskId) ?? null,
      };
    })
    .sort((left, right) => {
      const leftRunning = left.handlers.length > 0 ? 1 : 0;
      const rightRunning = right.handlers.length > 0 ? 1 : 0;
      if (rightRunning !== leftRunning) return rightRunning - leftRunning;

      const leftTime = left.since !== null ? Date.parse(left.since) || 0 : 0;
      const rightTime = right.since !== null ? Date.parse(right.since) || 0 : 0;
      if (rightTime !== leftTime) return rightTime - leftTime;

      return (
        right.score - left.score ||
        WIP_STATUS_ORDER.indexOf(left.status) - WIP_STATUS_ORDER.indexOf(right.status) ||
        left.taskId.localeCompare(right.taskId)
      );
    });
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

/** 评审与合并的行:打回/待初审/任务评审中/决策评审中/待点头,按读面分组顺序。 */
export interface ReviewRow {
  readonly id: string;
  readonly group:
    | "rework"
    | "adjudication"
    | "taskReviewing"
    | "decisionNeedsReview"
    | "decisionReviewing"
    | "decisionPending";
  readonly title: string;
  readonly detail: string | null;
  readonly since: string;
  readonly taskId: string | null;
  readonly decisionId: string | null;
}

export function reviewRows(agenda: AgendaSuccess | undefined): readonly ReviewRow[] {
  if (agenda === undefined) return [];
  return [
    ...agenda.awaitingRework.map((row): ReviewRow => {
      const entry: ReviewRow = {
        id: `rework:${row.taskId}`,
        group: "rework",
        title: row.title,
        detail: null,
        since: row.updatedAt,
        taskId: row.taskId,
        decisionId: null,
      };
      return entry;
    }),
    ...agenda.awaitingAdjudication.map(
      (row): ReviewRow => ({
        id: `adjudication:${row.executionId}`,
        group: "adjudication",
        title: row.title,
        detail: null,
        since: row.submittedAt,
        taskId: row.taskId,
        decisionId: null,
      }),
    ),
    ...agenda.underReview.map(
      (row): ReviewRow => ({
        id: `taskReviewing:${row.executionId}`,
        group: "taskReviewing",
        title: row.title,
        detail: null,
        since: row.submittedAt,
        taskId: row.taskId,
        decisionId: null,
      }),
    ),
    ...agenda.awaitingDecisionReview.map(
      (row): ReviewRow => ({
        id: `decisionNeedsReview:${row.decisionId}`,
        group: "decisionNeedsReview",
        title: row.title,
        detail: null,
        since: row.proposedAt,
        taskId: null,
        decisionId: row.decisionId,
      }),
    ),
    ...agenda.decisionReviewInProgress.flatMap((row): ReviewRow[] => [
      {
        id: `decisionReviewing:${row.decisionId}`,
        group: "decisionReviewing",
        title: row.title,
        detail: null,
        since: row.proposedAt,
        taskId: null,
        decisionId: row.decisionId,
      },
    ]),
    ...agenda.awaitingDecision.map(
      (row): ReviewRow => ({
        id: `decisionPending:${row.decisionId}`,
        group: "decisionPending",
        title: row.title,
        detail: null,
        since: row.proposedAt,
        taskId: null,
        decisionId: row.decisionId,
      }),
    ),
  ];
}

/** ReviewRow 的评审计数分布(下钻入口与放大层顶部计数条用)。 */
export function reviewCounts(rows: readonly ReviewRow[]): {
  readonly rework: number;
  readonly adjudication: number;
  readonly taskReviewing: number;
  readonly decisionNeedsReview: number;
  readonly decisionReviewing: number;
  readonly decisionPending: number;
} {
  const counts = {
    rework: 0,
    adjudication: 0,
    taskReviewing: 0,
    decisionNeedsReview: 0,
    decisionReviewing: 0,
    decisionPending: 0,
  };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}
