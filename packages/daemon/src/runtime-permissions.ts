// Permission/sandbox vocabulary for runtime instances. One harness-level mode per
// instance (default open) mapped onto each provider's own verified flags:
// Claude Code 2.1.234 `--permission-mode`; Codex CLI 0.147.0 uses `--sandbox`
// for a new exec, but its resume parser requires config overrides (or bypass).
export type RuntimePermissionMode = "bypass" | "workspace-write" | "read-only";
export type RuntimeIsolationState = "enforced" | "operator-environment";
export type RuntimePermissionKind = "claude" | "codex" | "agy";

export function runtimePermissionMode(value: unknown, kindId: RuntimePermissionKind): RuntimePermissionMode | undefined {
  if (value === undefined) return kindId === "agy" ? undefined : "bypass";
  if (kindId === "agy") throw permissionError("invalid_runtime_permission", "agy runtime instances have no harness permission mode; the agy CLI owns its own access policy.");
  if (typeof value !== "string" || !["bypass", "workspace-write", "read-only"].includes(value)) throw permissionError("invalid_runtime_permission", "Runtime permission mode must be bypass, workspace-write, or read-only.");
  return value as RuntimePermissionMode;
}

export function runtimeIsolationState(value: unknown, kindId: RuntimePermissionKind): RuntimeIsolationState {
  if (value === undefined) return kindId === "codex" ? "enforced" : "operator-environment";
  if (typeof value !== "string" || !["enforced", "operator-environment"].includes(value)) throw permissionError("invalid_runtime_isolation", "Runtime isolation must be enforced or operator-environment.");
  if (kindId === "agy" && value !== "operator-environment") throw permissionError("invalid_runtime_isolation", "agy runtime instances always reuse the operator environment.");
  return value as RuntimeIsolationState;
}

// The #1608 workspace-write hardening (excluding $TMPDIR and /tmp from the writable
// sandbox) stays exactly as it was whenever an operator explicitly tightens a codex
// instance back to workspace-write; only the default moved to the open side.
export function permissionLaunchArgs(kindId: "claude" | "codex", mode: RuntimePermissionMode, phase: "start" | "resume" = "start"): readonly string[] {
  if (kindId === "claude") return ["--permission-mode", mode === "bypass" ? "bypassPermissions" : mode === "workspace-write" ? "acceptEdits" : "plan"];
  const sandbox = mode === "bypass" ? "danger-full-access" : mode;
  const selection = phase === "resume" ? mode === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--config", `sandbox_mode=${JSON.stringify(sandbox)}`] : ["--sandbox", sandbox];
  return mode === "workspace-write" ? [...selection, "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--config", "sandbox_workspace_write.exclude_slash_tmp=true"] : selection;
}

function permissionError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
