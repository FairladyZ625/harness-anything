import { createHash } from "node:crypto";
import { runProcessText } from "./process-port.ts";

export type LocalTerminalBackend = "direct-pty" | "tmux";
export type LocalTerminalDurability = "daemon-process" | "daemon-restart";
export type TerminalBackendWarningCode = "tmux-unavailable";

export interface TmuxProbe {
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly reason?: string;
}

export interface TmuxController {
  readonly probe: () => TmuxProbe;
  readonly hasSession: (executable: string, namespace: string) => boolean;
  readonly killSession: (executable: string, namespace: string) => void;
}

export interface LocalTerminalBackendSelection {
  readonly requestedBackend: LocalTerminalBackend;
  readonly backend: LocalTerminalBackend;
  readonly durability: LocalTerminalDurability;
  readonly warning: TerminalBackendWarningCode | null;
}

export const systemTmuxController: TmuxController = {
  probe: () => {
    try {
      return { available: true, executable: "tmux", version: runProcessText("tmux", ["-V"]).trim() };
    } catch {
      return { available: false, reason: "tmux capability probe failed" };
    }
  },
  hasSession: (executable, namespace) => {
    try {
      runProcessText(executable, ["has-session", "-t", namespace]);
      return true;
    } catch {
      return false;
    }
  },
  killSession: (executable, namespace) => {
    try {
      runProcessText(executable, ["kill-session", "-t", namespace]);
    } catch (cause) {
      throw new Error("tmux session is unavailable", { cause });
    }
  },
};

export function selectLocalTerminalBackend(
  requestedBackend: LocalTerminalBackend,
  probe: TmuxProbe,
): LocalTerminalBackendSelection {
  if (requestedBackend === "direct-pty")
    return { requestedBackend, backend: "direct-pty", durability: "daemon-process", warning: null };
  if (probe.available && probe.executable)
    return { requestedBackend, backend: "tmux", durability: "daemon-restart", warning: null };
  return { requestedBackend, backend: "direct-pty", durability: "daemon-process", warning: "tmux-unavailable" };
}

export function terminalTmuxNamespace(repoId: string, sessionId: string): string {
  const digest = createHash("sha256").update(`${repoId}\0${sessionId}`).digest("hex").slice(0, 16);
  return `ha-${digest}-${sessionId.replaceAll(/[^A-Za-z0-9_-]/gu, "-").slice(-24)}`;
}
