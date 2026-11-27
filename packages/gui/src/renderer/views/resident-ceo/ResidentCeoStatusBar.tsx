import type { ResidentCeoProfileRead } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { formatListTime, formatTime } from "../../model/time.ts";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";

function executionModeBadge(profile: ResidentCeoProfileRead): { readonly label: string; readonly tone: StatusTone } {
  const mode = profile.executionPolicy ?? "advisory-only";
  if (mode === "approval-gated") {
    const senderCount = profile.autoApproveSenders?.length ?? 0;
    if (senderCount > 0) {
      return {
        label: `${t("residentCeo.policy.allowlistAuto")} (${senderCount})`,
        tone: "active",
      };
    }
    return { label: t("residentCeo.policy.approvalGated"), tone: "wait" };
  }
  return { label: t("residentCeo.policy.advisoryOnly"), tone: "neutral" };
}

function gateDisplay(profile: ResidentCeoProfileRead): { readonly label: string; readonly tone: StatusTone } {
  const mode = profile.approvalGate?.mode ?? "off";
  const minConfidence = profile.approvalGate?.minConfidence ?? 0.85;
  const providerSuffix = profile.approvalGate?.providerId ? ` · ${profile.approvalGate.providerId}` : "";
  if (mode === "auto-promote") {
    return {
      label: `${t("residentCeo.gateStatus")}: auto-promote @ ${Math.round(minConfidence * 100)}%${providerSuffix}`,
      tone: "done",
    };
  }
  if (mode === "secondary-guard") {
    return {
      label: `${t("residentCeo.gateStatus")}: secondary-guard @ ${Math.round(minConfidence * 100)}%${providerSuffix}`,
      tone: "active",
    };
  }
  return { label: `${t("residentCeo.gateStatus")}: off`, tone: "neutral" };
}

export function ResidentCeoStatusBar({
  profile,
  pendingProposalCount,
}: {
  readonly profile: ResidentCeoProfileRead | null;
  readonly pendingProposalCount: number;
}) {
  const statusTone: StatusTone = !profile ? "plan" : profile.status === "running" ? "active" : "neutral";
  const statusLabel = !profile
    ? t("residentCeo.notConfigured")
    : profile.status === "running"
      ? t("residentCeo.running")
      : t("residentCeo.stopped");
  const modeBadge = profile ? executionModeBadge(profile) : null;
  const gate = profile ? gateDisplay(profile) : null;
  const lastWake = profile?.lastWake ?? null;

  return (
    <div
      data-testid="resident-ceo-status-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-border bg-surface/70 px-5 py-2 ui-micro text-text-muted"
    >
      <StatusTag tone={statusTone} label={statusLabel} testId="resident-ceo-status" />
      {profile ? (
        <>
          <span
            className="font-mono text-text"
            data-testid="resident-ceo-instance-model"
            title={t("residentCeo.modelScopeHint")}
          >
            {profile.runtimeInstanceId} · {profile.model}
          </span>
          {modeBadge ? (
            <StatusTag tone={modeBadge.tone} label={modeBadge.label} testId="resident-ceo-policy-badge" />
          ) : null}
          {gate ? <StatusTag tone={gate.tone} label={gate.label} testId="resident-ceo-gate-badge" mono /> : null}
          <span
            className="font-mono tabular-nums text-text-faint"
            data-testid="resident-ceo-heartbeat-meta"
            title={t("residentCeo.heartbeatHint")}
          >
            {t("residentCeo.heartbeatStatusBadge", { seconds: profile.heartbeatIntervalSec })}
          </span>
          {pendingProposalCount > 0 ? (
            <StatusTag
              tone="wait"
              label={t("residentCeo.proposals.pendingCount", { count: pendingProposalCount })}
              testId="resident-ceo-pending-badge"
            />
          ) : null}
          <span
            className="ml-auto font-mono text-text-faint"
            data-testid="resident-ceo-last-wake"
            title={
              lastWake ? (formatTime(lastWake.requestedAt, { style: "date-time-seconds" }) ?? lastWake.requestedAt) : ""
            }
          >
            {t("residentCeo.lastWake")}:{" "}
            {lastWake
              ? `${lastWake.cause} · ${lastWake.status} · ${formatListTime(lastWake.requestedAt)}`
              : t("residentCeo.none")}
          </span>
        </>
      ) : (
        <span className="text-text-faint">{t("residentCeo.notConfiguredHint")}</span>
      )}
    </div>
  );
}
