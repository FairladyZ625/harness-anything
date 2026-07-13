import type { NodeProps } from "@xyflow/react";
import { AXIS_COLOR_VAR, AXIS_LABEL, type SemanticAxis } from "../constants";
import { t } from "../../i18n/index.tsx";

interface LaneData {
  label: string;
  axis: SemanticAxis | "focus";
}

/**
 * 三泳道背景(dec_01KXA7811SVVT8P66HNDFZQ7DF 落地路径)。
 * 不接受点击 / 拖拽(在 graphLayout 里通过 selectable:false / draggable:false 关掉),
 * 只作为视觉分区 — 让用户一眼看出「谱系 │ 主张 │ 派生」。
 */
export function LaneBackgroundNode({ data }: NodeProps) {
  const d = data as unknown as LaneData;
  const accentVar = d.axis === "focus" ? "var(--color-accent)" : AXIS_COLOR_VAR[d.axis as SemanticAxis];
  const tag = d.axis === "focus" ? t("graph.laneBackgroundNode.focus") : d.axis ? AXIS_LABEL[d.axis as SemanticAxis] : "";
  return (
    <div
      className="relative h-full w-full rounded-xl border"
      style={{
        backgroundColor: "rgba(255, 255, 255, 0.015)",
        borderColor: "rgba(255, 255, 255, 0.06)",
      }}
    >
      <div
        className="absolute left-3 top-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider"
        style={{ color: accentVar }}
      >
        <span
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: accentVar, opacity: 0.6 }}
        />
        <span className="text-text-faint">{tag}</span>
        <span className="text-text-muted">{d.label}</span>
      </div>
    </div>
  );
}
