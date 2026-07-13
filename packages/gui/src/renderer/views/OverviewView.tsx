import { useMemo, useState } from "react";
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
import { sortDecisionQueue } from "../model/triadic";
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

type DrillDimension = "root" | "module";

function dimensionKey(task: TaskRow, dimension: DrillDimension): string {
  if (dimension === "root") return task.rootTaskId ?? task.taskId;
  return task.module;
}

function dimensionLabel(
  key: string,
  dimension: DrillDimension,
  tasks: ReadonlyArray<TaskRow>,
): string {
  if (dimension === "root") {
    const representative = tasks.find((t) => (t.rootTaskId ?? t.taskId) === key);
    return representative?.rootTitle ?? representative?.title ?? key;
  }
  return key;
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
}) {
  // coding preset 默认按 root(milestone=root task)。用户可切回 module 维度。
  const [dimension, setDimension] = useState<DrillDimension>("root");

  const countStatus = (status: SnapshotStatus) =>
    tasks.filter((task) => task.coordinationStatus === status).length;
  const blocked = tasks.filter((task) => task.coordinationStatus === "blocked");
  const inReview = tasks.filter((task) => task.coordinationStatus === "in_review");
  const stale = tasks.filter((task) => task.freshness === "stale-but-usable");
  const unavailable = tasks.filter((task) => task.freshness === "unavailable-no-cache");
  const invalidatedFacts = facts.filter((fact) => fact.invalidated);
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const danglingRelations = relations.filter((relation) => {
    const endpointKnown = (endpoint: string) => {
      if (endpoint.startsWith("task/")) return taskIds.has(endpoint.slice(5).split("/")[0]);
      if (endpoint.startsWith("decision/")) return decisions.some((decision) => decision.decisionId === endpoint.split("/")[1]);
      if (endpoint.startsWith("fact/")) return facts.some((fact) => fact.anchor === endpoint.replace(/^fact\//, ""));
      return taskIds.has(endpoint);
    };
    return !endpointKnown(relation.from) || !endpointKnown(relation.to);
  });
  const proposedTop = sortDecisionQueue(decisions.filter((decision) => decision.state === "proposed")).slice(0, 5);

  const dimensionKeys = useMemo(
    () => [...new Set(tasks.map((task) => dimensionKey(task, dimension)))],
    [tasks, dimension],
  );
  const cellCount = (key: string, status: SnapshotStatus) =>
    tasks.filter(
      (task) => dimensionKey(task, dimension) === key && task.coordinationStatus === status,
    ).length;

  const blockers = [...blocked, ...inReview.filter((task) => task.closeoutReadiness === "ready")]
    .sort((a, b) => a.lastKnownAt.localeCompare(b.lastKnownAt))
    .slice(0, 8);

  const healthRows = [
    {
      label: t("views.overviewView.inv4Watermark"),
      value: t("views.overviewView.projectionValue", { value: dateTime(project.watermarkAt) }),
      tone: "text-text-muted",
      ok: true,
    },
    {
      label: t("views.overviewView.inv6DanglingRelations"),
      value: t("views.overviewView.countItems", { count: danglingRelations.length }),
      tone: danglingRelations.length > 0 ? "text-danger" : "text-success",
      ok: danglingRelations.length === 0,
    },
    {
      label: t("views.overviewView.factLiveness"),
      value: t("views.overviewView.countItemsHaveExpired", { count: invalidatedFacts.length }),
      tone: invalidatedFacts.length > 0 ? "text-stale" : "text-success",
      ok: invalidatedFacts.length === 0,
    },
    {
      label: t("views.overviewView.projectionFreshness"),
      value: t("views.overviewView.freshnessCounts", { stale: stale.length, unavailable: unavailable.length }),
      tone: stale.length + unavailable.length > 0 ? "text-stale" : "text-success",
      ok: stale.length + unavailable.length === 0,
    },
  ];

  const seg = (active: boolean) =>
    `rounded px-2 py-0.5 text-[11px] ${
      active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
    }`;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
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
          {proposedTop.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-muted">
              <CheckCircle weight="duotone" className="mr-1 inline text-success" />
              {t("views.overviewView.noDecisionApprovalPendingToday")}</div>
          ) : (
            <div className="space-y-2">
              {proposedTop.map((decision) => (
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
                <div className="mt-1 font-mono text-[22px] font-semibold">{countStatus(status)}</div>
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            {blockers.map((task) => (
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
            {blockers.length === 0 && (
              <p className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-faint">
                {t("views.overviewView.thereCurrentlyNoBlockedArchiveReadyHoldouts")}</p>
            )}
          </div>
        </Card>

        <Card title={t("views.overviewView.whatWeathering")} bodyClassName="p-3">
          <div className="flex items-center gap-2">
            <QuestionLabel>{t("views.overviewView.checkWatermarkFactLivenessMechanicalSignal")}</QuestionLabel>
            <button
              onClick={onOpenDecisionPool}
              className="ml-auto rounded border border-border px-2 py-1 font-mono text-[11px] text-accent hover:bg-surface-raised"
            >
              {t("views.overviewView.openDecisionPool")}</button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {healthRows.map((row) => (
              <div key={row.label} className="rounded-md border border-border bg-surface-raised px-3 py-2">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-faint">
                  {row.ok ? <CheckCircle weight="bold" className="text-success" /> : <WarningCircle weight="bold" className="text-stale" />}
                  {row.label}
                </div>
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
                      ? t("views.overviewView.groupByTaskTreeRootMilestone")
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
              {dimensionKeys.map((key) => {
                const label = dimensionLabel(key, dimension, tasks);
                return (
                  <tr key={key} className="border-t border-border">
                    <td
                      className="max-w-[180px] truncate px-1.5 py-1 text-left font-mono text-[12px] text-text-muted"
                      title={label}
                    >
                      {label}
                    </td>
                    {BOARD_COLUMNS.map((status) => {
                      const count = cellCount(key, status);
                      return (
                        <td key={status} className="px-0.5 py-0.5">
                          {count > 0 ? (
                            <button
                              onClick={() => onDrill(key, status, dimension)}
                              title={`${label} · ${STATUS_META[status].label} · ${count}`}
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
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
