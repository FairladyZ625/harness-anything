import { X, ArrowsOutSimple } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../../components/badges";
import { Drawer } from "../../components/primitives/Drawer";
import { ViewInGraphButton } from "../../components/ViewInGraphButton.tsx";

/**
 * 决策详情抽屉(REQ-GUI-05 + 视觉基线 v1 §2.6):复用共享 Drawer 原语的右侧覆盖式
 * 抽屉,谱系图选中节点时出现;Esc / 点背景 / 关闭钮收回。内容:状态、问题、
 * 已选/否决/why-not,可「在决策池查看」「在关系图聚焦」。
 */
export function DecisionDetailPanel({
  decision,
  onClose,
  onOpenPool,
  onFocusGraph,
}: {
  decision: DecisionRow;
  /** 关闭抽屉(Esc 与点背景由 Drawer 壳层处理)。 */
  onClose: () => void;
  /** 跳去决策池并聚焦该 decision。 */
  onOpenPool?: () => void;
  onFocusGraph?: (ref: string) => void;
}) {
  return (
    <Drawer open onClose={onClose} modal={false} ariaLabel="决策详情">
      <div data-testid="decision-detail-panel" className="flex flex-col gap-3">
        <div className="flex items-center gap-2 border-b border-border pb-2.5">
          <span className="font-mono ui-micro text-text-muted">决策详情</span>
          <button
            onClick={onClose}
            aria-label="关闭决策详情"
            className="ml-auto grid size-6 place-items-center rounded-xs text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <p className="ui-body font-semibold leading-snug text-text">{decision.title}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <DecisionStateBadge state={decision.state} />
          <RiskTierBadge tier={decision.riskTier} />
          <UrgencyBadge urgency={decision.urgency} />
        </div>
        <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2">
          <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">问题</span>
          <p className="mt-1 ui-meta font-medium text-text">{decision.question}</p>
        </div>
        {decision.chosen.length > 0 && (
          <div className="rounded-sm border border-accent/30 bg-accent/5 px-2.5 py-2">
            <span className="font-mono ui-micro uppercase tracking-wide text-accent">已选策略</span>
            {decision.chosen.map((c) => (
              <p key={c.id} className="mt-1 ui-meta text-text">
                {c.text}
              </p>
            ))}
          </div>
        )}
        {decision.rejected.length > 0 && (
          <div className="rounded-sm border border-danger/30 bg-danger/5 px-2.5 py-2">
            <span className="font-mono ui-micro uppercase tracking-wide text-danger">已否决(why-not)</span>
            {decision.rejected.map((c) => (
              <div key={c.id} className="mt-1.5">
                <p className="ui-meta text-text line-through opacity-70">{c.text}</p>
                {c.whyNot && <p className="mt-0.5 font-mono ui-micro text-text-muted">→ {c.whyNot}</p>}
              </div>
            ))}
          </div>
        )}
        {decision.claims.length > 0 && (
          <div className="rounded-sm border border-border bg-surface-raised px-2.5 py-2">
            <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">承重论点</span>
            <ul className="mt-1 list-inside list-disc ui-meta text-text-muted">
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
              className="inline-flex items-center gap-1 rounded-xs border border-border px-2 py-1.5 ui-micro text-text-muted hover:border-border-strong hover:text-text"
            >
              <ArrowsOutSimple weight="bold" className="ui-micro" />
              在决策池查看
            </button>
          )}
          <ViewInGraphButton
            entityRef={`decision/${decision.decisionId}`}
            onFocusGraph={onFocusGraph}
            testId="decision-panel-view-in-graph"
            className="inline-flex items-center gap-1 rounded-xs border border-border px-2 py-1.5 ui-micro text-text-muted hover:border-border-strong hover:text-text"
          />
        </div>
      </div>
    </Drawer>
  );
}
