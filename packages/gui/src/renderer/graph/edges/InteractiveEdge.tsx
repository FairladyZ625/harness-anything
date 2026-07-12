import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { AXIS_COLOR_VAR, type SemanticAxis } from "../constants";

/**
 * 关系图通用边(dec_01KXA7811SVVT8P66HNDFZQ7DF CH4)。
 *
 * 颜色按 axis (authority / evidence / execution / assoc) 区分;
 * 轴配色由 graphLayout.buildEdge 写入 style.stroke,本组件保留 hover 高亮。
 */
export function InteractiveEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
  data,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  const axis = (data as { axis?: SemanticAxis } | undefined)?.axis ?? "authority";
  const axisColor = AXIS_COLOR_VAR[axis];

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: selected ? 3.5 : (style.strokeWidth as number | undefined) ?? 1.6,
          stroke: selected ? "var(--color-accent)" : (style.stroke as string | undefined) ?? axisColor,
        }}
        className="transition-all duration-200 ease-in-out"
      />
      {/* Invisible thick path for hovering and clicking */}
      <path
        d={edgePath}
        fill="none"
        strokeOpacity={0}
        strokeWidth={20}
        className="cursor-pointer"
        onMouseEnter={(e) => {
          const el = e.currentTarget.previousElementSibling as SVGPathElement | null;
          if (el && !selected) {
            el.style.stroke = "var(--color-accent)";
            el.style.strokeWidth = "3";
          }
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget.previousElementSibling as SVGPathElement | null;
          if (el && !selected) {
            el.style.stroke = (style.stroke as string | undefined) ?? axisColor;
            el.style.strokeWidth = String((style.strokeWidth as number | undefined) ?? 1.6);
          }
        }}
      />
    </>
  );
}
