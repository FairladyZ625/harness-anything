import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, CaretLeft, CaretRight, ChatCircleDots, SealCheck, SkipForward } from "@phosphor-icons/react";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import { FactInspector } from "../components/FactInspector.tsx";
import type { JudgmentOpenRequest } from "../components/DecisionJudgmentPanel.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../decision-actions.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types.ts";
import { VerdictCard, sortKey } from "./decisions-verdict.tsx";
import { t } from "../i18n/index.tsx";

export type DecideAction = DecisionAction;

/** canonical 判定历史一次显示这么多条,剩下的靠批量按钮显形(照抄 BoardView 的做法)。 */
const HISTORY_BATCH_SIZE = 12;

type JudgmentHistoryRow = {
  readonly decision: DecisionRow;
  readonly consent: DecisionRow["judgmentConsents"][number];
};

/**
 * 判定历史原本只渲染前 12 条,超出的条数在界面上没有任何出口——标题只写
 * 「canonical judgment 历史」,用户看不出第 13 条以后被吞了。剩余条数现在显形并可展开。
 */
function JudgmentHistory({ history, mutationFeedback }: {
  readonly history: ReadonlyArray<JudgmentHistoryRow>;
  readonly mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
}) {
  const [visibleCount, setVisibleCount] = useState(HISTORY_BATCH_SIZE);
  useEffect(() => { setVisibleCount(HISTORY_BATCH_SIZE); }, [history.length]);
  const visible = history.slice(0, visibleCount), hiddenCount = history.length - visible.length;
  if (history.length === 0) return null;
  return <section className="mt-4 rounded-lg border border-border bg-surface p-3">
    <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wide text-text-faint">
      {t("views.decisionsView.canonicalJudgmentHistory")}</h2>
    <ul className="mt-1.5 space-y-1">{visible.map(({ decision, consent }) => {
      const receipt = mutationFeedback?.(decision.decisionId)?.receipt;
      return <li key={consent.consentId} className="text-[11px] leading-relaxed">
        <span className="font-mono text-text-muted">{consent.action} · {decision.decisionId} ·
          {consent.consentId}</span>
        <span className="ml-2 break-all text-text-faint">{receipt?.path ?? decision.path ??
          t("views.decisionsView.pathUnknown")} · commit {receipt?.commitSha?.slice(0, 10) ??
          t("views.decisionsView.notInCurrentSession")}</span>
      </li>;
    })}</ul>
    {hiddenCount > 0 && <button type="button" data-testid="decisions-history-more"
      onClick={() => setVisibleCount((count) => Math.min(count + HISTORY_BATCH_SIZE, history.length))}
      className="mt-1.5 w-full rounded-lg border border-dashed border-border px-3 py-2 text-center
        font-mono text-[11px] text-text-muted hover:border-border-strong hover:text-text">{
      t("views.decisionsView.showMoreHistory", { count: Math.min(HISTORY_BATCH_SIZE, hiddenCount),
        remaining: hiddenCount })}</button>}
  </section>;
}

export function DecisionsView({
  decisions, tasks, relations, facts, onCallAgent, onJudge, mutationFeedback, onCheckReceipt,
  relationState = "ready", onNavigateDecision, onNavigateTask, onFocusGraph, onNavigateEntity, coverageRows = [],
}: {
  decisions: DecisionRow[]; tasks: TaskRow[]; relations: RelationEdge[]; facts: FactRef[];
  onCallAgent?: (cmd: string) => void;
  onJudge: (decision: DecisionRow, action: DecisionAction, input: { readonly rationale: string; readonly judgmentOnlyRationale?: string }) => Promise<DecisionMutationFeedback>;
  mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
  onCheckReceipt?: (decisionId: string) => void;
  relationState?: "ready" | "loading" | "error";
  onNavigateDecision?: (decisionId: string) => void; onNavigateTask?: (taskId: string) => void; onFocusGraph?: (ref: string) => void;
  onNavigateEntity?: (ref: string) => void;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
}) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set()), [cursor, setCursor] = useState(0), [inspectedFactRef, setInspectedFactRef] = useState<string | null>(null), [help, setHelp] = useState(false);
  const [openRequest, setOpenRequest] = useState<(JudgmentOpenRequest & { readonly decisionId: string }) | undefined>();
  const queue = useMemo(() => {
    const proposed = decisions.filter((decision) => decision.state === "proposed"), active = proposed.filter((decision) => !skipped.has(decision.decisionId)), skippedRows = proposed.filter((decision) => skipped.has(decision.decisionId));
    const sorted = (rows: DecisionRow[]) => [...rows].sort((a, b) => { const [ra, ua] = sortKey(a), [rb, ub] = sortKey(b); return ra - rb || ua - ub || (a.proposedAt ?? "").localeCompare(b.proposedAt ?? ""); });
    return [...sorted(active), ...sorted(skippedRows)];
  }, [decisions, skipped]);
  const idx = Math.min(cursor, Math.max(0, queue.length - 1)), current = queue[idx] ?? null;
  const history = useMemo(() => decisions.flatMap((decision) => decision.judgmentConsents.map((consent) => ({ decision, consent }))).sort((a, b) => b.consent.consentedAt.localeCompare(a.consent.consentedAt)), [decisions]);
  const skip = useCallback(() => { if (current) setSkipped((previous) => new Set(previous).add(current.decisionId)); }, [current]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "j") setCursor((value) => Math.min(queue.length - 1, value + 1));
      else if (key === "k") setCursor((value) => Math.max(0, value - 1));
      else if (key === "s") skip();
      else if (key === "?") setHelp((value) => !value);
      else if (current && (key === "a" || key === "r" || key === "d")) setOpenRequest({ decisionId: current.decisionId, action: key === "a" ? "accept" : key === "r" ? "reject" : "defer", nonce: Date.now() });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [current, queue.length, skip]);

  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5"><ChatCircleDots weight="bold" className="text-accent" /><span className="text-[13px] font-semibold text-text">决策批准</span><span className="rounded bg-surface-raised px-1.5 font-mono text-[11px] tabular-nums text-text-muted">{queue.length ? `${idx + 1} / ${queue.length}` : "0 / 0"}</span><span className="truncate text-[11px] text-text-faint">riskTier × urgency · canonical reread</span>
      <div className="ml-auto flex items-center gap-1"><button onClick={() => setCursor((value) => Math.max(0, value - 1))} disabled={idx === 0} title="上一条 · K" className="grid size-6 place-items-center rounded-md text-text-muted transition-colors duration-100 hover:bg-surface-raised hover:text-text disabled:pointer-events-none disabled:opacity-30"><CaretLeft /></button><button onClick={() => setCursor((value) => Math.min(queue.length - 1, value + 1))} disabled={idx >= queue.length - 1} title="下一条 · J" className="grid size-6 place-items-center rounded-md text-text-muted transition-colors duration-100 hover:bg-surface-raised hover:text-text disabled:pointer-events-none disabled:opacity-30"><CaretRight /></button><button onClick={skip} disabled={!current} title="跳过 · S（不改 canonical 状态）" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-text disabled:pointer-events-none disabled:opacity-30"><SkipForward />跳过</button>{skipped.size > 0 && <button onClick={() => { setSkipped(new Set()); setCursor(0); }} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] tabular-nums text-accent transition-colors duration-100 hover:bg-accent/10"><ArrowsClockwise />恢复{skipped.size}</button>}<button onClick={() => setHelp((value) => !value)} className="rounded-md px-2 py-1 font-mono text-[11px] text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-text">?</button></div>
    </div>
    {help && <div className="border-b border-border bg-surface-raised px-4 py-2 font-mono text-[11px] leading-relaxed text-text-muted">J/K 下一条/上一条 · S 跳过 · A/R/D 打开 Accept/Reject/Defer rationale · ? 帮助；编辑字段内快捷键停用。</div>}
    <div className="flex min-h-0 flex-1"><div className="flex min-w-0 flex-1 flex-col"><div className="flex-1 overflow-auto p-4">
      {current ? <><div className="mb-2 rounded-md bg-stale/10 px-3 py-1.5 text-[11px] leading-relaxed text-stale">只处理 canonical proposed。mutation pending 只锁当前卡；不要重放，用 opId 查询 receipt。</div><VerdictCard key={current.decisionId} d={current} decisions={decisions} facts={facts} tasks={tasks} relations={relations} onCallAgent={onCallAgent} onJudge={onJudge} mutationFeedback={mutationFeedback?.(current.decisionId)} onCheckReceipt={() => onCheckReceipt?.(current.decisionId)} openRequest={openRequest?.decisionId === current.decisionId ? openRequest : undefined} onInspectFact={setInspectedFactRef}
          onNavigateDecision={(id) => onNavigateDecision?.(id)}
          onNavigateTask={(id) => onNavigateTask?.(id)}
          onNavigateEntity={(ref) => onNavigateEntity?.(ref)}
          coverageRows={coverageRows}
          relationState={relationState} />
          </> : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-surface-raised">
                <SealCheck weight="duotone" className="text-[28px] text-success" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-text">当前无待决策批准</div>
                <div className="mt-1 text-[12px] text-text-faint">终态只来自 canonical decision + judgment consent。</div>
              </div>
            </div>
          )}
      <JudgmentHistory history={history} mutationFeedback={mutationFeedback} />
    </div>
      {queue.length > 0 && <div className="border-t border-border bg-surface-raised/50 px-4 py-2"><div className="flex gap-1.5 overflow-x-auto pb-0.5">{queue.map((decision, index) => <button key={decision.decisionId} onClick={() => setCursor(index)} title={decision.title} className={`shrink-0 rounded-md px-2 py-1 font-mono text-[11px] transition-colors duration-100 ${index === idx ? "bg-accent font-semibold text-accent-fg" : skipped.has(decision.decisionId) ? "bg-surface text-text-faint line-through hover:text-text-muted" : "bg-surface text-text-muted hover:text-text"}`}>{decision.decisionId}</button>)}</div></div>}
    </div>{inspectedFactRef && <FactInspector factRef={inspectedFactRef} facts={facts} tasks={tasks} decisions={decisions} relations={relations} onClose={() => setInspectedFactRef(null)} onNavigateDecision={onNavigateDecision} onNavigateTask={onNavigateTask} onFocusGraph={onFocusGraph} coverageRows={coverageRows} />}</div>
  </div>;
}
