export interface TerminalTab {
  readonly sessionId: string;
  readonly name: string;
  readonly state: "running" | "exited" | "unknown";
  readonly daemonGeneration: number;
  readonly attachmentId: string | null;
  readonly lastSeq: number;
  readonly output: string;
  readonly notice: string | null;
  readonly cwd: string;
  readonly requestedBackend: "direct-pty" | "tmux";
  readonly backend: "direct-pty" | "tmux";
  readonly durability: "daemon-process" | "daemon-restart";
  readonly warning: "tmux-unavailable" | null;
  readonly attachable: boolean;
}
export interface TerminalStreamFrame { readonly schema: "terminal-attach-event/v1"; readonly sessionId: string; readonly seq: number; readonly kind: "output" | "gap" | "exit"; readonly utf8: string; readonly droppedThrough: number | null; readonly occurredAt: string }

export function mostRecentAttachableTerminal<
  T extends { readonly status: string; readonly attachable: boolean }
>(sessions: readonly T[]): T | null {
  return [...sessions].reverse().find((session) => session.status === "running" && session.attachable) ?? null;
}

export function reduceTerminalStream(tab: TerminalTab, frame: TerminalStreamFrame): TerminalTab {
  if (frame.sessionId !== tab.sessionId || frame.seq <= tab.lastSeq) return tab;
  const skipped = frame.seq > tab.lastSeq + 1 ? `Output sequence gap ${tab.lastSeq + 1}..${frame.seq - 1}; reload or reattach before trusting this transcript.` : null;
  if (frame.kind === "gap")
    return {
      ...tab,
      lastSeq: frame.seq,
      notice:
        `Daemon backpressure dropped output through sequence ${frame.droppedThrough ?? "unknown"}; ` +
        "reattach for bounded replay.",
    };
  if (frame.kind === "exit") return { ...tab, state: "exited", lastSeq: frame.seq, notice: skipped ?? "Process exited; this tab is read-only." };
  const output = `${tab.output}${frame.utf8}`; return { ...tab, lastSeq: frame.seq, output: output.slice(-131_072), notice: skipped ?? tab.notice };
}

export function reconcileTerminalGeneration(tabs: readonly TerminalTab[], daemonGeneration: number): readonly TerminalTab[] {
  return tabs.map((tab) =>
    tab.daemonGeneration === daemonGeneration || tab.state === "exited"
      ? tab
      : tab.durability === "daemon-restart"
        ? { ...tab, daemonGeneration, attachmentId: null }
        : {
            ...tab,
            daemonGeneration,
            state: "unknown",
            attachmentId: null,
            attachable: false,
            notice:
              "Daemon generation changed. This direct PTY is not durable; try reattaching only if it appears " +
              "in the new session list, otherwise start a new session.",
          },
  );
}

export async function closeTerminalTab(repoId: string, tab: TerminalTab, deps: { readonly stopStream: () => void; readonly detach: (repoId: string, sessionId: string, attachmentId: string) => Promise<unknown> }): Promise<void> {
  try { if (tab.attachmentId) await deps.detach(repoId, tab.sessionId, tab.attachmentId); }
  finally { deps.stopStream(); }
}

export async function requestTerminalTermination(repoId: string, tab: TerminalTab, confirmed: boolean, deps: { readonly terminate: (repoId: string, sessionId: string, confirmed: true) => Promise<unknown> }): Promise<{ readonly state: "confirmation_required" | "requested" }> {
  if (!confirmed) return { state: "confirmation_required" };
  await deps.terminate(repoId, tab.sessionId, true); return { state: "requested" };
}
