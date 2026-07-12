import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { DecisionRow, RelationEdge } from "../model/types";
import {
  KIND_META,
  buildGenealogyEdges,
  collectLineage,
  computeLayout,
  decisionIdOf,
  timeMsOf,
} from "./genealogy/layout";
import { DecisionDetailPanel } from "./genealogy/DecisionDetailPanel";
import { GenealogyEmptyState, IsolatedNodeMessage } from "./genealogy/EmptyStates";
import { ParticipantsSidebar } from "./genealogy/ParticipantsSidebar";
import { TimelinePlot } from "./genealogy/TimelinePlot";

/**
 * 决策谱系「演化史」视图入口壳（Jaeger-timeline 式）。
 *
 * 纯前端派生：从 triadicQuery.relations 里筛 kind ∈ 谱系四类且两端皆 decision，
 * 以选中 decision 为焦点上溯祖先 / 下溯后代。不改后端、不换图库、不碰 graph/**。
 *
 * 本文件只做编排（状态 / 派生 memo / 布局计算 / 子组件装配），职责细节见
 * ./genealogy/ 下的 layout（纯逻辑）、ParticipantsSidebar / TimelinePlot /
 * DecisionDetailPanel / EmptyStates（展示子组件）。
 */
export function GenealogyTimelineView({
  decisions,
  relations,
  focusRef,
  onNavigateEntity,
  onFocusGraph,
}: {
  decisions: DecisionRow[];
  relations: RelationEdge[];
  /** 跨视图带入的聚焦实体（decision/<id>）；用于多视图切换同一实体。 */
  focusRef?: string | null;
  onNavigateEntity?: (ref: string) => void;
  onFocusGraph?: (ref: string) => void;
}) {
  const byId = useMemo(() => {
    const map = new Map<string, DecisionRow>();
    for (const decision of decisions) map.set(decision.decisionId, decision);
    return map;
  }, [decisions]);

  const edges = useMemo(() => buildGenealogyEdges(relations, byId), [relations, byId]);

  // 参与谱系（有任一谱系边）的 decision——左栏候选焦点集。
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

  // 每个 decision 的谱系规模（祖先+后代数），用于默认挑一个「最有料」的焦点。
  const lineageSize = useMemo(() => {
    const size = new Map<string, number>();
    for (const decision of participants) {
      size.set(decision.decisionId, collectLineage(decision.decisionId, edges).size - 1);
    }
    return size;
  }, [participants, edges]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // 跨视图带入的焦点优先；否则挑谱系最大的一个。
  useEffect(() => {
    const incoming = focusRef ? decisionIdOf(focusRef) : null;
    if (incoming && byId.has(incoming)) {
      setFocusId(incoming);
      return;
    }
    setFocusId((current) => {
      if (current && byId.has(current)) return current;
      if (participants.length === 0) return null;
      let best = participants[0].decisionId;
      let bestSize = lineageSize.get(best) ?? 0;
      for (const decision of participants) {
        const size = lineageSize.get(decision.decisionId) ?? 0;
        if (size > bestSize) {
          best = decision.decisionId;
          bestSize = size;
        }
      }
      return best;
    });
  }, [focusRef, byId, participants, lineageSize]);

  const focus = focusId ? byId.get(focusId) ?? null : null;

  // 容器宽度测量（时间轴需要具体像素宽）。
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(900);
  useLayoutEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const update = () => setPlotWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 焦点谱系的布局。
  const layout = useMemo(
    () => computeLayout(focus, edges, byId, plotWidth),
    [focus, edges, byId, plotWidth],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const node of layout.nodes) map.set(node.id, node);
    return map;
  }, [layout.nodes]);

  // 焦点谱系内的边（两端都在布局集合里）。
  const lineageEdges = useMemo(
    () => edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to)),
    [edges, nodeById],
  );

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const ancestorCount = layout.nodes.filter((node) => node.depth < 0).length;
  const descendantCount = layout.nodes.filter((node) => node.depth > 0).length;

  const filteredParticipants = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return participants;
    return participants.filter(
      (decision) =>
        decision.title.toLowerCase().includes(needle) ||
        decision.decisionId.toLowerCase().includes(needle),
    );
  }, [participants, query]);

  if (edges.length === 0) {
    return <GenealogyEmptyState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <h1 className="ui-title inline-flex items-center gap-1.5 font-semibold">
          <ClockCounterClockwise weight="duotone" className="text-accent" />
          决策演化史
        </h1>
        <span className="font-mono text-[12px] text-text-faint">
          {participants.length} 决策参与谱系 · {edges.length} 条演化边
        </span>
        {focus && (
          <span className="font-mono text-[11px] text-text-faint">
            焦点谱系：{ancestorCount} 祖先 · {descendantCount} 后代
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          {(["refines", "narrows", "supersedes", "supports"] as const).map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1 text-text-muted">
              <svg width="18" height="6" aria-hidden>
                <line x1="0" y1="3" x2="18" y2="3" stroke={KIND_META[kind].color} strokeWidth="2" />
              </svg>
              {KIND_META[kind].label}
            </span>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <ParticipantsSidebar
          participants={filteredParticipants}
          focusId={focusId}
          lineageSize={lineageSize}
          query={query}
          onQueryChange={setQuery}
          onFocus={(id) => {
            setFocusId(id);
            setSelectedId(null);
          }}
        />

        {/* 主区：时间轴谱系。 */}
        <div ref={plotRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-bg">
          {focus && layout.nodes.length <= 1 ? (
            <IsolatedNodeMessage decision={focus} />
          ) : (
            <TimelinePlot
              layout={layout}
              nodeById={nodeById}
              lineageEdges={lineageEdges}
              selectedId={selectedId}
              onToggleSelect={(id) =>
                setSelectedId((prev) => (prev === id ? null : id))
              }
            />
          )}
        </div>

        {selected && (
          <DecisionDetailPanel
            decision={selected}
            onClose={() => setSelectedId(null)}
            onNavigateEntity={onNavigateEntity}
            onFocusGraph={onFocusGraph}
          />
        )}
      </div>
    </div>
  );
}
