import { isTerminalStatus, relationIsCurrent } from "@harness-anything/kernel";
import { taskPresentationReads } from "./task-presentation-read.ts";
import { workIndexFromProjection } from "./work-read.ts";
import { drainCursorPagesSync } from "./paginated-read.ts";
import type { AgendaAwaitsRow } from "./protocol/daemon-protocol-gui-types.ts";
import type { DaemonAgendaResult } from "./protocol/daemon-protocol.contract.ts";
import type { TaskProjection } from "@harness-anything/kernel";

/**
 * 「你交代的事」读模型(task_a3ffd5ceb;dec_C612E69B7C7E3480A5F9D2CAD3 重构区):每个工作根
 * 一行摘要——状态桶与「现在到哪了」的分句全部在这里推导,GUI 只做本地化渲染,不复制规则。
 *
 * 归属判据(实测 2026-10-18,23/23 工作根 principal=person_zeyu):委派模型下 agent 写入也
 * 挂在业主 principal 名下,「创建 principal === 读者」是范围判据而非业主亲述判据;executor
 * 是否为空不可用(会漏掉 CEO 代立的 17/23)。全部成员终态的根按已完成折叠,只留近 7 天。
 *
 * 状态桶(先命中先赢,规则与排序一致):等你(议程 awaitingYou 同源)> 卡住(有 blocked
 * 成员)> 在做(有 active 成员,或有已交付待收口的 submitted/in_review 成员)> 状态不明
 * (只剩没开工的成员)。已完成只认「全体成员终态」——根自身呈终态而子树未收口时,按
 * 子树实况归上三桶,否则会把挂着活提问的工作折进已完成(实测:PLT-Honest,2026-10-18)。
 */
export type WorkBriefBucket = "waiting" | "stuck" | "running" | "unclear" | "done";

/** 分句素材:已按重要性排序并截到两句,GUI 只翻译不定序。 */
export type WorkBriefSentencePart =
  | { readonly kind: "ask"; readonly title: string; readonly askKind: AgendaAwaitsRow["askKind"] }
  | { readonly kind: "blocked"; readonly title: string }
  | { readonly kind: "executing"; readonly title: string }
  | { readonly kind: "review"; readonly title: string }
  | { readonly kind: "planned" }
  | { readonly kind: "delivered"; readonly title: string }
  | { readonly kind: "retired" };

export interface WorkBriefDrawerTask {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface WorkBriefPullRequest {
  readonly taskId: string;
  readonly branch: string;
  readonly prNumber: number | null;
  readonly pass: boolean | null;
  readonly occurredAt: string;
}

export interface WorkBrief {
  readonly taskId: string;
  readonly title: string;
  readonly bucket: WorkBriefBucket;
  readonly lastActivityAt: string;
  /** 已完成根的最新成员更新时间;其余桶为 null。 */
  readonly deliveredAt: string | null;
  readonly sentenceParts: readonly WorkBriefSentencePart[];
  /** 等你的提问原文(议程同源行),抽屉就地答复复用议程答复面板。 */
  readonly asks: readonly AgendaAwaitsRow[];
  readonly openTasks: readonly WorkBriefDrawerTask[];
  readonly deliveredTasks: readonly WorkBriefDrawerTask[];
  readonly pullRequests: readonly WorkBriefPullRequest[];
}

export interface WorkBriefCiRun {
  readonly branch: string;
  readonly prNumber: number | null;
  readonly pass: boolean | null;
  readonly occurredAt: string;
}

const DONE_FOLD_DAYS = 7,
  SENTENCE_PART_LIMIT = 2,
  OPEN_TASK_LIMIT = 50,
  DELIVERED_TASK_LIMIT = 10,
  AGENDA_SWEEP_PAGE_SIZE = 500;

export interface WorkBriefsReadResult {
  readonly schema: "daemon.work-briefs/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly briefs: readonly WorkBrief[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}

export function workBriefsFromProjection(input: {
  readonly projection: TaskProjection;
  /** 议程读面的同源入口;分页在内部沿游标排空到末页,游标停滞抛错不发布部分读面。 */
  readonly agendaPage: (query: { readonly limit?: number; readonly cursor?: string }) => DaemonAgendaResult;
  /** 读者的 person id;缺省时不过滤(单仓单业主仍是全集,多业主仓必须传)。 */
  readonly principalId?: string;
  readonly ciRuns?: readonly WorkBriefCiRun[];
  readonly now?: () => Date;
}): WorkBriefsReadResult {
  const now = input.now ?? (() => new Date()),
    index = taskPresentationReads(input.projection).readTaskIndex({ activePackagesOnly: true }),
    byId = new Map(index.rows.map((row) => [row.taskId, row])),
    works = workIndexFromProjection(input.projection).works,
    asksByWork = asksByWorkRoot(input.projection, works, input.agendaPage, input.principalId),
    latestRunByBranch = new Map<string, WorkBriefCiRun>();
  for (const run of input.ciRuns ?? []) if (!latestRunByBranch.has(run.branch)) latestRunByBranch.set(run.branch, run);
  const briefs: WorkBrief[] = [];
  for (const work of works) {
    if (input.principalId !== undefined && rootPrincipal(input.projection, work.taskId) !== input.principalId) continue;
    // 根自身是容器:状态桶的成员证据只用子树成员,根的呈示状态只用于终态判定。
    const members = work.memberTaskIds.flatMap((taskId) => byId.get(taskId) ?? []),
      asks = asksByWork.get(work.taskId) ?? [],
      open = members.filter(({ status }) => !isTerminalStatus(status)),
      active = open.filter(({ status }) => status === "active"),
      blocked = open.filter(({ status }) => status === "blocked"),
      review = open.filter(({ status }) => status === "submitted" || status === "in_review"),
      doneMembers = members.filter(({ status }) => status === "done"),
      deliveredAt = doneMembers.reduce<string | null>(
        (newest, row) => (newest === null || row.updatedAt > newest ? row.updatedAt : newest),
        null,
      ),
      // 已完成必须「全体成员终态」:实测(2026-10-18,PLT-Honest)存在根呈 cancelled 而
      // 子树挂着活跃任务与等你提问的工作——按根终态折已完成会把业主的活问题藏掉。
      bucket: WorkBriefBucket =
        open.length === 0
          ? "done"
          : asks.length > 0
            ? "waiting"
            : blocked.length > 0
              ? "stuck"
              : active.length > 0 || review.length > 0
                ? "running"
                : "unclear";
    if (bucket === "done") {
      const retiredAt = deliveredAt ?? work.lastActivityAt;
      if (Date.parse(retiredAt) < now().getTime() - DONE_FOLD_DAYS * 86_400_000) continue;
    }
    briefs.push({
      taskId: work.taskId,
      title: work.title,
      bucket,
      lastActivityAt: work.lastActivityAt,
      deliveredAt: bucket === "done" ? deliveredAt : null,
      sentenceParts: sentenceParts(asks, blocked, active, review, open, doneMembers),
      asks,
      openTasks: [...open]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, OPEN_TASK_LIMIT)
        .map(({ taskId, title, status, updatedAt }) => ({ taskId, title, status, updatedAt })),
      deliveredTasks: [...doneMembers]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, DELIVERED_TASK_LIMIT)
        .map(({ taskId, title, status, updatedAt }) => ({ taskId, title, status, updatedAt })),
      pullRequests: pullRequestsOf(work.memberTaskIds, latestRunByBranch),
    });
  }
  briefs.sort(
    (left, right) =>
      BUCKET_ORDER.indexOf(left.bucket) - BUCKET_ORDER.indexOf(right.bucket) ||
      (right.deliveredAt ?? right.lastActivityAt).localeCompare(left.deliveredAt ?? left.lastActivityAt),
  );
  return {
    schema: "daemon.work-briefs/v1",
    ok: true,
    status: index.status,
    briefs,
    watermark: index.watermark,
    sourceRevision: index.sourceRevision,
    warnings: [...index.warnings],
  };
}

const BUCKET_ORDER: readonly WorkBriefBucket[] = ["waiting", "stuck", "running", "unclear", "done"];

function sentenceParts(
  asks: readonly AgendaAwaitsRow[],
  blocked: readonly { readonly title: string }[],
  active: readonly { readonly title: string }[],
  review: readonly { readonly title: string }[],
  open: readonly unknown[],
  doneMembers: readonly { readonly title: string; readonly updatedAt: string }[],
): readonly WorkBriefSentencePart[] {
  const parts: WorkBriefSentencePart[] = [
    ...asks.map((ask) => ({ kind: "ask" as const, title: ask.title, askKind: ask.askKind })),
    ...blocked.map(({ title }) => ({ kind: "blocked" as const, title })),
    ...active.map(({ title }) => ({ kind: "executing" as const, title })),
    ...review.map(({ title }) => ({ kind: "review" as const, title })),
  ];
  if (parts.length === 0) {
    if (open.length > 0) parts.push({ kind: "planned" });
    else if (doneMembers.length > 0)
      parts.push({
        kind: "delivered",
        title: [...doneMembers].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!.title,
      });
    else parts.push({ kind: "retired" });
  }
  return parts.slice(0, SENTENCE_PART_LIMIT);
}

function pullRequestsOf(
  memberTaskIds: readonly string[],
  latestRunByBranch: ReadonlyMap<string, WorkBriefCiRun>,
): readonly WorkBriefPullRequest[] {
  const pulls: WorkBriefPullRequest[] = [];
  for (const taskId of memberTaskIds) {
    const run = latestRunByBranch.get(`task_${taskId}`);
    if (run !== undefined)
      pulls.push({ taskId, branch: run.branch, prNumber: run.prNumber, pass: run.pass, occurredAt: run.occurredAt });
  }
  return pulls.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

/** 等你行的归属:task 源按子树成员落根;decision 源按 derives 边的目标任务落根。 */
function asksByWorkRoot(
  projection: TaskProjection,
  works: readonly { readonly taskId: string; readonly memberTaskIds: readonly string[] }[],
  agendaPage: (query: { readonly limit?: number; readonly cursor?: string }) => DaemonAgendaResult,
  principalId: string | undefined,
): ReadonlyMap<string, AgendaAwaitsRow[]> {
  // 「等你」行的扫取:沿服务端游标排空到末页,与 #3869 的关系图完整读同一策略
  // (cursorStep,同步壳见 ./paginated-read.ts);重复游标表示异常循环,抛错且不发布
  // 部分读面。
  const asks: readonly AgendaAwaitsRow[] =
    principalId === undefined
      ? []
      : drainCursorPagesSync(
          (facets) => agendaPage({ limit: AGENDA_SWEEP_PAGE_SIZE, ...facets }),
          "work briefs agenda sweep",
        ).flatMap((page) => page.awaitingYou);
  const workOfTask = new Map<string, string>();
  for (const work of works)
    for (const taskId of [work.taskId, ...work.memberTaskIds]) workOfTask.set(taskId, work.taskId);
  const derives = projection.readTaskRelationsByTargets(
      [...workOfTask.keys()].map((taskId) => `task/${taskId}`),
      "derives",
    ),
    workOfDecision = new Map<string, string>();
  for (const edge of derives.rows)
    if (relationIsCurrent(edge) && edge.state === "active") {
      const decisionId =
          /^decision\/([^/]+)\/CH[^/]+$/u.exec(edge.sourceRef)?.[1] ?? /^decision\/([^/]+)$/u.exec(edge.sourceRef)?.[1],
        workId = workOfTask.get(edge.targetRef.replace(/^task\//u, ""));
      if (decisionId !== undefined && workId !== undefined && !workOfDecision.has(decisionId))
        workOfDecision.set(decisionId, workId);
    }
  const byWork = new Map<string, AgendaAwaitsRow[]>();
  for (const ask of asks) {
    const sourceTaskId = /^task\/([^/]+)$/u.exec(ask.sourceRef)?.[1],
      workId =
        (sourceTaskId !== undefined ? workOfTask.get(sourceTaskId) : undefined) ??
        workOfDecision.get(/^decision\/([^/]+)$/u.exec(ask.sourceRef)?.[1] ?? "");
    if (workId !== undefined) {
      const rows = byWork.get(workId);
      if (rows) rows.push(ask);
      else byWork.set(workId, [ask]);
    }
  }
  return byWork;
}

function rootPrincipal(projection: TaskProjection, taskId: string): string | null {
  return projection.read(taskId).snapshot.task?.createdBy.principal.personId ?? null;
}
