import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { DecisionRow } from "../../model/types";

/** 全 ledger 无任何谱系边时的占位（data-testid 供集成测试定位）。 */
export function GenealogyEmptyState() {
  return (
    <div
      data-testid="genealogy-timeline-empty-state"
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
    >
      <ClockCounterClockwise weight="duotone" className="text-3xl text-text-faint" />
      <div className="text-[14px] font-semibold text-text">暂无决策谱系可展示</div>
      <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
        当前 ledger 里没有 refines / narrows / supersedes / supports 的 decision→decision 边。
        出现思想演化关系后，这里会按时间轴渲染其谱系。
      </div>
    </div>
  );
}

/** 焦点决策为孤立节点（无任何谱系边）时的主区提示。 */
export function IsolatedNodeMessage({ decision }: { decision: DecisionRow }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[13px] font-semibold text-text">{decision.title}</div>
      <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
        该决策暂无 refines / narrows / supersedes / supports 谱系关系（孤立节点）。
        从左栏选择一个带谱系的决策查看其演化史。
      </div>
    </div>
  );
}
