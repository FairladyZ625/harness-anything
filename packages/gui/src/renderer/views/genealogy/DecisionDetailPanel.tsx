import { X, ArrowsOutSimple, Graph } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../../components/badges";

/**
 * 决策详情面板(REQ-GUI-05):状态、问题、已选/否决/why-not,
 * 可「在决策池查看」「在关系图聚焦」。W4 起被决策详情页整栏复用
 * (onClose 缺省不渲染关闭钮,side 控制贴边方向)。
 */
export function DecisionDetailPanel({
  decision,
  onClose,
  onOpenPool,
  onFocusGraph,
  side = "left",
}: {
  decision: DecisionRow;
  /** 关闭按钮;缺省(详情页整栏复用)不渲染。 */
  onClose?: () => void;
  /** 跳去决策池并聚焦该 decision。 */
  onOpenPool?: () => void;
  onFocusGraph?: (ref: string) => void;
  /** 面板贴哪一侧:演化史内嵌(左)或详情页主栏(右)。 */
  side?: "left" | "right";
}) {
  return (
    <aside
      data-testid="decision-detail-panel"
      className={`flex w-[26rem] shrink-0 flex-col overflow-y-auto ${side === "left" ? "border-l" : "border-r"} border-border bg-surface`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="font-mono text-[11px] text-text-muted">决策详情</span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="text-[13px] font-semibold leading-snug text-text">{decision.title}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <DecisionStateBadge state={decision.state} />
          <RiskTierBadge tier={decision.riskTier} />
          <UrgencyBadge urgency={decision.urgency} />
        </div>
        <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">问题</span>
          <p className="mt-1 text-[12px] font-medium text-text">{decision.question}</p>
        </div>
        {decision.chosen.length > 0 && (
          <div className="rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-accent">已选策略</span>
            {decision.chosen.map((c) => (
              <p key={c.id} className="mt-1 text-[12px] text-text">
                {c.text}
              </p>
            ))}
          </div>
        )}
        {decision.rejected.length > 0 && (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-danger">已否决(why-not)</span>
            {decision.rejected.map((c) => (
              <div key={c.id} className="mt-1.5">
                <p className="text-[12px] text-text line-through opacity-70">{c.text}</p>
                {c.whyNot && <p className="mt-0.5 font-mono text-[11px] text-text-muted">→ {c.whyNot}</p>}
              </div>
            ))}
          </div>
        )}
        {decision.claims.length > 0 && (
          <div className="rounded-md border border-border bg-surface-raised px-2.5 py-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">承重论点</span>
            <ul className="mt-1 list-inside list-disc text-[12px] text-text-muted">
              {decision.claims.map((c) => (
                <li key={c.id}>{c.text}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-1 flex gap-2">
          {onOpenPool && (
            <button
              onClick={onOpenPool}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text"
            >
              <ArrowsOutSimple weight="bold" className="text-[11px]" />
              在决策池查看
            </button>
          )}
          {onFocusGraph && (
            <button
              onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[11px] text-text-muted hover:border-border-strong hover:text-text"
            >
              <Graph weight="bold" className="text-[11px]" />
              在关系图聚焦
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
