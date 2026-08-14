import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Funnel, Graph, GitBranch, Plus } from "@phosphor-icons/react";
import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import { harnessClient, type DecisionProposalInput } from "../api-client.ts";
import { DecisionJudgmentPanel } from "../components/DecisionJudgmentPanel.tsx";
import { DecisionProposalForm } from "../components/DecisionProposalForm.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../decision-actions.ts";
import { computeReadinessSignals, worstColor } from "../model/readiness-signals.ts";
import type { DecisionRow, DecisionState, FactRef, RelationEdge } from "../model/types.ts";
import { sortDecisionQueue, supersedeChain } from "../model/triadic.ts";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../components/badges.tsx";
import { triadicQueryKeys } from "../triadic-data.ts";
import { groupDecisions, type PoolGroupBy } from "../model/decision-pool-grouping.ts";

type PoolTab = "proposed" | "active" | "retired";
type TimeRange = "all" | "14d" | "30d";
type RelationState = "ready" | "loading" | "error";
const TAB_STATE: Record<PoolTab, DecisionState[]> = { proposed: ["proposed", "rejected", "deferred"], active: ["active"], retired: ["retired"] };
const selectClass = "rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-muted outline-none transition-colors duration-100 hover:border-border-strong focus-visible:border-border-strong";

function withinRange(decision: DecisionRow, range: TimeRange) {
  if (range === "all") return true;
  if (!decision.proposedAt) return false;
  return new Date(decision.proposedAt).getTime() >= Date.now() - (range === "14d" ? 14 : 30) * 86_400_000;
}

function ReadinessBadge({ decision, facts, rows, graphState }: { decision: DecisionRow; facts: FactRef[]; rows: ReadonlyArray<RelationCoverageRow>; graphState: RelationState }) {
  const signals = computeReadinessSignals(decision, facts, rows, graphState);
  const coverage = signals.find((signal) => signal.id === "coverage")!;
  const worst = worstColor(signals);
  const tone = coverage.color === "green" ? "bg-success/10 text-success" : coverage.color === "red" ? "bg-danger/10 text-danger" : "bg-surface-raised text-text-faint";
  return <span title={`${coverage.summary}\nworstColor:${worst}`} className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${tone}`}>coverage {coverage.color === "na" ? "N/A" : coverage.color}</span>;
}

function ChainView({ decision, relations }: { decision: DecisionRow; relations: RelationEdge[] }) {
  const chain = supersedeChain(decision, relations), amended = decision.decidedAt && decision.lastChangedAt && decision.lastChangedAt !== decision.decidedAt;
  if (!chain.supersedes.length && !chain.supersededBy.length && !amended) return <span className="font-mono text-[11px] text-text-faint">no supersede/amend chain</span>;
  return <div className="flex flex-wrap items-center gap-1.5 text-[11px]"><GitBranch weight="bold" className="text-text-faint" />
    {chain.supersedes.length > 0 && <span className="inline-flex items-center gap-1 font-mono text-danger">{decision.decisionId}<ArrowRight weight="bold" />retires {chain.supersedes.join(", ")}</span>}
    {chain.supersededBy.length > 0 && <span className="font-mono text-stale">superseded by {chain.supersededBy.join(", ")}</span>}
    {amended && <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted">amended @ {decision.lastChangedAt?.slice(5, 16).replace("T", " ")}</span>}
  </div>;
}

export function DecisionPoolView({ repoId, decisions, facts, relations, coverageRows = [], relationState = "ready", focusedDecisionId, onFocusGraph, onPropose, proposalFeedback, onJudge, mutationFeedback, onCheckReceipt }: {
  repoId: string;
  decisions: DecisionRow[]; facts: FactRef[]; relations: RelationEdge[]; coverageRows?: ReadonlyArray<RelationCoverageRow>; relationState?: RelationState;
  focusedDecisionId?: string | null; onFocusGraph?: (ref: string) => void;
  onPropose?: (input: DecisionProposalInput) => Promise<DecisionMutationFeedback>; proposalFeedback?: DecisionMutationFeedback;
  onJudge?: (decision: DecisionRow, action: DecisionAction, input: { readonly rationale: string; readonly judgmentOnlyRationale?: string }) => Promise<DecisionMutationFeedback>;
  mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
  onCheckReceipt?: (key: string) => void;
}) {
  const [tab, setTab] = useState<PoolTab>("proposed"), [stateFilter, setStateFilter] = useState<DecisionState | "all">("all");
  const [riskFilter, setRiskFilter] = useState<NonNullable<DecisionRow["riskTier"]> | "unknown" | "all">("all"), [urgencyFilter, setUrgencyFilter] = useState<NonNullable<DecisionRow["urgency"]> | "unknown" | "all">("all");
  const [verticalFilter, setVerticalFilter] = useState("all"), [presetFilter, setPresetFilter] = useState("all"), [proposedByFilter, setProposedByFilter] = useState<NonNullable<DecisionRow["proposedBy"]>["kind"] | "unknown" | "all">("all"), [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState(""), [moduleFilter, setModuleFilter] = useState("all"), [productLineFilter, setProductLineFilter] = useState("all"), [proposalOpen, setProposalOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<PoolGroupBy>("none");
  const handledFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusedDecisionId) { handledFocusRef.current = null; return; }
    if (handledFocusRef.current === focusedDecisionId) return;
    const decision = decisions.find((candidate) => candidate.decisionId === focusedDecisionId); if (!decision) return;
    handledFocusRef.current = focusedDecisionId; setTab(decision.state === "active" ? "active" : decision.state === "retired" ? "retired" : "proposed");
    setStateFilter("all"); setRiskFilter("all"); setUrgencyFilter("all"); setVerticalFilter("all"); setPresetFilter("all"); setProposedByFilter("all"); setTimeRange("all"); setSearch(""); setModuleFilter("all"); setProductLineFilter("all");
    const frame = window.requestAnimationFrame(() => document.getElementById(`decision-card-${focusedDecisionId}`)?.scrollIntoView({ block: "center" }));
    return () => window.cancelAnimationFrame(frame);
  }, [decisions, focusedDecisionId]);

  const verticals = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.vertical ? [decision.vertical] : []))].sort(), [decisions]);
  const presets = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.preset ? [decision.preset] : []))].sort(), [decisions]);
  const modules = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.appliesTo?.modules ?? []))].sort(), [decisions]);
  const productLines = useMemo(() => [...new Set(decisions.flatMap((decision) => decision.appliesTo?.productLines ?? []))].sort(), [decisions]);
  const remoteEnabled = Boolean(search.trim() || moduleFilter !== "all" || productLineFilter !== "all");
  const remote = useQuery({
    queryKey: [...triadicQueryKeys.decisions(repoId), "control-list", search.trim(), moduleFilter, productLineFilter],
    queryFn: () => harnessClient.listDecisionControls({ repoId, ...(search.trim() ? { search: search.trim() } : {}), ...(moduleFilter !== "all" ? { module: moduleFilter } : {}), ...(productLineFilter !== "all" ? { productLine: productLineFilter } : {}) }),
    enabled: remoteEnabled,
    staleTime: 0,
  });
  const remoteIds = remote.data?.status === "ready" ? new Set(remote.data.decisionIds) : null;
  const rows = useMemo(() => {
    const tabStates = new Set(TAB_STATE[tab]);
    return sortDecisionQueue(decisions).filter((decision) => !remoteEnabled || remoteIds?.has(decision.decisionId))
      .filter((decision) => tabStates.has(decision.state)).filter((decision) => stateFilter === "all" || decision.state === stateFilter)
      .filter((decision) => riskFilter === "all" || (riskFilter === "unknown" ? !decision.riskTier : decision.riskTier === riskFilter))
      .filter((decision) => urgencyFilter === "all" || (urgencyFilter === "unknown" ? !decision.urgency : decision.urgency === urgencyFilter))
      .filter((decision) => verticalFilter === "all" || decision.vertical === verticalFilter).filter((decision) => presetFilter === "all" || decision.preset === presetFilter)
      .filter((decision) => proposedByFilter === "all" || (proposedByFilter === "unknown" ? !decision.proposedBy : decision.proposedBy?.kind === proposedByFilter)).filter((decision) => withinRange(decision, timeRange));
  }, [decisions, presetFilter, proposedByFilter, remoteEnabled, remoteIds, riskFilter, stateFilter, tab, timeRange, urgencyFilter, verticalFilter]);
  const counts = { proposed: decisions.filter((decision) => TAB_STATE.proposed.includes(decision.state)).length, active: decisions.filter((decision) => decision.state === "active").length, retired: decisions.filter((decision) => decision.state === "retired").length };

  return <div className="flex h-full flex-col">
    <header className="flex items-center gap-3 border-b border-border px-4 py-3"><div><h1 className="ui-title font-semibold">决策池</h1><span className="font-mono text-[12px] text-text-faint">canonical pool · readiness · receipt</span></div>{onPropose && <button onClick={() => setProposalOpen((value) => !value)} className={`ml-auto inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors duration-100 ${proposalOpen ? "bg-accent/85 hover:bg-accent" : "bg-accent hover:bg-accent/85"}`}><Plus weight="bold" />Proposal</button>}</header>
    {proposalOpen && onPropose && <DecisionProposalForm feedback={proposalFeedback} onSubmit={onPropose} onClose={() => setProposalOpen(false)} onCheckReceipt={() => onCheckReceipt?.("proposal")} />}
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/50 px-4 py-2">
      {(["proposed", "active", "retired"] as PoolTab[]).map((item) => <button key={item} onClick={() => { setTab(item); setStateFilter("all"); }} className={`rounded-md px-3 py-1.5 font-mono text-[12px] tabular-nums transition-colors duration-100 ${tab === item ? "bg-accent text-accent-fg" : "bg-surface-raised text-text-muted hover:text-text"}`}>{item} · {counts[item]}</button>)}
      <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-text-faint"><Funnel weight="bold" />{rows.length} visible</span>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <input aria-label="decision search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="search title/question/id…" className={`${selectClass} min-w-52`} />
      <Filter value={moduleFilter} set={setModuleFilter} label="module" values={modules} /><Filter value={productLineFilter} set={setProductLineFilter} label="productLine" values={productLines} />
      <select className={selectClass} value={stateFilter} onChange={(e) => setStateFilter(e.target.value as DecisionState | "all")}><option value="all">state: all</option>{TAB_STATE[tab].map((state) => <option key={state}>{state}</option>)}</select>
      <Filter value={riskFilter} set={setRiskFilter as (value: string) => void} label="risk" values={["high", "medium", "low", "unknown"]} /><Filter value={urgencyFilter} set={setUrgencyFilter as (value: string) => void} label="urgency" values={["high", "medium", "low", "unknown"]} />
      <Filter value={verticalFilter} set={setVerticalFilter} label="vertical" values={verticals} /><Filter value={presetFilter} set={setPresetFilter} label="preset" values={presets} /><Filter value={proposedByFilter} set={setProposedByFilter as (value: string) => void} label="proposedBy" values={["human", "agent", "system", "unknown"]} />
      <select className={selectClass} value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)}><option value="all">time: all</option><option value="14d">time: last 14d</option><option value="30d">time: last 30d</option></select>
      <select aria-label="group by" className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as PoolGroupBy)} title="分组视图(纯前端派生;productLine=PLT 分组)"><option value="none">group: none</option><option value="productLine">group: PLT</option><option value="vertical">group: vertical</option></select>
    </div>
    {remoteEnabled && (remote.isPending || remote.isError || remote.data?.status !== "ready") && <div className="border-b border-border bg-stale/10 px-4 py-2 font-mono text-[11px] text-stale">decision-list projection unknown · {remote.error instanceof Error ? remote.error.message : remote.data?.hint ?? remote.data?.opId ?? "loading"} · 未就绪不当作空结果</div>}
    <div className="min-h-0 flex-1 overflow-auto p-4"><div className="space-y-2">
      {groupDecisions(rows, groupBy).map((group) => <section key={group.key} aria-label={group.title || "all"} className="space-y-2">
      {groupBy !== "none" && <div className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-border bg-surface/95 px-2.5 py-1.5 font-mono text-[12px] text-text-muted backdrop-blur" data-testid={`decision-pool-group-${group.key}`}><span className="font-semibold text-text">{group.title}</span><span className="text-text-faint">· {group.rows.length} 条</span></div>}
      {group.rows.map((decision) => <article key={decision.decisionId} id={`decision-card-${decision.decisionId}`} data-focused={decision.decisionId === focusedDecisionId || undefined} className={`rounded-lg border bg-surface px-3.5 py-3 transition-colors duration-100 ${decision.decisionId === focusedDecisionId ? "border-accent ring-1 ring-accent/30" : "border-border hover:border-border-strong"}`}>
        <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><span className="font-mono text-[12px] text-text-faint">{decision.decisionId}{decision.legacyId ? ` · ${decision.legacyId}` : ""}</span><DecisionStateBadge state={decision.state} /><RiskTierBadge tier={decision.riskTier} /><UrgencyBadge urgency={decision.urgency} /><ReadinessBadge decision={decision} facts={facts} rows={coverageRows} graphState={relationState} /></div>
          <h2 className="mt-1 text-[15px] font-semibold leading-snug text-text">{decision.title}</h2><p className="mt-0.5 text-[12px] text-text-muted">Q: {decision.question}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 font-mono text-[11px] text-text-faint"><span>{decision.vertical ?? "未知/—"}</span><span>{decision.preset ?? "未知/—"}</span><span>{decision.decisionClass ?? "unknown class"}</span><span>modules:{decision.appliesTo?.modules.join(",") || "—"}</span><span>PLT:{decision.appliesTo?.productLines.join(",") || "—"}</span><span>revision:{decision.workspaceRevision ?? "unknown"}</span></div>
        </div>{onFocusGraph && <button onClick={() => onFocusGraph(`decision/${decision.decisionId}`)} title="在关系图中聚焦" className="grid size-7 shrink-0 place-items-center rounded-md text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-accent"><Graph weight="bold" /></button>}</div>
        <div className="mt-2.5 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2"><ChainView decision={decision} relations={relations} /></div>
        {(decision.body || decision.judgmentConsents.length > 0) && <details className="mt-2 text-[11px] text-text-muted"><summary className="cursor-pointer select-none text-text-faint hover:text-text-muted">canonical body / judgment consents</summary>{decision.body && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2">{decision.body.body}</pre>}{decision.judgmentConsents.map((consent) => <div key={consent.consentId} className="mt-1 font-mono">{consent.action} · {consent.consentId} · {consent.consentedAt}</div>)}</details>}
        {decision.state === "proposed" && onJudge && <DecisionJudgmentPanel decision={decision} relations={relations} feedback={mutationFeedback?.(decision.decisionId)} onSubmit={onJudge} onCheckReceipt={() => onCheckReceipt?.(decision.decisionId)} />}
      </article>)}
      </section>)}
      {rows.length === 0 && (!remoteEnabled || remote.data?.status === "ready") && <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[14px] text-text-faint">当前过滤条件下没有 decision。</div>}
    </div></div>
  </div>;
}

function Filter({ value, set, label, values }: { value: string; set: (value: string) => void; label: string; values: string[] }) {
  return <select className={selectClass} value={value} onChange={(event) => set(event.target.value)}><option value="all">{label}: all</option>{values.map((item) => <option key={item} value={item}>{label}: {item}</option>)}</select>;
}
