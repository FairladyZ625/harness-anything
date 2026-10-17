import type { AgendaSuccess } from "../api-client.ts";
import type { MessageKey } from "../i18n/core.ts";
import { t } from "../i18n/index.tsx";
import { AWAITS_KIND_LABEL } from "../awaits-answer.ts";
import {
  decisionAgendaRowRef,
  decisionAgendaRows,
  taskAwaitsRows,
  type DecisionReviewGroup,
} from "./decision-review.ts";
import { actorDisplayName } from "./actor-name.ts";
import { formatListTime } from "./time.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import type { AgendaAwaitsRow } from "../../api/renderer-dto.ts";
import type { StatusTone } from "../components/primitives/StatusTag.tsx";

/**
 * 议程行派生(dec_C612E69B7C7E3480A5F9D2CAD3 起由议程页与「重构 › 今天」页共用):
 * 从同一条 repo.agenda.read 切面推出全部分组行,两页 import 同一函数,行集与
 * 「需要关注 / 待跟进」桶计数结构性相等——两页数字不一致即缺陷。纯函数、不碰 React。
 */
type AgendaGroup = DecisionReviewGroup | "answered" | "rework" | "adjudicate" | "taskReviewing";

/** 组的显示序 = 注意力序:等你动手的在前,已在别人手里的在后,已答复跟进垫底。 */
const GROUP_ORDER: readonly AgendaGroup[] = [
  "dispose",
  "rework",
  "adjudicate",
  "review",
  "judge",
  "reviewing",
  "taskReviewing",
  "answered",
];

const GROUP_LABEL: Readonly<Record<AgendaGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewGroupDispose",
  rework: "views.agenda.groupRework",
  adjudicate: "views.agenda.groupAdjudicate",
  review: "views.workspace.decisionReviewGroupReview",
  judge: "views.workspace.decisionReviewGroupJudge",
  reviewing: "views.workspace.decisionReviewGroupReviewing",
  taskReviewing: "views.agenda.groupTaskReviewing",
  answered: "components.awaitsAnswer.answeredForYou",
};

/** 组 → 状态色档(标准 §3:同一类别同一色;颜色通道只承载注意力类别)。 */
const GROUP_TONE: Readonly<Record<AgendaGroup, StatusTone>> = {
  dispose: "bad",
  rework: "bad",
  adjudicate: "bad",
  review: "wait",
  judge: "wait",
  reviewing: "wait",
  taskReviewing: "wait",
  answered: "wait",
};

/** 筛选桶:需要关注 = 下一步是「你」;待跟进 = 已出手、等别人回。 */
export type AgendaFilter = "attn" | "follow" | "all";

export const GROUP_BUCKET: Readonly<Record<AgendaGroup, AgendaFilter>> = {
  dispose: "attn",
  rework: "attn",
  adjudicate: "attn",
  review: "attn",
  judge: "attn",
  reviewing: "follow",
  taskReviewing: "follow",
  answered: "follow",
};

/** 议程的一行:组、标题、原因、等待时长,加上落点(完整详情 ref)与答复源行。 */
export interface AgendaRow {
  readonly id: string;
  readonly group: AgendaGroup;
  readonly title: string;
  readonly hint: string;
  /** 读面各源行自带的时间字段(askedAt/answeredAt/submittedAt/proposedAt/updatedAt)。 */
  readonly since: string | null;
  /** 注意力分的检索键(attentionItems 的 ref);不在注意力切面里的行为 null。 */
  readonly scoreRef: string | null;
  /** 「打开完整详情」的落点;ask 行的完整详情是它的源实体。 */
  readonly target: string;
  readonly ask?: AgendaAwaitsRow;
}

export function agendaRowsOf(agenda: AgendaSuccess): readonly AgendaRow[] {
  return [
    ...taskAwaitsRows(agenda).map((ask) => ({
      id: ask.relationId,
      title: ask.title,
      hint: `${AWAITS_KIND_LABEL[ask.askKind]()} · ${ask.question}`,
      group: "dispose" as const,
      since: ask.askedAt,
      scoreRef: `relation/${ask.relationId}`,
      target: ask.sourceRef,
      ask,
    })),
    ...agenda.answeredForYou.map((row) => ({
      id: row.relationId,
      title: row.title,
      // 答复者用可读名字(与总览、决策时间线同一套转换);完整身份串在答复面板里可见。
      hint: `${AWAITS_KIND_LABEL[row.askKind]()} · ${t("components.awaitsAnswer.answeredBy", {
        actor: actorDisplayName(row.answeredBy).name,
        time: formatListTime(row.answeredAt),
      })} · ${t("views.agenda.hintAnswered", { answer: row.answer })}`,
      group: "answered" as const,
      since: row.answeredAt,
      scoreRef: `relation/${row.relationId}`,
      target: row.sourceRef,
    })),
    ...taskReviewRows(agenda.awaitingRework, "rework", "views.agenda.hintRework", (row) => ({
      since: row.updatedAt,
      scoreRef: `task/${row.taskId}`,
    })),
    ...taskReviewRows(agenda.awaitingAdjudication, "adjudicate", "views.agenda.hintAdjudicate", (row) => ({
      since: row.submittedAt,
      scoreRef: `execution/${row.executionId}`,
    })),
    ...taskReviewRows(agenda.underReview, "taskReviewing", "views.agenda.hintTaskReviewing", (row) => ({
      since: row.submittedAt,
      scoreRef: `execution/${row.executionId}`,
    })),
    ...decisionAgendaRows(agenda).map((decision) => ({
      id: decision.decisionId,
      title: decision.title,
      hint: t(GROUP_HINTS[decision.group]),
      group: decision.group,
      since: null,
      scoreRef: `decision/${decision.decisionId}`,
      target: decisionAgendaRowRef(decision),
    })),
  ];
}

const GROUP_HINTS: Readonly<Record<DecisionReviewGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewHintChangesRequested",
  review: "views.workspace.decisionReviewHintReviewRequired",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  judge: "views.agenda.hintJudge",
};

export { GROUP_HINTS, GROUP_LABEL, GROUP_ORDER, GROUP_TONE };
export type { AgendaGroup };

/** 评审返回 / 待初审 / 任务评审中:行只取读面的 taskId 与标题,落任务详情的收口页签。 */
function taskReviewRows<T extends { readonly taskId: string; readonly title: string }>(
  rows: readonly T[],
  group: "rework" | "adjudicate" | "taskReviewing",
  hint: MessageKey,
  metaOf: (row: T) => { readonly since: string | null; readonly scoreRef: string },
): AgendaRow[] {
  return rows.map((row) => ({
    id: row.taskId,
    title: row.title,
    hint: t(hint),
    group,
    ...metaOf(row),
    target: taskReviewRef(row.taskId),
  }));
}
