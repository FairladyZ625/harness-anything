import { useMemo, useState, useCallback } from "react";
import {
  ChatCircleDots,
  SealCheck,
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  SkipForward,
  PencilSimpleLine,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  TaskRow,
  RelationEdge,
  FactRef,
} from "../model/types";
import { FactInspector } from "../components/FactInspector";
import { VerdictCard, sortKey } from "./decisions-verdict";
import type { RelationCoverageRow } from "../../api/renderer-dto";
import { t } from "../i18n/index.tsx";

export type DecideAction = "accept" | "reject" | "defer";

export function DecisionsView({
  decisions,
  tasks,
  relations,
  facts,
  onTraceSession,
  onCallAgent,
  onDecide,
  readOnly = false,
  onNavigateDecision,
  onNavigateTask,
  onFocusGraph,
  coverageRows = [],
}: {
  decisions: DecisionRow[];
  tasks: TaskRow[];
  relations: RelationEdge[];
  facts: FactRef[];
  onTraceSession: (sessionId: string) => void;
  onCallAgent?: (cmd: string) => void;
  onDecide: (id: string, action: DecideAction) => void;
  readOnly?: boolean;
  onNavigateDecision?: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onFocusGraph?: (ref: string) => void;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
}) {
  const [trace, setTrace] = useState<string | null>(null);
  // 本会话跳过的 id 集合(不改状态,仅本会话后移)
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  // 当前聚焦的队列索引
  const [cursor, setCursor] = useState(0);
  const [inspectedFactRef, setInspectedFactRef] = useState<string | null>(null);
  // 已处理流(本会话 accept/reject/defer 的历史,用于回看);writeback 标记该 accept 需派生回写 task(§3.1a)
  const [processed, setProcessed] = useState<{ id: string; title: string; action: DecideAction; at: string; writeback?: { target: string; kind: string } }[]>([]);

  /**
   * 队列:proposed 决策,按 riskTier × urgency 两轴正交排序(元组比较,不合并成单分)。
   * 跳过的在本会话内排到队尾(仍可见、可回退,只是不抢焦点)。
   */
  const queue = useMemo(() => {
    const proposed = decisions.filter((d) => d.state === "proposed");
    const active = proposed.filter((d) => !skipped.has(d.decisionId));
    const skippedOnes = proposed.filter((d) => skipped.has(d.decisionId));
    const sorted = (xs: DecisionRow[]) => [...xs].sort((a, b) => {
      const [ra, ua] = sortKey(a);
      const [rb, ub] = sortKey(b);
      if (ra !== rb) return ra - rb;
      if (ua !== ub) return ua - ub;
      return (a.proposedAt ?? "").localeCompare(b.proposedAt ?? "");
    });
    return [...sorted(active), ...sorted(skippedOnes)];
  }, [decisions, skipped]);

  // cursor 越界保护(队列缩短时回退)
  const idx = Math.min(cursor, Math.max(0, queue.length - 1));
  const current = queue.length > 0 ? queue[idx] : null;

  const handleDecide = useCallback(
    (id: string, action: DecideAction) => {
      if (readOnly) return;
      const d = decisions.find((x) => x.decisionId === id);
      if (d) {
        // accept 成功 + 声明需回写 → 记入处理历史(§3.1a:accept 只记意志,回写派生为 task)
        const wb = action === "accept" ? d.readinessSignals?.needsWriteback : undefined;
        setProcessed((p) => [{ id, title: d.title, action, at: new Date().toISOString(), writeback: wb }, ...p].slice(0, 12));
      }
      onDecide(id, action);
      // 处理一条 → 自动落到下一条(保持 cursor,因为该条已从 proposed 出队)
    },
    [decisions, onDecide, readOnly],
  );

  const handleSkip = () => {
    if (!current) return;
    setSkipped((prev) => new Set(prev).add(current.decisionId));
    // 跳过仅本会话后移,不改状态;自动落到下一条未跳过项
  };

  const handlePrev = () => setCursor((c) => Math.max(0, c - 1));
  const handleNext = () => setCursor((c) => Math.min(queue.length - 1, c + 1));
  const handleResetSkipped = () => {
    setSkipped(new Set());
    setCursor(0);
  };

  const handleTrace = (sid: string) => {
    setTrace(sid);
    onTraceSession(sid);
  };

  const processedTone: Record<DecideAction, string> = {
    accept: "text-success",
    reject: "text-danger",
    defer: "text-stale",
  };
  const processedLabel: Record<DecideAction, string> = {
    accept: "accepted",
    reject: "rejected",
    defer: "deferred",
  };

  return (
    <div className="flex h-full flex-col">
      {/* 队列指示条:当前位置 + 两轴排序说明 + 跳过/导航 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ChatCircleDots weight="bold" className="text-[14px] text-accent" />
        <span className="text-[13px] font-semibold text-text">{t("views.decisionsView.decisionApproval")}</span>
        <span className="rounded bg-surface-raised px-1.5 py-px font-mono text-[11px] text-text-muted">
          {queue.length > 0 ? `${idx + 1} / ${queue.length}` : "0 / 0"}
        </span>
        <span className="text-[11px] text-text-faint">
          {t("views.decisionsView.sortByRiskTierUrgencyTwoAxesOrthogonal")}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handlePrev}
            disabled={idx === 0}
            className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={t("views.decisionsView.previousArticle")}
          >
            <CaretLeft weight="bold" />
          </button>
          <button
            onClick={handleNext}
            disabled={idx >= queue.length - 1}
            className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={t("views.decisionsView.nextArticle")}
          >
            <CaretRight weight="bold" />
          </button>
          <button
            onClick={handleSkip}
            disabled={!current}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={t("views.decisionsView.skipDoNotChangeStatusOnlyMove")}
          >
            <SkipForward weight="bold" className="text-[12px]" />
            {t("views.decisionsView.skip")}</button>
          {skipped.size > 0 && (
            <button
              onClick={handleResetSkipped}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-surface-raised"
              title={t("views.decisionsView.restoreSkippedItemsSession")}
            >
              <ArrowsClockwise weight="bold" className="text-[12px]" />
              {t("views.decisionsView.restore")}{skipped.size}
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 主区:单卡聚焦(类邮件 inbox 节奏) */}
          <div className="flex-1 overflow-auto p-3">
            {current ? (
              <>
                <div className="mb-2 rounded-md bg-stale/10 px-3 py-1.5 text-[11px] text-stale">
                  {t("views.decisionsView.onlyQueuePeopleLowRiskDecisionMaking")}</div>
                {/* accept 成功 + 需回写的确认条(42 §4:accept 只记意志,回写派生为 task) */}
                {processed[0]?.writeback && (
                  <div className="mb-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] text-text-muted">
                    <div className="flex items-center gap-1 font-semibold text-accent">
                      <PencilSimpleLine weight="bold" className="text-[12px]" />
                      {processed[0].id} {t("views.decisionsView.acceptedNeedDeriveWritebackTask")}</div>
                    <div className="mt-0.5">
                      {t("views.decisionsView.writeBack")}<span className="mx-1 rounded bg-surface px-1 font-mono">{processed[0].writeback.target}</span>
                      ({processed[0].writeback.kind}{t("views.decisionsView.acceptOnlyRecordsWillDoesNotPerform")}</div>
                  </div>
                )}
                <VerdictCard
                  d={current}
                  decisions={decisions}
                  facts={facts}
                  tasks={tasks}
                  relations={relations}
                  onTrace={handleTrace}
                  onCallAgent={onCallAgent}
                  onDecide={handleDecide}
                  onInspectFact={setInspectedFactRef}
                  readOnly={readOnly}
                />
              </>
            ) : (
              // 空队列态:正常态且值得呈现,不用占位图表填充(P6)
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="grid size-14 place-items-center rounded-full bg-surface-raised">
                  <SealCheck weight="duotone" className="text-[28px] text-success" />
                </div>
                <div>
                  <div className="text-[15px] font-semibold text-text">{t("views.decisionsView.noDecisionApprovalPendingToday")}</div>
                  <div className="mt-1 text-[12px] text-text-faint">
                    {t("views.decisionsView.itNormalQueueClearedLoadBearingDecision")}</div>
                </div>
                {processed.length > 0 && (
                  <div className="mt-2 w-full max-w-md text-left">
                    <div className="mb-1 text-[11px] font-semibold text-text-faint">{t("views.decisionsView.sessionHasBeenProcessed")}</div>
                    <ul className="space-y-1">
                      {processed.map((p) => (
                        <li key={`${p.id}-${p.at}`} className="flex items-center gap-2 text-[11px]">
                          <span className={`font-mono ${processedTone[p.action]}`}>{processedLabel[p.action]}</span>
                          <span className="font-mono text-text-faint">{p.id}</span>
                          <span className="truncate text-text-muted">{p.title}</span>
                          {p.writeback && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent/10 px-1 font-mono text-[10px] text-accent" title={t("views.decisionsView.acceptOnlyRemembersWillWritesBackTarget", { target: p.writeback.target })}>
                              <PencilSimpleLine weight="bold" className="text-[10px]" />
                              {t("views.decisionsView.needWriteBack")}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 队列缩略导航:点击跳转,看见全队节奏 */}
          {queue.length > 0 && (
            <div className="border-t border-border bg-surface-raised/50 px-3 py-2">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {queue.map((d, i) => {
                  const isSkip = skipped.has(d.decisionId);
                  return (
                    <button
                      key={d.decisionId}
                      onClick={() => setCursor(i)}
                      title={`${d.decisionId} · ${d.riskTier ?? t("views.decisionsView.unknown")}/${d.urgency ?? t("views.decisionsView.unknown")}`}
                      className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 font-mono text-[10px] ${
                        i === idx
                          ? "bg-accent text-accent-fg"
                          : isSkip
                            ? "bg-surface text-text-faint line-through opacity-60"
                            : "bg-surface text-text-muted hover:bg-surface-raised"
                      }`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          d.riskTier === "high"
                            ? "bg-danger"
                            : d.riskTier === "medium"
                              ? "bg-stale"
                              : "bg-text-faint"
                        }`}
                      />
                      {d.decisionId}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {trace && (
            <div className="border-t border-border bg-surface-raised px-3 py-2 text-[11px] text-text-muted">
              <span className="font-mono">{t("views.decisionsView.traceValue", { value: trace.slice(0, 16) })}</span>
              <span className="ml-2 text-text-faint">
                {t("views.decisionsView.prototypeClickCallConversationMiningExportOriginal")}</span>
              <button onClick={() => setTrace(null)} className="ml-2 text-accent">{t("views.decisionsView.close")}</button>
            </div>
          )}
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
            onFocusGraph={onFocusGraph}
            coverageRows={coverageRows}
          />
        )}
      </div>
    </div>
  );
}
