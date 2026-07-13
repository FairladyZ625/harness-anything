import { Handle, Position } from "@xyflow/react";
import { t } from "../../i18n/index.tsx";

/**
 * 关系图里的 task 节点(派生 lane / 简化 ego)。
 * 接受 220x44 尺寸(三泳道布局默认),保留 loop / dimmed / cycle 状态。
 */
export function TaskNode({ data, selected }: any) {
  const isLoop = data.loop;
  const isDimmed = data.dimmed;
  const cycleWarning = data.cycleWarning;
  const isAssoc = data.assoc;

  return (
    <div
      className="flex h-full w-full cursor-pointer box-border rounded-md relative transition-all duration-200"
      style={{
        backgroundColor: "var(--color-surface-raised)",
        borderColor: isLoop
          ? "#f97316"
          : selected
            ? "var(--color-axis-execution)"
            : "var(--color-border-strong)",
        borderWidth: isLoop ? "2px" : selected ? "1.5px" : "1px",
        borderStyle: "solid",
        opacity: isDimmed ? 0.18 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-axis-execution)]" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !min-w-2 !min-h-2 !border-0 !bg-[var(--color-axis-execution)]" />
      {cycleWarning && (
        <span
          title={t("graph.nodes.relationCycleTraversalTruncated")}
          className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-danger font-mono text-[10px] font-bold text-white"
        >
          !
        </span>
      )}
      <div
        className="w-[3px] rounded-l-[2px] shrink-0"
        style={{ backgroundColor: data.color ?? "var(--color-status-planned)" }}
      />
      <div className="flex flex-col justify-center ml-2 my-1 min-w-0 flex-1">
        <span className="font-mono text-[10px] text-text-muted leading-tight">
          {data.taskId}{isAssoc ? " · assoc" : ""}
        </span>
        <span className="text-[11px] text-text truncate leading-snug">{data.label}</span>
      </div>
    </div>
  );
}
