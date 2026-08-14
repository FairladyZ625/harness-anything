import type { TerminalBackend } from "./session-registry.ts";

export type TerminalBackendDurability = "none" | "daemon-restart" | "remote-owned";
export type TerminalBackendEvidence = "always-available" | "probe" | "not-installed" | "remote-owned" | "disabled";

export interface TerminalBackendCapability {
  readonly backend: TerminalBackend;
  readonly available: boolean;
  readonly durability: TerminalBackendDurability;
  readonly evidence: TerminalBackendEvidence;
  readonly version?: string;
  readonly reason?: string;
}

export interface TerminalBackendWarning {
  readonly code: "terminal_backend_downgraded_non_durable";
  readonly requestedBackend: TerminalBackend;
  readonly selectedBackend: TerminalBackend;
  readonly hint: string;
}

export interface TerminalBackendSelectionSuccess {
  readonly ok: true;
  readonly backend: TerminalBackend;
  readonly capability: TerminalBackendCapability;
  readonly durableAcrossDaemonRestart: boolean;
  readonly warnings: ReadonlyArray<TerminalBackendWarning>;
}

export interface TerminalBackendFailure {
  readonly ok: false;
  readonly error: {
    readonly code:
      | "terminal_backend_mismatch"
      | "terminal_backend_unavailable"
      | "terminal_backend_not_registered"
      | "terminal_backend_resource_closed";
    readonly hint: string;
  };
}

export type TerminalBackendSelectionResult = TerminalBackendSelectionSuccess | TerminalBackendFailure;

export interface SelectTerminalBackendInput {
  readonly requestedBackend?: TerminalBackend;
  readonly defaultBackend?: TerminalBackend;
  readonly capabilities: ReadonlyArray<TerminalBackendCapability>;
  readonly allowDirectPtyFallback?: boolean;
}

export function directPtyCapability(): TerminalBackendCapability {
  return {
    backend: "direct-pty",
    available: true,
    durability: "none",
    evidence: "always-available",
    reason: "direct-pty sessions are development/degrade sessions and do not survive daemon restart."
  };
}

export function tmuxCapability(input: { readonly available: boolean; readonly version?: string; readonly reason?: string }): TerminalBackendCapability {
  return {
    backend: "tmux",
    available: input.available,
    durability: "daemon-restart",
    evidence: input.available ? "probe" : "not-installed",
    version: input.version,
    reason: input.reason
  };
}

export function remoteCapability(input: { readonly available: boolean; readonly reason?: string }): TerminalBackendCapability {
  return {
    backend: "remote",
    available: input.available,
    durability: "remote-owned",
    evidence: input.available ? "remote-owned" : "disabled",
    reason: input.reason
  };
}

export function selectTerminalBackend(input: SelectTerminalBackendInput): TerminalBackendSelectionResult {
  const targetBackend = input.requestedBackend ?? input.defaultBackend ?? "direct-pty";
  const target = findCapability(input.capabilities, targetBackend);
  if (!target) return backendFailure("terminal_backend_not_registered", `Terminal backend is not registered: ${targetBackend}`);
  if (target.available) return backendSelection(target, []);
  if (targetBackend === "tmux" && input.allowDirectPtyFallback !== false) {
    const fallback = findCapability(input.capabilities, "direct-pty");
    if (fallback?.available) {
      return backendSelection(fallback, [
        {
          code: "terminal_backend_downgraded_non_durable",
          requestedBackend: "tmux",
          selectedBackend: "direct-pty",
          hint: target.reason ?? "tmux is unavailable; selected direct-pty. This session will not survive daemon restart."
        }
      ]);
    }
  }
  return backendFailure("terminal_backend_unavailable", target.reason ?? `Terminal backend is unavailable: ${targetBackend}`);
}

function backendSelection(capability: TerminalBackendCapability, warnings: ReadonlyArray<TerminalBackendWarning>): TerminalBackendSelectionSuccess {
  return {
    ok: true,
    backend: capability.backend,
    capability,
    durableAcrossDaemonRestart: capability.durability !== "none",
    warnings
  };
}

function backendFailure(code: TerminalBackendFailure["error"]["code"], hint: string): TerminalBackendFailure {
  return { ok: false, error: { code, hint } };
}

function findCapability(capabilities: ReadonlyArray<TerminalBackendCapability>, backend: TerminalBackend): TerminalBackendCapability | undefined {
  return capabilities.find((capability) => capability.backend === backend);
}
