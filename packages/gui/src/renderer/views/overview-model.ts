import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaRegionWeights,
  AgendaTaskRow,
  AgendaAttentionItem,
  CiObservatoryRead,
  WorkIndexRead,
} from "../../api/renderer-dto.ts";
import type { AgentRuntimeOverviewResult } from "@harness-anything/daemon/protocol";
import type { AgendaSuccess } from "../api-client.ts";
import type { SnapshotStatus } from "../model/types";

/**
 * 总览(S3)的纯派生层:从已挂载的读面(repo.agenda.read 的 attentionItems/regionWeights、
 * repo.works.index、repo.agentRuntime.overview、repo.ci.observatory.read、observe.tail 事件页)
 * 推出各区域的行模型。不做任何取数,不重推 daemon 的判据——注意力分、分组、权重全部
 * 透传 S1;这里只做「行怎么显示、落在哪个区域、动作给谁」的投影。
 */

/** 注意力类别的显示档(原型 v4 KIND 表;label 走 i18n,tone 决定标签色)。 */
export type AttentionTone = "bad" | "wait" | "done" | "neutral";
export const ATTENTION_META: Readonly<
  Record<AgendaAttentionItem["kind"], { readonly tone: AttentionTone; readonly rank: number }>
> = {
  "awaiting-you": { tone: "bad", rank: 1 },
  rework: { tone: "bad", rank: 2 },
  adjudication: { tone: "bad", rank: 3 },
  decision: { tone: "wait", rank: 4 },
  blocked: { tone: "bad", rank: 5 },
  stalled: { tone: "wait", rank: 6 },
  answered: { tone: "done", rank: 7 },
  archive: { tone: "neutral", rank: 8 },
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

/** 原型 v4 `ago()`:分钟 → 小时 → 天;停滞/阻塞按天显示(入口在调用方)。 */
export function ageOf(iso: string, now: string): string {
  const hours = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分`;
  if (hours < 48) return `${Math.round(hours)} 时`;
  return `${Math.round(hours / 24)} 天`;
}

/** 停滞/阻塞的年龄按天(原型的 stuck 行口径);<1 天显示「<1 天」。 */
export function staleDaysOf(iso: string, now: string): string {
  const days = (Date.parse(now) - Date.parse(iso)) / 86_400_000;
  return days < 1 ? "<1 天" : `${Math.round(days)} 天`;
}

/** main CI 状态:观察窗里 main 分支最新一次 run 失败即红(区域只在这时出现)。 */
export function mainCiFailure(ci: CiObservatoryRead | undefined): {
  readonly job: string;
  readonly occurredAt: string;
  readonly failing: number;
} | null {
  if (ci?.status !== "ready") return null;
  const mainRuns = ci.runs
    .filter((run) => run.branch === "main")
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  const latest = mainRuns[0];
  if (latest === undefined || latest.pass) return null;
  const failing = mainRuns.filter((run) => !run.pass).length;
  return { job: latest.job, occurredAt: latest.occurredAt, failing };
}

/** CI 区域权重:红时 60(压过一切常规区域),绿时 0(不落位)。 */
export const CI_REGION_WEIGHT = 60;

export function overviewWeights(
  weights: AgendaRegionWeights | undefined,
  ci: CiObservatoryRead | undefined,
): {
  readonly mine: number;
  readonly stuck: number;
  readonly run: number;
  readonly review: number;
  readonly queue: number;
  readonly recent: number;
  readonly works: number;
  readonly ci: number;
} {
  const base = weights ?? { mine: 0, stuck: 0, run: 0, review: 0, queue: 0, recent: 0, works: 0 };
  return { ...base, ci: mainCiFailure(ci) === null ? 0 : CI_REGION_WEIGHT };
}

/** 执行中区域:live 会话一行(who = kind · model,what = 关联任务标题)。 */
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
  const titleOf = new Map<string, string>((agenda?.inFlight ?? []).map((row) => [row.taskId, row.title] as const));
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

/** 执行中区域的「无人」行:在飞任务里没有 live 会话关联的。 */
export function idleInFlightCount(
  overview: AgentRuntimeOverviewResult | undefined,
  agenda: AgendaSuccess | undefined,
): number {
  const liveTasks = new Set(
    (overview?.sessions ?? []).flatMap((session) =>
      session.liveness === "live" ? session.associations.map(({ taskId }) => taskId) : [],
    ),
  );
  return (agenda?.inFlight ?? []).filter(({ taskId }) => !liveTasks.has(taskId)).length;
}

/** 工作区域:每个工作一行,注意力 = 名下 attentionItems 的最高分(同一套分数)。 */
export interface WorkRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly counts: Readonly<Partial<Record<SnapshotStatus, number>>>;
  readonly doneRatio: number;
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
      let effective = 0,
        done = 0;
      for (const [key, count] of Object.entries(work.counts)) {
        const status = SEG_STATUS[key] ?? "unknown";
        counts[status] = (counts[status] ?? 0) + count;
        if (status !== "cancelled") effective += count;
        if (status === "done") done += count;
      }
      const attention = byWork.get(work.taskId) ?? { mine: 0, top: 0 };
      return {
        taskId: work.taskId,
        title: work.title,
        status: (work.status as SnapshotStatus) ?? "unknown",
        counts,
        doneRatio: effective === 0 ? 0 : done / effective,
        mineCount: attention.mine,
        topScore: attention.top,
        lastActivityAt: work.lastActivityAt,
      };
    })
    .sort(
      (left, right) =>
        right.topScore - left.topScore ||
        right.mineCount - left.mineCount ||
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
}

/** 置顶待派:可派且置顶的承诺(原型 QUEUE;行显示读面给的 pinned 标记)。 */
export function pinnedDispatchable(agenda: AgendaSuccess | undefined): readonly AgendaTaskRow[] {
  return (agenda?.dispatchable ?? []).filter((row) => row.pinned);
}

/** 最近变化:observe.tail 事件页 → 一行一事件(时间、类型、摘要、可跳实体)。 */
export interface RecentEventRow {
  readonly key: string;
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly ref: string | null;
}

export type RecentEventSource = {
  readonly key: string;
  readonly at: string | null;
  readonly type: string;
  readonly summary: string | null;
  readonly taskId: string | null;
  readonly decisionId: string | null;
};

export function recentEventRows(events: readonly RecentEventSource[], limit = 16): readonly RecentEventRow[] {
  return events
    .filter((event) => event.at !== null)
    .slice(0, limit)
    .map((event) => ({
      key: event.key,
      at: event.at!,
      type: event.type,
      summary: event.summary ?? event.type,
      ref:
        event.taskId !== null
          ? `task/${event.taskId}`
          : event.decisionId !== null
            ? `decision/${event.decisionId}`
            : null,
    }));
}

/** 评审与合并区域的行:打回/待初审/任务评审中/决策评审中/待点头,按读面分组顺序。 */
export interface ReviewRow {
  readonly id: string;
  readonly group: "rework" | "adjudication" | "taskReviewing" | "decisionReviewing" | "decisionPending";
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

/** ReviewRow 的评审计数分布(评审与合并区域顶部计数条用)。 */
export function reviewCounts(rows: readonly ReviewRow[]): {
  readonly rework: number;
  readonly adjudication: number;
  readonly taskReviewing: number;
  readonly decisionReviewing: number;
  readonly decisionPending: number;
} {
  const counts = { rework: 0, adjudication: 0, taskReviewing: 0, decisionReviewing: 0, decisionPending: 0 };
  for (const row of rows) counts[row.group] += 1;
  return counts;
}
