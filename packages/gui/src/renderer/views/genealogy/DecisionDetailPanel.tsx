import { ArrowSquareOut, Graph, X } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { DecisionStateBadge } from "../../components/badges";
import { t } from "../../i18n/index.tsx";

/** 选中决策的详情面板（右栏）：id / 状态 / question / chosen / rejected + 外链。 */
export function DecisionDetailPanel({
  decision,
  onClose,
  onNavigateEntity,
  onFocusGraph,
}: {
  decision: DecisionRow;
  onClose: () => void;
  onNavigateEntity?: (ref: string) => void;
  onFocusGraph?: (ref: string) => void;
}) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-start gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-text-faint">{decision.decisionId}</span>
            <DecisionStateBadge state={decision.state} />
          </div>
          <h3 className="mt-1 text-[15px] font-semibold leading-snug text-text">{decision.title}</h3>
        </div>
        <button
          onClick={onClose}
          title={t("views.decisionDetailPanel.closeDetails")}
          className="grid size-6 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
        >
          <X weight="bold" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
          <span>{t("views.decisionDetailPanel.decidedValue", { value: decision.decidedAt ? decision.decidedAt.slice(0, 16).replace("T", " ") : "—" })}</span>
          <span>{t("views.decisionDetailPanel.proposedValue", { value: decision.proposedAt ? decision.proposedAt.slice(0, 16).replace("T", " ") : "—" })}</span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-text-muted">
          <span className="font-semibold text-text-faint">Q: </span>
          {decision.question}
        </p>
        {decision.chosen.length > 0 && (
          <section className="mt-3">
            <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailPanel.chosen")}</div>
            <ul className="mt-1 space-y-1">
              {decision.chosen.map((claim) => (
                <li key={claim.id} className="flex gap-1.5 text-[12px] leading-snug text-text">
                  <span className="font-mono text-[10px] text-accent">{claim.id}</span>
                  <span className="min-w-0">{claim.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {decision.rejected.length > 0 && (
          <section className="mt-3">
            <div className="font-mono text-[10px] uppercase tracking-wide text-text-faint">{t("views.decisionDetailPanel.rejected")}</div>
            <ul className="mt-1 space-y-1">
              {decision.rejected.map((claim) => (
                <li key={claim.id} className="text-[12px] leading-snug text-text-muted">
                  <span className="font-mono text-[10px] text-danger">{claim.id}</span> {claim.text}
                  {claim.whyNot && (
                    <span className="mt-0.5 block text-[11px] text-text-faint">↳ {claim.whyNot}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        {onNavigateEntity && (
          <button
            onClick={() => onNavigateEntity(`decision/${decision.decisionId}`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-text-muted hover:border-border-strong hover:text-text"
          >
            <ArrowSquareOut weight="bold" />
            {t("views.decisionDetailPanel.viewDecisionPool")}</button>
        )}
        {onFocusGraph && (
          <button
            onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-text-muted hover:border-border-strong hover:text-accent"
          >
            <Graph weight="bold" />
            {t("views.decisionDetailPanel.focusRelationshipDiagram")}</button>
        )}
      </footer>
    </aside>
  );
}
