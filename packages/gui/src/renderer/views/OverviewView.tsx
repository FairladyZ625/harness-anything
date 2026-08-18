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
import { coordinationStatusCensus } from "../model/status-census.ts";
import { sortDecisionQueue } from "../model/triadic";
import { t } from "../i18n/index.tsx";

// 与 archive 线一致:维度表首屏固定行数上限,超出走分页(不做无限下拉)。
const OVERVIEW_DIMENSION_PAGE_SIZE = 40;

/** 窗口化维度行,不静默截断 —— 调用方必须暴露分页控件。 */
export function windowDimensionRows<T>(rows: readonly T[], page: number, pageSize = OVERVIEW_DIMENSION_PAGE_SIZE): { readonly visible: readonly T[]; readonly page: number; readonly pageCount: number; readonly total: number } {
  const total = rows.length, pageCount = Math.max(1, Math.ceil(total / pageSize)), safePage = Math.min(Math.max(0, page), pageCount - 1), start = safePage * pageSize;
  return { visible: rows.slice(start, start + pageSize), page: safePage, pageCount, total };
}

const timeOf = (iso: string) => iso.slice(11, 16);
const dateTime = (iso: string) => iso.slice(5, 16).replace("T", " ");

function QuestionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-text-faint">
      {children}
    </div>
  );
}

type DrillDimension = "root" | "module" | "plt";

import { UNASSIGNED_PLT_LANE as UNASSIGNED_PLT } from "./SwimlaneBoard.tsx";

export function dimensionKeysOf(task: TaskRow, dimension: DrillDimension): string[] {
  if (dimension === "root") return [task.rootTaskId ?? task.taskId];
  if (dimension === "module") return [task.module];
  // PLT 从现有投影字段前端派生:productLines 缺失的任务归入「未投影 PLT」,
  // 不伪装成某个具体产品线。
  const lines = task.productLines ?? [];
  return lines.length > 0 ? [...lines] : [UNASSIGNED_PLT];
}

export function dimensionLabel(
  key: string,
  dimension: DrillDimension,
  tasks: ReadonlyArray<TaskRow>,
): string {
  if (dimension === "root") {
    const representative = tasks.find((t) => (t.rootTaskId ?? t.taskId) === key);
    return representative?.rootTitle ?? representative?.title ?? key;
  }
  if (dimension === "plt" && key === UNASSIGNED_PLT) return "未投影 PLT";
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
  const [dimensionPage, setDimensionPage] = useState(0);
  // 维度切换或行数变化 → 回到第一页(筛后行集变了,旧页码没有意义)。
  useEffect(() => { setDimensionPage(0); }, [dimension, tasks.length]);

  // 统计口径注释见 model/status-census.ts:数字与侧栏摘要同源同义。
  const census = useMemo(() => coordinationStatusCensus(tasks), [tasks]);
  const countStatus = (status: SnapshotStatus) => census.get(status) ?? 0;
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
    () => [...new Set(tasks.flatMap((task) => dimensionKeysOf(task, dimension)))],
    [tasks, dimension],
  );
  const windowed = useMemo(
    () => windowDimensionRows(dimensionKeys, dimensionPage),
    [dimensionKeys, dimensionPage],
  );
  const cellCount = (key: string, status: SnapshotStatus) =>
    tasks.filter(
      (task) => dimensionKeysOf(task, dimension).includes(key) && task.coordinationStatus === status,
    ).length;

  const blockers = [...blocked, ...inReview.filter((task) => task.closeoutReadiness === "ready")]
    .sort((a, b) => a.lastKnownAt.localeCompare(b.lastKnownAt))
    .slice(0, 8);

  const healthRows = [
    {
      label: "INV-4 watermark",
      value: `投影 @ ${dateTime(project.watermarkAt)}`,
      tone: "text-text-muted",
      ok: true,
    },
    {
      label: "INV-6 dangling relations",
      value: `${danglingRelations.length} 条`,
      tone: danglingRelations.length > 0 ? "text-danger" : "text-success",
      ok: danglingRelations.length === 0,
    },
    {
      label: "fact liveness",
      value: `${invalidatedFacts.length} 条已失效`,
      tone: invalidatedFacts.length > 0 ? "text-stale" : "text-success",
      ok: invalidatedFacts.length === 0,
    },
    {
      label: "projection freshness",
      value: `${stale.length} stale · ${unavailable.length} unavailable`,
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
            投影 @ {timeOf(project.watermarkAt)}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-text-muted">
          一屏三问：今天要裁什么 / 现在在跑什么 / 什么在风化。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <Card title="今天要裁什么" bodyClassName="p-3">
          <QuestionLabel>① proposed decision top-N → 决策批准</QuestionLabel>
          {proposedTop.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-raised px-3 py-4 text-[13px] text-text-muted">
              <CheckCircle weight="duotone" className="mr-1 inline text-success" />
              今日无待决策批准。
            </div>
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

        <Card title="现在在跑什么" bodyClassName="p-3">
          <QuestionLabel>② active / blocked / in_review 分布 → 看板筛选</QuestionLabel>
          <div className="grid grid-cols-3 gap-2">
            {(["active", "blocked", "in_review"] as SnapshotStatus[]).map((status) => (
              <button
                key={status}
                onClick={() => onDrill("__all__", status, dimension)}
                title="按当前维度下钻该状态"
                className="rounded-md border border-border bg-surface-raised px-3 py-2 text-left hover:border-border-strong"
              >
                <div className="flex items-center gap-1.5">
                  <span style={{ color: STATUS_META[status].color }}>{STATUS_META[status].icon}</span>
                  <span className="text-[13px] font-semibold text-text">{STATUS_META[status].label}</span>
                </div>
                <div className="mt-1 font-mono text-[22px] font-semibold tabular-nums" style={{ color: STATUS_META[status].color }}>{countStatus(status)}</div>
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
                当前无 blocked 或封存就绪滞留项。
              </p>
            )}
          </div>
        </Card>

        <Card title="什么在风化" bodyClassName="p-3">
          <div className="flex items-center gap-2">
            <QuestionLabel>③ check / watermark / fact liveness 机械信号</QuestionLabel>
            <button
              onClick={onOpenDecisionPool}
              className="ml-auto rounded border border-border px-2 py-1 font-mono text-[11px] text-accent hover:bg-surface-raised"
            >
              打开决策池
            </button>
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

        <Card title={`${dimension === "root" ? "根任务" : dimension === "module" ? "模块" : "PLT"} × 状态下钻`} bodyClassName="p-3">
          <div className="mb-2 flex items-center gap-2">
            <QuestionLabel>② 点击进入可操作任务集合</QuestionLabel>
            <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
              {(["root", "module", "plt"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDimension(d)}
                  title={
                    d === "root"
                      ? "按任务树根分组(milestone)"
                      : d === "module"
                        ? "按 module 分组(传统)"
                        : "按 productLine(PLT)分组 · 前端从 productLines 派生"
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
              {windowed.visible.map((key) => {
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
                              className="w-full rounded px-1 py-1 font-mono text-[12px] tabular-nums transition-colors duration-100 hover:bg-surface-raised hover:text-text"
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
          {windowed.pageCount > 1 && (
            <nav aria-label={t("views.overviewView.dimensionPaging")} className="mt-2 flex items-center justify-center gap-2 font-mono text-[12px]">
              <button type="button" className="rounded border border-border px-2 py-1 text-text-muted disabled:opacity-40" disabled={windowed.page === 0} onClick={() => setDimensionPage((page) => Math.max(0, page - 1))}>{t("views.overviewView.previousPage")}</button>
              <span className="text-text-faint">{t("views.overviewView.pageOf", { page: windowed.page + 1, pageCount: windowed.pageCount, total: windowed.total, unit: t(dimension === "root" ? "views.overviewView.unitRoot" : dimension === "module" ? "views.overviewView.unitModule" : "views.overviewView.unitPlt") })}</span>
              <button type="button" className="rounded border border-border px-2 py-1 text-text-muted disabled:opacity-40" disabled={windowed.page + 1 >= windowed.pageCount} onClick={() => setDimensionPage((page) => page + 1)}>{t("views.overviewView.nextPage")}</button>
            </nav>
          )}
        </Card>
      </div>
    </div>
  );
}
