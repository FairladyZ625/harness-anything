import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Scales,
  WarningCircle,
} from "@phosphor-icons/react";
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
  StatusBadge,
  RiskTierBadge,
  UrgencyBadge,
} from "../components/badges";
import { Card } from "../components/overview/parts";
import { OverviewLedgerSections } from "../components/overview/LedgerSections.tsx";
import {
  buildOverviewIndex,
  countStatus,
  windowDimensionRows,
  OVERVIEW_DIMENSION_PAGE_SIZE,
  type DrillDimension,
} from "../model/overview-selectors.ts";
import { markPerf, startPerfNavigation, FIRST_USABLE_ATTR, FIRST_USABLE_VIEW_ATTR } from "../perf/first-usable.ts";
import { t } from "../i18n/index.tsx";

const timeOf = (iso: string) => iso.slice(11, 16);
const dateTime = (iso: string) => iso.slice(5, 16).replace("T", " ");

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
  onOpenInbox,
  onOpenDecisionPool,
  onOpenDecision,
  dataReady = true,
}: {
  project: Project;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  onSelect: (id: string) => void;
  onDrill: (lane: string, status: SnapshotStatus, dimension: DrillDimension) => void;
  onOpenInbox: () => void;
  onOpenDecisionPool: () => void;
  onOpenDecision: (id: string) => void;
  /** When false, show skeleton; first-usable fires only after real rows are interactive. */
  dataReady?: boolean;
}) {
  // coding preset 默认按 PLT 根任务分组。用户可切回 module 维度。
  const [dimension, setDimension] = useState<DrillDimension>("root");
  const [dimensionPage, setDimensionPage] = useState(0);

  useEffect(() => {
    setDimensionPage(0);
  }, [dimension, tasks.length]);

  useEffect(() => {
    startPerfNavigation("overview");
  }, []);

  const index = useMemo(
    () => buildOverviewIndex({ tasks, decisions, facts, relations, dimension }),
    [tasks, decisions, facts, relations, dimension],
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
      proposedTop: index.proposedTop.length,
    });
    // First usable = interactive status strip + decision queue + windowed table are painted.
    markPerf("overview", "first-usable", {
      visibleDimensionRows: windowed.visible.length,
      domBudgetRows: OVERVIEW_DIMENSION_PAGE_SIZE,
    });
  }, [dataReady, tasks.length, index.dimensionRows.length, index.proposedTop.length, windowed.visible.length]);

  const healthRows = [
    {
      label: t("views.overviewView.inv4Watermark"),
      hint: t("views.overviewView.inv4WatermarkHint"),
      value: t("views.overviewView.projectionValue", { value: dateTime(project.watermarkAt) }),
      tone: "text-text-muted",
      ok: true,
    },
    {
      label: t("views.overviewView.inv6DanglingRelations"),
      hint: t("views.overviewView.inv6DanglingRelationsHint"),
      value: t("views.overviewView.countItems", { count: index.danglingRelationCount }),
      tone: index.danglingRelationCount > 0 ? "text-danger" : "text-success",
      ok: index.danglingRelationCount === 0,
    },
    {
      label: t("views.overviewView.factLiveness"),
      hint: t("views.overviewView.factLivenessHint"),
      value: t("views.overviewView.countItemsHaveExpired", { count: index.invalidatedFactCount }),
      tone: index.invalidatedFactCount > 0 ? "text-stale" : "text-success",
      ok: index.invalidatedFactCount === 0,
    },
    {
      label: t("views.overviewView.projectionFreshness"),
      hint: t("views.overviewView.projectionFreshnessHint"),
      value: t("views.overviewView.freshnessCounts", { stale: index.staleCount, unavailable: index.unavailableCount }),
      tone: index.staleCount + index.unavailableCount > 0 ? "text-stale" : "text-success",
      ok: index.staleCount + index.unavailableCount === 0,
    },
  ];

  const seg = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] ${
      active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
    }`;

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
        <OverviewLedgerSections
          tasks={tasks}
          decisions={decisions}
          onOpenTask={onSelect}
          onOpenDecision={onOpenDecision}
        />

        <Card title={t("views.overviewView.whatWillCutToday")} bodyClassName="p-3">
          <QuestionLabel>{t("views.overviewView.proposedDecisionTopNDecisionApproval")}</QuestionLabel>
          {index.proposedTop.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-muted">
              <CheckCircle weight="duotone" className="mr-1 inline text-success" />
              {t("views.overviewView.noDecisionApprovalPendingToday")}</div>
          ) : (
            <div className="space-y-2">
              {index.proposedTop.map((decision) => (
                <button
                  key={decision.decisionId}
                  onClick={onOpenInbox}
                  className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-left hover:border-accent/60"
                >
                  <div className="flex items-start gap-2">
                    <Scales weight="bold" className="mt-0.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[12px] text-text-faint">{decision.decisionId}</span>
                        <RiskTierBadge tier={decision.riskTier} />
                        <UrgencyBadge urgency={decision.urgency} />
                      </div>
                      <div className="mt-1 truncate text-[14px] font-semibold text-text">
                        {decision.title}
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-text-muted">
                        Q: {decision.question}
                      </div>
                    </div>
                    <ArrowSquareOut weight="bold" className="mt-1 text-text-faint" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title={t("views.overviewView.whatYouRunningNow")} bodyClassName="p-3">
          <QuestionLabel>{t("views.overviewView.activeBlockedReviewDistributionKanbanFiltering")}</QuestionLabel>
          <div className="grid grid-cols-3 gap-2">
            {(["active", "blocked", "in_review"] as SnapshotStatus[]).map((status) => (
              <button
                key={status}
                onClick={() => onDrill("__all__", status, dimension)}
                title={t("views.overviewView.drillDownStatusAccordingCurrentDimension")}
                className="rounded-md border border-border bg-surface-raised px-3 py-2 text-left hover:border-border-strong"
              >
                <div className="flex items-center gap-1.5">
                  <span style={{ color: STATUS_META[status].color }}>{STATUS_META[status].icon}</span>
                  <span className="text-[13px] font-semibold text-text">{STATUS_META[status].label}</span>
                </div>
                <div className="mt-1 font-mono text-[22px] font-semibold">{countStatus(index, status)}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            {index.blockers.map((task) => (
              <button
                key={task.taskId}
                onClick={() => onSelect(task.taskId)}
                title={task.taskId}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-left hover:bg-surface-raised"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-text">{task.title}</span>
                <StatusBadge status={task.coordinationStatus} />
              </button>
            ))}
            {index.blockers.length === 0 && (
              <p className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-faint">
                {t("views.overviewView.thereCurrentlyNoBlockedArchiveReadyHoldouts")}</p>
            )}
          </div>
        </Card>

        <Card title={t("views.overviewView.whatWeathering")} bodyClassName="p-3">
          <div className="flex items-center gap-2">
            <QuestionLabel>
              <span title={t("views.overviewView.whatWeatheringHint")} aria-label={t("views.overviewView.whatWeatheringHint")}>
                {t("views.overviewView.checkWatermarkFactLivenessMechanicalSignal")}
              </span>
            </QuestionLabel>
            <button
              onClick={onOpenDecisionPool}
              className="ml-auto rounded border border-border px-2 py-1 font-mono text-[11px] text-accent hover:bg-surface-raised"
            >
              {t("views.overviewView.openDecisionPool")}</button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {healthRows.map((row) => (
              <div
                key={row.label}
                className="rounded-md border border-border bg-surface-raised px-3 py-2"
                title={row.hint}
                aria-label={`${row.label}: ${row.hint}`}
              >
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
                  {row.ok ? <CheckCircle weight="bold" className="text-success" /> : <WarningCircle weight="bold" className="text-stale" />}
                  {row.label}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-text-faint">{row.hint}</div>
                <div className={`mt-1 font-mono text-[13px] ${row.tone}`}>{row.value}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title={t("views.overviewView.valueStatusDrillDown", {
            value: dimension === "root"
              ? t("views.overviewView.rootTask")
              : t("views.overviewView.module"),
          })}
        >
          <div className="mb-2 flex items-center gap-2">
            <QuestionLabel>{t("views.overviewView.clickEnterOperableTaskCollection")}</QuestionLabel>
            <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
              {(["root", "module"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDimension(d)}
                  title={
                    d === "root"
                      ? t("views.overviewView.groupByTaskTreeRootPlt")
                      : t("views.overviewView.groupByModuleTraditional")
                  }
                  className={seg(dimension === d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <table className="w-full border-collapse text-center">
            <thead>
              <tr>
                <th className="px-1.5 py-1 text-left font-mono text-[11px] font-normal uppercase tracking-wide text-text-faint">
                  {dimension}
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
                    {row.label}
                  </td>
                  {BOARD_COLUMNS.map((status) => {
                    const count = row.counts[status] ?? 0;
                    return (
                      <td key={status} className="px-0.5 py-0.5">
                        {count > 0 ? (
                          <button
                            onClick={() => onDrill(row.key, status, dimension)}
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
