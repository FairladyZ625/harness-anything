import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { harnessClient } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";

export interface TerminalPaneProps {
  readonly projectId: string;
}

type TerminalPaneState =
  | { readonly kind: "connecting" }
  | { readonly kind: "active"; readonly cwd: string }
  | { readonly kind: "exited"; readonly cwd: string; readonly exitCode: number }
  | { readonly kind: "error"; readonly error: string };

export function TerminalPane({ projectId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalPaneState>({ kind: "connecting" });

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
        const session = await harnessClient.createTerminal({
          name: t("terminal.dock.title"),
          backend: "direct-pty",
          projectId
        });
        if (disposed) {
          await harnessClient.exitTerminal({ sessionId: session.sessionId }).catch(() => undefined);
          return;
        }
        sessionId = session.sessionId;
        const cwd = session.cwd ?? "";
        setState({ kind: "active", cwd });
        scheduleFit();
        terminal.focus();

        while (!disposed && sessionId) {
          const output = await harnessClient.readTerminal({ sessionId, cursor, timeoutMs: 500 });
          if (disposed) return;
          if (output.dropped) terminal.writeln(`\r\n${t("terminal.pane.outputDropped")}\r\n`);
          for (const event of output.events) {
            if (event.kind === "data") {
              terminal.write(event.data);
              continue;
            }
            terminal.writeln(`\r\n${t("terminal.pane.exited", { code: event.exitCode })}`);
            setState({ kind: "exited", cwd, exitCode: event.exitCode });
            return;
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
      if (sessionId) void harnessClient.exitTerminal({ sessionId }).catch(() => undefined);
    };
  }, [projectId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1d1d20]">
      <div className="flex h-7 shrink-0 items-center border-b border-white/10 px-3 font-mono text-[11px] text-white/55">
        {state.kind === "connecting" && t("terminal.pane.connecting")}
        {(state.kind === "active" || state.kind === "exited") && (
          <span className="truncate" title={t("terminal.pane.cwd", { cwd: state.cwd })}>
            {state.cwd}
          </span>
        )}
        {state.kind === "error" && t("terminal.pane.connectionFailed", { error: state.error })}
      </div>
      <div ref={containerRef} className="terminal-xterm min-h-0 flex-1 px-2 py-1" aria-label={t("terminal.dock.title")} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
