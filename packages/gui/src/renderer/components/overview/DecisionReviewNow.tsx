import type { AgendaSuccess } from "../../api-client.ts";
import type { AgendaAwaitsRow } from "../../../api/renderer-dto.ts";
import { AWAITS_KIND_LABEL } from "../../awaits-answer.ts";
import { t } from "../../i18n/index.tsx";
import {
  decisionAgendaRowRef,
  decisionAgendaRows,
  taskAwaitsRows,
  type DecisionAgendaRow,
  type DecisionTileTarget,
} from "../../model/decision-review.ts";

/** 每栏首屏行数;超出的由议程页 / 会话页承接,并如实写出总数。 */
const PANEL_ROWS = 3;

/** 一栏里的一行:标题、次级说明与唯一的落点按钮。 */
type PanelRow = {
  readonly key: string;
  readonly title: string;
  readonly hint: string;
  readonly action: string;
  readonly testId: string;
  readonly open: () => void;
};

/**
 * 总览(原型 S1)的「需要我的判断」与「正在发生」两栏:行取总览已挂载的议程读面,不另发请求。
 * 需要我的判断 = task 源等你处理(点开即答复面板)+ 待处置(等你处理里的 Decision 行)+ 待裁决;
 * 正在发生 = 评审中的 Decision,每行写出读面给的评审人与已登记的意见数,直达该 Decision 的评审会话。
 * 议程还没读到时只写读取中,不把空当成没有。
 */
export function DecisionReviewNow({
  agenda,
  onOpen,
  onAnswer,
}: {
  agenda: AgendaSuccess | undefined;
  onOpen: (target: DecisionTileTarget) => void;
  /** task 源等你处理行的落点:这条 awaits 的答复面板。 */
  onAnswer: (row: AgendaAwaitsRow) => void;
}) {
  const rows = agenda ? decisionAgendaRows(agenda) : null;
  const decisionRow = (row: DecisionAgendaRow, action: string, hint: string): PanelRow => ({
    key: `${row.group}:${row.decisionId}`,
    title: row.title,
    hint,
    action,
    testId: `overview-decision-open-${row.decisionId}`,
    open: () => onOpen({ kind: "entity", ref: decisionAgendaRowRef(row) }),
  });
  const judgment = agenda
    ? [
        ...taskAwaitsRows(agenda).map(
          (row): PanelRow => ({
            key: `awaits:${row.relationId}`,
            title: row.title,
            hint: `${AWAITS_KIND_LABEL[row.askKind]()} · ${row.question}`,
            action: t("components.awaitsAnswer.openAnswer"),
            testId: `overview-awaits-open-${row.relationId}`,
            open: () => onAnswer(row),
          }),
        ),
        ...(rows ?? [])
          .filter(({ group }) => group === "dispose" || group === "judge")
          .map((row) =>
            row.group === "dispose"
              ? decisionRow(
                  row,
                  t("views.overviewView.judgmentOpenProposal"),
                  t("views.workspace.decisionReviewHintChangesRequested"),
                )
              : decisionRow(row, t("views.overviewView.judgmentOpenBasis"), t("views.agenda.hintJudge")),
          ),
      ]
    : null;
  const happening =
    rows
      ?.filter(({ group }) => group === "reviewing")
      .map((row) => decisionRow(row, t("views.overviewView.happeningOpenSessions"), reviewerLine(row))) ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section data-testid="overview-judgment" className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold text-text">{t("views.overviewView.judgmentTitle")}</h2>
        <Rows
          rows={judgment}
          empty={t("views.overviewView.judgmentEmpty")}
          more={{ view: "agenda", label: t("views.overviewView.judgmentMore", { count: judgment?.length ?? 0 }) }}
          onOpen={onOpen}
        />
      </section>
      <section data-testid="overview-happening" className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold text-text">{t("views.overviewView.happeningTitle")}</h2>
        <Rows
          rows={happening}
          empty={t("views.overviewView.happeningEmpty")}
          more={{ view: "sessions", label: t("views.overviewView.happeningMore", { count: happening?.length ?? 0 }) }}
          onOpen={onOpen}
        />
        <p className="ui-meta text-text-faint">{t("views.overviewView.happeningNotice")}</p>
      </section>
    </div>
  );
}

/** 原型 S1「独立评审乙提出 2 项意见」:每位在飞评审人一段;评审尚未登记时如实写进行中。 */
function reviewerLine(row: DecisionAgendaRow): string {
  return (row.reviewers ?? [])
    .map(({ reviewer, findingCount }) => {
      const name = reviewer ?? t("views.overviewView.happeningReviewerUnnamed");
      return findingCount === null
        ? t("views.overviewView.happeningReviewerRunning", { reviewer: name })
        : t("views.overviewView.happeningReviewerFindings", { reviewer: name, count: findingCount });
    })
    .join(" · ");
}

function Rows({
  rows,
  empty,
  more,
  onOpen,
}: {
  rows: readonly PanelRow[] | null;
  empty: string;
  more: { view: "agenda" | "sessions"; label: string };
  onOpen: (target: DecisionTileTarget) => void;
}) {
  if (rows === null) return <p className="ui-meta text-text-muted">{t("views.agenda.loading")}</p>;
  if (rows.length === 0) return <p className="ui-meta text-text-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, PANEL_ROWS).map((row) => (
        <li
          key={row.key}
          className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">{row.title}</p>
            <p className="truncate ui-meta text-text-muted">{row.hint}</p>
          </div>
          <button
            type="button"
            data-testid={row.testId}
            onClick={row.open}
            className="shrink-0 rounded border border-border bg-surface px-2.5 py-1 ui-meta font-semibold text-text hover:border-border-strong"
          >
            {row.action}
          </button>
        </li>
      ))}
      {rows.length > PANEL_ROWS ? (
        <li>
          <button
            type="button"
            onClick={() => onOpen({ kind: "view", view: more.view })}
            className="ui-meta text-accent hover:underline"
          >
            {more.label}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
