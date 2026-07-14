import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  Funnel,
  Graph,
  GitBranch,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import {
  DecisionStateBadge,
  RiskTierBadge,
  UrgencyBadge,
} from "../components/badges";
import { coverageOf, sortDecisionQueue } from "../model/triadic";
import { DecisionDetailPanel } from "./genealogy/DecisionDetailPanel";
import { ClaimList } from "./decisions-verdict";
import {
  POOL_TABS,
  cardCounts,
  countByTab,
  decisionSearchHaystack,
  formatActorAxes,
  groupRows,
  relationSummary,
  tabForState,
  withinRange,
  type GroupBy,
  type PoolTab,
  type TimeRange,
} from "./decision-pool-helpers";
import { t } from "../i18n/index.tsx";

const selectClass =
  "rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-muted outline-none hover:border-border-strong";

function CoverageBadge({ decision, facts }: { decision: DecisionRow; facts: FactRef[] }) {
  const coverage = coverageOf(decision, facts);
  if (coverage.total === 0) {
    return <span className="font-mono text-[11px] text-text-faint">{t("views.decisionPoolView.coverageNotAvailable")}</span>;
  }
  const ok = coverage.covered === coverage.total;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
        ok ? "bg-success/10 text-success" : "bg-stale/10 text-stale"
      }`}
      title={ok ? t("views.decisionPoolView.loadBearingArgumentsAllViableFacts") : t("views.decisionPoolView.lackAvailabilityFactValue", { value: coverage.gaps.join(", ") })}
    >
      {ok ? <CheckCircle weight="bold" /> : <WarningCircle weight="bold" />}
      {t("views.decisionPoolView.reachableCoverage", { covered: coverage.covered, total: coverage.total })}
    </span>
  );
}

function RelationSummaryView({
  decision,
  relations,
  tasks,
}: {
  decision: DecisionRow;
  relations: RelationEdge[];
  tasks: TaskRow[];
}) {
  const lines = relationSummary(decision, relations, tasks);
  if (lines.length === 0) {
    return <span className="font-mono text-[11px] text-text-faint">{t("views.decisionPoolView.noLineage")}</span>;
  }
  return (
    <div className="space-y-0.5 text-[11px]">
      {lines.map((line) => (
        <div key={line.kind} className="flex flex-wrap items-center gap-1.5">
          <GitBranch weight="bold" className="text-text-faint" />
          <span className="font-mono text-text-faint">{line.label}</span>
          <span className="font-mono text-text-muted">{line.targets.join(", ")}</span>
        </div>
      ))}
    </div>
  );
}

function CountBadges({
  decision,
  relations,
  tasks,
}: {
  decision: DecisionRow;
  relations: RelationEdge[];
  tasks: TaskRow[];
}) {
  const counts = cardCounts(decision, relations, tasks);
  return (
    <>
      <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-muted" title="claims">
        claims:{counts.claims}
      </span>
      <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-muted" title="derives">
        ↴derives:{counts.derives}
      </span>
      <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-text-muted" title="chosen/rejected">
        chosen:{counts.chosen}/rejected:{counts.rejected}
      </span>
    </>
  );
}

export function DecisionPoolView({
  decisions,
  facts,
  relations,
  tasks = [],
  focusedDecisionId,
  onFocusGraph,
  onNavigateEntity,
  onOpenApproval,
}: {
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  tasks?: TaskRow[];
  focusedDecisionId?: string | null;
  onFocusGraph?: (ref: string) => void;
  onNavigateEntity?: (ref: string) => void;
  /** Route a proposed decision into the approval queue (P3-2). */
  onOpenApproval?: (decisionId: string) => void;
}) {
  const [tab, setTab] = useState<PoolTab>("proposed");
  const [riskFilter, setRiskFilter] = useState<NonNullable<DecisionRow["riskTier"]> | "unknown" | "all">("all");
  const [urgencyFilter, setUrgencyFilter] = useState<NonNullable<DecisionRow["urgency"]> | "unknown" | "all">("all");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [presetFilter, setPresetFilter] = useState("all");
  const [originatorFilter, setOriginatorFilter] = useState<"person" | "agent" | "unknown" | "all">("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("milestone");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const handledFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusedDecisionId) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === focusedDecisionId) return;
    const decision = decisions.find((candidate) => candidate.decisionId === focusedDecisionId);
    if (!decision) return;
    handledFocusRef.current = focusedDecisionId;
    setTab(tabForState(decision.state));
    setRiskFilter("all");
    setUrgencyFilter("all");
    setVerticalFilter("all");
    setPresetFilter("all");
    setOriginatorFilter("all");
    setTimeRange("all");
    setSelectedId(focusedDecisionId);
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`decision-card-${focusedDecisionId}`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [decisions, focusedDecisionId]);

  const verticals = useMemo(
    () => [...new Set(decisions.flatMap((decision) => (decision.vertical ? [decision.vertical] : [])))].sort(),
    [decisions],
  );
  const presets = useMemo(
    () => [...new Set(decisions.flatMap((decision) => (decision.preset ? [decision.preset] : [])))].sort(),
    [decisions],
  );

  const searchTerms = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return null;
    return trimmed.split(/\s+/u).filter(Boolean);
  }, [searchQuery]);

  const hasActiveFilters =
    riskFilter !== "all"
    || urgencyFilter !== "all"
    || verticalFilter !== "all"
    || presetFilter !== "all"
    || originatorFilter !== "all"
    || timeRange !== "all"
    || searchQuery !== "";

  const resetAllFilters = () => {
    setRiskFilter("all");
    setUrgencyFilter("all");
    setVerticalFilter("all");
    setPresetFilter("all");
    setOriginatorFilter("all");
    setTimeRange("all");
    setSearchQuery("");
  };

  const rows = useMemo(() => {
    return sortDecisionQueue(decisions)
      .filter((decision) => decision.state === tab)
      .filter((decision) => {
        if (riskFilter === "all") return true;
        if (riskFilter === "unknown") return !decision.riskTier;
        return decision.riskTier === riskFilter;
      })
      .filter((decision) => {
        if (urgencyFilter === "all") return true;
        if (urgencyFilter === "unknown") return !decision.urgency;
        return decision.urgency === urgencyFilter;
      })
      .filter((decision) => verticalFilter === "all" || decision.vertical === verticalFilter)
      .filter((decision) => presetFilter === "all" || decision.preset === presetFilter)
      .filter((decision) => {
        if (originatorFilter === "all") return true;
        const originator = decision.attribution.originator;
        if (originatorFilter === "unknown") return !originator;
        return originatorFilter === "agent"
          ? Boolean(originator?.executor)
          : Boolean(originator && !originator.executor);
      })
      .filter((decision) => withinRange(decision, timeRange))
      .filter((decision) => {
        if (!searchTerms) return true;
        const hay = decisionSearchHaystack(decision);
        return searchTerms.every((term) => hay.includes(term));
      });
  }, [
    decisions,
    originatorFilter,
    presetFilter,
    riskFilter,
    searchTerms,
    tab,
    timeRange,
    urgencyFilter,
    verticalFilter,
  ]);

  const groups = useMemo(
    () => groupRows(rows, groupBy, relations, tasks),
    [groupBy, relations, rows, tasks],
  );

  const counts = useMemo(() => countByTab(decisions), [decisions]);
  const selected = selectedId
    ? decisions.find((decision) => decision.decisionId === selectedId) ?? null
    : null;

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    if (rows.length === 0) return;
    const top = rows[0]!;
    setSelectedId(top.decisionId);
    window.requestAnimationFrame(() => {
      document.getElementById(`decision-card-${top.decisionId}`)?.scrollIntoView({ block: "center" });
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">{t("views.decisionPoolView.decisionPool")}</h1>
          <span className="font-mono text-[13px] text-text-faint">
            {t("views.decisionPoolView.browseFullSetCoverageAccessibilitySupersedeAmend")}
          </span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/50 px-4 py-2">
        {POOL_TABS.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`rounded-md px-3 py-1.5 font-mono text-[12px] ${
              tab === item ? "bg-accent text-accent-fg" : "bg-surface-raised text-text-muted hover:text-text"
            }`}
          >
            {item} · {counts[item]}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-text-faint">
          <Funnel weight="bold" />
          {t("views.decisionPoolView.visibleCount", { count: rows.length })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label className="relative inline-flex items-center">
          <span className="sr-only">{t("views.decisionPoolView.searchTitleIdQuestion")}</span>
          <MagnifyingGlass
            weight="bold"
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-text-faint"
          />
          <input
            type="search"
            value={searchQuery}
            data-testid="decision-pool-search"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("views.decisionPoolView.searchTitleIdQuestion")}
            className={`${selectClass} pl-6`}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <select
          className={selectClass}
          value={groupBy}
          data-testid="decision-pool-group-by"
          onChange={(event) => setGroupBy(event.target.value as GroupBy)}
        >
          <option value="milestone">{t("views.decisionPoolView.groupByMilestone")}</option>
          <option value="vertical">{t("views.decisionPoolView.groupByVertical")}</option>
          <option value="none">{t("views.decisionPoolView.groupByNone")}</option>
        </select>
        <select className={selectClass} value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as typeof riskFilter)}>
          <option value="all">{t("views.decisionPoolView.riskAll")}</option>
          <option value="high">{t("views.decisionPoolView.riskHigh")}</option>
          <option value="medium">{t("views.decisionPoolView.riskMedium")}</option>
          <option value="low">{t("views.decisionPoolView.riskLow")}</option>
          <option value="unknown">{t("views.decisionPoolView.riskUnknown")}</option>
        </select>
        <select className={selectClass} value={urgencyFilter} onChange={(event) => setUrgencyFilter(event.target.value as typeof urgencyFilter)}>
          <option value="all">{t("views.decisionPoolView.urgencyAll")}</option>
          <option value="high">{t("views.decisionPoolView.urgencyHigh")}</option>
          <option value="medium">{t("views.decisionPoolView.urgencyMedium")}</option>
          <option value="low">{t("views.decisionPoolView.urgencyLow")}</option>
          <option value="unknown">{t("views.decisionPoolView.urgencyUnknown")}</option>
        </select>
        <select className={selectClass} value={verticalFilter} onChange={(event) => setVerticalFilter(event.target.value)}>
          <option value="all">{t("views.decisionPoolView.verticalAll")}</option>
          {verticals.map((vertical) => <option key={vertical} value={vertical}>{vertical}</option>)}
        </select>
        <select className={selectClass} value={presetFilter} onChange={(event) => setPresetFilter(event.target.value)}>
          <option value="all">{t("views.decisionPoolView.presetAll")}</option>
          {presets.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
        <select className={selectClass} value={originatorFilter} onChange={(event) => setOriginatorFilter(event.target.value as typeof originatorFilter)}>
          <option value="all">{t("views.decisionPoolView.originatorAll")}</option>
          <option value="person">{t("views.decisionPoolView.originatorPerson")}</option>
          <option value="agent">{t("views.decisionPoolView.originatorAgent")}</option>
          <option value="unknown">{t("views.decisionPoolView.originatorUnknown")}</option>
        </select>
        <select className={selectClass} value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)}>
          <option value="all">{t("views.decisionPoolView.timeAll")}</option>
          <option value="14d">{t("views.decisionPoolView.timeLast14Days")}</option>
          <option value="30d">{t("views.decisionPoolView.timeLast30Days")}</option>
        </select>
        <button
          type="button"
          onClick={resetAllFilters}
          disabled={!hasActiveFilters}
          title={t("views.decisionPoolView.resetAllFilters")}
          data-testid="decision-pool-reset-filters"
          className={`inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[12px] transition-colors ${
            hasActiveFilters
              ? "text-text-muted hover:border-border-strong hover:text-text"
              : "cursor-not-allowed text-text-faint opacity-60"
          }`}
        >
          <ArrowClockwise weight="bold" className="size-3" />
          {t("views.decisionPoolView.reset")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="space-y-4">
            {groups.map((group) => (
              <section key={group.key} data-testid={`decision-pool-group-${group.key}`}>
                {groupBy !== "none" && group.title && (
                  <header className="sticky top-0 z-10 mb-2 flex items-center gap-2 border-b border-border bg-surface/95 px-1 py-1.5 backdrop-blur-sm">
                    <span className="font-mono text-[12px] font-semibold text-text">{group.title}</span>
                    <span className="font-mono text-[11px] text-text-faint">{group.rows.length}</span>
                  </header>
                )}
                <div className="space-y-2">
                  {group.rows.map((decision) => {
                    const expanded = expandedIds.has(decision.decisionId);
                    const isSelected = decision.decisionId === selectedId;
                    return (
                      <article
                        key={decision.decisionId}
                        id={`decision-card-${decision.decisionId}`}
                        data-focused={decision.decisionId === focusedDecisionId || undefined}
                        data-selected={isSelected || undefined}
                        className={`rounded-lg border bg-surface px-3 py-3 transition-colors ${
                          isSelected || decision.decisionId === focusedDecisionId
                            ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                            : "border-border"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggleExpanded(decision.decisionId)}
                            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
                            title={expanded ? t("views.decisionPoolView.collapseCard") : t("views.decisionPoolView.expandCard")}
                          >
                            {expanded ? <CaretDown weight="bold" /> : <CaretRight weight="bold" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedId(decision.decisionId)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[12px] text-text-faint">{decision.decisionId}</span>
                              <DecisionStateBadge state={decision.state} />
                              <RiskTierBadge tier={decision.riskTier} />
                              <UrgencyBadge urgency={decision.urgency} />
                              <CoverageBadge decision={decision} facts={facts} />
                              <CountBadges decision={decision} relations={relations} tasks={tasks} />
                            </div>
                            <h2 className={`mt-1 text-[15px] font-semibold text-text ${expanded ? "" : "truncate"}`}>
                              {decision.title}
                            </h2>
                            <p className={`mt-0.5 text-[12px] text-text-muted ${expanded ? "" : "truncate"}`}>
                              Q: {decision.question}
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
                              <span>{decision.vertical ?? t("views.decisionPoolView.unknown")}</span>
                              <span>{decision.preset ?? t("views.decisionPoolView.unknown")}</span>
                              <span>
                                {t("views.decisionPoolView.originatorValue", {
                                  value: formatActorAxes(decision.attribution.originator),
                                })}
                              </span>
                              <span>
                                {t("views.decisionPoolView.proposedValue", {
                                  value: decision.proposedAt
                                    ? decision.proposedAt.slice(5, 16).replace("T", " ")
                                    : t("views.decisionPoolView.unknown"),
                                })}
                              </span>
                            </div>
                          </button>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {decision.state === "proposed" && onOpenApproval && (
                              <button
                                type="button"
                                onClick={() => onOpenApproval(decision.decisionId)}
                                className="rounded border border-border px-2 py-1 font-mono text-[10px] text-accent hover:border-accent/50 hover:bg-accent/5"
                                title={t("views.decisionPoolView.openInApproval")}
                              >
                                {t("views.decisionPoolView.openInApproval")}
                              </button>
                            )}
                            {onFocusGraph && (
                              <button
                                onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
                                title={t("views.decisionPoolView.focusDecisionDiagram")}
                                className="grid size-7 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-accent"
                              >
                                <Graph weight="bold" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2">
                          <RelationSummaryView decision={decision} relations={relations} tasks={tasks} />
                        </div>
                        {expanded && (
                          <div className="mt-2 rounded-md border border-border bg-surface-raised/30 px-2.5 py-2" data-testid={`decision-card-expanded-${decision.decisionId}`}>
                            <ClaimList
                              title={t("views.decisionsVerdict.chosen")}
                              items={decision.chosen}
                              tone="chosen"
                              facts={facts}
                              relations={relations}
                              onInspectFact={() => undefined}
                            />
                            <ClaimList
                              title={t("views.decisionsVerdict.rejected")}
                              items={decision.rejected}
                              tone="rejected"
                              facts={facts}
                              relations={relations}
                              onInspectFact={() => undefined}
                            />
                            {decision.claims.length > 0 && (
                              <div className="mt-2">
                                <div className="text-[11px] font-semibold text-text-faint">
                                  {t("views.decisionPoolView.claimsHeading")}
                                </div>
                                <ul className="mt-1 space-y-0.5">
                                  {decision.claims.map((claim) => (
                                    <li key={claim.id} className="text-[12px] text-text-muted">
                                      <span className="font-mono text-text-faint">{claim.id}</span> {claim.text}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
            {rows.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
                {t("views.decisionPoolView.thereNoDecisionsUnderCurrentFilter")}
              </div>
            )}
          </div>
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
