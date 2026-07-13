import { Handle, Position } from "@xyflow/react";
import { t } from "../../i18n/index.tsx";

/**
 * 关系图里的 decision 节点(非聚焦态 — 谱系 lane 的邻居决策)。
 * 聚焦态由 DecisionFocusNode 渲染(claim 泳道展开)。
 */
export function DecisionNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;

  return (
    <div
      className="flex h-full w-full cursor-pointer flex-col justify-center relative box-border px-3 group transition-all duration-200"
      style={{
        backgroundColor: "var(--color-surface)",
        opacity: isDimmed ? 0.4 : 1,
        borderRadius: 8,
        borderLeft: `3px solid ${isLoop ? "#f97316" : selected ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        boxShadow: selected || isLoop
          ? `inset 0 0 0 1px ${isLoop ? "#f97316" : "var(--color-accent)"}`
          : "inset 0 0 0 1px var(--color-border)",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-axis-authority)]" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-axis-authority)]" />
      {cycleWarning && (
        <span
          title={t("graph.nodes.relationCycleTraversalTruncated")}
          className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-danger font-mono text-[10px] font-bold text-white"
        >
          !
        </span>
      )}

      <div className="absolute inset-0 bg-accent opacity-[0.05] group-hover:opacity-10 pointer-events-none rounded-lg" />

      <span className="font-mono text-[9px] text-accent leading-tight flex items-center gap-1">
        <span className="text-[12px]">◆</span> {data.decisionId}
      </span>
      <span className="text-[11px] font-medium text-text truncate w-full leading-snug mt-0.5 pr-2">
        {data.label}
      </span>
    </div>
  );
}
