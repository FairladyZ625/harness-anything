import { ArrowClockwise, LinkSimple, Plugs, Skull, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import {
  TERMINATE_TERMINAL_SESSION_CONFIRMATION,
  type TerminalSessionInfo
} from "../../terminal-api-client.ts";
import {
  errorMessage,
  formatTerminalSessionMeta,
  terminalDegradationSummary,
  terminalSessionIsAttachable
} from "./terminal-display.ts";

export interface TerminalSessionManagerProps {
  readonly open: boolean;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onAttach: (session: TerminalSessionInfo) => void;
  readonly onSpawn: () => void;
  /** Increment to force a refresh (e.g. after detach/terminate from parent). */
  readonly refreshEpoch?: number;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly sessions: ReadonlyArray<TerminalSessionInfo> }
  | { readonly kind: "error"; readonly error: string };

type ConfirmState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirm-terminate"; readonly session: TerminalSessionInfo };

export function TerminalSessionManager({
  open,
  projectId,
  onClose,
  onAttach,
  onSpawn,
  refreshEpoch = 0
}: TerminalSessionManagerProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "idle" });
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    setActionError(null);
    try {
      const sessions = await harnessClient.listTerminals();
      // Prefer project-scoped sessions first, then the rest for attach visibility.
      const scoped = sessions
        .filter((session) => !session.projectId || session.projectId === projectId)
        .concat(sessions.filter((session) => session.projectId && session.projectId !== projectId));
      const seen = new Set<string>();
      const ordered = scoped.filter((session) => {
        if (seen.has(session.sessionId)) return false;
        seen.add(session.sessionId);
        return true;
      });
      setLoad({ kind: "ready", sessions: ordered });
    } catch (error) {
      setLoad({ kind: "error", error: errorMessage(error) });
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) {
      setConfirm({ kind: "idle" });
      return;
    }
    void refresh();
  }, [open, refresh, refreshEpoch]);

  if (!open) return null;

  const terminateSession = async (session: TerminalSessionInfo) => {
    setBusySessionId(session.sessionId);
    setActionError(null);
    try {
      await harnessClient.terminateTerminal({
        sessionId: session.sessionId,
        confirmation: TERMINATE_TERMINAL_SESSION_CONFIRMATION
      });
      setConfirm({ kind: "idle" });
      await refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusySessionId(null);
    }
  };

  return (
    <div
      className="absolute inset-x-0 bottom-9 z-20 mx-2 mb-1 max-h-64 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
      role="dialog"
      aria-label={t("terminal.manager.title")}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border px-2">
        <span className="text-xs font-medium text-text">{t("terminal.manager.title")}</span>
        <span className="font-mono text-[10px] text-text-faint">{t("terminal.manager.subtitle")}</span>
        <button
          type="button"
          className="ml-auto grid size-6 place-items-center rounded text-text-faint hover:bg-surface hover:text-text"
          aria-label={t("terminal.manager.refresh")}
          title={t("terminal.manager.refresh")}
          onClick={() => void refresh()}
        >
          <ArrowClockwise size={13} />
        </button>
        <button
          type="button"
          className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface hover:text-text"
          aria-label={t("terminal.manager.close")}
          title={t("terminal.manager.close")}
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto p-2">
        <button
          type="button"
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-xs text-text-muted hover:border-accent hover:bg-surface hover:text-text"
          onClick={onSpawn}
        >
          <Plugs size={14} />
          <span>{t("terminal.manager.spawnNew")}</span>
        </button>

        {load.kind === "loading" && (
          <p className="px-1 py-3 text-center font-mono text-[11px] text-text-faint">
            {t("terminal.manager.loading")}
          </p>
        )}
        {load.kind === "error" && (
          <p className="px-1 py-3 text-center text-[11px] text-danger">
            {t("terminal.manager.loadFailed", { error: load.error })}
          </p>
        )}
        {load.kind === "ready" && load.sessions.length === 0 && (
          <p className="px-1 py-3 text-center font-mono text-[11px] text-text-faint">
            {t("terminal.manager.empty")}
          </p>
        )}
        {load.kind === "ready" && load.sessions.map((session) => {
          const attachable = terminalSessionIsAttachable(session);
          const degradation = terminalDegradationSummary(session);
          const busy = busySessionId === session.sessionId;
          return (
            <div
              key={session.sessionId}
              className="mb-1.5 rounded-md border border-border bg-surface px-2 py-1.5 last:mb-0"
              data-session-id={session.sessionId}
              data-attachable={attachable ? "true" : "false"}
              data-status={session.status}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-text" title={session.name}>
                    {session.name}
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-[10px] text-text-faint"
                    title={formatTerminalSessionMeta(session)}
                  >
                    {formatTerminalSessionMeta(session)}
                    {session.exitCode !== undefined ? ` · exit ${session.exitCode}` : ""}
                  </div>
                  {degradation && (
                    <div className="mt-1 text-[10px] text-stale" title={degradation}>
                      {session.degraded ? t("terminal.manager.degraded") : t("terminal.manager.nonDurable")}: {degradation}
                    </div>
                  )}
                  {!attachable && session.status === "unknown" && (
                    <div className="mt-1 text-[10px] text-text-faint">{t("terminal.manager.statusUnknown")}</div>
                  )}
                  {!attachable && session.status === "exited" && (
                    <div className="mt-1 text-[10px] text-text-faint">{t("terminal.manager.statusExited")}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10px] text-text-muted hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!attachable || busy}
                    title={attachable ? t("terminal.manager.attach") : t("terminal.manager.notAttachable")}
                    onClick={() => onAttach(session)}
                  >
                    <LinkSimple size={12} />
                    {t("terminal.manager.attach")}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 rounded border border-danger/40 px-1.5 text-[10px] text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={busy || session.status === "exited"}
                    title={t("terminal.manager.terminate")}
                    onClick={() => setConfirm({ kind: "confirm-terminate", session })}
                  >
                    <Skull size={12} />
                    {t("terminal.manager.terminate")}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {actionError && (
        <div className="border-t border-border px-2 py-1.5 text-[11px] text-danger">{actionError}</div>
      )}

      {confirm.kind === "confirm-terminate" && (
        <div className="border-t border-border bg-surface px-3 py-2">
          <p className="text-[12px] text-text">
            {t("terminal.manager.terminateConfirm", { name: confirm.session.name })}
          </p>
          <p className="mt-1 font-mono text-[10px] text-text-faint">
            {t("terminal.manager.terminateConfirmHint")}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-surface-raised"
              onClick={() => setConfirm({ kind: "idle" })}
            >
              {t("terminal.manager.cancel")}
            </button>
            <button
              type="button"
              className="rounded border border-danger/50 bg-danger/15 px-2 py-1 text-[11px] text-danger hover:bg-danger/25 disabled:opacity-40"
              disabled={busySessionId === confirm.session.sessionId}
              onClick={() => void terminateSession(confirm.session)}
            >
              {t("terminal.manager.terminateConfirmAction")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
