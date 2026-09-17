import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle, Graph, GitBranch, Plus, XCircle } from "@phosphor-icons/react";
import type { RelationCoverageRow, WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import { harnessClient, type DecisionProposalInput } from "../api-client.ts";
import { DecisionJudgmentPanel } from "../components/DecisionJudgmentPanel.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { DecisionProposalForm } from "../components/DecisionProposalForm.tsx";
import { AttestFeedbackRow, GateAttestForm } from "../components/taskDetail/TaskGateAttestCard.tsx";
import type { GateAttestMode } from "../components/taskDetail/TaskGateAttestCard.tsx";
import type { DecisionAction, DecisionMutationFeedback } from "../decision-actions.ts";
import { computeReadinessSignals, worstColor } from "../model/readiness-signals.ts";
import {
  decisionCan,
  type DecisionRow,
  type DecisionState,
  type FactRef,
  type RelationEdge,
  type TaskRow,
} from "../model/types.ts";
import { sortDecisionQueue, supersedeChain } from "../model/triadic.ts";
import { DecisionStateBadge, RiskTierBadge, UrgencyBadge } from "../components/badges.tsx";
import { triadicQueryKeys } from "../triadic-data.ts";
import { groupDecisions, type PoolGroupBy } from "../model/decision-pool-grouping.ts";
import {
  ATTESTATION_POOL_TABS,
  deriveAttestationLanes,
  type AttestationPoolTabId,
  type GateAttestationItem,
} from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";

type PoolGroupTab = WorkspaceSummaryRead["decisions"]["groups"][number]["id"];
type TimeRange = "all" | "14d" | "30d";
type RelationState = "ready" | "loading" | "error";
const selectClass =
  "rounded-md border border-border bg-surface px-2 py-1 font-mono ui-meta text-text-muted outline-none transition-colors duration-100 hover:border-border-strong focus-visible:border-border-strong";

const TAB_LABEL_KEY: Record<AttestationPoolTabId, MessageKey> = {
  all: "views.attestationPoolView.tabAll",
  decisions: "views.attestationPoolView.tabDecisions",
  gates: "views.attestationPoolView.tabGates",
  consents: "views.attestationPoolView.tabConsents",
  breakGlass: "views.attestationPoolView.tabBreakGlass",
};

/**
 * 待办签发总池:人类治理动作的集中大厅。五个 lane——待裁决策(既有决策池的快速
 * 批复能力原样保留)、待签门禁(manual-attest 打勾签注与自动已过的双控缺签)、
 * 待同意收口(consent)、阻断需特批(契约声明 allowOverride 的自动门失败)——
 * 数据源只来自投影行真实状态。Tab 由 AppLocation 携带(poolTab),URL/刷新可寻址;
 * 动作全部行内展开,不出全局模态。
 */
export function AttestationPoolView({
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
  tasks,
  onAttest,
  taskFeedback,
  onCompleteTask,
  onNavigateTask,
  poolTab,
  onPoolTabChange,
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
  /** G10 实体互链:卡头/supersede 链的 decision ID 必须有路。 */
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
  /** 任务侧 lane 数据源(投影行原样);签发判据见 model/attestation-pool.ts。 */
  tasks: readonly TaskRow[];
  onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: GateAttestMode,
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
  taskFeedback?: (taskId: string) => TaskMutationFeedback | undefined;
  onCompleteTask?: (task: TaskRow, consent: boolean) => Promise<unknown>;
  onNavigateTask?: (taskId: string) => void;
  /** 当前 Tab 由应用位置携带(可寻址、刷新不丢)。 */
  poolTab: AttestationPoolTabId;
  onPoolTabChange: (tab: AttestationPoolTabId) => void;
}) {
  const lanes = useMemo(() => deriveAttestationLanes(tasks), [tasks]),
    pendingDecisionCount = useMemo(
      () => decisions.filter((decision) => decisionCan(decision, "accept")).length,
      [decisions],
    ),
    counts: Record<AttestationPoolTabId, number> = {
      all: pendingDecisionCount + lanes.gates.length + lanes.consents.length + lanes.breakGlass.length,
      decisions: pendingDecisionCount,
      gates: lanes.gates.length,
      consents: lanes.consents.length,
      breakGlass: lanes.breakGlass.length,
    };
  // 深链聚焦一条决策时,决策 lane 是落点(与 openDecisionInPool 的推栈路径一致)。
  useEffect(() => {
    if (focusedDecisionId && poolTab !== "decisions") onPoolTabChange("decisions");
  }, [focusedDecisionId, onPoolTabChange, poolTab]);

  const showDecisions = poolTab === "all" || poolTab === "decisions",
    showGates = poolTab === "all" || poolTab === "gates",
    showConsents = poolTab === "all" || poolTab === "consents",
    showBreakGlass = poolTab === "all" || poolTab === "breakGlass";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="ui-title font-semibold">{t("views.attestationPoolView.title")}</h1>
          <span className="font-mono ui-meta text-text-faint">{t("views.attestationPoolView.subtitle")}</span>
        </div>
        <span
          data-testid="attestation-pool-total"
          className="ml-auto rounded-full bg-accent/15 px-2.5 py-1 font-mono ui-meta font-semibold text-accent-fg"
        >
          {t("views.attestationPoolView.totalCount", { count: counts.all })}
        </span>
      </header>
      <div
        role="tablist"
        aria-label={t("views.attestationPoolView.tablist")}
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/50 px-4 py-2"
      >
        {ATTESTATION_POOL_TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={poolTab === id}
            data-testid={`attestation-pool-tab-${id}`}
            onClick={() => onPoolTabChange(id)}
            className={`rounded-md px-3 py-1.5 font-mono ui-meta tabular-nums transition-colors duration-100 ${poolTab === id ? "bg-accent text-accent-fg" : "bg-surface-raised text-text-muted hover:text-text"}`}
          >
            {t(TAB_LABEL_KEY[id])} · {counts[id]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="space-y-6">
          {showDecisions && (
            <section aria-label={t("views.attestationPoolView.tabDecisions")} className="space-y-2">
              <LaneHeading title={t("views.attestationPoolView.tabDecisions")} count={counts.decisions} />
              <DecisionPoolSection
                repoId={repoId}
                decisions={decisions}
                summary={summary}
                facts={facts}
                relations={relations}
                coverageRows={coverageRows}
                relationState={relationState}
                focusedDecisionId={focusedDecisionId}
                onFocusGraph={onFocusGraph}
                onNavigateDecision={onNavigateDecision}
                onPropose={onPropose}
                proposalFeedback={proposalFeedback}
                onJudge={onJudge}
                mutationFeedback={mutationFeedback}
                onCheckReceipt={onCheckReceipt}
              />
            </section>
          )}
          {showGates && (
            <section aria-label={t("views.attestationPoolView.tabGates")} className="space-y-2">
              <LaneHeading title={t("views.attestationPoolView.tabGates")} count={counts.gates} />
              {lanes.gates.length === 0 ? (
                <LaneEmpty text={t("views.attestationPoolView.gatesEmpty")} />
              ) : (
                lanes.gates.map((item) => (
                  <GateAttestRow
                    key={`${item.taskId}:${item.gateId}`}
                    item={item}
                    feedback={taskFeedback?.(item.taskId)}
                    onAttest={onAttest}
                    onNavigateTask={onNavigateTask}
                  />
                ))
              )}
            </section>
          )}
          {showConsents && (
            <section aria-label={t("views.attestationPoolView.tabConsents")} className="space-y-2">
              <LaneHeading title={t("views.attestationPoolView.tabConsents")} count={counts.consents} />
              {lanes.consents.length === 0 ? (
                <LaneEmpty text={t("views.attestationPoolView.consentsEmpty")} />
              ) : (
                lanes.consents.map((item) => {
                  const task = tasks.find((candidate) => candidate.taskId === item.taskId),
                    feedback = taskFeedback?.(item.taskId),
                    consentFeedback = feedback?.kind === "complete" ? feedback : undefined;
                  return (
                    <article
                      key={item.taskId}
                      data-testid={`pool-consent-card-${item.taskId}`}
                      className="rounded-lg border border-border bg-surface px-3.5 py-3 transition-colors duration-100 hover:border-border-strong"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono ui-meta text-text-faint">{item.taskId}</span>
                        <span className="ui-prose font-semibold text-text">{item.taskTitle}</span>
                        {onNavigateTask && (
                          <button
                            onClick={() => onNavigateTask(item.taskId)}
                            className="font-mono ui-micro text-accent hover:underline"
                          >
                            {t("views.attestationPoolView.openTask")}
                          </button>
                        )}
                      </div>
                      <p className="mt-1 ui-meta text-text-muted">{t("views.attestationPoolView.consentHint")}</p>
                      <div className="mt-2">
                        <button
                          type="button"
                          data-testid={`pool-consent-approve-${item.taskId}`}
                          disabled={!onCompleteTask || !task || consentFeedback?.state === "pending"}
                          onClick={() => task && void onCompleteTask?.(task, true)}
                          className="rounded-md bg-accent px-2.5 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50"
                        >
                          {t("views.attestationPoolView.consentApprove")}
                        </button>
                      </div>
                      <AttestFeedbackRow feedback={consentFeedback} />
                    </article>
                  );
                })
              )}
            </section>
          )}
          {showBreakGlass && (
            <section aria-label={t("views.attestationPoolView.tabBreakGlass")} className="space-y-2">
              <LaneHeading title={t("views.attestationPoolView.tabBreakGlass")} count={counts.breakGlass} />
              <p className="ui-micro text-text-faint">{t("views.attestationPoolView.breakGlassHint")}</p>
              {lanes.breakGlass.length === 0 ? (
                <LaneEmpty text={t("views.attestationPoolView.breakGlassEmpty")} />
              ) : (
                lanes.breakGlass.map((item) => (
                  <GateAttestRow
                    key={`${item.taskId}:${item.gateId}`}
                    item={item}
                    feedback={taskFeedback?.(item.taskId)}
                    onAttest={onAttest}
                    onNavigateTask={onNavigateTask}
                  />
                ))
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function LaneHeading({ title, count }: { readonly title: string; readonly count: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-surface/95 px-2.5 py-1.5 font-mono ui-meta text-text-muted backdrop-blur">
      <span className="font-semibold text-text">{title}</span>
      <span className="text-text-faint">{t("views.attestationPoolView.laneCount", { count })}</span>
    </div>
  );
}

function LaneEmpty({ text }: { readonly text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center ui-body text-text-faint">
      {text}
    </div>
  );
}

/** 门禁 lane 行:待签(approve)/可特批失败(override)共用,按 item.mode 分支交互。 */
function GateAttestRow({
  item,
  feedback,
  onAttest,
  onNavigateTask,
}: {
  readonly item: GateAttestationItem;
  readonly feedback?: TaskMutationFeedback;
  readonly onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: GateAttestMode,
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
  readonly onNavigateTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false),
    mode = item.mode,
    attestFeedback = feedback?.kind === "attest" ? feedback : undefined,
    pending = attestFeedback?.state === "pending";
  return (
    <article
      data-testid={`pool-gate-row-${item.taskId}-${item.gateId}`}
      className={`rounded-lg border bg-surface px-3.5 py-3 transition-colors duration-100 hover:border-border-strong ${mode === "override" ? "border-danger/40" : "border-border"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {mode === "approve" ? (
          <CheckCircle weight="bold" className="text-stale" />
        ) : (
          <XCircle weight="bold" className="text-danger" />
        )}
        <span className="font-mono ui-meta text-text-faint">{item.taskId}</span>
        <span className="ui-prose font-semibold text-text">{item.taskTitle}</span>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-muted">
          {item.gateId}
        </span>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-faint">
          {t("views.attestationPoolView.gateStatus", { status: item.gateStatus })}
        </span>
        {item.adapterId && (
          <span className="rounded border border-border px-1.5 py-0.5 font-mono ui-micro text-text-faint">
            adapter:{item.adapterId}
          </span>
        )}
        {onNavigateTask && (
          <button
            onClick={() => onNavigateTask(item.taskId)}
            className="font-mono ui-micro text-accent hover:underline"
          >
            {t("views.attestationPoolView.openTask")}
          </button>
        )}
        <button
          type="button"
          data-testid={`pool-gate-${mode}-${item.taskId}-${item.gateId}`}
          onClick={() => setOpen((value) => !value)}
          disabled={pending}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:opacity-50 ${mode === "approve" ? "bg-accent text-accent-fg hover:bg-accent/85" : "border border-danger/50 text-danger hover:bg-danger/10"}`}
        >
          {mode === "approve" ? <CheckCircle weight="bold" /> : <XCircle weight="bold" />}
          {t(mode === "approve" ? "views.attestationPoolView.attest" : "views.attestationPoolView.override")}
        </button>
      </div>
      {item.detail ? <p className="mt-1 ui-meta text-text-faint">{item.detail}</p> : null}
      {open && (
        <GateAttestForm
          mode={mode}
          pending={pending}
          onCancel={() => setOpen(false)}
          onSubmit={(rationale) => {
            setOpen(false);
            void onAttest?.({ taskId: item.taskId }, item.gateId, mode, rationale || undefined);
          }}
        />
      )}
      <AttestFeedbackRow feedback={attestFeedback} />
    </article>
  );
}

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
  const tone =
    coverage.color === "green"
      ? "bg-success/10 text-success"
      : coverage.color === "red"
        ? "bg-danger/10 text-danger"
        : "bg-surface-raised text-text-faint";
  return (
    <span
      title={`${coverage.summary}\nworstColor:${worst}`}
      className={`rounded px-1.5 py-0.5 font-mono ui-micro ${tone}`}
    >
      {t("views.decisionPoolView.coverageValue", { value: coverage.color === "na" ? "N/A" : coverage.color })}
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
      <GitBranch weight="bold" className="text-text-faint" />
      {chain.supersedes.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-danger">
          <EntityRefLink
            entityRef={`decision/${decision.decisionId}`}
            onNavigate={() => onNavigateDecision(decision.decisionId)}
            title={decision.decisionId}
            className="text-danger hover:underline"
          />
          <ArrowRight weight="bold" />
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
        <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-text-muted">
          {t("views.decisionPoolView.amendedAtValue", {
            value: formatTime(decision.lastChangedAt!, { style: "month-day-time" }) ?? "—",
          })}
        </span>
      )}
    </div>
  );
}

/** 决策 lane:原 DecisionPoolView 的过滤/分组/快速批复能力原样保留。 */
function DecisionPoolSection({
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
  const [tab, setTab] = useState<PoolGroupTab>("proposed"),
    [stateFilter, setStateFilter] = useState<DecisionState | "all">("all");
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
    [proposalOpen, setProposalOpen] = useState(false);
  const [groupBy, setGroupBy] = useState<PoolGroupBy>("none");
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

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        {onPropose && (
          <button
            onClick={() => setProposalOpen((value) => !value)}
            className={`ml-auto inline-flex items-center gap-1 rounded-md px-3 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 ${proposalOpen ? "bg-accent/85 hover:bg-accent" : "bg-accent hover:bg-accent/85"}`}
          >
            <Plus weight="bold" />
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
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface/50 px-2 py-1.5">
        {summary.groups.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setTab(item.id);
              setStateFilter("all");
            }}
            className={`rounded-md px-3 py-1.5 font-mono ui-meta tabular-nums transition-colors duration-100 ${tab === item.id ? "bg-accent text-accent-fg" : "bg-surface-raised text-text-muted hover:text-text"}`}
          >
            {item.id.replaceAll("_", " ")} · {item.count}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 px-0.5">
        <input
          aria-label={t("views.decisionPoolView.decisionSearch")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("views.decisionPoolView.searchTitleIdQuestion")}
          className={`${selectClass} min-w-52`}
        />
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
          <option value="productLine">{t("views.decisionPoolView.groupByMilestone")}</option>
          <option value="vertical">{t("views.decisionPoolView.groupByVertical")}</option>
        </select>
      </div>
      {remoteEnabled && (remote.isPending || remote.isError || remote.data?.status !== "ready") && (
        <div className="mt-2 rounded-md border border-border bg-stale/10 px-4 py-2 font-mono ui-micro text-stale">
          {t("views.decisionPoolView.projectionUnknown", {
            detail:
              remote.error instanceof Error
                ? remote.error.message
                : (remote.data?.hint ?? remote.data?.opId ?? "loading"),
          })}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {groups.map((group) => (
          <section
            key={group.key}
            aria-label={group.title || t("views.decisionPoolView.allGroup")}
            className="space-y-2"
          >
            {groupBy !== "none" && (
              <div
                data-testid={`decision-pool-group-${group.key}`}
                className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-border bg-surface/95 px-2.5 py-1.5 font-mono ui-meta text-text-muted backdrop-blur"
              >
                <span className="font-semibold text-text">{group.title}</span>
                <span className="text-text-faint">
                  {t("views.decisionPoolView.groupCount", { count: group.rows.length })}
                </span>
              </div>
            )}
            {group.rows.map((decision) => (
              <article
                key={decision.decisionId}
                id={`decision-card-${decision.decisionId}`}
                data-focused={decision.decisionId === focusedDecisionId || undefined}
                className={[
                  "rounded-lg border bg-surface px-3.5 py-3 transition-colors duration-100 cv-auto-10r",
                  decision.decisionId === focusedDecisionId
                    ? "border-accent ring-1 ring-accent/30"
                    : "border-border hover:border-border-strong",
                ].join(" ")}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono ui-meta text-text-faint">
                        <EntityRefLink
                          entityRef={`decision/${decision.decisionId}`}
                          onNavigate={() => onNavigateDecision(decision.decisionId)}
                          title={decision.decisionId}
                          className="text-text-faint hover:text-accent hover:underline"
                        />
                        {decision.legacyId ? ` · ${decision.legacyId}` : ""}
                      </span>
                      <DecisionStateBadge state={decision.state} />
                      <RiskTierBadge tier={decision.riskTier} />
                      <UrgencyBadge urgency={decision.urgency} />
                      <ReadinessBadge
                        decision={decision}
                        facts={facts}
                        rows={coverageRows}
                        graphState={relationState}
                      />
                    </div>
                    <h2 className="mt-1 ui-prose font-semibold leading-snug text-text">{decision.title}</h2>
                    <p className="mt-0.5 ui-meta text-text-muted">Q: {decision.question}</p>
                    <div className="mt-2 flex flex-wrap gap-x-3 font-mono ui-micro text-text-faint">
                      <span>{decision.vertical ?? "未知/—"}</span>
                      <span>{decision.preset ?? "未知/—"}</span>
                      <span>{decision.decisionClass ?? "unknown class"}</span>
                      <span>modules:{decision.appliesTo?.modules.join(",") || "—"}</span>
                      <span>PLT:{decision.appliesTo?.productLines.join(",") || "—"}</span>
                      <span>revision:{decision.workspaceRevision ?? "unknown"}</span>
                    </div>
                  </div>
                  {onFocusGraph && (
                    <button
                      onClick={() => onFocusGraph(`decision/${decision.decisionId}`)}
                      title={t("views.decisionPoolView.focusDecisionDiagram")}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-accent"
                    >
                      <Graph weight="bold" />
                    </button>
                  )}
                </div>
                <div className="mt-2.5 rounded-md border border-border bg-surface-raised/50 px-2.5 py-2">
                  <ChainView decision={decision} relations={relations} onNavigateDecision={onNavigateDecision} />
                </div>
                {decision.judgmentConsents.length > 0 && (
                  <details className="mt-2 ui-micro text-text-muted">
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
                    />
                  )
                }
              </article>
            ))}
          </section>
        ))}
        {rows.length === 0 && (!remoteEnabled || remote.data?.status === "ready") && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center ui-body text-text-faint">
            {t("views.decisionPoolView.emptyFilter")}
          </div>
        )}
      </div>
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
