import { useCallback, useEffect, useRef, useState } from "react";
import { t, type MessageKey } from "../../i18n/index.tsx";
import type {
  CenterSwitchInput,
  CenterSwitchPreflightCheck,
  CenterSwitchPreflightResult,
  CenterSwitchReply,
} from "../../../api/center-settings-contract.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { Notice } from "../../components/primitives/Notice.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";
import { StepChain } from "../../components/primitives/StepChain.tsx";

const CORE_PREFLIGHT_CHECKS = new Set(["tls_reachable", "replica_healthy", "auth_reachable", "symmetric_readiness"]);

const PREFLIGHT_CHECK_LABEL: Readonly<Record<string, MessageKey>> = {
  trigger_source: "collaboration.switch.check.triggerSource",
  node_identity: "collaboration.switch.check.nodeIdentity",
  tls_reachable: "collaboration.switch.check.tlsReachable",
  replica_healthy: "collaboration.switch.check.replicaHealthy",
  auth_reachable: "collaboration.switch.check.authReachable",
  symmetric_readiness: "collaboration.switch.check.symmetricReadiness",
};

const SWITCH_CODE_LABEL = new Map<string, MessageKey>([
  ["unsupported_trigger_source", "collaboration.switch.code.unsupportedTriggerSource"],
  ["invalid_switchover_identity", "collaboration.switch.code.invalidIdentity"],
  ["target_tls_unreachable", "collaboration.switch.code.tlsUnreachable"],
  ["replica_disconnected", "collaboration.switch.code.replicaDisconnected"],
  ["history_mismatch", "collaboration.switch.code.historyMismatch"],
  ["replica_lag_exceeded", "collaboration.switch.code.replicaLagExceeded"],
  ["insufficient_disk_space", "collaboration.switch.code.insufficientDiskSpace"],
  ["auth_surface_unreachable", "collaboration.switch.code.authUnreachable"],
  ["source_symmetric_identity_missing", "collaboration.switch.code.symmetricIdentityMissing"],
  ["target_candidate_unconfigured", "collaboration.switch.code.candidateUnconfigured"],
  ["target_activation_not_disproven", "collaboration.switch.code.rollbackTargetNotDisproven"],
  ["target_attempt_not_invalidated", "collaboration.switch.code.rollbackTargetNotInvalidated"],
  ["switchover_fence_missing", "collaboration.switch.code.fenceMissing"],
  ["rpo_zero_barrier_unmet", "collaboration.switch.code.rpoZeroBarrierUnmet"],
  ["rpo_zero_catchup_timeout", "collaboration.switch.code.rpoZeroTimeout"],
  ["target_activation_failed", "collaboration.switch.code.targetActivationFailed"],
  ["authorization_denied", "collaboration.switch.code.authorizationDenied"],
  ["gui_read_only", "collaboration.switch.code.readOnly"],
  ["repo_namespace_unknown", "collaboration.switch.code.repoUnknown"],
  ["bridge_unavailable", "collaboration.switch.code.bridgeUnavailable"],
]);

function switchCodeLabel(code: string): string {
  if (code === "sync_failure:target_candidate_unconfigured") {
    return t("collaboration.switch.code.candidateUnconfigured");
  }
  if (code.startsWith("sync_failure:")) return t("collaboration.switch.code.replicaSyncFailure");
  const key = SWITCH_CODE_LABEL.get(code);
  return key === undefined ? t("collaboration.switch.code.unknown") : t(key);
}

function visibleChecksOf(preflight: CenterSwitchPreflightResult): readonly CenterSwitchPreflightCheck[] {
  return preflight.checks.filter((entry) => CORE_PREFLIGHT_CHECKS.has(entry.check) || !entry.passed);
}

function extractFailure(reply: CenterSwitchReply): { readonly code: string; readonly detail: string } {
  if (reply.ok) return { code: "unknown", detail: "" };
  const code = reply.error?.code ?? reply.code;
  const detail = reply.error?.hint ?? reply.rejectionExplanation ?? code;
  return { code, detail };
}

type SwitchState =
  | { readonly step: "idle" }
  | { readonly step: "preflighting" }
  | { readonly step: "preflight_error"; readonly code: string; readonly detail: string }
  | {
      readonly step: "preflight_done";
      readonly preflight: CenterSwitchPreflightResult;
      readonly switchoverId?: string;
    }
  | {
      readonly step: "switching";
      readonly preflight: CenterSwitchPreflightResult;
      readonly switchoverId?: string;
    }
  | {
      readonly step: "succeeded";
      readonly newEpoch: number | null;
      readonly summary: string | null;
    }
  | {
      readonly step: "switch_failed";
      readonly code: string;
      readonly detail: string;
      readonly fencedCeded: boolean;
      readonly switchoverId: string | null;
      readonly rollbackReason: string;
      readonly rollbackError: string | null;
      readonly rollingBack: boolean;
    }
  | {
      readonly step: "rolled_back";
      readonly rollbackEpoch: number | null;
    };

export function CenterSwitchPanel({
  repoId,
  actorPersonId,
  nodeId,
  label,
  canSetCenter,
  requestNonce,
  onActiveChange,
  onCenterSwitch,
  onSwitchCompleted,
}: {
  readonly repoId: string;
  readonly actorPersonId: string | null;
  readonly nodeId: string;
  readonly label: string;
  readonly canSetCenter: boolean;
  readonly requestNonce: number;
  readonly onActiveChange: (active: boolean) => void;
  readonly onCenterSwitch: (input: CenterSwitchInput) => Promise<CenterSwitchReply>;
  readonly onSwitchCompleted?: () => void;
}) {
  const [state, setState] = useState<SwitchState>({ step: "idle" });
  const contextKey = `${repoId}\0${actorPersonId ?? ""}\0${nodeId}`;
  const contextRef = useRef(contextKey);
  const opSeqRef = useRef(0);
  const lastNonceRef = useRef(0);
  const onCenterSwitchRef = useRef(onCenterSwitch);
  const onSwitchCompletedRef = useRef(onSwitchCompleted);
  contextRef.current = contextKey;
  onCenterSwitchRef.current = onCenterSwitch;
  onSwitchCompletedRef.current = onSwitchCompleted;

  const resetToIdle = useCallback(() => {
    opSeqRef.current += 1;
    setState({ step: "idle" });
    onActiveChange(false);
  }, [onActiveChange]);

  useEffect(() => {
    opSeqRef.current += 1;
    lastNonceRef.current = 0;
    setState({ step: "idle" });
    onActiveChange(false);
  }, [contextKey, onActiveChange]);

  useEffect(() => {
    if (!canSetCenter) {
      opSeqRef.current += 1;
      setState({ step: "idle" });
      onActiveChange(false);
    }
  }, [canSetCenter, onActiveChange]);

  const runPreflight = useCallback(() => {
    if (!canSetCenter) return;
    const requestContext = contextKey;
    const targetRepoId = repoId;
    const targetNodeId = nodeId;
    const seq = ++opSeqRef.current;
    onActiveChange(true);
    setState({ step: "preflighting" });
    void onCenterSwitchRef.current({ repoId: targetRepoId, targetNodeId, dryRun: true }).then(
      (reply) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        if (reply.preflight) {
          setState({
            step: "preflight_done",
            preflight: reply.preflight,
            ...(reply.ok && reply.state?.switchoverId ? { switchoverId: reply.state.switchoverId } : {}),
          });
          return;
        }
        if (reply.ok) {
          setState({
            step: "preflight_done",
            preflight: { ok: true, checks: [], blockingCodes: [] },
            ...(reply.state?.switchoverId ? { switchoverId: reply.state.switchoverId } : {}),
          });
          return;
        }
        const failure = extractFailure(reply);
        setState({ step: "preflight_error", code: failure.code, detail: failure.detail });
      },
      (error: unknown) => {
        if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "switch_preflight_failed";
        const detail = error instanceof Error ? error.message : String(error);
        setState({ step: "preflight_error", code, detail });
      },
    );
  }, [canSetCenter, contextKey, nodeId, onActiveChange, repoId]);

  useEffect(() => {
    if (requestNonce > 0 && requestNonce !== lastNonceRef.current) {
      lastNonceRef.current = requestNonce;
      runPreflight();
    }
  }, [requestNonce, runPreflight]);

  const confirmSwitch = () => {
    if (!canSetCenter || state.step !== "preflight_done" || !state.preflight.ok) return;
    const requestContext = contextKey;
    const targetRepoId = repoId;
    const targetNodeId = nodeId;
    const preflight = state.preflight;
    const switchoverId = state.switchoverId;
    const seq = ++opSeqRef.current;
    setState({ step: "switching", preflight, ...(switchoverId ? { switchoverId } : {}) });
    void onCenterSwitchRef
      .current({
        repoId: targetRepoId,
        targetNodeId,
        dryRun: false,
        ...(switchoverId ? { switchoverId } : {}),
      })
      .then(
        (reply) => {
          if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
          if (reply.ok) {
            setState({
              step: "succeeded",
              newEpoch: reply.activation?.newEpoch ?? reply.state?.targetEpoch ?? null,
              summary: reply.summary ?? null,
            });
            onSwitchCompletedRef.current?.();
            return;
          }
          const failure = extractFailure(reply);
          setState({
            step: "switch_failed",
            code: failure.code,
            detail: failure.detail,
            fencedCeded: reply.fencedCeded === true,
            switchoverId: reply.state?.switchoverId ?? switchoverId ?? null,
            rollbackReason: "",
            rollbackError: null,
            rollingBack: false,
          });
        },
        (error: unknown) => {
          if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            typeof (error as { code?: unknown }).code === "string"
              ? (error as { code: string }).code
              : "center_switch_failed";
          setState({
            step: "switch_failed",
            code,
            detail: error instanceof Error ? error.message : String(error),
            fencedCeded: false,
            switchoverId: switchoverId ?? null,
            rollbackReason: "",
            rollbackError: null,
            rollingBack: false,
          });
        },
      );
  };

  const confirmRollback = () => {
    if (!canSetCenter || state.step !== "switch_failed" || !state.fencedCeded) return;
    const switchoverId = state.switchoverId;
    if (!switchoverId) return;
    const reason = state.rollbackReason.trim();
    if (!reason) return;
    const current = state;
    const requestContext = contextKey;
    const seq = ++opSeqRef.current;
    setState({ ...current, rollingBack: true, rollbackError: null });
    void onCenterSwitchRef
      .current({
        repoId,
        abortRollback: true,
        switchoverId,
        reason,
      })
      .then(
        (reply) => {
          if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
          if (reply.ok) {
            setState({
              step: "rolled_back",
              rollbackEpoch: reply.rollback?.rollbackEpoch ?? null,
            });
            onSwitchCompletedRef.current?.();
            return;
          }
          const failure = extractFailure(reply);
          setState({
            ...current,
            rollingBack: false,
            rollbackError: switchCodeLabel(failure.code),
          });
        },
        (error: unknown) => {
          if (opSeqRef.current !== seq || contextRef.current !== requestContext) return;
          setState({
            ...current,
            rollingBack: false,
            rollbackError: error instanceof Error ? error.message : String(error),
          });
        },
      );
  };

  if (state.step === "idle") return null;

  return (
    <div
      data-testid="collaboration-switch-panel"
      className="flex flex-col gap-2.5 rounded border border-border-strong bg-surface-raised/60 p-3 ui-meta"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-text">{t("collaboration.switch.panelTitle", { label })}</span>
        <StepChain
          steps={[
            {
              label: t("collaboration.switch.step.preflight"),
              tone: state.step === "preflighting" ? "active" : state.step === "preflight_error" ? "bad" : "done",
            },
            {
              label: t("collaboration.switch.step.switching"),
              tone:
                state.step === "switching"
                  ? "active"
                  : state.step === "succeeded" || state.step === "rolled_back"
                    ? "done"
                    : state.step === "switch_failed"
                      ? "bad"
                      : "plan",
            },
            {
              label: t("collaboration.switch.step.done"),
              tone: state.step === "succeeded" || state.step === "rolled_back" ? "done" : "plan",
            },
          ]}
        />
      </div>

      {state.step === "preflighting" && (
        <p data-testid="collaboration-switch-preflighting" className="text-text-muted">
          {t("collaboration.switch.preflighting")}
        </p>
      )}

      {state.step === "preflight_error" && (
        <div className="flex flex-col gap-2">
          <Notice tone="bad" testId="collaboration-switch-error">
            <span data-reason={state.code} title={state.detail}>
              {t("collaboration.switch.preflightFailed", { reason: switchCodeLabel(state.code) })}
            </span>
          </Notice>
          <div className="flex items-center gap-2">
            <Button size="sm" testId="collaboration-switch-recheck" onClick={runPreflight}>
              {t("collaboration.switch.recheck")}
            </Button>
            <Button size="sm" variant="ghost" testId="collaboration-switch-cancel" onClick={resetToIdle}>
              {t("collaboration.switch.cancel")}
            </Button>
          </div>
        </div>
      )}

      {(state.step === "preflight_done" || state.step === "switching") && (
        <div className="flex flex-col gap-2">
          <ul
            data-testid="collaboration-switch-checks"
            className="divide-y divide-border rounded border border-border bg-surface"
          >
            {visibleChecksOf(state.preflight).map((check) => {
              const titleKey = PREFLIGHT_CHECK_LABEL[check.check];
              return (
                <li
                  key={check.check}
                  data-testid={`collaboration-switch-check-${check.check}`}
                  data-passed={check.passed ? "true" : "false"}
                  data-reason={check.passed ? undefined : check.code}
                  title={check.passed ? check.detail : `${check.code}: ${check.detail}`}
                  className="flex flex-col gap-0.5 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text">{titleKey ? t(titleKey) : check.check}</span>
                    <StatusTag
                      tone={check.passed ? "done" : "bad"}
                      label={
                        check.passed ? t("collaboration.switch.checkPassed") : t("collaboration.switch.checkBlocked")
                      }
                    />
                  </div>
                  {!check.passed && <span className="ui-micro text-status-blocked">{switchCodeLabel(check.code)}</span>}
                </li>
              );
            })}
          </ul>

          {state.preflight.ok ? (
            <Notice tone="wait" testId="collaboration-switch-confirm-notice">
              {t("collaboration.switch.confirmSummary", { label })}
            </Notice>
          ) : (
            <Notice tone="bad" testId="collaboration-switch-blocked-notice">
              {t("collaboration.switch.blockedSummary")}
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              testId="collaboration-switch-confirm"
              disabled={!state.preflight.ok || state.step === "switching"}
              loading={state.step === "switching"}
              onClick={confirmSwitch}
            >
              {state.step === "switching"
                ? t("collaboration.switch.switching")
                : t("collaboration.switch.confirm", { label })}
            </Button>
            <Button
              size="sm"
              testId="collaboration-switch-recheck"
              disabled={state.step === "switching"}
              onClick={runPreflight}
            >
              {t("collaboration.switch.recheck")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              testId="collaboration-switch-cancel"
              disabled={state.step === "switching"}
              onClick={resetToIdle}
            >
              {t("collaboration.switch.cancel")}
            </Button>
          </div>
        </div>
      )}

      {state.step === "succeeded" && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid="collaboration-switch-succeeded" className="text-status-done">
            {state.newEpoch !== null
              ? t("collaboration.switch.succeededWithEpoch", { label, epoch: state.newEpoch })
              : t("collaboration.switch.succeeded", { label })}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" testId="collaboration-switch-close" onClick={resetToIdle}>
              {t("collaboration.close")}
            </Button>
          </div>
        </div>
      )}

      {state.step === "switch_failed" && (
        <div className="flex flex-col gap-2">
          <Notice tone="bad" testId="collaboration-switch-error">
            <span data-reason={state.code} title={state.detail}>
              {t("collaboration.switch.failed", { reason: switchCodeLabel(state.code) })}
            </span>
          </Notice>
          {state.fencedCeded && state.switchoverId ? (
            <div
              data-testid="collaboration-switch-rollback-panel"
              className="flex flex-col gap-2 rounded border border-status-blocked/40 bg-status-blocked/5 p-2.5"
            >
              <p className="ui-micro text-status-blocked">{t("collaboration.switch.fencedCededNotice")}</p>
              <input
                type="text"
                data-testid="collaboration-switch-rollback-reason"
                aria-label={t("collaboration.switch.rollbackReasonLabel")}
                placeholder={t("collaboration.switch.rollbackReasonPlaceholder")}
                value={state.rollbackReason}
                onChange={(event) =>
                  setState((prev) =>
                    prev.step === "switch_failed" ? { ...prev, rollbackReason: event.target.value } : prev,
                  )
                }
                className="rounded border border-border bg-surface px-2 py-1 ui-micro text-text"
              />
              {state.rollbackError && (
                <p role="alert" className="ui-micro text-status-blocked">
                  {state.rollbackError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  testId="collaboration-switch-rollback-confirm"
                  disabled={state.rollbackReason.trim() === "" || state.rollingBack}
                  loading={state.rollingBack}
                  onClick={confirmRollback}
                >
                  {t("collaboration.switch.rollbackConfirm")}
                </Button>
                <Button size="sm" variant="ghost" testId="collaboration-switch-cancel" onClick={resetToIdle}>
                  {t("collaboration.switch.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" testId="collaboration-switch-recheck" onClick={runPreflight}>
                {t("collaboration.switch.recheck")}
              </Button>
              <Button size="sm" variant="ghost" testId="collaboration-switch-cancel" onClick={resetToIdle}>
                {t("collaboration.switch.cancel")}
              </Button>
            </div>
          )}
        </div>
      )}

      {state.step === "rolled_back" && (
        <div className="flex flex-col gap-2">
          <p role="status" data-testid="collaboration-switch-rolled-back" className="text-status-done">
            {state.rollbackEpoch !== null
              ? t("collaboration.switch.rolledBackWithEpoch", { epoch: state.rollbackEpoch })
              : t("collaboration.switch.rolledBack")}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" testId="collaboration-switch-close" onClick={resetToIdle}>
              {t("collaboration.close")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
