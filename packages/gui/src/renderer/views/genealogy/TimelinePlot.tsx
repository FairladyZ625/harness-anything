import { useState } from "react";
import type { GenealogyEdge, LaidOutNode, TimelineLayout } from "./layout";
import { AXIS_H, CARD_H, CARD_W, KIND_META, shortTime } from "./layout";

/**
 * 主区时间轴谱系：时间刻度 + 竖向网格 + 谱系边（带箭头与语义色）+ 决策卡。
 * hover 高亮自管：悬停一张卡时，与之无关的边/卡会被压暗。
 */
export function TimelinePlot({
  layout,
  nodeById,
  lineageEdges,
  selectedId,
  onToggleSelect,
}: {
  layout: TimelineLayout;
  nodeById: Map<string, LaidOutNode>;
  lineageEdges: GenealogyEdge[];
  selectedId: string | null;
  onToggleSelect: (id: string) => void;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: "100%" }}>
      {/* 时间轴刻度 + 竖向网格 */}
      <svg
        className="pointer-events-none absolute inset-0"
        width={layout.width}
        height={layout.height}
      >
        <defs>
          {(["refines", "narrows", "supersedes", "supports"] as const).map((kind) => (
            <marker
              key={kind}
              id={`gen-arrow-${kind}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" fill={KIND_META[kind].color} />
            </marker>
          ))}
        </defs>
        {layout.ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={tick.x}
              y1={AXIS_H}
              x2={tick.x}
              y2={layout.height}
              stroke="var(--color-border)"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text x={tick.x + 3} y={20} fill="var(--color-text-faint)" fontSize="10" fontFamily="var(--font-mono)">
              {tick.label}
            </text>
          </g>
        ))}
        {/* 谱系边 */}
        {lineageEdges.map((edge, index) => {
          const ancestor = nodeById.get(edge.to)!;
          const descendant = nodeById.get(edge.from)!;
          const ancRight = ancestor.x <= descendant.x;
          const sx = ancRight ? ancestor.x + CARD_W : ancestor.x;
          const sy = ancestor.y + CARD_H / 2;
          const ex = ancRight ? descendant.x : descendant.x + CARD_W;
          const ey = descendant.y + CARD_H / 2;
          const dx = (ex - sx) * 0.45;
          const incident = hoverId === edge.from || hoverId === edge.to;
          const dim = hoverId !== null && !incident;
          return (
            <path
              key={index}
              d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`}
              fill="none"
              stroke={KIND_META[edge.kind]?.color ?? "var(--color-border-strong)"}
              strokeWidth={incident ? 2.2 : 1.4}
              strokeOpacity={dim ? 0.15 : 0.85}
              markerEnd={`url(#gen-arrow-${edge.kind})`}
            />
          );
        })}
      </svg>

      {/* 决策卡 */}
      {layout.nodes.map((node) => {
        const isFocus = node.depth === 0;
        const isSelected = node.id === selectedId;
        const dim = hoverId !== null && hoverId !== node.id;
        return (
          <button
            key={node.id}
            onClick={() => onToggleSelect(node.id)}
            onMouseEnter={() => setHoverId(node.id)}
            onMouseLeave={() => setHoverId(null)}
            style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
            className={`absolute flex flex-col justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              isFocus
                ? "border-accent bg-accent/10"
                : isSelected
                  ? "border-border-strong bg-surface-raised"
                  : "border-border bg-surface hover:border-border-strong"
            } ${dim ? "opacity-40" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono text-[10px] text-text-faint">{node.id}</span>
              {isFocus && (
                <span className="ml-auto rounded bg-accent px-1 py-px font-mono text-[9px] font-semibold text-accent-fg">
                  焦点
                </span>
              )}
            </div>
            <span className="truncate text-[12px] font-medium leading-tight text-text">{node.decision.title}</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] text-text-faint">{shortTime(node.decision)}</span>
              {node.timeMs === null && (
                <span className="rounded bg-stale/15 px-1 font-mono text-[9px] text-stale">无时间</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
