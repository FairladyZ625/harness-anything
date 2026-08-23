import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DecisionRow, RelationEdge } from "../model/types";
import {
  buildGenealogyEdges,
  collectLineage,
  computeLayout,
  decisionIdOf,
  findGenealogyCycles,
  KIND_META,
  timeMsOf,
} from "../graph/genealogy";
import { DecisionDetailPanel } from "./genealogy/DecisionDetailPanel";
import { ParticipantsSidebar } from "./genealogy/ParticipantsSidebar";
import { TimelinePlot } from "./genealogy/TimelinePlot";

/**
 * 决策谱系「演化史」视图(REQ-GUI-05)。
 *
 * 纯前端派生:从 relations 筛谱系四类边(refines/narrows/supersedes/supports —— 均为
 * decision↔decision),焦点上溯/下溯。布局 = DAG 拓扑(x = 谱系深度),同列同日
 * 节点过多自动折成簇(time cluster)。
 *
 * 必填 focusRef —— 无焦点 / 非 decision 焦点 → 空态(引导用户先在聚光灯里选 decision)。
 */
export function GenealogyTimelineView({
  decisions,
  relations,
  focusRef,
  onOpenDecisionPool,
  onFocusGraph,
  onFocusChange,
}: {
  decisions: DecisionRow[];
  relations: RelationEdge[];
  focusRef?: string | null;
  /** 跳去决策池并聚焦该 decision(DecisionDetailPanel 的「在决策池查看」)。 */
  onOpenDecisionPool?: (decisionId: string) => void;
  onFocusGraph?: (ref: string) => void;
  onFocusChange?: (ref: string) => void;
}) {
  const byId = useMemo(() => {
    const map = new Map<string, DecisionRow>();
    for (const d of decisions) map.set(d.decisionId, d);
    return map;
  }, [decisions]);

  const edges = useMemo(() => buildGenealogyEdges(relations, byId), [relations, byId]);
  const cycleWarning = useMemo(() => {
    const cycles = findGenealogyCycles(edges);
    return { count: cycles.length, cycles };
  }, [edges]);

  const participants = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return [...ids]
      .map((id) => byId.get(id)!)
      .filter(Boolean)
      .sort((a, b) => (timeMsOf(b) ?? 0) - (timeMsOf(a) ?? 0));
  }, [edges, byId]);

  const lineageSize = useMemo(() => {
    const size = new Map<string, number>();
    for (const d of participants) {
      size.set(d.decisionId, collectLineage(d.decisionId, edges).size - 1);
    }
    return size;
  }, [participants, edges]);

  const focusId = useMemo(() => {
    if (!focusRef) return null;
    const incoming = decisionIdOf(focusRef);
    return incoming && byId.has(incoming) ? incoming : null;
  }, [focusRef, byId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setExpandedDays(new Set());
    setSelectedId(null);
  }, [focusId]);

  const focus = focusId ? byId.get(focusId) ?? null : null;

  const plotRef = useRef<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(900);
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => setPlotWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => computeLayout(focus, edges, byId, plotWidth, { expandedDays }),
    [focus, edges, byId, plotWidth, expandedDays],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const node of layout.nodes) map.set(node.id, node);
    return map;
  }, [layout.nodes]);

  const lineageEdges = useMemo(
    () =>
      edges.filter((edge) => {
        const covered = (id: string) =>
          nodeById.has(id) ||
          layout.nodes.some((n) => n.isCluster && n.memberIds?.includes(id));
        return covered(edge.from) && covered(edge.to);
      }),
    [edges, nodeById, layout.nodes],
  );

  if (edges.length === 0) {
    return (
      <div
        data-testid="genealogy-empty"
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
      >
        <div className="text-[14px] font-semibold text-text">暂无决策谱系边</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          当前投影没有 refines / narrows / supersedes / supports 关系。决策出现谱系边后,演化史会自动展示祖先与后代。
        </div>
      </div>
    );
  }

  if (!focus) {
    return (
      <div
        data-testid="genealogy-no-focus"
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-surface px-6 text-center"
      >
        <div className="text-[13px] font-semibold text-text">演化史需要 decision 焦点</div>
        <div className="max-w-md text-[12px] leading-relaxed text-text-faint">
          先在聚光灯里选中一个 decision,演化史会展示它的谱系(祖先 / 后代 / 同日 cluster)。
        </div>
      </div>
    );
  }

  const ancestorCount = layout.nodes.filter((n) => !n.isCluster && n.depth < 0).length;
  const descendantCount = layout.nodes.filter((n) => !n.isCluster && n.depth > 0).length;
  const visibleClusters = layout.nodes.filter((n) => n.isCluster).length;
  const selected = selectedId ? byId.get(selectedId) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="genealogy-timeline">
      <div className="flex flex-col gap-0.5 border-b border-border px-4 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span className="min-w-0 truncate font-mono text-[12px] tabular-nums text-text-faint">
            {edges.length} 条谱系边 · {participants.length} 参与者
          </span>
          {cycleWarning.count > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger"
              title={cycleWarning.cycles.map((c) => c.join(" → ")).join("\n")}
            >
              环警告 · {cycleWarning.count}
            </span>
          )}
          <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-text-faint">
            焦点谱系 · {ancestorCount} 祖先 / {descendantCount} 后代{visibleClusters > 0 ? ` · ${visibleClusters} 同日簇` : ""}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
        <span className="font-mono text-[11px] text-text-faint">DAG 拓扑(谱系深度排序,同日自动折簇)</span>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          {(["refines", "narrows", "supersedes", "supports"] as const).map((kind) => {
            const meta = KIND_META[kind];
            return (
              <span key={kind} className="inline-flex items-center gap-1 text-text-muted">
                <svg width="22" height="8" aria-hidden>
                  <line
                    x1="0" y1="4" x2="22" y2="4"
                    stroke={meta.color}
                    strokeWidth={meta.strokeWidth}
                    strokeDasharray={meta.dash || undefined}
                  />
                </svg>
                {meta.label}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ParticipantsSidebar
          participants={participants}
          focusId={focusId}
          lineageSize={lineageSize}
          onFocus={(id) => {
            if (onFocusChange) onFocusChange(`decision/${id}`);
            setSelectedId(null);
          }}
        />

        <div ref={plotRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-bg">
          {layout.nodes.length <= 1 && !layout.nodes[0]?.isCluster ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <div className="max-w-sm text-[12px] leading-relaxed text-text-faint">
                该 decision 暂无谱系连接(没有 refines/narrows/supersedes/supports 邻居)。
              </div>
            </div>
          ) : (
            <div className="p-4">
              <TimelinePlot
                layout={layout}
                nodeById={nodeById}
                lineageEdges={lineageEdges}
                selectedId={selectedId}
                expandedDays={expandedDays}
                onToggleSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
                onToggleCluster={(dayKey) => {
                  setExpandedDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(dayKey)) next.delete(dayKey);
                    else next.add(dayKey);
                    return next;
                  });
                }}
              />
            </div>
          )}
        </div>

        {selected && (
          <DecisionDetailPanel
            decision={selected}
            onClose={() => setSelectedId(null)}
            onOpenPool={onOpenDecisionPool ? () => onOpenDecisionPool(selected.decisionId) : undefined}
            onFocusGraph={onFocusGraph}
          />
        )}
      </div>
    </div>
  );
}
