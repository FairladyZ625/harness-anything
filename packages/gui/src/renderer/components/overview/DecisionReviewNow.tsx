import type { AgendaSuccess } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import {
  decisionAgendaRowRef,
  decisionAgendaRows,
  type DecisionAgendaRow,
  type DecisionTileTarget,
} from "../../model/decision-review.ts";

/** 每栏首屏行数;超出的由议程页 / 会话页承接,并如实写出总数。 */
const PANEL_ROWS = 3;

/**
 * 总览(原型 S1)的「需要我的判断」与「正在发生」两栏:行取总览已挂载的议程读面,不另发请求。
 * 需要我的判断 = 待处置(等你处理里的 Decision 行)+ 待裁决;正在发生 = 评审中的 Decision,
 * 每行直达该 Decision 的评审会话。议程还没读到时只写读取中,不把空当成没有。
 */
export function DecisionReviewNow({
  agenda,
  onOpen,
}: {
  agenda: AgendaSuccess | undefined;
  onOpen: (target: DecisionTileTarget) => void;
}) {
  const rows = agenda ? decisionAgendaRows(agenda) : null;
  const judgment = rows?.filter(({ group }) => group === "dispose" || group === "judge") ?? null;
  const happening = rows?.filter(({ group }) => group === "reviewing") ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section data-testid="overview-judgment" className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold text-text">{t("views.overviewView.judgmentTitle")}</h2>
        <Rows
          rows={judgment}
          empty={t("views.overviewView.judgmentEmpty")}
          more={{ view: "agenda", label: t("views.overviewView.judgmentMore", { count: judgment?.length ?? 0 }) }}
          action={(row) =>
            row.group === "dispose"
              ? t("views.overviewView.judgmentOpenProposal")
              : t("views.overviewView.judgmentOpenBasis")
          }
          hint={(row) =>
            row.group === "dispose"
              ? t("views.workspace.decisionReviewHintChangesRequested")
              : t("views.agenda.hintJudge")
          }
          onOpen={onOpen}
        />
      </section>
      <section data-testid="overview-happening" className="min-w-0 space-y-2">
        <h2 className="text-sm font-semibold text-text">{t("views.overviewView.happeningTitle")}</h2>
        <Rows
          rows={happening}
          empty={t("views.overviewView.happeningEmpty")}
          more={{ view: "sessions", label: t("views.overviewView.happeningMore", { count: happening?.length ?? 0 }) }}
          action={() => t("views.overviewView.happeningOpenSessions")}
          hint={() => t("views.overviewView.happeningHint")}
          onOpen={onOpen}
        />
        <p className="ui-meta text-text-faint">{t("views.overviewView.happeningNotice")}</p>
      </section>
    </div>
  );
}

function Rows({
  rows,
  empty,
  more,
  action,
  hint,
  onOpen,
}: {
  rows: readonly DecisionAgendaRow[] | null;
  empty: string;
  more: { view: "agenda" | "sessions"; label: string };
  action: (row: DecisionAgendaRow) => string;
  hint: (row: DecisionAgendaRow) => string;
  onOpen: (target: DecisionTileTarget) => void;
}) {
  if (rows === null) return <p className="ui-meta text-text-muted">{t("views.agenda.loading")}</p>;
  if (rows.length === 0) return <p className="ui-meta text-text-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, PANEL_ROWS).map((row) => (
        <li
          key={`${row.group}:${row.decisionId}`}
          className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-text">{row.title}</p>
            <p className="truncate ui-meta text-text-muted">{hint(row)}</p>
          </div>
          <button
            type="button"
            data-testid={`overview-decision-open-${row.decisionId}`}
            onClick={() => onOpen({ kind: "entity", ref: decisionAgendaRowRef(row) })}
            className="shrink-0 rounded border border-border bg-surface px-2.5 py-1 ui-meta font-semibold text-text hover:border-border-strong"
          >
            {action(row)}
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
