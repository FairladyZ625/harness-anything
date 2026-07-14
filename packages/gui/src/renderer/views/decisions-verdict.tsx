import { useState } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  WarningCircle,
  ClockClockwise,
  TreeStructure,
  PaperPlaneTilt,
  ProhibitInset,
  BugBeetle,
  Robot,
} from "@phosphor-icons/react";
import type {
  DecisionRow,
  DecisionClaim,
  TaskRow,
  RelationEdge,
  FactRef,
} from "../model/types";
import {
  DecisionStateBadge,
  RiskTierBadge,
  UrgencyBadge,
} from "../components/badges";
import {
  coverageOf,
  derivedTasks,
  factOf,
  rationaleFor,
  supersedeChain,
} from "../model/triadic";
import { CopyContextButton } from "../components/CopyContextButton";
import { buildEntityJumpContext } from "../model/copy-context";
import { t } from "../i18n/index.tsx";
import {
  buildConflictRejection,
  computeReadinessSignals,
  hasUnknownSignals,
  sortKey,
  worstColor,
  type ReadinessSignal,
  type SignalColor,
} from "./decisions-readiness";

export type { ReadinessSignal, SignalColor };
export { sortKey, computeReadinessSignals, worstColor, hasUnknownSignals };

const dateLabel = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

const formatActorAxes = (actor: DecisionRow["attribution"]["originator"], fallback: string) => actor
  ? `person:${actor.principal.personId} / ${actor.executor ? `agent:${actor.executor.id}` : "executor:none"}`
  : fallback;

/** 单盏灯;unknown 灯用 muted 占位,不画假绿。 */
function SignalLamp({ signal }: { signal: ReadinessSignal }) {
  if (signal.unknown) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-text-faint"
        title={signal.summary}
      >
        <span className="size-1.5 rounded-full bg-text-faint/40" />
        {signal.label}
      </span>
    );
  }
  const colorCls =
    signal.color === "red"
      ? "text-danger"
      : signal.color === "yellow"
        ? "text-stale"
        : "text-success";
  const dotCls =
    signal.color === "red"
      ? "bg-danger"
      : signal.color === "yellow"
        ? "bg-stale"
        : "bg-success";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ${colorCls}`}
      title={signal.summary}
    >
      <span className={`size-1.5 rounded-full ${dotCls} ${signal.color !== "green" ? "animate-pulse" : ""}`} />
      {signal.label}
    </span>
  );
}

function FactChip({
  factRef,
  facts,
  relations,
  onInspect,
}: {
  factRef: string;
  facts: FactRef[];
  relations: RelationEdge[];
  onInspect: (factRef: string) => void;
}) {
  const f = factOf(factRef, facts);
  const rationale = rationaleFor(factRef, relations);
  if (!f) {
    return (
      <button
        onClick={() => onInspect(factRef)}
        className="inline-flex items-center gap-1 rounded border border-dashed border-danger/60 px-1.5 py-0.5 font-mono text-[11px] text-danger hover:bg-danger/10"
        title={t("views.decisionsVerdict.danglingReferenceNonExistentFactAnchor")}
      >
        <WarningCircle weight="bold" className="text-[11px]" />
        {factRef}
      </button>
    );
  }
  return (
    <button
      onClick={() => onInspect(factRef)}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ${
        f.invalidated ? "text-stale line-through" : "text-success"
      } hover:bg-surface-raised`}
      title={t("views.decisionsVerdict.factTooltip", {
        fact: f.text,
        expired: f.invalidated ? t("views.decisionsVerdict.expired") : "",
        rationale: rationale ? t("views.decisionsVerdict.rationaleValue", { rationale }) : "",
      })}
    >
      <span className="font-sans text-text-faint">⟶</span>
      {f.anchor}
      {f.invalidated && <WarningCircle weight="bold" className="text-[10px]" />}
      {rationale && (
        <span className="font-sans normal-case text-text-faint not-italic">({rationale})</span>
      )}
    </button>
  );
}

export function ClaimList({
  title,
  items,
  tone,
  facts,
  relations,
  onInspectFact,
}: {
  title: string;
  items: DecisionClaim[];
  tone: "chosen" | "rejected";
  facts: FactRef[];
  relations: RelationEdge[];
  onInspectFact: (factRef: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-semibold text-text-faint">
        {title}
        {tone === "rejected" && (
          <span className="ml-1 text-danger">{t("views.decisionsVerdict.rejectionMoreImportantThanSelectionEveryEntry")}</span>
        )}
      </div>
      <ul className="mt-1 space-y-1.5">
        {items.map((c) => (
          <li key={c.id} className="text-[12px] leading-relaxed">
            <span className="font-mono text-text-faint">{c.id} </span>
            <span className={tone === "rejected" ? "text-text-muted line-through opacity-80" : "text-text"}>
              {c.text}
            </span>
            {c.evidence.length > 0 ? (
              <div className="ml-4 mt-0.5 flex flex-wrap items-center gap-1">
                {c.evidence.map((evRef) => (
                  <FactChip key={evRef} factRef={evRef} facts={facts} relations={relations} onInspect={onInspectFact} />
                ))}
              </div>
            ) : (
              <span className="ml-2 font-mono text-[11px] text-danger">
                {t("views.decisionsVerdict.noEvidenceInv5GoodhartRisk")}</span>
            )}
            {tone === "rejected" && !c.whyNot && (
              <span className="ml-2 font-mono text-[11px] text-danger">{t("views.decisionsVerdict.missingWhyNot")}</span>
            )}
            {c.whyNot && (
              <div className="ml-4 text-[11px] italic text-text-faint">{t("views.decisionsVerdict.whyNotValue", { value: c.whyNot })}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type DecideAction = "accept" | "reject" | "defer";

/**
 * 决策卡。五必显项逐项落地(41 §3.1)。
 * onDecide 现携带可选 rationale(reject 必填、defer 可选)。
 */
export function VerdictCard({
  d,
  decisions,
  facts,
  tasks,
  relations,
  onTrace,
  onCallAgent,
  onDecide,
  onInspectFact,
  onNavigateDecision,
  readOnly = false,
  initialPendingAction = null,
}: {
  d: DecisionRow;
  decisions: DecisionRow[];
  facts: FactRef[];
  tasks: TaskRow[];
  relations: RelationEdge[];
  onTrace: (sessionId: string) => void;
  onCallAgent?: (cmd: string) => void;
  onDecide: (id: string, action: DecideAction, rationale?: string) => void;
  onInspectFact: (factRef: string) => void;
  onNavigateDecision?: (decisionId: string) => void;
  readOnly?: boolean;
  /** Open the reject/defer rationale panel on mount (keyboard hotkey bridge). */
  initialPendingAction?: "reject" | "defer" | null;
}) {
  const cov = coverageOf(d, facts);
  const derived = derivedTasks(d, relations, tasks);
  const chain = supersedeChain(d, relations);
  const deepHint = d.riskTier === "high";
  const quickHint = d.riskTier === "low";

  const signals = computeReadinessSignals(d, facts);
  const worst = worstColor(signals);
  const unknownPresent = hasUnknownSignals(signals);
  const hasAlert = worst !== "green";
  const conflictSignal = signals.find((s) => s.id === "conflict-marker" && s.color === "red" && !s.unknown);

  const [rejection, setRejection] = useState<{ code: string; reason: string; detail: string[] } | null>(null);
  // P1-2: reject/defer 展开 rationale 输入。reject 要求非空;defer 可选。
  const [pendingAction, setPendingAction] = useState<"reject" | "defer" | null>(
    readOnly ? null : initialPendingAction,
  );
  const [rationaleDraft, setRationaleDraft] = useState("");
  const [rationaleError, setRationaleError] = useState<string | null>(null);

  const handleAccept = () => {
    if (readOnly) return;
    if (conflictSignal) {
      setRejection(buildConflictRejection(d));
      return;
    }
    onDecide(d.decisionId, "accept");
  };

  const openRationale = (action: "reject" | "defer") => {
    if (readOnly) return;
    setPendingAction(action);
    setRationaleDraft("");
    setRationaleError(null);
  };

  const submitRationale = () => {
    if (!pendingAction) return;
    const trimmed = rationaleDraft.trim();
    if (pendingAction === "reject" && trimmed.length === 0) {
      setRationaleError(t("views.decisionsVerdict.rationaleRequiredForReject"));
      return;
    }
    onDecide(d.decisionId, pendingAction, trimmed.length > 0 ? trimmed : undefined);
    setPendingAction(null);
    setRationaleDraft("");
    setRationaleError(null);
  };

  const cancelRationale = () => {
    setPendingAction(null);
    setRationaleDraft("");
    setRationaleError(null);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-text-faint">{d.decisionId}</span>
            <DecisionStateBadge state={d.state} />
            <span className="font-mono text-[11px] text-text-faint">{d.vertical}</span>
          </div>
          <div className="mt-1 text-[15px] font-semibold text-text">{d.title}</div>
          <div className="mt-0.5 text-[12px] italic text-text-muted">Q: {d.question}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            {onNavigateDecision && (
              <button
                type="button"
                onClick={() => onNavigateDecision(d.decisionId)}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted hover:border-border-strong hover:text-text"
                title={t("views.decisionsVerdict.viewInDecisionPool")}
              >
                {t("views.decisionsVerdict.viewInDecisionPool")}
              </button>
            )}
            <CopyContextButton
              compact
              buildText={() =>
                buildEntityJumpContext(
                  `decision/${d.decisionId}`,
                  relations,
                  decisions,
                  facts,
                  tasks,
                  t("views.decisionsVerdict.checkingEvidenceCoverageReadinessSignalsRelationshipUpstream"),
                )
              }
            />
          </div>
          <RiskTierBadge tier={d.riskTier} />
          <UrgencyBadge urgency={d.urgency} />
        </div>
      </div>

      {deepHint && (
        <div className="mt-2 rounded-md bg-stale/10 px-2.5 py-1.5 text-[11px] text-stale">
          <WarningCircle weight="bold" className="mr-1 inline text-[11px]" />
          {t("views.decisionsVerdict.highRiskItRecommendedFullyReviewEvidence")}</div>
      )}
      {quickHint && (
        <div className="mt-2 rounded-md bg-surface-raised px-2.5 py-1.5 text-[11px] text-text-faint">
          {t("views.decisionsVerdict.lowRiskCanPassQuicklyGettingInto")}</div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface-raised/40 px-2.5 py-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-text-faint">{t("views.decisionsVerdict.decisionReady")}</span>
        {signals.map((s) => (
          <SignalLamp key={s.id} signal={s} />
        ))}
        {unknownPresent && (
          <span className="ml-auto text-[10px] text-text-faint">{t("views.decisionsVerdict.driftConflictNotProjected")}</span>
        )}
        {!unknownPresent && worst === "green" && (
          <span className="ml-auto text-[10px] text-success">{t("views.decisionsVerdict.fullyGreenDirectDecisionMakingApprovalLegitimate")}</span>
        )}
      </div>

      {hasAlert && (
        <div
          className={`mt-2 rounded-md px-2.5 py-2 text-[11px] ${
            worst === "red"
              ? "bg-danger/10 text-danger"
              : "bg-stale/10 text-stale"
          }`}
        >
          <div className="flex items-center gap-1 font-semibold">
            {worst === "red" ? <BugBeetle weight="bold" className="text-[12px]" /> : <WarningCircle weight="bold" className="text-[12px]" />}
            {worst === "red" ? t("views.decisionsVerdict.redLightVerificationRequiredBeforeDecisionApproval") : t("views.decisionsVerdict.yellowLightProposedVerificationBeforeDecisionApproval")}
          </div>
          <ul className="mt-1 space-y-0.5 pl-4">
            {signals.filter((s) => !s.unknown && s.color !== "green").map((s) => (
              <li key={s.id} className="flex gap-1">
                <span className={`shrink-0 ${s.color === "red" ? "text-danger" : "text-stale"}`}>●</span>
                <span className="font-mono text-[10px]">{s.label}:</span>
                <span>{s.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-faint">
        <span>
          {t("views.decisionsVerdict.originator")} <span className="font-mono text-text-muted">{formatActorAxes(d.attribution.originator, t("views.decisionsVerdict.unknown"))}</span>
        </span>
        <span>
          {t("views.decisionsVerdict.latestActor")} <span className="font-mono text-text-muted">{formatActorAxes(d.attribution.latestActor, t("views.decisionsVerdict.pendingDecisionApproval"))}</span>
        </span>
      </div>

      <ClaimList title={t("views.decisionsVerdict.chosen")} items={d.chosen} tone="chosen" facts={facts} relations={relations} onInspectFact={onInspectFact} />
      <ClaimList title={t("views.decisionsVerdict.rejected")} items={d.rejected} tone="rejected" facts={facts} relations={relations} onInspectFact={onInspectFact} />

      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-text-faint">{t("views.decisionsVerdict.coverage")}</span>
        {cov.total === 0 ? (
          <span className="text-text-faint">{t("views.decisionsVerdict.noLoadBearingArgument")}</span>
        ) : cov.covered === cov.total ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle weight="bold" /> {cov.covered}/{cov.total} {t("views.decisionsVerdict.argumentHasEvidence")}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-stale">
            <WarningCircle weight="bold" /> {cov.covered}/{cov.total} {t("views.decisionsVerdict.missing")}{cov.gaps.join(", ")}
          </span>
        )}
      </div>

      {(derived.length > 0 || chain.supersedes.length > 0 || chain.supersededBy.length > 0) && (
        <div className="mt-2 rounded-md border border-border bg-surface-raised/50 p-2">
          <div className="flex items-center gap-1 text-[11px] font-semibold text-text-faint">
            <TreeStructure weight="bold" className="text-[12px]" /> {t("views.decisionsVerdict.relationUpstreamDownstreamLoop")}</div>
          {derived.length > 0 && (
            <div className="mt-1 text-[11px]">
              <span className="text-text-faint">{t("views.decisionsVerdict.derivedTask")}</span>
              {derived.map((task) => (
                <span key={task.taskId} className="mr-2 inline-flex items-center gap-1 font-mono text-text-muted">
                  <span className="rounded bg-surface px-1">{task.taskId}</span>
                  <span className="font-sans text-text-faint">{task.title}</span>
                </span>
              ))}
            </div>
          )}
          {chain.supersedes.length > 0 && (
            <div className="mt-0.5 text-[11px]">
              <span className="text-text-faint">{t("views.decisionsVerdict.overthrowSupersedes")}</span>
              <span className="font-mono text-danger">{chain.supersedes.join(", ")}</span>
            </div>
          )}
          {chain.supersededBy.length > 0 && (
            <div className="mt-0.5 text-[11px]">
              <span className="text-text-faint">{t("views.decisionsVerdict.overturnedSupersededBy")}</span>
              <span className="font-mono text-danger">{chain.supersededBy.join(", ")}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-text-faint">{t("views.decisionsVerdict.provenance")}</span>
        {d.provenance?.map((p) => (
          <button
            key={p.sessionId}
            onClick={() => onTrace(p.sessionId)}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-px font-mono text-[11px] text-accent hover:bg-surface-raised"
            title={`runtime: ${p.runtime}\nsessionId: ${p.sessionId}\nboundAt: ${dateLabel(p.boundAt)}`}
          >
            <ArrowSquareOut weight="bold" className="text-[11px]" />
            {p.runtime}:{p.sessionId.slice(0, 8)}…
            <span className="font-sans text-text-faint">· {dateLabel(p.boundAt)}</span>
          </button>
        ))}
      </div>

      <div className="mt-1 text-[11px] text-text-faint">
        {t("views.decisionsVerdict.timestamps", { proposedAt: dateLabel(d.proposedAt), lastChanged: dateLabel(d.lastChangedAt) })}
      </div>

      <div className="mt-3 flex gap-2 border-t border-border pt-3">
        <button
          onClick={handleAccept}
          disabled={readOnly}
          title={readOnly ? t("views.decisionsVerdict.readOnlyApiConnectedDecisionMakingApproval") : t("views.decisionsVerdict.accept")}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckCircle weight="bold" className="text-[13px]" />
          {t("views.decisionsVerdict.accept")}
          {!readOnly && <kbd className="ml-1 rounded bg-accent-fg/15 px-1 font-mono text-[10px] font-normal opacity-70">a</kbd>}
        </button>
        <button
          onClick={() => openRationale("reject")}
          disabled={readOnly}
          title={readOnly ? t("views.decisionsVerdict.readOnlyApiConnectedDecisionMakingApproval") : t("views.decisionsVerdict.reject")}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-text hover:border-danger/50 hover:bg-danger/5 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ProhibitInset weight="bold" className="text-[13px]" />
          {t("views.decisionsVerdict.reject")}
          {!readOnly && <kbd className="ml-1 rounded bg-surface px-1 font-mono text-[10px] font-normal opacity-70">r</kbd>}
        </button>
        <button
          onClick={() => openRationale("defer")}
          disabled={readOnly}
          title={readOnly ? t("views.decisionsVerdict.readOnlyApiConnectedDecisionMakingApproval") : t("views.decisionsVerdict.defer")}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-text hover:border-stale/50 hover:bg-stale/5 hover:text-stale disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ClockClockwise weight="bold" className="text-[13px]" />
          {t("views.decisionsVerdict.defer")}
          {!readOnly && <kbd className="ml-1 rounded bg-surface px-1 font-mono text-[10px] font-normal opacity-70">d</kbd>}
        </button>
      </div>

      {readOnly && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-text-faint">
          {t("views.decisionsVerdict.readOnlyApiConnectedDecisionMakingApproval")}
        </p>
      )}

      {/* P1-2 rationale capture for reject/defer */}
      {pendingAction && (
        <div className="mt-2 rounded-md border border-border bg-surface-raised/60 p-2.5" data-testid="decision-rationale-panel">
          <div className="mb-1 text-[11px] font-semibold text-text-muted">
            {pendingAction === "reject"
              ? t("views.decisionsVerdict.rationaleRequiredForReject")
              : t("views.decisionsVerdict.rationaleOptionalForDefer")}
          </div>
          <textarea
            value={rationaleDraft}
            onChange={(event) => {
              setRationaleDraft(event.target.value);
              if (rationaleError) setRationaleError(null);
            }}
            rows={3}
            data-testid="decision-rationale-input"
            placeholder={t("views.decisionsVerdict.rationalePlaceholder")}
            className="w-full resize-y rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
            autoFocus
          />
          {rationaleError && (
            <div className="mt-1 text-[11px] text-danger" data-testid="decision-rationale-error">{rationaleError}</div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancelRationale}
              className="rounded px-2 py-1 text-[11px] text-text-muted hover:bg-surface hover:text-text"
            >
              {t("views.decisionsVerdict.cancelRationale")}
            </button>
            <button
              type="button"
              onClick={submitRationale}
              data-testid="decision-rationale-submit"
              className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
                pendingAction === "reject"
                  ? "bg-danger/15 text-danger hover:bg-danger/25"
                  : "bg-stale/15 text-stale hover:bg-stale/25"
              }`}
            >
              {pendingAction === "reject" ? t("views.decisionsVerdict.confirmReject") : t("views.decisionsVerdict.confirmDefer")}
            </button>
          </div>
        </div>
      )}

      {rejection && (
        <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 font-mono text-[11px] text-danger">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{t("views.decisionsVerdict.acceptRejectedTryAgainCoordinatorPreCheck")}</span>
            <button onClick={() => setRejection(null)} className="text-danger/70 hover:text-danger">✕</button>
          </div>
          <div className="mt-1">{t("views.decisionsVerdict.codeValue", { code: rejection.code })}</div>
          <div>{rejection.reason}</div>
          <div className="mt-1 space-y-0.5 text-danger/80">
            {rejection.detail.map((line, i) => (
              <div key={i}>· {line}</div>
            ))}
          </div>
        </div>
      )}

      {onCallAgent && (
        hasAlert ? (
          <button
            onClick={() => onCallAgent(`harness decision ${d.decisionId} --check`)}
            className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-semibold ${
              worst === "red"
                ? "bg-danger/15 text-danger hover:bg-danger/25"
                : "bg-stale/15 text-stale hover:bg-stale/25"
            }`}
          >
            <Robot weight="bold" className="text-[13px]" />
            {t("views.decisionsVerdict.callAgentVerifyRecommended")}<span className="ml-1 text-[10px] font-normal opacity-70">{t("views.decisionsVerdict.agentChecksDriftFailureMakesDecisionsBehalf")}</span>
          </button>
        ) : (
          <button
            onClick={() => onCallAgent(`harness decision ${d.decisionId}`)}
            className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <PaperPlaneTilt weight="bold" className="text-[11px]" />
            {t("views.decisionsVerdict.decideApproveAfterDiscussionAgentThroughCli")}</button>
        )
      )}
    </div>
  );
}
