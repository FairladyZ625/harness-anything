import { useMemo, useState, useCallback, useEffect, type ComponentProps } from "react";
import {
  ChatCircleDots,
  SealCheck,
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  SkipForward,
  PencilSimpleLine,
  Question,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  TaskRow,
  RelationEdge,
  FactRef,
} from "../model/types";
import { FactInspector } from "../components/FactInspector";
import { VerdictCard, sortKey, type DecideAction } from "./decisions-verdict";
import type { RelationCoverageRow } from "../../api/renderer-dto";
import { t } from "../i18n/index.tsx";

export type { DecideAction };

type ProcessedEntry = {
  id: string;
  title: string;
  action: DecideAction;
  at: string;
  rationale?: string;
  writeback?: { target: string; kind: string };
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

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
  focusedDecisionId = null,
}: {
  decisions: DecisionRow[];
  tasks: TaskRow[];
  relations: RelationEdge[];
  facts: FactRef[];
  onTraceSession: (sessionId: string) => void;
  onCallAgent?: (cmd: string) => void;
  onDecide: (id: string, action: DecideAction, rationale?: string) => void;
  readOnly?: boolean;
  onNavigateDecision?: (decisionId: string) => void;
  onNavigateTask?: (taskId: string) => void;
  onFocusGraph?: (ref: string) => void;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  /** When set (e.g. from decision pool "Approve here"), jump the cursor to this id. */
  focusedDecisionId?: string | null;
}) {
  const [trace, setTrace] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [inspectedFactRef, setInspectedFactRef] = useState<string | null>(null);
  const [processed, setProcessed] = useState<ProcessedEntry[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);

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

  const idx = Math.min(cursor, Math.max(0, queue.length - 1));
  const current = queue.length > 0 ? queue[idx] : null;

  // When the pool (or another entry) hands us a focus id, move the cursor there.
  useEffect(() => {
    if (!focusedDecisionId) return;
    const target = queue.findIndex((d) => d.decisionId === focusedDecisionId);
    if (target >= 0) setCursor(target);
  }, [focusedDecisionId, queue]);

  const handleDecide = useCallback(
    (id: string, action: DecideAction, rationale?: string) => {
      if (readOnly) return;
      const d = decisions.find((x) => x.decisionId === id);
      if (d) {
        const wb = action === "accept" ? d.readinessSignals?.needsWriteback : undefined;
        setProcessed((p) =>
          [
            {
              id,
              title: d.title,
              action,
              at: new Date().toISOString(),
              rationale,
              writeback: wb,
            },
            ...p,
          ].slice(0, 12),
        );
      }
      onDecide(id, action, rationale);
    },
    [decisions, onDecide, readOnly],
  );

  const handleSkip = useCallback(() => {
    if (!current) return;
    setSkipped((prev) => new Set(prev).add(current.decisionId));
  }, [current]);

  const handlePrev = useCallback(() => setCursor((c) => Math.max(0, c - 1)), []);
  const handleNext = useCallback(
    () => setCursor((c) => Math.min(queue.length - 1, c + 1)),
    [queue.length],
  );
  const handleResetSkipped = () => {
    setSkipped(new Set());
    setCursor(0);
  };

  const handleTrace = (sid: string) => {
    setTrace(sid);
    onTraceSession(sid);
  };

  // P1-1: keyboard flow for the inbox queue (j/k/s/a/r/d/?).
  useEffect(() => {
    if (readOnly || !current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "j") {
        event.preventDefault();
        handleNext();
      } else if (key === "k") {
        event.preventDefault();
        handlePrev();
      } else if (key === "s") {
        event.preventDefault();
        handleSkip();
      } else if (key === "a") {
        event.preventDefault();
        handleDecide(current.decisionId, "accept");
      } else if (key === "r") {
        // open rationale via Reject button path: dispatch through handleDecide only after rationale
        // VerdictCard owns the rationale panel; fire a synthetic click on reject is brittle.
        // Instead, accept keyboard 'r'/'d' as "open rationale" by focusing the reject/defer path:
        // We call handleDecide only when rationale already known; for keyboard we open via custom event.
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("decision-queue-hotkey", { detail: { action: "reject" } }),
        );
      } else if (key === "d") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("decision-queue-hotkey", { detail: { action: "defer" } }),
        );
      } else if (key === "?" || (event.shiftKey && key === "/")) {
        event.preventDefault();
        setShowShortcuts((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, handleDecide, handleNext, handlePrev, handleSkip, readOnly]);

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

  const processedList = processed.length > 0 && (
    <div className="w-full" data-testid="decision-processed-history">
      <div className="mb-1 text-[11px] font-semibold text-text-faint">
        {t("views.decisionsView.sessionHasBeenProcessed")} · {processed.length}
      </div>
      <ul className="space-y-1">
        {processed.map((p) => (
          <li key={`${p.id}-${p.at}`} className="flex items-start gap-2 text-[11px]">
            <span className={`shrink-0 font-mono ${processedTone[p.action]}`}>{processedLabel[p.action]}</span>
            <span className="shrink-0 font-mono text-text-faint">{p.id}</span>
            <span className="min-w-0 truncate text-text-muted">{p.title}</span>
            {p.rationale && (
              <span className="min-w-0 truncate italic text-text-faint" title={p.rationale}>
                — {p.rationale}
              </span>
            )}
            {p.writeback && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent/10 px-1 font-mono text-[10px] text-accent"
                title={t("views.decisionsView.acceptOnlyRemembersWillWritesBackTarget", {
                  target: p.writeback.target,
                })}
              >
                <PencilSimpleLine weight="bold" className="text-[10px]" />
                {t("views.decisionsView.needWriteBack")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ChatCircleDots weight="bold" className="text-[14px] text-accent" />
        <span className="text-[13px] font-semibold text-text">{t("views.decisionsView.decisionApproval")}</span>
        <span className="rounded bg-surface-raised px-1.5 py-px font-mono text-[11px] text-text-muted">
          {queue.length > 0 ? `${idx + 1} / ${queue.length}` : "0 / 0"}
        </span>
        <span className="text-[11px] text-text-faint">
          {t("views.decisionsView.sortByRiskTierUrgencyTwoAxesOrthogonal")}
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setShowShortcuts((open) => !open)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-text-faint hover:bg-surface-raised hover:text-text"
            title={t("views.decisionsView.keyboardShortcuts")}
          >
            <Question weight="bold" className="text-[11px]" />
            ?
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handlePrev}
            disabled={idx === 0}
            className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={`${t("views.decisionsView.previousArticle")} (k)`}
          >
            <CaretLeft weight="bold" />
          </button>
          <kbd className="hidden font-mono text-[10px] text-text-faint sm:inline">k</kbd>
          <button
            onClick={handleNext}
            disabled={idx >= queue.length - 1}
            className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={`${t("views.decisionsView.nextArticle")} (j)`}
          >
            <CaretRight weight="bold" />
          </button>
          <kbd className="hidden font-mono text-[10px] text-text-faint sm:inline">j</kbd>
          <button
            onClick={handleSkip}
            disabled={!current}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-faint hover:bg-surface-raised hover:text-text disabled:opacity-30"
            title={`${t("views.decisionsView.skipDoNotChangeStatusOnlyMove")} (s)`}
          >
            <SkipForward weight="bold" className="text-[12px]" />
            {t("views.decisionsView.skip")}
            <kbd className="font-mono text-[10px] opacity-70">s</kbd>
          </button>
          {skipped.size > 0 && (
            <button
              onClick={handleResetSkipped}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-accent hover:bg-surface-raised"
              title={t("views.decisionsView.restoreSkippedItemsSession")}
            >
              <ArrowsClockwise weight="bold" className="text-[12px]" />
              {t("views.decisionsView.restore")}
              {skipped.size}
            </button>
          )}
        </div>
      </div>

      {showShortcuts && !readOnly && (
        <div
          className="border-b border-border bg-surface-raised/70 px-3 py-2 font-mono text-[11px] text-text-muted"
          data-testid="decision-shortcuts-hint"
        >
          <span className="mr-3 font-semibold text-text-faint">{t("views.decisionsView.keyboardShortcuts")}:</span>
          <span className="mr-3"><kbd>j</kbd>/<kbd>k</kbd> {t("views.decisionsView.nextArticle")}/{t("views.decisionsView.previousArticle")}</span>
          <span className="mr-3"><kbd>s</kbd> {t("views.decisionsView.skip")}</span>
          <span className="mr-3"><kbd>a</kbd> {t("views.decisionsVerdict.accept")}</span>
          <span className="mr-3"><kbd>r</kbd> {t("views.decisionsVerdict.reject")}</span>
          <span className="mr-3"><kbd>d</kbd> {t("views.decisionsVerdict.defer")}</span>
          <span><kbd>?</kbd> {t("views.decisionsView.toggleShortcuts")}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto p-3">
            {current ? (
              <>
                <div className="mb-2 rounded-md bg-stale/10 px-3 py-1.5 text-[11px] text-stale">
                  {t("views.decisionsView.onlyQueuePeopleLowRiskDecisionMaking")}
                </div>
                {processed[0]?.writeback && (
                  <div className="mb-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-[11px] text-text-muted">
                    <div className="flex items-center gap-1 font-semibold text-accent">
                      <PencilSimpleLine weight="bold" className="text-[12px]" />
                      {processed[0].id} {t("views.decisionsView.acceptedNeedDeriveWritebackTask")}
                    </div>
                    <div className="mt-0.5">
                      {t("views.decisionsView.writeBack")}
                      <span className="mx-1 rounded bg-surface px-1 font-mono">{processed[0].writeback.target}</span>
                      ({processed[0].writeback.kind}
                      {t("views.decisionsView.acceptOnlyRecordsWillDoesNotPerform")})
                    </div>
                  </div>
                )}
                <HotkeyAwareVerdict
                  d={current}
                  decisions={decisions}
                  facts={facts}
                  tasks={tasks}
                  relations={relations}
                  onTrace={handleTrace}
                  onCallAgent={onCallAgent}
                  onDecide={handleDecide}
                  onInspectFact={setInspectedFactRef}
                  onNavigateDecision={onNavigateDecision}
                  readOnly={readOnly}
                />
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="grid size-14 place-items-center rounded-full bg-surface-raised">
                  <SealCheck weight="duotone" className="text-[28px] text-success" />
                </div>
                <div>
                  <div className="text-[15px] font-semibold text-text">
                    {t("views.decisionsView.noDecisionApprovalPendingToday")}
                  </div>
                  <div className="mt-1 text-[12px] text-text-faint">
                    {t("views.decisionsView.itNormalQueueClearedLoadBearingDecision")}
                  </div>
                </div>
                {processedList && <div className="mt-2 w-full max-w-md text-left">{processedList}</div>}
              </div>
            )}
          </div>

          {/* P2-3: processed history always visible while queue is live */}
          {queue.length > 0 && processed.length > 0 && (
            <div className="border-t border-border bg-surface/80 px-3 py-2">
              {processedList}
            </div>
          )}

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
                {t("views.decisionsView.prototypeClickCallConversationMiningExportOriginal")}
              </span>
              <button onClick={() => setTrace(null)} className="ml-2 text-accent">
                {t("views.decisionsView.close")}
              </button>
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

/**
 * Wraps VerdictCard so keyboard r/d open the rationale panel without a DOM
 * query. Listens for the queue hotkey custom event and remounts the card with
 * initialPendingAction set so the rationale panel opens.
 */
function HotkeyAwareVerdict(
  props: Omit<ComponentProps<typeof VerdictCard>, "initialPendingAction">,
) {
  const [forceAction, setForceAction] = useState<"reject" | "defer" | null>(null);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ action: "reject" | "defer" }>).detail;
      if (detail?.action === "reject" || detail?.action === "defer") {
        setForceAction(detail.action);
        setPulse((n) => n + 1);
      }
    };
    window.addEventListener("decision-queue-hotkey", handler);
    return () => window.removeEventListener("decision-queue-hotkey", handler);
  }, []);

  return (
    <VerdictCard
      {...props}
      key={`${props.d.decisionId}:${pulse}:${forceAction ?? "idle"}`}
      initialPendingAction={forceAction}
    />
  );
}
