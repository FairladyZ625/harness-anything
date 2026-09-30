import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Graph, GitBranch, Plus } from "@phosphor-icons/react";
import type { RelationCoverageRow, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import { harnessClient, type DecisionProposalInput } from "../api-client.ts";
import { DecisionJudgmentPanel } from "../components/DecisionJudgmentPanel.tsx";
import { DecisionReviewBadge, reviewAcceptBlockedReason } from "../components/decisionReview/parts.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { DecisionProposalForm } from "../components/DecisionProposalForm.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../decision-actions.ts";
import { computeReadinessSignals, worstColor } from "../model/readiness-signals.ts";
import { decisionCan, type DecisionRow, type DecisionState, type FactRef, type RelationEdge } from "../model/types.ts";
import { sortDecisionQueue, supersedeChain } from "../model/triadic.ts";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../components/badges.tsx";
import { triadicQueryKeys } from "../triadic-data.ts";
import { groupDecisions, type PoolGroupBy } from "../model/decision-pool-grouping.ts";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";

type PoolGroupTab = WorkspaceSummaryRead["decisions"]["groups"][number]["id"];
type TimeRange = "all" | "14d" | "30d";
type RelationState = "ready" | "loading" | "error";
const selectClass =
  "rounded-xs border border-border bg-surface px-2 py-1 font-mono ui-meta text-text-muted outline-none transition-colors duration-100 hover:border-border-strong focus-visible:border-border-strong";

function withinRange(decision: DecisionRow, range: TimeRange) {
  if (range === "all") return true;
  if (!decision.proposedAt) return false;
  return new Date(decision.proposedAt).getTime() >= Date.now() - (range === "14d" ? 14 : 30) * 86_400_000;
}

function ReadinessBadge({
  decision,
  facts,
  rows,
  graphState,
}: {
  decision: DecisionRow;
  facts: FactRef[];
  rows: ReadonlyArray<RelationCoverageRow>;
  graphState: RelationState;
}) {
  const signals = computeReadinessSignals(decision, facts, rows, graphState);
  const coverage = signals.find((signal) => signal.id === "coverage")!;
  const worst = worstColor(signals);
  return (
    <span title={`${coverage.summary}\nworstColor:${worst}`}>
      <StatusTag
        tone={
          coverage.color === "green"
            ? "done"
            : coverage.color === "red"
              ? "bad"
              : coverage.color === "yellow"
                ? "wait"
                : "neutral"
        }
        label={t("views.decisionPoolView.coverageValue", {
          value: coverage.color === "na" ? "N/A" : coverage.color,
        })}
      />
    </span>
  );
}

function ChainView({
  decision,
  relations,
  onNavigateDecision,
}: {
  decision: DecisionRow;
  relations: RelationEdge[];
  onNavigateDecision: (decisionId: string) => void;
}) {
  const chain = supersedeChain(decision, relations),
    amended = decision.decidedAt && decision.lastChangedAt && decision.lastChangedAt !== decision.decidedAt;
  if (!chain.supersedes.length && !chain.supersededBy.length && !amended)
    return (
      <span className="font-mono ui-micro text-text-faint">{t("views.decisionPoolView.noSupersedeAmendChain")}</span>
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5 ui-micro">
      <GitBranch weight="bold" className="text-text-faint" aria-hidden />
      {chain.supersedes.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-danger">
          <EntityRefLink
            entityRef={`decision/${decision.decisionId}`}
            onNavigate={() => onNavigateDecision(decision.decisionId)}
            title={decision.decisionId}
            className="text-danger hover:underline"
          />
          <ArrowRight weight="bold" aria-hidden />
          {chain.supersedes
            .map((id) => (
              <EntityRefLink
                key={id}
                entityRef={`decision/${id}`}
                onNavigate={() => onNavigateDecision(id)}
                title={id}
                className="text-danger hover:underline"
              />
            ))
            .reduce<React.ReactNode[]>((acc, link, index) => (index === 0 ? [link] : [...acc, ", ", link]), [])}
        </span>
      )}
      {chain.supersededBy.length > 0 && (
        <span className="font-mono text-stale">
          {chain.supersededBy
            .map((id) => (
              <EntityRefLink
                key={id}
                entityRef={`decision/${id}`}
                onNavigate={() => onNavigateDecision(id)}
                title={id}
                className="text-stale hover:underline"
              />
            ))
            .reduce<React.ReactNode[]>((acc, link, index) => (index === 0 ? [link] : [...acc, ", ", link]), [])}
        </span>
      )}
      {amended && (
        <span className="rounded-xs bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted">
          {t("views.decisionPoolView.amendedAtValue", {
            value: formatTime(decision.lastChangedAt!, { style: "month-day-time" }) ?? "—",
          })}
        </span>
      )}
    </div>
  );
}

/**
 * 决策 lane:原 DecisionPoolView 的过滤/分组/快速批复能力原样保留,版式按 §2.4——
 * 状态分组用带计数 FilterChips、搜索外露、其余筛选收进「高级筛选」;行是单行条目
 * (徽章 + 标题 + 问题),完整依据与快速批复面板进抽屉。
 */
export function DecisionPoolSection({
  repoId,
  decisions,
  summary,
  facts,
  relations,
  coverageRows = [],
  relationState = "ready",
  focusedDecisionId,
  onFocusGraph,
  onNavigateDecision,
  onPropose,
  proposalFeedback,
  onJudge,
  mutationFeedback,
  onCheckReceipt,
}: {
  repoId: string;
  decisions: DecisionRow[];
  summary: WorkspaceSummaryRead["decisions"];
  facts: FactRef[];
  relations: RelationEdge[];
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  relationState?: RelationState;
  focusedDecisionId?: string | null;
  onFocusGraph?: (ref: string) => void;
  onNavigateDecision: (decisionId: string) => void;
  onPropose?: (input: DecisionProposalInput) => Promise<DecisionMutationFeedback>;
  proposalFeedback?: DecisionMutationFeedback;
  onJudge?: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<DecisionMutationFeedback>;
  mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
  onCheckReceipt?: (key: string) => void;
}) {
  const [tab, setTab] = useState<PoolGroupTab>("proposed");
  const [stateFilter, setStateFilter] = useState<DecisionState | "all">("all");
  const [riskFilter, setRiskFilter] = useState<NonNullable<DecisionRow["riskTier"]> | "unknown" | "all">("all"),
    [urgencyFilter, setUrgencyFilter] = useState<NonNullable<DecisionRow["urgency"]> | "unknown" | "all">("all");
  const [verticalFilter, setVerticalFilter] = useState("all"),
    [presetFilter, setPresetFilter] = useState("all"),
    [proposedByFilter, setProposedByFilter] = useState<
      NonNullable<DecisionRow["proposedBy"]>["kind"] | "unknown" | "all"
    >("all"),
    [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState(""),
    [moduleFilter, setModuleFilter] = useState("all"),
    [productLineFilter, setProductLineFilter] = useState("all"),
    [proposalOpen, setProposalOpen] = useState(false),
    [advancedOpen, setAdvancedOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<PoolGroupBy>("none");
  const [drawerDecisionId, setDrawerDecisionId] = useState<string | null>(null);
  const handledFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusedDecisionId) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === focusedDecisionId) return;
    const decision = decisions.find((candidate) => candidate.decisionId === focusedDecisionId),
      group = summary.groups.find((candidate) => candidate.decisionIds.includes(focusedDecisionId));
    if (!decision || !group) return;
    handledFocusRef.current = focusedDecisionId;
    setTab(group.id);
    setStateFilter("all");
    setRiskFilter("all");
    setUrgencyFilter("all");
    setVerticalFilter("all");
    setPresetFilter("all");
    setProposedByFilter("all");
    setTimeRange("all");
    setSearch("");
    setModuleFilter("all");
    setProductLineFilter("all");
    const frame = window.requestAnimationFrame(() =>
      document.getElementById(`decision-card-${focusedDecisionId}`)?.scrollIntoView({ block: "center" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [decisions, focusedDecisionId, summary.groups]);

  const verticals = useMemo(
    () => [...new Set(decisions.flatMap((decision) => (decision.vertical ? [decision.vertical] : [])))].sort(),
    [decisions],
  );
  const presets = useMemo(
    () => [...new Set(decisions.flatMap((decision) => (decision.preset ? [decision.preset] : [])))].sort(),
    [decisions],
  );
  const modules = useMemo(
    () => [...new Set(decisions.flatMap((decision) => decision.appliesTo?.modules ?? []))].sort(),
    [decisions],
  );
  const productLines = useMemo(
    () => [...new Set(decisions.flatMap((decision) => decision.appliesTo?.productLines ?? []))].sort(),
    [decisions],
  );
  const remoteEnabled = Boolean(search.trim() || moduleFilter !== "all" || productLineFilter !== "all");
  const remote = useQuery({
    queryKey: [...triadicQueryKeys.decisions(repoId), "control-list", search.trim(), moduleFilter, productLineFilter],
    queryFn: () =>
      harnessClient.listDecisionControls({
        repoId,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(moduleFilter !== "all" ? { module: moduleFilter } : {}),
        ...(productLineFilter !== "all" ? { productLine: productLineFilter } : {}),
      }),
    enabled: remoteEnabled,
    staleTime: 4_000,
  });
  const remoteIds = useMemo(
    () => (remote.data?.status === "ready" ? new Set(remote.data.decisionIds) : null),
    [remote.data],
  );
  const currentGroup = summary.groups.find((group) => group.id === tab) ?? summary.groups[0]!;
  const rows = useMemo(() => {
    const groupDecisionIds = new Set(currentGroup.decisionIds);
    return sortDecisionQueue(decisions)
      .filter((decision) => !remoteEnabled || remoteIds?.has(decision.decisionId))
      .filter((decision) => groupDecisionIds.has(decision.decisionId))
      .filter((decision) => stateFilter === "all" || decision.state === stateFilter)
      .filter(
        (decision) =>
          riskFilter === "all" || (riskFilter === "unknown" ? !decision.riskTier : decision.riskTier === riskFilter),
      )
      .filter(
        (decision) =>
          urgencyFilter === "all" ||
          (urgencyFilter === "unknown" ? !decision.urgency : decision.urgency === urgencyFilter),
      )
      .filter((decision) => verticalFilter === "all" || decision.vertical === verticalFilter)
      .filter((decision) => presetFilter === "all" || decision.preset === presetFilter)
      .filter(
        (decision) =>
          proposedByFilter === "all" ||
          (proposedByFilter === "unknown" ? !decision.proposedBy : decision.proposedBy?.kind === proposedByFilter),
      )
      .filter((decision) => withinRange(decision, timeRange));
  }, [
    currentGroup.decisionIds,
    decisions,
    presetFilter,
    proposedByFilter,
    remoteEnabled,
    remoteIds,
    riskFilter,
    stateFilter,
    timeRange,
    urgencyFilter,
    verticalFilter,
  ]);
  const groups = useMemo(() => groupDecisions(rows, groupBy), [groupBy, rows]);
  const drawerDecision =
    drawerDecisionId === null ? null : (rows.find(({ decisionId }) => decisionId === drawerDecisionId) ?? null);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <input
            aria-label={t("views.decisionPoolView.decisionSearch")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("views.decisionPoolView.searchTitleIdQuestion")}
            className={`${selectClass} min-w-52 bg-bg/30 px-3 py-1.5 text-text`}
          />
        </div>
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((value) => !value)}
          className="h-7 rounded-xs border border-border bg-text/5 px-2.5 ui-meta text-text-muted hover:text-text"
        >
          {t("views.decisionPoolView.advancedFilters")}
        </button>
        {onPropose && (
          <button
            type="button"
            onClick={() => setProposalOpen((value) => !value)}
            className={`inline-flex h-7 items-center gap-1 rounded-xs px-2.5 ui-meta font-medium text-accent-fg hover:opacity-90 ${
              proposalOpen ? "bg-accent/85" : "bg-accent"
            }`}
          >
            <Plus weight="bold" aria-hidden />
            {t("views.decisionPoolView.proposal")}
          </button>
        )}
      </div>
      {proposalOpen && onPropose && (
        <DecisionProposalForm
          feedback={proposalFeedback}
          onSubmit={onPropose}
          onClose={() => setProposalOpen(false)}
          onCheckReceipt={() => onCheckReceipt?.("proposal")}
        />
      )}
      {advancedOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xs border border-border bg-surface/40 px-2.5 py-2">
          <Filter
            value={moduleFilter}
            set={setModuleFilter}
            label={t("views.decisionPoolView.filterModule")}
            allLabel={t("views.decisionPoolView.filterAll", { label: t("views.decisionPoolView.filterModule") })}
            values={modules}
          />
          <Filter
            value={productLineFilter}
            set={setProductLineFilter}
            label={t("views.decisionPoolView.filterProductLine")}
            allLabel={t("views.decisionPoolView.filterAll", { label: t("views.decisionPoolView.filterProductLine") })}
            values={productLines}
          />
          <select
            className={selectClass}
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as DecisionState | "all")}
          >
            <option value="all">{t("views.decisionPoolView.stateAll")}</option>
            {currentGroup.states.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
          <Filter
            value={riskFilter}
            set={setRiskFilter as (value: string) => void}
            label={t("views.decisionPoolView.filterRisk")}
            allLabel={t("views.decisionPoolView.riskAll")}
            values={["high", "medium", "low", "unknown"]}
          />
          <Filter
            value={urgencyFilter}
            set={setUrgencyFilter as (value: string) => void}
            label={t("views.decisionPoolView.filterUrgency")}
            allLabel={t("views.decisionPoolView.urgencyAll")}
            values={["high", "medium", "low", "unknown"]}
          />
          <Filter
            value={verticalFilter}
            set={setVerticalFilter}
            label={t("views.decisionPoolView.filterVertical")}
            allLabel={t("views.decisionPoolView.verticalAll")}
            values={verticals}
          />
          <Filter
            value={presetFilter}
            set={setPresetFilter}
            label={t("views.decisionPoolView.filterPreset")}
            allLabel={t("views.decisionPoolView.presetAll")}
            values={presets}
          />
          <Filter
            value={proposedByFilter}
            set={setProposedByFilter as (value: string) => void}
            label={t("views.decisionPoolView.filterProposedBy")}
            allLabel={t("views.decisionPoolView.filterProposedByAll")}
            values={["human", "agent", "system", "unknown"]}
          />
          <select className={selectClass} value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)}>
            <option value="all">{t("views.decisionPoolView.timeAll")}</option>
            <option value="14d">{t("views.decisionPoolView.timeLast14Days")}</option>
            <option value="30d">{t("views.decisionPoolView.timeLast30Days")}</option>
          </select>
          <select
            aria-label={t("views.decisionPoolView.filterGroupBy")}
            className={selectClass}
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as PoolGroupBy)}
            title={t("views.decisionPoolView.groupByTitle")}
          >
            <option value="none">{t("views.decisionPoolView.groupByNone")}</option>
            <option value="productLine">{t("views.decisionPoolView.groupByProductLine")}</option>
            <option value="vertical">{t("views.decisionPoolView.groupByVertical")}</option>
          </select>
        </div>
      )}
      <div className="mt-2.5" data-testid="decision-pool-group-chips">
        <FilterChips
          value={tab}
          onChange={(key) => {
            setTab(key);
            setStateFilter("all");
          }}
          chips={summary.groups.map((item) => ({
            key: item.id,
            label: item.id.replaceAll("_", " "),
            count: item.count,
          }))}
        />
      </div>
      {remoteEnabled && (remote.isPending || remote.isError || remote.data?.status !== "ready") && (
        <div className="mt-2 rounded-xs border border-stale/40 bg-stale/10 px-3 py-1.5 font-mono ui-micro text-stale">
          {t("views.decisionPoolView.projectionUnknown", {
            detail:
              remote.error instanceof Error
                ? remote.error.message
                : (remote.data?.hint ?? remote.data?.opId ?? "loading"),
          })}
        </div>
      )}
      <div className="mt-3">
        {groups.map((group) => (
          <section key={group.key} aria-label={group.title || t("views.decisionPoolView.allGroup")} className="mb-6">
            {groupBy !== "none" && (
              <div
                data-testid={`decision-pool-group-${group.key}`}
                className="mb-1.5 flex items-baseline gap-2 border-b border-border pb-1"
              >
                <h3 className="min-w-0 truncate font-semibold text-text ui-body">{group.title}</h3>
                <span className="font-mono tabular-nums text-text-faint ui-meta">
                  {t("views.decisionPoolView.groupCount", { count: group.rows.length })}
                </span>
              </div>
            )}
            {group.rows.map((decision) => (
              <DecisionPoolRow
                key={decision.decisionId}
                decision={decision}
                facts={facts}
                coverageRows={coverageRows}
                relationState={relationState}
                focused={decision.decisionId === focusedDecisionId}
                onOpen={() => setDrawerDecisionId(decision.decisionId)}
              />
            ))}
          </section>
        ))}
        {rows.length === 0 && (!remoteEnabled || remote.data?.status === "ready") && (
          <p className="py-3 text-text-faint ui-body">{t("views.decisionPoolView.emptyFilter")}</p>
        )}
      </div>
      <Drawer
        open={drawerDecision !== null}
        onClose={() => setDrawerDecisionId(null)}
        ariaLabel={drawerDecision?.title ?? t("views.decisionPoolView.subtitle")}
      >
        {drawerDecision !== null && (
          <DecisionDrawerBody
            decision={drawerDecision}
            relations={relations}
            facts={facts}
            coverageRows={coverageRows}
            relationState={relationState}
            onFocusGraph={onFocusGraph}
            onNavigateDecision={onNavigateDecision}
            onJudge={onJudge}
            mutationFeedback={mutationFeedback}
            onCheckReceipt={onCheckReceipt}
          />
        )}
      </Drawer>
    </div>
  );
}

/** 决策池单行:徽章 + 标题 + 问题 + 提议时间;点行开抽屉看完整依据并快速批复。 */
function DecisionPoolRow({
  decision,
  facts,
  coverageRows,
  relationState,
  focused,
  onOpen,
}: {
  readonly decision: DecisionRow;
  readonly facts: FactRef[];
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly relationState: RelationState;
  readonly focused: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      id={`decision-card-${decision.decisionId}`}
      data-focused={focused || undefined}
      onClick={onOpen}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-xs border-b border-border px-2.5 py-2 text-left hover:bg-text/5 ${
        focused ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <DecisionStateBadge state={decision.state} />
          <RiskTierBadge tier={decision.riskTier} />
          <UrgencyBadge urgency={decision.urgency} />
          <DecisionReviewBadge review={decision.review} />
          <ReadinessBadge decision={decision} facts={facts} rows={coverageRows} graphState={relationState} />
        </span>
        <span className="mt-1 block truncate text-text ui-body" title={decision.title}>
          <TitleText title={decision.title} />
          <span className="ml-2 text-text-faint ui-meta">{decision.question}</span>
        </span>
      </span>
      <span className="shrink-0 font-mono text-text-faint ui-meta">
        <span className="block truncate">{decision.decisionId}</span>
        {decision.proposedAt ? (
          <span className="block text-right">{formatTime(decision.proposedAt, { style: "month-day-time" })}</span>
        ) : null}
      </span>
    </button>
  );
}

/** 抽屉里的完整决策依据:元信息、取代/修订链、canonical 裁决 consent 与快速批复面板。 */
function DecisionDrawerBody({
  decision,
  relations,
  facts,
  coverageRows,
  relationState,
  onFocusGraph,
  onNavigateDecision,
  onJudge,
  mutationFeedback,
  onCheckReceipt,
}: {
  readonly decision: DecisionRow;
  readonly relations: RelationEdge[];
  readonly facts: FactRef[];
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
  readonly relationState: RelationState;
  readonly onFocusGraph?: (ref: string) => void;
  readonly onNavigateDecision: (decisionId: string) => void;
  readonly onJudge?: (
    decision: DecisionRow,
    action: DecisionAction,
    input: { readonly rationale: string; readonly judgmentOnlyRationale?: string },
  ) => Promise<DecisionMutationFeedback>;
  readonly mutationFeedback?: (decisionId: string) => DecisionMutationFeedback | undefined;
  readonly onCheckReceipt?: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline gap-2">
        <h2 className="min-w-0 flex-1 font-semibold text-text ui-title">
          <TitleText title={decision.title} />
        </h2>
        <EntityRefLink
          entityRef={`decision/${decision.decisionId}`}
          onNavigate={() => onNavigateDecision(decision.decisionId)}
          title={decision.decisionId}
          className="font-mono ui-meta text-text-faint hover:text-accent hover:underline"
        />
        {onFocusGraph && (
          <button
            type="button"
            onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
            title={t("views.decisionPoolView.focusDecisionDiagram")}
            className="grid size-7 place-items-center rounded-xs text-text-faint hover:bg-surface-raised hover:text-accent"
          >
            <Graph weight="bold" aria-hidden />
          </button>
        )}
      </header>
      <p className="ui-meta text-text-muted">Q: {decision.question}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <DecisionStateBadge state={decision.state} />
        <RiskTierBadge tier={decision.riskTier} />
        <UrgencyBadge urgency={decision.urgency} />
        <DecisionReviewBadge review={decision.review} />
        <ReadinessBadge decision={decision} facts={facts} rows={coverageRows} graphState={relationState} />
      </div>
      <div className="rounded-xs border border-border bg-surface-raised/50 px-2.5 py-2">
        <ChainView decision={decision} relations={relations} onNavigateDecision={onNavigateDecision} />
      </div>
      <div className="flex flex-wrap gap-x-3 font-mono ui-micro text-text-faint">
        <span>{decision.vertical ?? "—"}</span>
        <span>{decision.preset ?? "—"}</span>
        <span>{decision.decisionClass ?? "unknown class"}</span>
        <span>modules:{decision.appliesTo?.modules.join(",") || "—"}</span>
        <span>PLT:{decision.appliesTo?.productLines.join(",") || "—"}</span>
        <span>revision:{decision.workspaceRevision ?? "unknown"}</span>
      </div>
      {decision.judgmentConsents.length > 0 && (
        <details className="ui-micro text-text-muted">
          <summary className="cursor-pointer select-none text-text-faint hover:text-text-muted">
            {t("views.decisionPoolView.canonicalBodyConsents")}
          </summary>
          {decision.judgmentConsents.map((consent) => (
            <div key={consent.consentId} className="mt-1 font-mono">
              {consent.action} · {consent.consentId} · {consent.consentedAt}
            </div>
          ))}
        </details>
      )}
      {
        /* 裁决面板只挂在仍可裁决的行上(行级能力投影,不再比较状态词)。 */
        decisionCan(decision, "accept") && onJudge && (
          <DecisionJudgmentPanel
            decision={decision}
            relations={relations}
            feedback={mutationFeedback?.(decision.decisionId)}
            onSubmit={onJudge}
            onCheckReceipt={() => onCheckReceipt?.(decision.decisionId)}
            acceptBlockedReason={reviewAcceptBlockedReason(decision.review)}
          />
        )
      }
    </div>
  );
}

function Filter({
  value,
  set,
  label,
  allLabel,
  values,
}: {
  value: string;
  set: (value: string) => void;
  label: string;
  allLabel: string;
  values: string[];
}) {
  return (
    <select className={selectClass} value={value} onChange={(event) => set(event.target.value)}>
      <option value="all">{allLabel}</option>
      {values.map((item) => (
        <option key={item} value={item}>
          {label}: {item}
        </option>
      ))}
    </select>
  );
}
