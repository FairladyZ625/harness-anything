import { useCallback, useEffect, useRef, useState } from "react";
import { t, type MessageKey } from "../../i18n/index.tsx";
import type {
  CenterSettingsReply,
  EdgeLocalState,
  PromoteFromEdgeInput,
  PromoteFromEdgeReply,
} from "../../../api/center-settings-contract.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { Notice } from "../../components/primitives/Notice.tsx";
import { Section } from "../../components/primitives/Section.tsx";
import { StatusTag } from "../../components/primitives/StatusTag.tsx";

const OFFLINE_ERROR_PATTERNS = [
  "replica_unavailable",
  "center_moved",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "ehostunreach",
  "fleet center unavailable",
  "daemon_unavailable",
] as const;

export function offlineDisconnectCodeOf(overviewError: string | null): string | null {
  if (overviewError === null) return null;
  const lowered = overviewError.toLowerCase();
  return OFFLINE_ERROR_PATTERNS.find((token) => lowered.includes(token)) ?? null;
}

const DISCONNECT_REASON_LABEL: Readonly<Record<string, MessageKey>> = {
  replica_unavailable: "collaboration.offline.reason.replicaUnavailable",
  CENTER_MOVED: "collaboration.offline.reason.centerMoved",
  center_moved: "collaboration.offline.reason.centerMoved",
  fleet_edge_config_missing: "collaboration.offline.reason.configMissing",
  fleet_edge_config_invalid: "collaboration.offline.reason.configInvalid",
  replica_health_unreadable: "collaboration.offline.reason.healthUnreadable",
  repo_canonical_root_missing: "collaboration.offline.reason.rootMissing",
  edge_daemon_running: "collaboration.offline.reason.edgeDaemonRunning",
  missing_confirmation: "collaboration.offline.reason.missingConfirmation",
  authorization_denied: "collaboration.offline.reason.authorizationDenied",
  gui_read_only: "collaboration.offline.reason.readOnly",
};

function disconnectReasonText(code: string | null): string {
  if (!code) return t("collaboration.offline.reason.centerUnreachable");
  const key = DISCONNECT_REASON_LABEL[code] ?? DISCONNECT_REASON_LABEL[code.toLowerCase()];
  if (key !== undefined) return t(key);
  const lowered = code.toLowerCase();
  if (lowered.includes("center_moved")) return t("collaboration.offline.reason.centerMoved");
  if (lowered.includes("replica_unavailable") || lowered.includes("econn") || lowered.includes("etimedout")) {
    return t("collaboration.offline.reason.replicaUnavailable");
  }
  return t("collaboration.offline.reason.centerUnreachable");
}

type LocalReadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly code: string; readonly detail: string }
  | { readonly kind: "ready"; readonly data: EdgeLocalState };

type PromoteState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "succeeded"; readonly newEpoch: number; readonly nextAction: string | null }
  | { readonly kind: "error"; readonly code: string; readonly detail: string };

export function OfflineBreakGlassPanel({
  repoId,
  overviewError,
  onReadEdgeLocalState,
  onPromoteFromEdge,
  onPromoted,
}: {
  readonly repoId: string;
  readonly overviewError: string | null;
  readonly onReadEdgeLocalState: (repoId: string) => Promise<CenterSettingsReply<EdgeLocalState>>;
  readonly onPromoteFromEdge?: (input: PromoteFromEdgeInput) => Promise<PromoteFromEdgeReply>;
  readonly onPromoted?: () => void;
}) {
  const [readState, setReadState] = useState<LocalReadState>({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [confirmTailLoss, setConfirmTailLoss] = useState(false);
  const [confirmNewEpoch, setConfirmNewEpoch] = useState(false);
  const [promoteState, setPromoteState] = useState<PromoteState>({ kind: "idle" });

  const contextRef = useRef(repoId);
  const readSeqRef = useRef(0);
  const promoteSeqRef = useRef(0);
  contextRef.current = repoId;

  const loadLocalState = useCallback(() => {
    const targetRepoId = repoId;
    const seq = ++readSeqRef.current;
    setReadState({ kind: "loading" });
    void onReadEdgeLocalState(targetRepoId).then(
      (reply) => {
        if (readSeqRef.current !== seq || contextRef.current !== targetRepoId) return;
        if (reply.ok) {
          setReadState({ kind: "ready", data: reply });
          return;
        }
        setReadState({
          kind: "error",
          code: reply.code,
          detail: reply.rejectionExplanation ?? reply.code,
        });
      },
      (error: unknown) => {
        if (readSeqRef.current !== seq || contextRef.current !== targetRepoId) return;
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "edge_local_state_failed";
        setReadState({
          kind: "error",
          code,
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [onReadEdgeLocalState, repoId]);

  useEffect(() => {
    promoteSeqRef.current += 1;
    setExpanded(false);
    setConfirmTailLoss(false);
    setConfirmNewEpoch(false);
    setPromoteState({ kind: "idle" });
    loadLocalState();
  }, [loadLocalState, repoId]);

  const submitPromote = () => {
    if (!onPromoteFromEdge || !confirmTailLoss || !confirmNewEpoch || promoteState.kind === "submitting") return;
    if (readState.kind !== "ready" || !readState.data.canPromote) return;
    const targetRepoId = repoId;
    const seq = ++promoteSeqRef.current;
    setPromoteState({ kind: "submitting" });
    void onPromoteFromEdge({
      repoId: targetRepoId,
      forceNewEpoch: true,
      confirmPossibleTailLoss: true,
    }).then(
      (reply) => {
        if (promoteSeqRef.current !== seq || contextRef.current !== targetRepoId) return;
        if (reply.ok) {
          setPromoteState({
            kind: "succeeded",
            newEpoch: reply.newEpoch,
            nextAction: reply.nextAction ?? null,
          });
          onPromoted?.();
          return;
        }
        const code = reply.error?.code ?? reply.code;
        const detail = reply.error?.hint ?? reply.rejectionExplanation ?? code;
        setPromoteState({ kind: "error", code, detail });
      },
      (error: unknown) => {
        if (promoteSeqRef.current !== seq || contextRef.current !== targetRepoId) return;
        const code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "promote_from_edge_failed";
        setPromoteState({
          kind: "error",
          code,
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  const primaryDisconnectCode =
    readState.kind === "ready" ? (readState.data.syncFailureCode ?? overviewError) : overviewError;

  return (
    <Section
      title={t("collaboration.offline.title")}
      note={t("collaboration.offline.note")}
      variant="panel"
      action={
        <Button
          size="sm"
          testId="collaboration-edge-local-refresh"
          loading={readState.kind === "loading"}
          onClick={loadLocalState}
        >
          {t("collaboration.offline.refresh")}
        </Button>
      }
    >
      <div data-testid="collaboration-offline-break-glass" className="flex flex-col gap-3 px-3 py-3 ui-meta">
        {readState.kind === "loading" ? (
          <p data-testid="collaboration-edge-local-loading" className="text-text-muted">
            {t("collaboration.offline.loading")}
          </p>
        ) : readState.kind === "error" ? (
          <Notice tone="bad" testId="collaboration-edge-local-error">
            <span data-reason={readState.code} title={readState.detail}>
              {t("collaboration.offline.readFailed", { reason: disconnectReasonText(readState.code) })}
            </span>
          </Notice>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <LocalField
                testId="collaboration-edge-local-node"
                label={t("collaboration.offline.fieldNode")}
                value={readState.data.nodeId ?? t("collaboration.notProvided")}
              />
              <LocalField
                testId="collaboration-edge-local-center"
                label={t("collaboration.offline.fieldCenter")}
                value={
                  readState.data.configuredCenter
                    ? `${readState.data.configuredCenter.host}:${readState.data.configuredCenter.port}`
                    : t("collaboration.notProvided")
                }
              />
              <LocalField
                testId="collaboration-edge-local-watermark"
                label={t("collaboration.offline.fieldWatermark")}
                value={t("collaboration.offline.watermarkValue", {
                  rev: readState.data.localRevision ?? "—",
                  seq: readState.data.localSequence ?? "—",
                  epoch: readState.data.writerEpoch ?? "—",
                })}
              />
              <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
                <dt className="shrink-0 text-text-faint">{t("collaboration.offline.fieldReason")}</dt>
                <dd
                  data-testid="collaboration-edge-local-reason"
                  data-reason={primaryDisconnectCode ?? undefined}
                  title={primaryDisconnectCode ?? undefined}
                  className="min-w-0 break-words text-right text-status-blocked"
                >
                  {disconnectReasonText(primaryDisconnectCode)}
                </dd>
              </div>
            </dl>

            <div className="border-t border-border pt-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StatusTag
                    tone={readState.data.canPromote ? "wait" : "neutral"}
                    label={
                      readState.data.canPromote
                        ? t("collaboration.offline.promotableBadge")
                        : t("collaboration.offline.notPromotableBadge")
                    }
                  />
                  {!readState.data.canPromote && (
                    <span className="ui-micro text-text-muted">{t("collaboration.offline.cannotPromoteHint")}</span>
                  )}
                </div>
                {readState.data.canPromote && onPromoteFromEdge && (
                  <Button
                    size="sm"
                    variant="danger"
                    testId="collaboration-break-glass-toggle"
                    onClick={() => setExpanded((prev) => !prev)}
                  >
                    {expanded ? t("collaboration.offline.hideBreakGlass") : t("collaboration.offline.openBreakGlass")}
                  </Button>
                )}
              </div>

              {expanded && readState.data.canPromote && onPromoteFromEdge && (
                <div
                  data-testid="collaboration-break-glass-form"
                  className="mt-3 flex flex-col gap-2.5 rounded border border-status-blocked/45 bg-status-blocked/5 p-3"
                >
                  <Notice tone="bad" testId="collaboration-break-glass-warning">
                    {t("collaboration.offline.breakGlassWarning")}
                  </Notice>
                  <label className="flex items-start gap-2 ui-micro text-text">
                    <input
                      type="checkbox"
                      data-testid="collaboration-break-glass-confirm-tail-loss"
                      checked={confirmTailLoss}
                      disabled={promoteState.kind === "submitting" || promoteState.kind === "succeeded"}
                      onChange={(event) => setConfirmTailLoss(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t("collaboration.offline.confirmTailLoss")}</span>
                  </label>
                  <label className="flex items-start gap-2 ui-micro text-text">
                    <input
                      type="checkbox"
                      data-testid="collaboration-break-glass-confirm-new-epoch"
                      checked={confirmNewEpoch}
                      disabled={promoteState.kind === "submitting" || promoteState.kind === "succeeded"}
                      onChange={(event) => setConfirmNewEpoch(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t("collaboration.offline.confirmNewEpoch")}</span>
                  </label>

                  {promoteState.kind === "error" && (
                    <Notice tone="bad" testId="collaboration-break-glass-error">
                      <span data-reason={promoteState.code} title={promoteState.detail}>
                        {t("collaboration.offline.promoteFailed", {
                          reason: disconnectReasonText(promoteState.code),
                        })}
                      </span>
                    </Notice>
                  )}

                  {promoteState.kind === "succeeded" ? (
                    <p role="status" data-testid="collaboration-break-glass-succeeded" className="text-status-done">
                      {t("collaboration.offline.promoteSucceeded", { epoch: promoteState.newEpoch })}
                      {promoteState.nextAction ? ` ${promoteState.nextAction}` : ""}
                    </p>
                  ) : (
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="danger"
                        testId="collaboration-break-glass-submit"
                        disabled={!confirmTailLoss || !confirmNewEpoch || promoteState.kind === "submitting"}
                        loading={promoteState.kind === "submitting"}
                        onClick={submitPromote}
                      >
                        {promoteState.kind === "submitting"
                          ? t("collaboration.offline.promoting")
                          : t("collaboration.offline.confirmPromote")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function LocalField({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
      <dt className="shrink-0 text-text-faint">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-all text-right font-mono text-text-muted">
        {value}
      </dd>
    </div>
  );
}
