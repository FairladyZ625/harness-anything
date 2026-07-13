import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Funnel,
  Graph,
  GitBranch,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DecisionRow, DecisionState, FactRef, RelationEdge } from "../model/types";
import {
  DecisionStateBadge,
  RiskTierBadge,
  UrgencyBadge,
} from "../components/badges";
import { coverageOf, sortDecisionQueue, supersedeChain } from "../model/triadic";
import { t } from "../i18n/index.tsx";

type PoolTab = "proposed" | "active" | "retired";
type TimeRange = "all" | "14d" | "30d";

const TAB_STATE: Record<PoolTab, DecisionState[]> = {
  proposed: ["proposed", "rejected", "deferred"],
  active: ["active"],
  retired: ["retired"],
};

const labelForTab: Record<PoolTab, string> = {
  proposed: "proposed",
  active: "active",
  retired: "retired",
};

const selectClass =
  "rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-muted outline-none hover:border-border-strong";

function withinRange(decision: DecisionRow, range: TimeRange) {
  if (range === "all") return true;
  if (!decision.proposedAt) return false;
  const days = range === "14d" ? 14 : 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(decision.proposedAt).getTime() >= since;
}

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

function ChainView({
  decision,
  relations,
}: {
  decision: DecisionRow;
  relations: RelationEdge[];
}) {
  const chain = supersedeChain(decision, relations);
  const hasSupersede = chain.supersedes.length > 0 || chain.supersededBy.length > 0;
  const amended = decision.decidedAt && decision.lastChangedAt && decision.lastChangedAt !== decision.decidedAt;

  if (!hasSupersede && !amended) {
    return <span className="font-mono text-[11px] text-text-faint">{t("views.decisionPoolView.noSupersedeAmendChain")}</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <GitBranch weight="bold" className="text-text-faint" />
      {chain.supersedes.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-danger">
          {decision.decisionId}
          <ArrowRight weight="bold" />
          {t("views.decisionPoolView.retiresValue", { value: chain.supersedes.join(", ") })}
        </span>
      )}
      {chain.supersededBy.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-stale">
          {t("views.decisionPoolView.supersededByValue", { value: chain.supersededBy.join(", ") })}
        </span>
      )}
      {amended && (
        <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted">
          {t("views.decisionPoolView.amendedAtValue", { value: decision.lastChangedAt?.slice(5, 16).replace("T", " ") })}
        </span>
      )}
    </div>
  );
}

export function DecisionPoolView({
  decisions,
  facts,
  relations,
  focusedDecisionId,
  onFocusGraph,
}: {
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  focusedDecisionId?: string | null;
  onFocusGraph?: (ref: string) => void;
}) {
  const [tab, setTab] = useState<PoolTab>("proposed");
  const [stateFilter, setStateFilter] = useState<DecisionState | "all">("all");
  const [riskFilter, setRiskFilter] = useState<NonNullable<DecisionRow["riskTier"]> | "unknown" | "all">("all");
  const [urgencyFilter, setUrgencyFilter] = useState<NonNullable<DecisionRow["urgency"]> | "unknown" | "all">("all");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [presetFilter, setPresetFilter] = useState("all");
  const [originatorFilter, setOriginatorFilter] = useState<"person" | "agent" | "unknown" | "all">("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const handledFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusedDecisionId) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === focusedDecisionId) return;
    const decision = decisions.find(
      (candidate) => candidate.decisionId === focusedDecisionId,
    );
    if (!decision) return;
    handledFocusRef.current = focusedDecisionId;
    const targetTab: PoolTab =
      decision.state === "active"
        ? "active"
        : decision.state === "retired"
          ? "retired"
          : "proposed";
    setTab(targetTab);
    setStateFilter("all");
    setRiskFilter("all");
    setUrgencyFilter("all");
    setVerticalFilter("all");
    setPresetFilter("all");
    setOriginatorFilter("all");
    setTimeRange("all");
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`decision-card-${focusedDecisionId}`)
        ?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [decisions, focusedDecisionId]);

  const verticals = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.vertical ? [decision.vertical] : []))].sort(), [decisions]);
  const presets = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.preset ? [decision.preset] : []))].sort(), [decisions]);

  const rows = useMemo(() => {
    const tabStates = new Set(TAB_STATE[tab]);
    // 修 #2(预存 bug,归属 dec_mrf2nzvf):三元 `||`/`?:` 优先级让 riskFilter="all"
    // 走到 !decision.riskTier 分支,把所有有 riskTier 的决策反筛掉;urgency/originator
    // 同样的运算符陷阱。显式拆成「all 放行 + unknown 反查 + 精确匹配」三路,并加括号。
    return sortDecisionQueue(decisions)
      .filter((decision) => tabStates.has(decision.state))
      .filter((decision) => stateFilter === "all" || decision.state === stateFilter)
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
        return originatorFilter === "agent" ? Boolean(originator?.executor) : Boolean(originator && !originator.executor);
      })
      .filter((decision) => withinRange(decision, timeRange));
  }, [decisions, originatorFilter, presetFilter, riskFilter, stateFilter, tab, timeRange, urgencyFilter, verticalFilter]);

  const counts = {
    proposed: decisions.filter((decision) => TAB_STATE.proposed.includes(decision.state)).length,
    active: decisions.filter((decision) => decision.state === "active").length,
    retired: decisions.filter((decision) => decision.state === "retired").length,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">{t("views.decisionPoolView.decisionPool")}</h1>
          <span className="font-mono text-[13px] text-text-faint">
            {t("views.decisionPoolView.browseFullSetCoverageAccessibilitySupersedeAmend")}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/50 px-4 py-2">
        {(["proposed", "active", "retired"] as PoolTab[]).map((item) => (
          <button
            key={item}
            onClick={() => {
              setTab(item);
              setStateFilter("all");
            }}
            className={`rounded-md px-3 py-1.5 font-mono text-[12px] ${
              tab === item ? "bg-accent text-accent-fg" : "bg-surface-raised text-text-muted hover:text-text"
            }`}
          >
            {labelForTab[item]} · {counts[item]}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-text-faint">
          <Funnel weight="bold" />
          {t("views.decisionPoolView.visibleCount", { count: rows.length })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <select className={selectClass} value={stateFilter} onChange={(event) => setStateFilter(event.target.value as DecisionState | "all")}>
          <option value="all">{t("views.decisionPoolView.stateAll")}</option>
          {TAB_STATE[tab].map((state) => (
            <option key={state} value={state}>{t("views.decisionPoolView.stateValue", { value: state })}</option>
          ))}
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
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="space-y-2">
          {rows.map((decision) => (
            <article
              key={decision.decisionId}
              id={`decision-card-${decision.decisionId}`}
              data-focused={decision.decisionId === focusedDecisionId || undefined}
              className={`rounded-lg border bg-surface px-3 py-3 transition-colors ${
                decision.decisionId === focusedDecisionId
                  ? "border-accent bg-accent/5 ring-1 ring-accent/30"
                  : "border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] text-text-faint">{decision.decisionId}</span>
                    <DecisionStateBadge state={decision.state} />
                    <RiskTierBadge tier={decision.riskTier} />
                    <UrgencyBadge urgency={decision.urgency} />
                    <CoverageBadge decision={decision} facts={facts} />
                  </div>
                  <h2 className="mt-1 truncate text-[15px] font-semibold text-text">{decision.title}</h2>
                  <p className="mt-0.5 truncate text-[12px] text-text-muted">Q: {decision.question}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-faint">
                    <span>{decision.vertical ?? t("views.decisionPoolView.unknown")}</span>
                    <span>{decision.preset ?? t("views.decisionPoolView.unknown")}</span>
                    <span>{t("views.decisionPoolView.originatorValue", { value: formatActorAxes(decision.attribution.originator) })}</span>
                    <span>{t("views.decisionPoolView.proposedValue", { value: decision.proposedAt ? decision.proposedAt.slice(5, 16).replace("T", " ") : t("views.decisionPoolView.unknown") })}</span>
                  </div>
                </div>
                {onFocusGraph && (
                  <button
                    onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
                    title={t("views.decisionPoolView.focusDecisionDiagram")}
                    className="grid size-7 shrink-0 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-accent"
                  >
                    <Graph weight="bold" />
                  </button>
                )}
              </div>
              <div className="mt-2 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2">
                <ChainView decision={decision} relations={relations} />
              </div>
            </article>
          ))}
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
              {t("views.decisionPoolView.thereNoDecisionsUnderCurrentFilter")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatActorAxes(actor: DecisionRow["attribution"]["originator"]): string {
  if (!actor) return t("views.decisionPoolView.unknown");
  return `person:${actor.principal.personId} / ${actor.executor ? `agent:${actor.executor.id}` : "executor:none"}`;
}
