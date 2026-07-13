import { Handle, Position } from "@xyflow/react";
import { t } from "../../i18n/index.tsx";

/**
 * fact 节点(展开态)。默认折叠成 claim/task 上的徽章(dec_01KXA7811SVVT8P66HNDFZQ7DF CH3);
 * 用户点开后渲染为圆形节点,边锚到 claim handle。
 */
export function FactNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;

  return (
    <div
      className="relative flex h-full w-full items-center justify-center cursor-pointer rounded-full border shadow-sm transition-all duration-200"
      style={{
        backgroundColor: "rgba(240, 162, 60, 0.18)",
        opacity: isDimmed ? 0.4 : 1,
        borderColor: isLoop ? "#f97316" : selected ? "var(--color-axis-evidence)" : "var(--color-border-strong)",
        borderWidth: isLoop ? "2px" : selected ? "1.5px" : "1px",
        boxShadow: selected ? `0 0 0 3px rgba(240,162,60,0.2)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !min-w-1.5 !min-h-1.5 !border-0 !bg-[var(--color-axis-evidence)]" />
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !min-w-1.5 !min-h-1.5 !border-0 !bg-[var(--color-axis-evidence)]" />
      {cycleWarning && (
        <span
          title={t("graph.nodes.relationCycleDetected")}
          className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full bg-danger font-mono text-[9px] font-bold text-white"
        >
          !
        </span>
      )}
      <span className="font-mono text-[9px] text-stale font-semibold">F</span>
    </div>
  );
}
