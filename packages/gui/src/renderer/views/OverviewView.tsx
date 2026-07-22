import { useEffect, useMemo, useState } from "react";
import type {
  Project,
  TaskRow,
  SnapshotStatus,
  DecisionRow,
  FactRef,
  RelationEdge,
} from "../model/types";
import { BOARD_COLUMNS } from "../model/types";
import {
  STATUS_META,
} from "../components/badges";
import { Card } from "../components/overview/parts";
import {
  DecisionRecencyList,
  RunningTaskList,
  StaleTaskList,
} from "../components/overview/OperationalLists.tsx";
import {
  buildOverviewIndex,
  windowDimensionRows,
  OVERVIEW_DIMENSION_PAGE_SIZE,
} from "../model/overview-selectors.ts";
import { markPerf, startPerfNavigation, FIRST_USABLE_ATTR, FIRST_USABLE_VIEW_ATTR } from "../perf/first-usable.ts";
import { t } from "../i18n/index.tsx";

const timeOf = (iso: string) => iso.slice(11, 16);

function QuestionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-text-faint">
      {children}
    </div>
  );
}

export function OverviewView({
  project,
  tasks,
  decisions,
  facts,
  relations,
  onSelect,
  onDrill,
  onOpenDecision,
  dataReady = true,
}: {
  project: Project;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  onSelect: (id: string) => void;
  onDrill: (lane: string, status: SnapshotStatus) => void;
  onOpenDecision: (id: string) => void;
  /** When false, show skeleton; first-usable fires only after real rows are interactive. */
  dataReady?: boolean;
}) {
  const [dimensionPage, setDimensionPage] = useState(0);

  useEffect(() => {
    setDimensionPage(0);
  }, [tasks.length]);

  useEffect(() => {
    startPerfNavigation("overview");
  }, []);

  const index = useMemo(
    () => buildOverviewIndex({ tasks, decisions, facts, relations }),
    [tasks, decisions, facts, relations],
  );
  const windowed = useMemo(
    () => windowDimensionRows(index.dimensionRows, dimensionPage, OVERVIEW_DIMENSION_PAGE_SIZE),
    [index.dimensionRows, dimensionPage],
  );

  useEffect(() => {
    if (!dataReady) return;
    markPerf("overview", "data-ready", {
      taskCount: tasks.length,
      dimensionRows: index.dimensionRows.length,
    });
    markPerf("overview", "first-meaningful-rows", {
      visibleDimensionRows: windowed.visible.length,
      recentDecisionRows: Math.min(decisions.length, 12),
    });
    // First usable = interactive status strip + decision queue + windowed table are painted.
    markPerf("overview", "first-usable", {
      visibleDimensionRows: windowed.visible.length,
      domBudgetRows: OVERVIEW_DIMENSION_PAGE_SIZE,
    });
  }, [dataReady, tasks.length, decisions.length, index.dimensionRows.length, windowed.visible.length]);

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto"
      {...(dataReady
        ? { [FIRST_USABLE_ATTR]: "true", [FIRST_USABLE_VIEW_ATTR]: "overview" }
        : { "data-overview-skeleton": "true" })}
    >
      <header className="border-b border-border bg-surface/40 px-5 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="ui-title font-mono font-semibold">{project.name}</h1>
          <span className="truncate font-mono text-[12px] text-text-faint">
            {project.path}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[12px] text-text-faint">
            {t("views.overviewView.projection")}{timeOf(project.watermarkAt)}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-text-muted">
          {t("views.overviewView.threeQuestionsOneScreenWhatCutToday")}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <Card title={t("views.overviewView.whatWillCutToday")} bodyClassName="p-3">
          <QuestionLabel>{t("views.overviewView.proposedDecisionTopNDecisionApproval")}</QuestionLabel>
          <DecisionRecencyList decisions={decisions} onOpenDecision={onOpenDecision} />
        </Card>

        <Card title={t("views.overviewView.whatYouRunningNow")} bodyClassName="p-3">
          <QuestionLabel>{t("views.overviewView.activeBlockedReviewDistributionKanbanFiltering")}</QuestionLabel>
          <RunningTaskList tasks={tasks} onOpenTask={onSelect} />
        </Card>

        <Card title={t("views.overviewView.whatWeathering")} bodyClassName="p-3">
          <QuestionLabel>{t("views.overviewView.checkWatermarkFactLivenessMechanicalSignal")}</QuestionLabel>
          <StaleTaskList tasks={tasks} onOpenTask={onSelect} />
        </Card>

        <Card
          title={t("views.overviewView.valueStatusDrillDown", {
            value: "PLT",
          })}
        >
          <QuestionLabel>{t("views.overviewView.clickEnterOperableTaskCollection")}</QuestionLabel>
          <div className="max-h-[30rem] overflow-auto">
            <table className="w-full border-collapse text-center">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  <th className="px-1.5 py-1 text-left font-mono text-[11px] font-normal uppercase tracking-wide text-text-faint">
                    PLT
                  </th>
                  {BOARD_COLUMNS.map((status) => (
                    <th key={status} title={STATUS_META[status].label} className="px-1 py-1">
                      <span className="inline-flex text-[13px]" style={{ color: STATUS_META[status].color }}>
                        {STATUS_META[status].icon}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {windowed.visible.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td
                      className="max-w-[180px] truncate px-1.5 py-1 text-left font-mono text-[12px] text-text-muted"
                      title={row.label}
                    >
                      {row.key === "unassigned" ? t("views.ledger.noPlt") : row.label}
                    </td>
                    {BOARD_COLUMNS.map((status) => {
                      const count = row.counts[status] ?? 0;
                      return (
                        <td key={status} className="px-0.5 py-0.5">
                          {count > 0 ? (
                            <button
                              onClick={() => onDrill(row.key, status)}
                              title={`${row.label} · ${STATUS_META[status].label} · ${count}`}
                              className="w-full rounded px-1 py-1 font-mono text-[12px] hover:bg-surface-raised"
                            >
                              {count}
                            </button>
                          ) : (
                            <span className="font-mono text-[12px] text-text-faint">·</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {windowed.pageCount > 1 && (
            <nav
              aria-label={t("views.overviewView.dimensionPaging")}
              className="mt-2 flex items-center justify-center gap-2 font-mono text-[12px]"
            >
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-text-muted disabled:opacity-40"
                disabled={windowed.page === 0}
                onClick={() => setDimensionPage((page) => Math.max(0, page - 1))}
              >
                {t("views.overviewView.previousPage")}
              </button>
              <span className="text-text-faint">
                {t("views.overviewView.pageOf", {
                  page: windowed.page + 1,
                  pageCount: windowed.pageCount,
                  total: windowed.total,
                })}
              </span>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-text-muted disabled:opacity-40"
                disabled={windowed.page + 1 >= windowed.pageCount}
                onClick={() => setDimensionPage((page) => page + 1)}
              >
                {t("views.overviewView.nextPage")}
              </button>
            </nav>
          )}
        </Card>
      </div>
    </div>
  );
}
