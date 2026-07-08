import { useMemo, useState } from "react";
import { Funnel, WarningCircle, Warning, Info } from "@phosphor-icons/react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import {
  buildFactTriage,
  SIGNAL_LABEL,
  SIGNAL_SEVERITY,
  type FactTriageItem,
  type FactTriageSignalKind,
} from "../model/fact-triage";
import { buildFactTriageContext } from "../model/copy-context";
import { FactInspector } from "../components/FactInspector";
import { CopyContextButton } from "../components/CopyContextButton";

/** 信号 → 颜色/图标(triage 卡片 badge 语言) */
const SIGNAL_VISUAL: Record<
  FactTriageSignalKind,
  { cls: string; icon: typeof WarningCircle }
> = {
  INVALIDATED: { cls: "bg-danger/15 text-danger border-danger/30", icon: WarningCircle },
  ORPHAN: { cls: "bg-stale/15 text-stale border-stale/30", icon: Warning },
  WEAKLY_CITED: { cls: "bg-stale/10 text-stale border-stale/20", icon: Warning },
  SUPERSEDES_OTHER: { cls: "bg-accent/10 text-accent border-accent/25", icon: Info },
  MARGINAL_SOURCE: { cls: "bg-surface-raised text-text-muted border-border", icon: Info },
};

const SIGNAL_ORDER: FactTriageSignalKind[] = [
  "INVALIDATED",
  "ORPHAN",
  "WEAKLY_CITED",
  "SUPERSEDES_OTHER",
  "MARGINAL_SOURCE",
];

export function FactTriageView({
  facts,
  relations,
  decisions,
  tasks,
  onNavigateDecision,
  onNavigateTask,
}: {
  facts: FactRef[];
  relations: RelationEdge[];
  decisions: DecisionRow[];
  tasks: TaskRow[];
  /** 活链接:点击 decision ref 跳转 */
  onNavigateDecision?: (decisionId: string) => void;
  /** 活链接:点击 task ref 跳转 */
  onNavigateTask?: (taskId: string) => void;
}) {
  const [signalFilter, setSignalFilter] = useState<Set<FactTriageSignalKind>>(
    new Set(SIGNAL_ORDER),
  );
  const [inspectedFactRef, setInspectedFactRef] = useState<string | null>(null);

  const triage = useMemo(
    () => buildFactTriage(facts, relations, decisions, tasks),
    [facts, relations, decisions, tasks],
  );

  // 信号计数(用于 filter chip 显示)
  const signalCounts = useMemo(() => {
    const counts = new Map<FactTriageSignalKind, number>();
    for (const item of triage) {
      for (const signal of item.signals) {
        counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
      }
    }
    return counts;
  }, [triage]);

  const rows = useMemo(
    () =>
      triage.filter((item) =>
        item.signals.some((s) => signalFilter.has(s.kind)),
      ),
    [triage, signalFilter],
  );

  const toggleSignal = (kind: FactTriageSignalKind) => {
    setSignalFilter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="ui-title font-semibold">事实分诊</h1>
            <span className="font-mono text-[13px] text-text-faint">
              按危险信号排序 · 机器发现候选,人判
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
            triage 维度全部从 relation 图投影现算,不改 kernel fact schema。
            健康 fact(severity=0)不进池——只顶有异常信号的到最前。
          </p>
        </header>

        {/* 信号 filter chips */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/50 px-4 py-2">
          <Funnel weight="bold" className="text-[12px] text-text-faint" />
          {SIGNAL_ORDER.map((kind) => {
            const active = signalFilter.has(kind);
            const count = signalCounts.get(kind) ?? 0;
            const visual = SIGNAL_VISUAL[kind];
            const Icon = visual.icon;
            return (
              <button
                key={kind}
                onClick={() => toggleSignal(kind)}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-opacity ${
                  active ? visual.cls : "border-border bg-surface text-text-faint opacity-50"
                }`}
                title={active ? "点击隐藏此类信号" : "点击显示此类信号"}
              >
                <Icon weight="bold" className="text-[11px]" />
                {SIGNAL_LABEL[kind]}
                <span className="ml-0.5 rounded bg-surface px-1 text-[10px]">{count}</span>
              </button>
            );
          })}
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-text-faint">
            {rows.length} / {triage.length} visible
            {facts.length - triage.length > 0 && (
              <span className="text-success">· {facts.length - triage.length} healthy hidden</span>
            )}
          </span>
        </div>

        {/* triage 列表 */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {triage.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
              当前投影没有触发 triage 信号的 fact——全部健康。
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
              当前信号过滤条件下没有 fact。调整 filter chips 查看其他信号。
            </div>
          ) : (
            <div className="space-y-2">
              {rows.map((item) => (
                <FactTriageCard
                  key={item.fact.anchor}
                  item={item}
                  tasks={tasks}
                  decisions={decisions}
                  relations={relations}
                  onInspect={() => setInspectedFactRef(`fact/${item.fact.anchor}`)}
                  onNavigateDecision={onNavigateDecision}
                  onNavigateTask={onNavigateTask}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {inspectedFactRef && (
        <FactInspector
          factRef={inspectedFactRef}
          facts={facts}
          tasks={tasks}
          decisions={decisions}
          relations={relations}
          onClose={() => setInspectedFactRef(null)}
          onNavigateDecision={onNavigateDecision}
          onNavigateTask={onNavigateTask}
        />
      )}
    </div>
  );
}

function FactTriageCard({
  item,
  tasks,
  decisions,
  relations,
  onInspect,
  onNavigateDecision,
  onNavigateTask,
}: {
  item: FactTriageItem;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  relations: RelationEdge[];
  onInspect: () => void;
  onNavigateDecision?: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
}) {
  const { fact, signals, citingDecisionIds, severity } = item;
  const sourceTask = tasks.find((t) => t.taskId === fact.taskId);

  // severity → 左侧色条
  const accentColor =
    severity >= SIGNAL_SEVERITY.INVALIDATED
      ? "var(--color-danger)"
      : severity >= SIGNAL_SEVERITY.ORPHAN
        ? "var(--color-stale)"
        : "var(--color-border-strong)";

  return (
    <article
      className="rounded-lg border border-border bg-surface px-3 py-3"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* 信号 badges */}
          <div className="flex flex-wrap items-center gap-1">
            {signals.map((signal) => {
              const visual = SIGNAL_VISUAL[signal.kind];
              const Icon = visual.icon;
              return (
                <span
                  key={signal.kind}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${visual.cls}`}
                  title={signal.detail}
                >
                  <Icon weight="bold" className="text-[11px]" />
                  {SIGNAL_LABEL[signal.kind]}
                </span>
              );
            })}
            <span className="font-mono text-[10px] text-text-faint">
              severity {severity}
            </span>
          </div>

          {/* fact anchor + 观察文本(可点击 → inspector) */}
          <button
            onClick={onInspect}
            className="mt-1.5 block w-full text-left"
            title="点击打开 Fact Inspector"
          >
            <div className="font-mono text-[11px] text-text-faint">{fact.anchor}</div>
            <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-text">
              {fact.text}
            </p>
          </button>

          {/* 元信息行 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
            <span className="rounded bg-surface-raised px-1.5 py-0.5">{fact.category}</span>
            <span>@ {fact.at.slice(0, 16).replace("T", " ")}</span>
            {sourceTask ? (
              <button
                onClick={() => onNavigateTask?.(sourceTask.taskId)}
                className="text-accent hover:underline"
                title="跳转到来源 task"
              >
                task/{sourceTask.taskId}
              </button>
            ) : (
              <span>task/{fact.taskId}</span>
            )}
          </div>

          {/* citing decisions(活链接) */}
          {citingDecisionIds.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-text-faint">支撑的 decision:</span>
              {citingDecisionIds.map((decId) => {
                const dec = decisions.find((d) => d.decisionId === decId);
                return (
                  <button
                    key={decId}
                    onClick={() => onNavigateDecision?.(decId)}
                    className="font-mono text-accent hover:underline"
                    title={dec?.title ?? "未知 decision"}
                  >
                    {decId}[{dec?.state ?? "?"}]
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 右侧:复制上下文按钮 */}
        <div className="shrink-0">
          <CopyContextButton
            compact
            buildText={() => buildFactTriageContext(item, relations, decisions, tasks)}
          />
        </div>
      </div>
    </article>
  );
}
