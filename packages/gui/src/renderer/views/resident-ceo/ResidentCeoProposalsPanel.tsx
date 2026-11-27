import { useState } from "react";
import type { ResidentCeoDelegationProposalRead } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { formatListTime, formatTime } from "../../model/time.ts";
import { EntityRefLink, entityRefOf } from "../../components/EntityRefLink.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { Section } from "../../components/primitives/Section.tsx";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";

function proposalTone(status: ResidentCeoDelegationProposalRead["status"]): StatusTone {
  switch (status) {
    case "pending_approval":
      return "wait";
    case "promoted":
      return "done";
    case "rejected":
      return "cancel";
    case "failed":
      return "bad";
  }
}

function formatGateVerdict(proposal: ResidentCeoDelegationProposalRead): string | null {
  const verdict = proposal.gateVerdict;
  if (!verdict) return null;
  const confidence =
    verdict.confidence !== null
      ? ` ${Math.round(verdict.confidence * 100)}% / ${Math.round(verdict.minConfidence * 100)}%`
      : "";
  const fallback = verdict.fallbackReason ? ` (${verdict.fallbackReason})` : "";
  return `${verdict.mode}: ${verdict.selected ?? "error"}${confidence}${fallback}`;
}

export function ResidentCeoProposalsPanel({
  proposals,
  defaultWorkId,
  approvingId,
  rejectingId,
  onApprove,
  onReject,
  onNavigateEntity,
}: {
  readonly proposals: readonly ResidentCeoDelegationProposalRead[];
  readonly defaultWorkId: string | null;
  readonly approvingId: string | null;
  readonly rejectingId: string | null;
  readonly onApprove: (input: { readonly proposalId: string; readonly workId?: string }) => void;
  readonly onReject: (input: { readonly proposalId: string; readonly reason: string }) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [showSettled, setShowSettled] = useState(false);
  const [rejectDrafts, setRejectDrafts] = useState<Readonly<Record<string, string>>>({});
  const [openRejectId, setOpenRejectId] = useState<string | null>(null);
  const [workOverrides, setWorkOverrides] = useState<Readonly<Record<string, string>>>({});

  const pending = proposals.filter((item) => item.status === "pending_approval");
  const settled = proposals.filter((item) => item.status !== "pending_approval");

  if (proposals.length === 0) return null;

  const renderCard = (proposal: ResidentCeoDelegationProposalRead) => {
    const isPending = proposal.status === "pending_approval";
    const resolvedWorkId = proposal.proposedWorkId ?? defaultWorkId ?? "";
    const workInputValue = workOverrides[proposal.proposalId] ?? resolvedWorkId;
    const targetNode = proposal.dispatchedTargetNodeId ?? proposal.proposedTargetNodeId ?? null;
    const gateLabel = formatGateVerdict(proposal);
    const isRejectingThis = openRejectId === proposal.proposalId;
    const rejectReason = rejectDrafts[proposal.proposalId] ?? "";
    const busy = approvingId === proposal.proposalId || rejectingId === proposal.proposalId;

    return (
      <article
        key={proposal.proposalId}
        data-testid={`resident-ceo-proposal-${proposal.proposalId}`}
        data-proposal-status={proposal.status}
        className="rounded-md border border-border-strong bg-surface-raised p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag
            tone={proposalTone(proposal.status)}
            label={t(`residentCeo.proposals.status.${proposal.status}`)}
          />
          <strong className="min-w-0 flex-1 ui-body font-semibold text-text">{proposal.proposedTitle}</strong>
          <span
            className="font-mono ui-micro text-text-faint"
            title={formatTime(proposal.createdAt, { style: "date-time-seconds" }) ?? proposal.createdAt}
          >
            {formatListTime(proposal.createdAt)}
          </span>
        </div>

        <p className="mt-1.5 ui-meta text-text-muted">{proposal.summary}</p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono ui-micro text-text-faint">
          <span>
            {t("residentCeo.proposals.from")}: <span className="text-text">{proposal.fromPersonId}</span>
          </span>
          <span>
            {t("residentCeo.peerRequestRef")}: {proposal.peerRequestId}
          </span>
          {resolvedWorkId ? (
            <span>
              {t("residentCeo.proposals.work")}:{" "}
              <EntityRefLink entityRef={entityRefOf("task", resolvedWorkId)} onNavigate={onNavigateEntity}>
                {resolvedWorkId}
              </EntityRefLink>
            </span>
          ) : null}
          {proposal.proposedAgentId ? (
            <span>
              {t("residentCeo.proposals.agent")}:{" "}
              <EntityRefLink entityRef={entityRefOf("agent", proposal.proposedAgentId)} onNavigate={onNavigateEntity}>
                {proposal.proposedAgentId}
              </EntityRefLink>
            </span>
          ) : null}
          {targetNode ? (
            <span data-testid={`resident-ceo-proposal-node-${proposal.proposalId}`}>
              {t("residentCeo.proposals.targetNode")}: <span className="text-text">{targetNode}</span>
            </span>
          ) : null}
          {gateLabel ? (
            <StatusTag
              tone={proposal.gateVerdict?.selected === "approve_low_risk" ? "done" : "wait"}
              label={`${t("residentCeo.proposals.gateVerdict")}: ${gateLabel}`}
              mono
              testId={`resident-ceo-proposal-gate-${proposal.proposalId}`}
            />
          ) : null}
        </div>

        {proposal.rationale ? (
          <p className="mt-1.5 ui-micro text-text-muted">
            <span className="font-semibold text-text-faint">{t("residentCeo.proposals.rationale")}: </span>
            {proposal.rationale}
          </p>
        ) : null}

        {proposal.promotedTaskId ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 ui-micro text-text-muted">
            <span>{t("residentCeo.proposals.promotedTask")}:</span>
            <EntityRefLink entityRef={entityRefOf("task", proposal.promotedTaskId)} onNavigate={onNavigateEntity}>
              {entityRefOf("task", proposal.promotedTaskId)}
            </EntityRefLink>
          </div>
        ) : null}

        {proposal.rejectionReason ? (
          <p className="mt-1.5 ui-micro text-text-faint">
            {t("residentCeo.proposals.rejectionReason")}: {proposal.rejectionReason}
          </p>
        ) : null}

        {proposal.dispatchError ? (
          <p className="mt-1.5 ui-micro text-danger">
            {t("residentCeo.proposals.dispatchError")}: {proposal.dispatchError}
          </p>
        ) : null}

        {isPending ? (
          <div className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2">
            {!resolvedWorkId ? (
              <div className="flex items-center gap-2">
                <TextInput
                  label={t("residentCeo.proposals.work")}
                  placeholder={t("residentCeo.proposals.workIdPlaceholder")}
                  value={workInputValue}
                  mono
                  onChange={(value) => setWorkOverrides((prev) => ({ ...prev, [proposal.proposalId]: value }))}
                  testId={`resident-ceo-proposal-work-input-${proposal.proposalId}`}
                />
              </div>
            ) : null}

            {isRejectingThis ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[220px] flex-1">
                  <TextInput
                    label={t("residentCeo.proposals.rejectReasonLabel")}
                    placeholder={t("residentCeo.proposals.rejectReasonPlaceholder")}
                    value={rejectReason}
                    onChange={(value) => setRejectDrafts((prev) => ({ ...prev, [proposal.proposalId]: value }))}
                    testId={`resident-ceo-reject-reason-${proposal.proposalId}`}
                  />
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  loading={rejectingId === proposal.proposalId}
                  disabled={busy || rejectReason.trim().length === 0}
                  testId={`resident-ceo-confirm-reject-${proposal.proposalId}`}
                  onClick={() => {
                    onReject({ proposalId: proposal.proposalId, reason: rejectReason.trim() });
                    setOpenRejectId(null);
                  }}
                >
                  {t("residentCeo.proposals.confirmReject")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setOpenRejectId(null)}>
                  {t("residentCeo.proposals.cancelReject")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={approvingId === proposal.proposalId}
                  disabled={busy || workInputValue.trim().length === 0}
                  testId={`resident-ceo-approve-${proposal.proposalId}`}
                  onClick={() =>
                    onApprove({
                      proposalId: proposal.proposalId,
                      ...(workInputValue.trim() ? { workId: workInputValue.trim() } : {}),
                    })
                  }
                >
                  {t("residentCeo.proposals.approve")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  testId={`resident-ceo-reject-${proposal.proposalId}`}
                  onClick={() => setOpenRejectId(proposal.proposalId)}
                >
                  {t("residentCeo.proposals.reject")}
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <div data-testid="resident-ceo-proposals-panel" className="shrink-0 border-b border-border px-5 pt-3 pb-2">
      {pending.length > 0 ? (
        <Section
          variant="hero"
          title={t("residentCeo.proposals.pendingTitle")}
          count={pending.length}
          action={
            settled.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setShowSettled((prev) => !prev)}>
                {t("residentCeo.proposals.historyToggle", { count: settled.length })}
              </Button>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-2">{pending.map(renderCard)}</div>
        </Section>
      ) : settled.length > 0 ? (
        <div className="flex items-center justify-between py-0.5">
          <Button
            variant="ghost"
            size="sm"
            testId="resident-ceo-settled-proposals-toggle"
            onClick={() => setShowSettled((prev) => !prev)}
          >
            {t("residentCeo.proposals.historyToggle", { count: settled.length })}
          </Button>
        </div>
      ) : null}

      {showSettled && settled.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 pb-1" data-testid="resident-ceo-settled-proposals">
          {settled.map(renderCard)}
        </div>
      ) : null}
    </div>
  );
}
