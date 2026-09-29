import type { AgendaSuccess } from "../api-client.ts";
import type { MessageKey } from "../i18n/core.ts";
import { t } from "../i18n/index.tsx";
import { DecisionReviewGroups } from "../components/decisionReview/DecisionReviewGroups.tsx";
import { decisionAgendaRowRef, decisionAgendaRows, type DecisionReviewGroup } from "../model/decision-review.ts";

const GROUP_HINTS: Readonly<Record<DecisionReviewGroup, MessageKey>> = {
  dispose: "views.workspace.decisionReviewHintChangesRequested",
  review: "views.workspace.decisionReviewHintReviewRequired",
  reviewing: "views.workspace.decisionReviewHintReviewing",
  judge: "views.agenda.hintJudge",
};

/**
 * 议程(原型 S2 #agenda):下一步由谁来推进。行与组全部取总览同一条议程读面
 * (repo.agenda.read),不另发请求、不逐条读 Decision;页签只改当前显示,
 * 查看按组落到逐项回应 / 评审页签 / 评审会话 / 裁决页签。
 */
export function AgendaView({
  agenda,
  agendaError,
  onNavigateEntity,
}: {
  readonly agenda: AgendaSuccess | undefined;
  readonly agendaError: string | null;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const rows = agenda ? decisionAgendaRows(agenda).map((row) => ({ ...row, hint: t(GROUP_HINTS[row.group]) })) : [];
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
                label={t("views.agenda.title")}
                testIdPrefix="agenda-decision"
                onOpen={(row) => onNavigateEntity(decisionAgendaRowRef(row))}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
