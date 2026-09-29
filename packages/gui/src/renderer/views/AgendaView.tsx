import { useState } from "react";
import type { AgendaSuccess } from "../api-client.ts";
import type { MessageKey } from "../i18n/core.ts";
import { t } from "../i18n/index.tsx";
import { AWAITS_KIND_LABEL, type AwaitsPanelSubject } from "../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import {
  DECISION_REVIEW_GROUPS,
  DecisionReviewGroups,
  type DecisionReviewGroupRow,
  type ReviewGroupSpec,
} from "../components/decisionReview/DecisionReviewGroups.tsx";
import {
  decisionAgendaRowRef,
  decisionAgendaRows,
  taskAwaitsRows,
  type DecisionAgendaRow,
  type DecisionReviewGroup,
} from "../model/decision-review.ts";
import { taskReviewRef } from "../navigation/entityRoutes.ts";
import type { AgendaAwaitsRow } from "../../api/renderer-dto.ts";

/** 议程在 Decision 四组之外的 task 侧分组:已答复待你跟进、评审返回、待初审、任务评审中。 */
type AgendaGroup = DecisionReviewGroup | "answered" | "rework" | "adjudicate" | "taskReviewing";

const [DISPOSE_GROUP, ...DECISION_LATER_GROUPS] = DECISION_REVIEW_GROUPS;
const AGENDA_GROUPS: ReviewGroupSpec<AgendaGroup> = [
  DISPOSE_GROUP!,
  ["answered", "components.awaitsAnswer.answeredForYou"],
  ["rework", "views.agenda.groupRework"],
  ["adjudicate", "views.agenda.groupAdjudicate"],
  ["taskReviewing", "views.agenda.groupTaskReviewing"],
  ...DECISION_LATER_GROUPS,
];

/**
 * 议程的一行:task 源等你处理(落点是答复面板)、一行议程 Decision(落点按组),
 * 或落到一个实体引用的行(已答复 → 源实体详情,task 评审类 → 任务详情的收口页签)。
 */
type AgendaRow = DecisionReviewGroupRow<AgendaGroup> &
  ({ readonly ask: AgendaAwaitsRow } | { readonly decision: DecisionAgendaRow } | { readonly ref: string });

const GROUP_HINTS: Readonly<Record<DecisionReviewGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewHintChangesRequested",
  review: "views.workspace.decisionReviewHintReviewRequired",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  judge: "views.agenda.hintJudge",
};

/**
 * 议程(原型 S2 #agenda):下一步由谁来推进(dec_DC3A1BB9 是它的唯一归处)。行与组全部取总览同一条
 * 议程读面(repo.agenda.read),不另发请求、不逐条读 Decision;页签只改当前显示,
 * 查看按组落到逐项回应 / 评审页签 / 评审会话 / 裁决页签。「等你答复」的全部来源都在待处置
 * (CH2):task 源的 question / acceptance / consent / reopen 行就地打开答复面板。
 * 已答复待你跟进落源实体详情(那里看答复与再次提问);评审返回 / 待初审 / 任务评审中落任务详情的收口页签。
 */
export function AgendaView({
  repoId,
  agenda,
  agendaError,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly agenda: AgendaSuccess | undefined;
  readonly agendaError: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const rows: readonly AgendaRow[] = agenda
    ? [
        ...taskAwaitsRows(agenda).map((ask) => ({
          id: ask.relationId,
          title: ask.title,
          hint: `${AWAITS_KIND_LABEL[ask.askKind]()} · ${ask.question}`,
          group: "dispose" as const,
          action: t("components.awaitsAnswer.openAnswer"),
          ask,
        })),
        ...agenda.answeredForYou.map((row) => ({
          id: row.relationId,
          title: row.title,
          hint: `${AWAITS_KIND_LABEL[row.askKind]()} · ${t("views.agenda.hintAnswered", { answer: row.answer })}`,
          group: "answered" as const,
          action: t("components.awaitsAnswer.openSource"),
          ref: row.sourceRef,
        })),
        ...taskReviewRows(agenda.awaitingRework, "rework", "views.agenda.hintRework"),
        ...taskReviewRows(agenda.awaitingAdjudication, "adjudicate", "views.agenda.hintAdjudicate"),
        ...taskReviewRows(agenda.underReview, "taskReviewing", "views.agenda.hintTaskReviewing"),
        ...decisionAgendaRows(agenda).map((decision) => ({
          id: decision.decisionId,
          title: decision.title,
          hint: t(GROUP_HINTS[decision.group]),
          group: decision.group,
          decision,
        })),
      ]
    : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="agenda-view">
      <header className="shrink-0 border-b border-border bg-surface/40 px-5 py-4">
        <h1 className="ui-title font-mono font-semibold">{t("views.agenda.title")}</h1>
        <p className="mt-1 ui-meta text-text-muted">{t("views.agenda.note")}</p>
      </header>
      <div className="space-y-4 p-5">
        {agendaError ? (
          <p role="alert" className="text-sm text-danger">
            {t("views.agenda.error", { message: agendaError })}
          </p>
        ) : agenda === undefined ? (
          <p className="text-sm text-text-muted">{t("views.agenda.loading")}</p>
        ) : (
          <>
            {agenda.status === "pending" ? (
              <p className="font-mono ui-micro text-text-faint">
                {t("views.overviewView.decisionTilesCatchingUp", { revision: String(agenda.sourceRevision) })}
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="text-sm text-text-muted">{t("views.agenda.empty")}</p>
            ) : (
              <DecisionReviewGroups
                rows={rows}
                groups={AGENDA_GROUPS}
                label={t("views.agenda.title")}
                testIdPrefix="agenda-decision"
                onOpen={(row) =>
                  "ask" in row
                    ? setPanel({ mode: "answer", row: row.ask })
                    : onNavigateEntity("ref" in row ? row.ref : decisionAgendaRowRef(row.decision))
                }
              />
            )}
          </>
        )}
      </div>
      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

/** 评审返回 / 待初审 / 任务评审中:行只取读面的 taskId 与标题,落任务详情的收口页签。 */
function taskReviewRows(
  rows: readonly { readonly taskId: string; readonly title: string }[],
  group: "rework" | "adjudicate" | "taskReviewing",
  hint: MessageKey,
): readonly AgendaRow[] {
  return rows.map(({ taskId, title }) => ({ id: taskId, title, hint: t(hint), group, ref: taskReviewRef(taskId) }));
}
