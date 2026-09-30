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
import { StatusTag } from "../components/primitives/StatusTag";
import { TitleText } from "../components/primitives/TitleText";
import { DecisionDetailPanel } from "./genealogy/DecisionDetailPanel";
import { ParticipantsSidebar } from "./genealogy/ParticipantsSidebar";
import { TimelinePlot } from "./genealogy/TimelinePlot";

/**
 * 决策谱系「演化史」视图(REQ-GUI-05,视觉基线 v1 §2.6 工具型页面)。
 *
 * 纯前端派生:从 relations 筛谱系四类边(refines/narrows/supersedes/supports —— 均为
 * decision↔decision),焦点上溯/下溯。布局 = DAG 拓扑(x = 谱系深度),同列同日
 * 节点过多自动折成簇(time cluster)。页头统一(§2.3):页名 + 一句话 + 关键计数 +
 * 环警告;主画布(时间轴)铺满内容区,边类图例贴边;详情进右侧 Drawer;空态只一行
 * 说明,无焦点时侧栏即入口(点任意参与者换焦点)。
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

  const focus = focusId ? (byId.get(focusId) ?? null) : null;

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
          nodeById.has(id) || layout.nodes.some((n) => n.isCluster && n.memberIds?.includes(id));
        return covered(edge.from) && covered(edge.to);
      }),
    [edges, nodeById, layout.nodes],
  );

  if (edges.length === 0) {
    // 空态只一行说明(§2.6),不画大框。
    return (
      <div data-testid="genealogy-empty" className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="ui-meta text-text-faint">
          当前投影没有 refines / narrows / supersedes / supports 关系;决策出现谱系边后,演化史会自动展示祖先与后代。
        </p>
      </div>
    );
  }

  const ancestorCount = focus ? layout.nodes.filter((n) => !n.isCluster && n.depth < 0).length : 0;
  const descendantCount = focus ? layout.nodes.filter((n) => !n.isCluster && n.depth > 0).length : 0;
  const visibleClusters = layout.nodes.filter((n) => n.isCluster).length;
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="genealogy-timeline">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        <h1 className="flex-none text-sm font-semibold text-text">演化史</h1>
        <span className="min-w-0 flex-1 truncate ui-meta text-text-muted">这条决策线是怎么一步步演化来的</span>
        {focus && (
          <span className="min-w-0 max-w-[36%] truncate ui-meta text-text" title={focus.title}>
            <TitleText title={focus.title} />
          </span>
        )}
        <span className="flex-none font-mono ui-micro tabular-nums text-text-muted">
          {edges.length} 条谱系边 · {participants.length} 参与者
          {focus
            ? ` · 焦点谱系 ${ancestorCount} 祖先 / ${descendantCount} 后代${
                visibleClusters > 0 ? ` · ${visibleClusters} 同日簇` : ""
              }`
            : ""}
        </span>
        {cycleWarning.count > 0 && (
          <span title={cycleWarning.cycles.map((c) => c.join(" → ")).join("\n")}>
            <StatusTag tone="bad" label={`环警告 · ${cycleWarning.count}`} />
          </span>
        )}
      </header>

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
          {!focus ? (
            <div data-testid="genealogy-no-focus" className="flex h-full items-center justify-center px-6">
              <p className="max-w-sm ui-meta leading-relaxed text-text-faint">
                演化史需要 decision 焦点 —— 在左侧点一个参与者,或先在聚光灯里选中一个 decision。
              </p>
            </div>
          ) : layout.nodes.length <= 1 && !layout.nodes[0]?.isCluster ? (
            <div className="flex h-full items-center justify-center px-6">
              <p className="max-w-sm ui-meta leading-relaxed text-text-faint">
                该 decision 暂无谱系连接(没有 refines/narrows/supersedes/supports 邻居)。
              </p>
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

          {/* 边类图例:贴边玻璃(§2.6 周边控件),不遮挡主体内容。 */}
          <div className="glass pointer-events-none absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-sm px-3 py-2">
            <span className="font-mono ui-micro text-text-faint">DAG 拓扑 · 谱系深度排序 · 同日自动折簇</span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {(["refines", "narrows", "supersedes", "supports"] as const).map((kind) => {
                const meta = KIND_META[kind];
                return (
                  <span key={kind} className="inline-flex items-center gap-1 ui-micro text-text-muted">
                    <svg width="22" height="8" aria-hidden>
                      <line
                        x1="0"
                        y1="4"
                        x2="22"
                        y2="4"
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
