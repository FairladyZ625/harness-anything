/**
 * Pure display helpers for session list/status labels in the GUI terminal UI.
 * No React, no bridge calls — safe to unit-test and reuse across dock/manager/pane.
 */

import type {
  TerminalBackend,
  TerminalSessionDurability,
  TerminalSessionInfo,
  TerminalSessionStatus
} from "../../terminal-api-client.ts";

export function terminalBackendLabel(backend: TerminalBackend): string {
  switch (backend) {
    case "tmux":
      return "tmux";
    case "remote":
      return "remote";
    case "direct-pty":
    default:
      return "direct-pty";
  }
}

export function terminalStatusLabel(status: TerminalSessionStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "exited":
      return "exited";
    case "unknown":
    default:
      return "unknown";
  }
}

export function terminalDurabilityLabel(durability: TerminalSessionDurability): string {
  switch (durability) {
    case "daemon-restart":
      return "daemon-restart";
    case "remote-owned":
      return "remote-owned";
    case "none":
    default:
      return "none";
  }
}

/** Prefer backendWarnings[].hint; fall back to a durability/degraded summary. */
export function terminalDegradationSummary(session: Pick<
  TerminalSessionInfo,
  "backend" | "durability" | "degraded" | "backendWarnings"
>): string | undefined {
  const warnings = session.backendWarnings ?? [];
  if (warnings.length > 0) {
    return warnings.map((warning) => warning.hint).filter((hint) => hint.length > 0).join(" · ");
  }
  if (session.degraded || session.durability === "none") {
    if (session.backend === "direct-pty" && session.durability === "none") {
      return "direct-pty is non-durable; session will not survive daemon restart.";
    }
    if (session.degraded) return "Session is running in a degraded backend mode.";
  }
  return undefined;
}

export function terminalSessionIsAttachable(session: Pick<TerminalSessionInfo, "attachable">): boolean {
  return session.attachable === true;
}

export function formatTerminalSessionMeta(session: TerminalSessionInfo): string {
  const parts = [
    terminalBackendLabel(session.backend),
    terminalStatusLabel(session.status),
    terminalDurabilityLabel(session.durability)
  ];
  if (session.hostLabel) parts.push(session.hostLabel);
  if (session.cwd) parts.push(session.cwd);
  return parts.join(" · ");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function safeTerminalText(value: string): string {
  // Strip C0 controls except TAB/LF/CR so xterm never receives binary noise from error strings.
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      out += value[i];
    }
  }
  return out;
}
