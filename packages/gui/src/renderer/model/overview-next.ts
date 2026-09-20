import type { AgendaSuccess } from "../api-client.ts";
import type { AgendaAwaitingRow, AgendaTaskRow } from "../../api/renderer-dto.ts";
import type { TaskRow } from "./types.ts";
import type { CadenceFeedEvent } from "./cadence.ts";

/**
 * 总览(新)的纯派生引擎(S3,task_66c85101):把 agenda / tasks 投影 / runtime
 * overview / cadence 事件窗口合成四个区域的行集。不做 IO、不碰 React,供视图与
 * vitest 共用。判定纪律与 cadence.ts 同源:当前状态一律读投影行,本模块只做
 * 呈现层分组与排序,不重推任何生命周期判定、不在渲染层重算全仓计数。
 */

/** G2 的三个待处理分组(取数全部收在 attentionItemsOf,议程分区词表变更只动这里)。 */
export type AttentionGroup = "reviewReturned" | "initialReview" | "decision";

export interface AttentionItem {
  readonly key: string;
  readonly group: AttentionGroup;
  readonly title: string;
  /** 实体引用:task/<id> 或 decision/<id>,点击走统一实体导航。 */
  readonly ref: string;
  /** 进入队列时间(初审=提交时间,决策=提案时间,返回=任务最后已知时间)。 */
  readonly queuedAt: string | null;
  readonly pinned: boolean;
  /** 行内次级信息:决策行给风险/紧急度,执行行给阻塞判定码。 */
  readonly meta: string | null;
  /** 阻塞当前工作:kernel blockingAssessment.state=blocked 才置真,不从 urgency 推断。 */
  readonly blocking: boolean;
}

export const ATTENTION_GROUP_ORDER: readonly AttentionGroup[] = ["reviewReturned", "initialReview", "decision"];

/**
 * 议程 → 「需要你处理」行集。agenda 尚未读到时返回 null(调用方显示读取中,不冒充空)。
 *
 * 分组取数(2026-09-20 现状):待初审 = `awaitingDecision` 的 execution 行(提交待裁);
 * 评审返回 = `awaitingRework`(可选购,读面拆分 awaitingAdjudication/awaitingRework 后
 * 在此一处切换);决策待裁 = `awaitingDecision` 的 decision 行。
 * 排序:置顶优先 → 阻塞当前工作(blockingAssessment=blocked)→ 进入队列时间倒序。
 */
export function attentionItemsOf(agenda: AgendaSuccess | undefined): readonly AttentionItem[] | null {
  if (agenda === undefined) return null;
  const items: AttentionItem[] = [
    ...agenda.awaitingDecision.map(attentionOfAwaiting),
    ...(agenda.awaitingRework ?? []).map(attentionOfRework),
  ];
  return items.sort(compareAttention);
}

function attentionOfAwaiting(row: AgendaAwaitingRow): AttentionItem {
  return row.kind === "decision"
    ? {
        key: `decision/${row.decisionId}`,
        group: "decision",
        title: row.title,
        ref: `decision/${row.decisionId}`,
        queuedAt: row.proposedAt,
        pinned: false,
        meta: `risk:${row.riskTier} urgency:${row.urgency}`,
        blocking: false,
      }
    : {
        key: `execution/${row.executionId}`,
        group: "initialReview",
        title: row.title,
        ref: `task/${row.taskId}`,
        queuedAt: row.submittedAt,
        pinned: row.pinned,
        meta: row.blockingAssessment.state === "blocked" ? `blocked:${row.blockingAssessment.label}` : null,
        blocking: row.blockingAssessment.state === "blocked",
      };
}

function attentionOfRework(row: AgendaTaskRow): AttentionItem {
  return {
    key: `rework/${row.taskId}`,
    group: "reviewReturned",
    title: row.title,
    ref: `task/${row.taskId}`,
    queuedAt: row.updatedAt,
    pinned: row.pinned,
    meta: null,
    blocking: row.blockingAssessment.state === "blocked",
  };
}

function compareAttention(left: AttentionItem, right: AttentionItem): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.blocking !== right.blocking) return left.blocking ? -1 : 1;
  const byTime = (right.queuedAt ?? "").localeCompare(left.queuedAt ?? "");
  return byTime !== 0 ? byTime : left.key.localeCompare(right.key);
}

/** G3 的重点工作行:置顶(共享 pin 语义)与 Milestone/任务组两段分列。 */
export interface KeyWorkRow {
  readonly key: string;
  readonly kind: "pinned" | "group";
  readonly ref: string;
  readonly taskId: string | null;
  readonly title: string;
  /** 状态原词(投影行的 canonical/raw 状态),呈现层不重判。 */
  readonly status: string | null;
  /** 组行 = wip 读面给的 directChildCount(不自行重算);置顶行 = 实体 kind。 */
  readonly note: string | null;
  readonly updatedAt: string | null;
}

/**
 * 「重点工作」行集:置顶段直接取 agenda.pinnedEntities(共享 pin,不改归属语义);
 * 组段 = 任务树根任务(rootTaskId 自指)且 wip root 判定在场的行,milestone 类根
 * 即使暂无子任务也列出。排序按组内最新活动时间倒序(呈现层排序,允许)。
 */
export function keyWorkRowsOf(
  agenda: AgendaSuccess | undefined,
  tasks: readonly TaskRow[],
): { readonly pinned: readonly KeyWorkRow[]; readonly groups: readonly KeyWorkRow[] } {
  const pinned = (agenda?.pinnedEntities ?? []).map(
    (row): KeyWorkRow => ({
      key: `pinned/${row.ref}`,
      kind: "pinned",
      ref: row.ref,
      taskId: row.ref.startsWith("task/") ? row.ref.slice("task/".length) : null,
      title: row.title,
      status: row.status,
      note: row.kind,
      updatedAt: row.pinnedAt,
    }),
  );
  const groups = tasks
    .filter(
      (task) =>
        task.taskId === task.rootTaskId && (task.rootAssessment !== undefined || task.taskClass === "milestone"),
    )
    .map(
      (task): KeyWorkRow => ({
        key: `group/${task.taskId}`,
        kind: "group",
        ref: `task/${task.taskId}`,
        taskId: task.taskId,
        title: task.title,
        status: task.canonicalStatus ?? task.rawStatus,
        note:
          task.rootAssessment !== undefined
            ? `children:${task.rootAssessment.directChildCount}`
            : (task.taskClass ?? null),
        updatedAt: task.lastKnownAt,
      }),
    )
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return { pinned, groups };
}

/** G5 的变化类型筛选项(事件 type 词表的呈现层分组,与 cadence 阶段映射同源纪律)。 */
export type ChangeCategory = "new" | "progress" | "complete" | "blocked" | "decision" | "delivery";

export const CHANGE_CATEGORY_ORDER: readonly ChangeCategory[] = [
  "new",
  "progress",
  "complete",
  "blocked",
  "decision",
  "delivery",
];

const CHANGE_TYPES_BY_CATEGORY: Readonly<Record<ChangeCategory, readonly string[]>> = {
  new: ["task_created", "task_bootstrapped"],
  progress: [
    "task_progress_appended",
    "execution_started",
    "lease_renewed",
    "execution_annotated",
    "execution_executor_declared",
    "fact_recorded",
  ],
  complete: ["task_completed"],
  blocked: ["submission_returned", "task_reopened"],
  decision: [],
  delivery: [
    "execution_submitted",
    "submission_forwarded",
    "code_doc_reconciled",
    "code_doc_repointed",
    "review_recorded",
    "completion_gate_verified",
  ],
};

/** 单事件归类:显式词表命中优先,受阻/完成的评审与门禁结果按 verdict/result 细分,决策实体兜底。 */
export function changeCategoryOf(event: CadenceFeedEvent): ChangeCategory | null {
  for (const category of CHANGE_CATEGORY_ORDER) {
    if (CHANGE_TYPES_BY_CATEGORY[category].includes(event.type)) {
      if (event.type === "review_recorded") return event.reviewVerdict === "changes_requested" ? "blocked" : "delivery";
      if (event.type === "completion_gate_verified") return event.gateResult === "fail" ? "blocked" : "delivery";
      return category;
    }
  }
  if (event.decisionId !== null) return "decision";
  return null;
}
