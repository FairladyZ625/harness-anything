import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import type { TerminalSessionInfo } from "../../terminal-api-client.ts";
import {
  errorMessage,
  safeTerminalText,
  terminalDegradationSummary,
  terminalBackendLabel,
  terminalDurabilityLabel,
  terminalStatusLabel
} from "./terminal-display.ts";

export interface TerminalPaneProps {
  readonly projectId: string;
  /** When set, attach an existing backend session instead of creating one. */
  readonly attachSessionId?: string;
  readonly title?: string;
  readonly onSessionReady?: (session: TerminalSessionInfo) => void;
  readonly onSessionEnded?: (session: TerminalSessionInfo) => void;
}

type TerminalPaneState =
  | { readonly kind: "connecting" }
  | {
      readonly kind: "active";
      readonly cwd: string;
      readonly session: TerminalSessionInfo;
    }
  | {
      readonly kind: "exited";
      readonly cwd: string;
      readonly exitCode: number;
      readonly session?: TerminalSessionInfo;
    }
  | { readonly kind: "error"; readonly error: string };

export function TerminalPane({
  projectId,
  attachSessionId,
  title,
  onSessionReady,
  onSessionEnded
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalPaneState>({ kind: "connecting" });
  const onSessionReadyRef = useRef(onSessionReady);
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionReadyRef.current = onSessionReady;
  onSessionEndedRef.current = onSessionEnded;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#1d1d20",
        foreground: "#e8e7ea",
        cursor: "#74d4dd",
        selectionBackground: "#365d69"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    let disposed = false;
    let sessionId: string | undefined;
    let cursor = 0;
    let resizeFrame: number | undefined;
    let lastColumns = 0;
    let lastRows = 0;
    let latestSession: TerminalSessionInfo | undefined;

    const fitAndResize = () => {
      if (disposed || !container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (!sessionId || (terminal.cols === lastColumns && terminal.rows === lastRows)) return;
      lastColumns = terminal.cols;
      lastRows = terminal.rows;
      void harnessClient.resizeTerminal({ sessionId, columns: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    };
    const scheduleFit = () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        fitAndResize();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);
    scheduleFit();

    const inputDisposable = terminal.onData((data) => {
      if (!sessionId || disposed) return;
      void harnessClient.writeTerminal({ sessionId, data }).catch((error: unknown) => {
        if (!disposed) terminal.writeln(`\r\n${safeTerminalText(errorMessage(error))}`);
      });
    });

    const start = async () => {
      try {
        let session: TerminalSessionInfo;
        if (attachSessionId) {
          const attached = await harnessClient.attachTerminal({ sessionId: attachSessionId });
          session = attached.session;
        } else {
          session = await harnessClient.createTerminal({
            name: title ?? t("terminal.dock.title"),
            projectId
          });
        }
        if (disposed) {
          // Pane closed before connect finished — detach only, keep backend alive.
          await harnessClient.detachTerminal({ sessionId: session.sessionId }).catch(() => undefined);
          return;
        }
        sessionId = session.sessionId;
        latestSession = session;
        const cwd = session.cwd ?? "";
        setState({ kind: "active", cwd, session });
        onSessionReadyRef.current?.(session);
        scheduleFit();
        terminal.focus();

        while (!disposed && sessionId) {
          const output = await harnessClient.readTerminal({ sessionId, cursor, timeoutMs: 500 });
          if (disposed) return;
          latestSession = output.session;
          if (output.dropped) terminal.writeln(`\r\n${t("terminal.pane.outputDropped")}\r\n`);
          for (const event of output.events) {
            if (event.kind === "data") {
              terminal.write(event.data);
              continue;
            }
            terminal.writeln(`\r\n${t("terminal.pane.exited", { code: event.exitCode })}`);
            setState({ kind: "exited", cwd, exitCode: event.exitCode, session: output.session });
            onSessionEndedRef.current?.(output.session);
            return;
          }
          // Reflect idle/active/unknown status updates without inventing liveness.
          if (output.session.status !== "active") {
            setState((prev) => {
              if (prev.kind !== "active") return prev;
              return { ...prev, session: output.session };
            });
          } else {
            setState((prev) => {
              if (prev.kind !== "active") return prev;
              return { ...prev, session: output.session, cwd: output.session.cwd ?? prev.cwd };
            });
          }
          cursor = output.nextCursor;
        }
      } catch (error) {
        if (disposed) return;
        const message = errorMessage(error);
        setState({ kind: "error", error: message });
        terminal.writeln(`\r\n${safeTerminalText(t("terminal.pane.connectionFailed", { error: message }))}`);
      }
    };

    void start();
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      terminal.dispose();
      // Hard constraint: pane close/unmount always detaches; never exit/terminate.
      if (sessionId) {
        void harnessClient.detachTerminal({ sessionId }).catch(() => undefined);
        if (latestSession) onSessionEndedRef.current?.(latestSession);
      }
    };
  }, [projectId, attachSessionId, title]);

  const degradation =
    state.kind === "active" || state.kind === "exited"
      ? state.session
        ? terminalDegradationSummary(state.session)
        : undefined
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1d1d20]">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-white/10 px-3 font-mono text-[11px] text-white/55">
        {state.kind === "connecting" && t("terminal.pane.connecting")}
        {(state.kind === "active" || state.kind === "exited") && (
          <>
            <span className="truncate" title={t("terminal.pane.cwd", { cwd: state.cwd })}>
              {state.cwd || t("terminal.pane.noCwd")}
            </span>
            {state.session && (
              <span
                className="ml-auto shrink-0 truncate text-white/40"
                title={[
                  terminalBackendLabel(state.session.backend),
                  terminalStatusLabel(state.session.status),
                  terminalDurabilityLabel(state.session.durability),
                  degradation
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {terminalBackendLabel(state.session.backend)}
                {" · "}
                {terminalStatusLabel(state.session.status)}
                {state.session.degraded ? ` · ${t("terminal.pane.degraded")}` : ""}
                {state.session.durability === "none" ? ` · ${t("terminal.pane.nonDurable")}` : ""}
              </span>
            )}
          </>
        )}
        {state.kind === "error" && t("terminal.pane.connectionFailed", { error: state.error })}
      </div>
      {degradation && state.kind === "active" && (
        <div className="shrink-0 border-b border-white/10 bg-amber-950/40 px-3 py-1 text-[10px] text-amber-200/90" title={degradation}>
          {degradation}
        </div>
      )}
      <div
        ref={containerRef}
        className="terminal-xterm min-h-0 flex-1 px-2 py-1"
        aria-label={title ?? t("terminal.dock.title")}
      />
    </div>
  );
}
