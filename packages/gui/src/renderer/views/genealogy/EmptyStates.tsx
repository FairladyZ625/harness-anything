import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";
import { t } from "../../i18n/index.tsx";

/** 全 ledger 无任何谱系边时的占位（data-testid 供集成测试定位）。 */
export function GenealogyEmptyState() {
  return (
    <div
      data-testid="genealogy-timeline-empty-state"
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
    >
      <ClockCounterClockwise weight="duotone" className="text-3xl text-text-faint" />
      <div className="text-[14px] font-semibold text-text">{t("views.emptyStates.thereCurrentlyNoDecisionMakingPedigreeDisplay")}</div>
      <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
        {t("views.emptyStates.thereCurrentlyNoDecisionDecisionEdgeRefines")}</div>
    </div>
  );
}

/** 焦点决策为孤立节点（无任何谱系边）时的主区提示。 */
export function IsolatedNodeMessage({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[13px] font-semibold text-text">{decision.title}</div>
      <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
        {t("views.emptyStates.decisionHasNoRefinesNarrowsSupersedesSupports")}</div>
    </div>
  );
}
