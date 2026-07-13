import { useState } from "react";
import type { GenealogyEdge, LaidOutNode, TimelineLayout } from "./layout";
import {
  AXIS_H,
  CARD_H,
  CARD_W,
  CLUSTER_H,
  CLUSTER_W,
  KIND_META,
  shortTime,
} from "./layout";
import { t } from "../../i18n/index.tsx";

/**
 * 主区谱系图：刻度 + 网格 + 语义色/线型边 + 决策卡（或日簇）。
 * hover 高亮自管。同列同日簇点开展开由 onToggleCluster 上抛。
 */
export function TimelinePlot({
  layout,
  nodeById,
  lineageEdges,
  selectedId,
  expandedDays,
  onToggleSelect,
  onToggleCluster,
}: {
  layout: TimelineLayout;
  nodeById: Map<string, LaidOutNode>;
  lineageEdges: GenealogyEdge[];
  selectedId: string | null;
  expandedDays?: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleCluster?: (dayKey: string) => void;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  // 簇折叠时边的端点是成员 id；映射成员 → 可见节点（卡或所属簇）。
  const resolveVisible = (id: string): LaidOutNode | undefined => {
    const direct = nodeById.get(id);
    if (direct) return direct;
    for (const node of layout.nodes) {
      if (node.isCluster && node.memberIds?.includes(id)) return node;
    }
    return undefined;
  };

  return (
    <div
      className="relative"
      style={{ width: layout.width, height: layout.height, minWidth: "100%" }}
      data-encoding={layout.encoding}
    >
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
            <text
              x={tick.x + 3}
              y={20}
              fill="var(--color-text-faint)"
              fontSize="10"
              fontFamily="var(--font-mono)"
            >
              {tick.label}
            </text>
          </g>
        ))}
        {lineageEdges.map((edge, index) => {
          const ancestor = resolveVisible(edge.to);
          const descendant = resolveVisible(edge.from);
          if (!ancestor || !descendant) return null;
          // 同簇内边在折叠时不画，避免自环噪点。
          if (ancestor.id === descendant.id) return null;
          const aW = ancestor.isCluster ? CLUSTER_W : CARD_W;
          const dW = descendant.isCluster ? CLUSTER_W : CARD_W;
          const aH = ancestor.isCluster ? CLUSTER_H : CARD_H;
          const dH = descendant.isCluster ? CLUSTER_H : CARD_H;
          const ancRight = ancestor.x <= descendant.x;
          const sx = ancRight ? ancestor.x + aW : ancestor.x;
          const sy = ancestor.y + aH / 2;
          const ex = ancRight ? descendant.x : descendant.x + dW;
          const ey = descendant.y + dH / 2;
          const dx = (ex - sx) * 0.45;
          const meta = KIND_META[edge.kind] ?? {
            color: "var(--color-border-strong)",
            dash: "",
            strokeWidth: 1.4,
          };
          const incident =
            hoverId === edge.from ||
            hoverId === edge.to ||
            (ancestor.isCluster && ancestor.memberIds?.includes(hoverId ?? "")) ||
            (descendant.isCluster && descendant.memberIds?.includes(hoverId ?? ""));
          const dim = hoverId !== null && !incident;
          return (
            <path
              key={index}
              d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`}
              fill="none"
              stroke={meta.color}
              strokeWidth={incident ? meta.strokeWidth + 0.6 : meta.strokeWidth}
              strokeOpacity={dim ? 0.12 : 0.88}
              strokeDasharray={meta.dash || undefined}
              markerEnd={`url(#gen-arrow-${edge.kind})`}
            />
          );
        })}
      </svg>

      {layout.nodes.map((node) => {
        if (node.isCluster) {
          const dim = hoverId !== null && hoverId !== node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => node.dayKey && onToggleCluster?.(node.dayKey)}
              onMouseEnter={() => setHoverId(node.id)}
              onMouseLeave={() => setHoverId(null)}
              style={{ left: node.x, top: node.y, width: CLUSTER_W, height: CLUSTER_H }}
              className={`absolute flex flex-col justify-center gap-0.5 rounded-xl border border-dashed border-border-strong bg-surface-raised px-3 py-2 text-left transition-colors hover:border-accent ${
                dim ? "opacity-40" : ""
              }`}
              title={t("views.timelinePlot.clickExpandDaySDecision")}
            >
              <span className="font-mono text-[11px] font-semibold text-text">
                {node.dayKey === "NO_TIME" ? t("views.timelinePlot.noTime") : node.dayKey}
              </span>
              <span className="text-[12px] text-text-muted">
                {node.clusterSize ?? 0} {t("views.timelinePlot.decisionsClickExpand")}</span>
            </button>
          );
        }

        const isFocus = node.depth === 0;
        const isSelected = node.id === selectedId;
        const dim = hoverId !== null && hoverId !== node.id;
        return (
          <button
            key={node.id}
            type="button"
            title={node.decision.title}
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
              <span className="min-w-0 truncate font-mono text-[10px] text-text-faint">
                {node.id}
              </span>
              {isFocus && (
                <span className="ml-auto shrink-0 rounded bg-accent px-1 py-px font-mono text-[9px] font-semibold text-accent-fg">
                  {t("views.timelinePlot.focus")}</span>
              )}
            </div>
            <span className="line-clamp-3 break-words text-[12px] font-medium leading-snug text-text">
              {node.decision.title}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] text-text-faint">
                {shortTime(node.decision)}
              </span>
              {node.timeMs === null && (
                <span className="rounded bg-stale/15 px-1 font-mono text-[9px] text-stale">
                  {t("views.timelinePlot.noTime2")}</span>
              )}
              {node.dayKey &&
                onToggleCluster &&
                expandedDays?.has(node.dayKey) && (
                <span
                  role="link"
                  tabIndex={0}
                  className="ml-auto cursor-pointer font-mono text-[9px] text-accent hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleCluster(node.dayKey!);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.stopPropagation();
                      onToggleCluster(node.dayKey!);
                    }
                  }}
                >
                  {t("views.timelinePlot.closeDay")}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
