import type { SemanticAxis } from "../constants";
import { AXIS_COLOR_VAR } from "../constants";

/**
 * 三泳道背景带(REQ-GUI-04 聚光灯)。
 * 左侧泳道标签 + 轴色淡底,不可选不可拖。节点在其上方绘制(ZIndex 更高)。
 */
export function LaneBackgroundNode({ data }: any) {
  const axis = (data.axis ?? "assoc") as SemanticAxis;
  const color = AXIS_COLOR_VAR[axis];
  return (
    <div
      className="flex items-start"
      style={{
        width: "100%",
        height: "100%",
        background: `linear-gradient(90deg, color-mix(in oklch, ${color} 10%, transparent) 0%, transparent 60%)`,
        borderTop: `1px dashed color-mix(in oklch, ${color} 40%, transparent)`,
        borderBottom: `1px dashed color-mix(in oklch, ${color} 40%, transparent)`,
      }}
    >
      <div
        className="flex h-full shrink-0 flex-col justify-center px-3"
        style={{ width: 84, borderRight: `2px solid ${color}` }}
      >
        <span className="font-mono text-[11px] font-semibold" style={{ color }}>
          {data.label}
        </span>
        <span className="mt-1 font-mono text-[9px] leading-tight text-text-faint">
          {data.sublabel}
        </span>
      </div>
    </div>
  );
}
