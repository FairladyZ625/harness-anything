import { memo } from "react";
import type { GenealogyEdge, LaidOutNode, TimelineLayout } from "../../graph/genealogy";
import { CARD_H, CARD_W, CLUSTER_H, CLUSTER_W, KIND_META } from "../../graph/genealogy";
import { DecisionStateBadge } from "../../components/badges";
import type { DecisionRow } from "../../model/types";

/**
 * 谱系时间轴 SVG 绘制(REQ-GUI-05)。
 * DAG 拓扑:x = 谱系深度 rank,同列内同日节点过多折簇(可展开)。
 * 边按 kind 着色(refines/narrows/supersedes/supports);环边红色虚线。
 */
export const TimelinePlot = memo(function TimelinePlot({
  layout,
  nodeById,
  lineageEdges,
  selectedId,
  expandedDays,
  onToggleSelect,
  onToggleCluster,
}: {
  layout: TimelineLayout;
  nodeById: ReadonlyMap<string, LaidOutNode>;
  lineageEdges: ReadonlyArray<GenealogyEdge>;
  selectedId: string | null;
  expandedDays: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleCluster: (dayKey: string) => void;
}) {
  const { width, height, ticks, cycleWarning } = layout;
  return (
    <div className="relative min-w-full" style={{ width: Math.max(width, 480), minHeight: height }}>
      <svg className="absolute inset-0" width={Math.max(width, 480)} height={height} style={{ pointerEvents: "none" }}>
        {/* 深度刻度 */}
        {ticks.map((tick, i) => (
          <g key={`tick-${i}`}>
            <line
              x1={tick.x + CARD_W / 2}
              y1={28}
              x2={tick.x + CARD_W / 2}
              y2={height}
              stroke="var(--color-border)"
              strokeDasharray="2 4"
              opacity={0.4}
            />
            <text
              x={tick.x + CARD_W / 2}
              y={20}
              textAnchor="middle"
              className="font-mono"
              fontSize={10}
              fill="var(--color-text-faint)"
            >
              {tick.label}
            </text>
          </g>
        ))}
        {/* 谱系边 */}
        {lineageEdges.map((edge, i) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          const meta = KIND_META[edge.kind];
          const isCycle = cycleWarning.cycles.some((c) =>
            c.some((node, j) => node === edge.from && c[j + 1] === edge.to),
          );
          const x1 = from.x + (from.isCluster ? CLUSTER_W : CARD_W) / 2;
          const y1 = from.y + (from.isCluster ? CLUSTER_H : CARD_H);
          const x2 = to.x + (to.isCluster ? CLUSTER_W : CARD_W) / 2;
          const y2 = to.y;
          const midY = (y1 + y2) / 2;
          return (
            <g key={`edge-${i}`} style={{ pointerEvents: "auto" }}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke={isCycle ? "var(--color-danger)" : meta.color}
                strokeWidth={isCycle ? 2.4 : meta.strokeWidth}
                strokeDasharray={isCycle ? "5 3" : meta.dash || undefined}
                opacity={0.85}
              />
              <title>{`${edge.from} ${meta.verb} ${edge.to}`}</title>
            </g>
          );
        })}
      </svg>
      {/* 节点卡片(absolute div,可点) */}
      {layout.nodes.map((node) =>
        node.isCluster ? (
          <button
            key={node.id}
            onClick={() => onToggleCluster(node.dayKey!)}
            className="absolute flex flex-col items-center justify-center rounded-lg border border-border bg-surface-raised shadow-sm hover:border-border-strong"
            style={{ left: node.x, top: node.y, width: CLUSTER_W, height: CLUSTER_H }}
            title={`${node.clusterSize} 条同日决策 · 点击展开`}
          >
            <span className="font-mono text-[20px] font-bold text-text-faint">{node.clusterSize}</span>
            <span className="font-mono text-[11px] text-text-faint">
              {(node.dayKey ?? "").slice(5)} · {expandedDays.has(node.dayKey!) ? "收起" : "展开"}
            </span>
          </button>
        ) : (
          <DecisionCard
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            onClick={() => onToggleSelect(node.id)}
          />
        ),
      )}
    </div>
  );
});

const DecisionCard = memo(function DecisionCard({
  node,
  selected,
  onClick,
}: {
  node: LaidOutNode;
  selected: boolean;
  onClick: () => void;
}) {
  const decision = node.decision as DecisionRow;
  return (
    <button
      data-testid="genealogy-card"
      data-decision-id={decision.decisionId}
      onClick={onClick}
      className={`absolute flex flex-col gap-1 rounded-lg border bg-surface-raised px-2.5 py-2 text-left shadow-sm transition-shadow hover:shadow-md ${
        selected ? "border-accent ring-1 ring-accent/40" : "border-border"
      }`}
      style={{ left: node.x, top: node.y, width: CARD_W, height: CARD_H }}
    >
      <div className="flex items-center gap-1.5">
        <DecisionStateBadge state={decision.state} />
        <span className="ml-auto font-mono text-[11px] text-text-faint">{node.dayKey?.slice(5)}</span>
      </div>
      <span className="line-clamp-3 text-[11px] font-medium leading-snug text-text">{decision.title}</span>
    </button>
  );
});
