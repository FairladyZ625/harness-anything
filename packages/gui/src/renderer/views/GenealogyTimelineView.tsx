import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { DecisionRow, RelationEdge } from "../model/types";
import {
  ENCODING_META,
  KIND_META,
  buildGenealogyEdges,
  collectLineage,
  computeLayout,
  decisionIdOf,
  findGenealogyCycles,
  timeMsOf,
} from "./genealogy/layout";
import { DecisionDetailPanel } from "./genealogy/DecisionDetailPanel";
import { GenealogyEmptyState, IsolatedNodeMessage } from "./genealogy/EmptyStates";
import { ParticipantsSidebar } from "./genealogy/ParticipantsSidebar";
import { TimelinePlot } from "./genealogy/TimelinePlot";
import { t, tp } from "../i18n/index.tsx";

/**
 * 决策谱系「演化史」视图入口壳。
 *
 * 纯前端派生：从 relations 筛谱系四类边，焦点上溯/下溯。
 * 布局 = DAG 拓扑（x = 谱系深度），同列内同日节点过多时自动折成簇（可展开）。
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
    for (const decision of participants) {
      size.set(decision.decisionId, collectLineage(decision.decisionId, edges).size - 1);
    }
    return size;
  }, [participants, edges]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());

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

  // 换焦点时收起日簇，避免状态串台。
  useEffect(() => {
    setExpandedDays(new Set());
    setSelectedId(null);
  }, [focusId]);

  const focus = focusId ? byId.get(focusId) ?? null : null;

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

  const layout = useMemo(
    () =>
      computeLayout(focus, edges, byId, plotWidth, {
        expandedDays,
      }),
    [focus, edges, byId, plotWidth, expandedDays],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, (typeof layout.nodes)[number]>();
    for (const node of layout.nodes) map.set(node.id, node);
    return map;
  }, [layout.nodes]);

  const lineageEdges = useMemo(
    () => edges.filter((edge) => {
      // 边端点在布局集合，或被折叠进某个可见簇。
      const covered = (id: string) =>
        nodeById.has(id) ||
        layout.nodes.some((n) => n.isCluster && n.memberIds?.includes(id));
      return covered(edge.from) && covered(edge.to);
    }),
    [edges, nodeById, layout.nodes],
  );

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const ancestorCount = layout.nodes.filter((node) => !node.isCluster && node.depth < 0).length;
  const descendantCount = layout.nodes.filter((node) => !node.isCluster && node.depth > 0).length;
  const visibleCards = layout.nodes.filter((n) => !n.isCluster).length;
  const visibleClusters = layout.nodes.filter((n) => n.isCluster).length;

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
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="genealogy-timeline">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <h1 className="ui-title inline-flex items-center gap-1.5 font-semibold">
          <ClockCounterClockwise weight="duotone" className="text-accent" />
          {t("views.genealogyTimelineView.evolutionDecisionMaking")}
        </h1>
        <span className="font-mono text-[12px] text-text-faint">
          {tp(edges.length, {
            one: "views.genealogyTimelineView.headerStatsOne",
            other: "views.genealogyTimelineView.headerStatsOther",
          }, {
            participants: participants.length,
          })}
        </span>
        {cycleWarning.count > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-danger"
            title={cycleWarning.cycles.map((c) => c.join(" → ")).join("\n")}
          >
            {t("views.genealogyTimelineView.cycleWarning", { count: cycleWarning.count })}
          </span>
        )}
        {focus && (
          <span className="font-mono text-[11px] text-text-faint">
            {t("views.genealogyTimelineView.focusPedigree")}{ancestorCount} {t("views.genealogyTimelineView.ancestors")}{descendantCount} {t("views.genealogyTimelineView.descendants")}{visibleClusters > 0
              ? t("views.genealogyTimelineView.visibleClustersDayClustersVisibleCardsCards", { visibleClusters: visibleClusters, visibleCards: visibleCards })
              : ""}
          </span>
        )}
      </header>

      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
        <span className="font-mono text-[11px] text-text-faint">
          {ENCODING_META.dag.label}：{ENCODING_META.dag.blurb}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          {(["refines", "narrows", "supersedes", "supports"] as const).map((kind) => {
            const meta = KIND_META[kind];
            return (
              <span key={kind} className="inline-flex items-center gap-1 text-text-muted">
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

        <div ref={plotRef} className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-bg">
          {focus && layout.nodes.length <= 1 && !layout.nodes[0]?.isCluster ? (
            <IsolatedNodeMessage decision={focus} />
          ) : (
            <TimelinePlot
              layout={layout}
              nodeById={nodeById}
              lineageEdges={lineageEdges}
              selectedId={selectedId}
              expandedDays={expandedDays}
              onToggleSelect={(id) =>
                setSelectedId((prev) => (prev === id ? null : id))
              }
              onToggleCluster={(dayKey) => {
                setExpandedDays((prev) => {
                  const next = new Set(prev);
                  if (next.has(dayKey)) next.delete(dayKey);
                  else next.add(dayKey);
                  return next;
                });
              }}
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
