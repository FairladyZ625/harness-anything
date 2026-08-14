import type { TerminalBackendWarning } from "./backend-policy.ts";

// Renderer-only display types retained for the R2 migration. Session ownership now lives in daemon TerminalHost.
export type TerminalBackend = "direct-pty" | "tmux" | "remote";
export type TerminalSessionStatus = "active" | "idle" | "exited" | "unknown";
export interface TerminalSessionInfo {
  readonly sessionId: string; readonly name: string; readonly backend: TerminalBackend; readonly backendWarnings?: readonly TerminalBackendWarning[]; readonly status: TerminalSessionStatus; readonly envProfileId?: string; readonly hostProfileId?: string; readonly hostLabel: string; readonly projectId?: string; readonly taskId?: string; readonly cwd?: string; readonly shell?: string; readonly createdAt: string; readonly lastActivityAt?: string; readonly exitCode?: number;
}
