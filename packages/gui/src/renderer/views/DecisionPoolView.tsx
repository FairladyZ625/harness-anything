import { useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Funnel,
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
  const days = range === "14d" ? 14 : 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(decision.proposedAt).getTime() >= since;
}

function CoverageBadge({ decision, facts }: { decision: DecisionRow; facts: FactRef[] }) {
  const coverage = coverageOf(decision, facts);
  if (coverage.total === 0) {
    return <span className="font-mono text-[11px] text-text-faint">coverage n/a</span>;
  }
  const ok = coverage.covered === coverage.total;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
        ok ? "bg-success/10 text-success" : "bg-stale/10 text-stale"
      }`}
      title={ok ? "承重论点均有可达活 fact" : `缺可达活 fact: ${coverage.gaps.join(", ")}`}
    >
      {ok ? <CheckCircle weight="bold" /> : <WarningCircle weight="bold" />}
      {coverage.covered}/{coverage.total} reachable
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
  const amended = decision.decidedAt && decision.lastChangedAt !== decision.decidedAt;

  if (!hasSupersede && !amended) {
    return <span className="font-mono text-[11px] text-text-faint">no supersede/amend chain</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <GitBranch weight="bold" className="text-text-faint" />
      {chain.supersedes.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-danger">
          {decision.decisionId}
          <ArrowRight weight="bold" />
          retires {chain.supersedes.join(", ")}
        </span>
      )}
      {chain.supersededBy.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-stale">
          superseded by {chain.supersededBy.join(", ")}
        </span>
      )}
      {amended && (
        <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted">
          amended @ {decision.lastChangedAt.slice(5, 16).replace("T", " ")}
        </span>
      )}
    </div>
  );
}

export function DecisionPoolView({
  decisions,
  facts,
  relations,
}: {
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
}) {
  const [tab, setTab] = useState<PoolTab>("proposed");
  const [stateFilter, setStateFilter] = useState<DecisionState | "all">("all");
  const [riskFilter, setRiskFilter] = useState<DecisionRow["riskTier"] | "all">("all");
  const [urgencyFilter, setUrgencyFilter] = useState<DecisionRow["urgency"] | "all">("all");
  const [verticalFilter, setVerticalFilter] = useState("all");
  const [presetFilter, setPresetFilter] = useState("all");
  const [proposedByFilter, setProposedByFilter] = useState<DecisionRow["proposedBy"]["kind"] | "all">("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");

  const verticals = useMemo(() => [...new Set(decisions.map((decision) => decision.vertical))].sort(), [decisions]);
  const presets = useMemo(() => [...new Set(decisions.map((decision) => decision.preset))].sort(), [decisions]);

  const rows = useMemo(() => {
    const tabStates = new Set(TAB_STATE[tab]);
    return sortDecisionQueue(decisions)
      .filter((decision) => tabStates.has(decision.state))
      .filter((decision) => stateFilter === "all" || decision.state === stateFilter)
      .filter((decision) => riskFilter === "all" || decision.riskTier === riskFilter)
      .filter((decision) => urgencyFilter === "all" || decision.urgency === urgencyFilter)
      .filter((decision) => verticalFilter === "all" || decision.vertical === verticalFilter)
      .filter((decision) => presetFilter === "all" || decision.preset === presetFilter)
      .filter((decision) => proposedByFilter === "all" || decision.proposedBy.kind === proposedByFilter)
      .filter((decision) => withinRange(decision, timeRange));
  }, [decisions, presetFilter, proposedByFilter, riskFilter, stateFilter, tab, timeRange, urgencyFilter, verticalFilter]);

  const counts = {
    proposed: decisions.filter((decision) => TAB_STATE.proposed.includes(decision.state)).length,
    active: decisions.filter((decision) => decision.state === "active").length,
    retired: decisions.filter((decision) => decision.state === "retired").length,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">决策池</h1>
          <span className="font-mono text-[13px] text-text-faint">
            全集浏览 · 覆盖度可达性 · supersede/amend 演化链
          </span>
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
          {rows.length} visible
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <select className={selectClass} value={stateFilter} onChange={(event) => setStateFilter(event.target.value as DecisionState | "all")}>
          <option value="all">state: all</option>
          {TAB_STATE[tab].map((state) => (
            <option key={state} value={state}>state: {state}</option>
          ))}
        </select>
        <select className={selectClass} value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as DecisionRow["riskTier"] | "all")}>
          <option value="all">risk: all</option>
          <option value="high">risk: high</option>
          <option value="medium">risk: medium</option>
          <option value="low">risk: low</option>
        </select>
        <select className={selectClass} value={urgencyFilter} onChange={(event) => setUrgencyFilter(event.target.value as DecisionRow["urgency"] | "all")}>
          <option value="all">urgency: all</option>
          <option value="high">urgency: high</option>
          <option value="medium">urgency: medium</option>
          <option value="low">urgency: low</option>
        </select>
        <select className={selectClass} value={verticalFilter} onChange={(event) => setVerticalFilter(event.target.value)}>
          <option value="all">vertical: all</option>
          {verticals.map((vertical) => <option key={vertical} value={vertical}>{vertical}</option>)}
        </select>
        <select className={selectClass} value={presetFilter} onChange={(event) => setPresetFilter(event.target.value)}>
          <option value="all">preset: all</option>
          {presets.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </select>
        <select className={selectClass} value={proposedByFilter} onChange={(event) => setProposedByFilter(event.target.value as DecisionRow["proposedBy"]["kind"] | "all")}>
          <option value="all">proposedBy: all</option>
          <option value="human">proposedBy: human</option>
          <option value="agent">proposedBy: agent</option>
          <option value="system">proposedBy: system</option>
        </select>
        <select className={selectClass} value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)}>
          <option value="all">time: all</option>
          <option value="14d">time: last 14d</option>
          <option value="30d">time: last 30d</option>
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="space-y-2">
          {rows.map((decision) => (
            <article key={decision.decisionId} className="rounded-lg border border-border bg-surface px-3 py-3">
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
                    <span>{decision.vertical}</span>
                    <span>{decision.preset}</span>
                    <span>proposedBy {decision.proposedBy.kind}:{decision.proposedBy.id}</span>
                    <span>proposed {decision.proposedAt.slice(5, 16).replace("T", " ")}</span>
                  </div>
                </div>
              </div>
              <div className="mt-2 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2">
                <ChainView decision={decision} relations={relations} />
              </div>
            </article>
          ))}
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">
              当前过滤条件下没有 decision。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
