// Permission/sandbox vocabulary for runtime instances. One harness-level mode per
// instance (default open) mapped onto each provider's own verified flags:
// Claude Code 2.1.234 `--permission-mode`; Codex CLI 0.147.0 uses `--sandbox`
// for a new exec, but its resume parser requires config overrides (or bypass).
export type RuntimePermissionMode = "bypass" | "workspace-write" | "read-only";
export type RuntimeIsolationState = "enforced" | "operator-environment";
import { runtimeKindForId, type RuntimeKindId } from "./runtime-inventory.ts";

export type RuntimePermissionKind = RuntimeKindId;

export function runtimePermissionMode(
  value: unknown,
  _kindId: RuntimePermissionKind,
): RuntimePermissionMode | undefined {
  if (value === undefined) return "bypass";
  if (typeof value !== "string" || !["bypass", "workspace-write", "read-only"].includes(value))
    throw permissionError(
      "invalid_runtime_permission",
      "Runtime permission mode must be bypass, workspace-write, or read-only.",
    );
  return value as RuntimePermissionMode;
}

export function runtimeIsolationState(value: unknown, kindId: RuntimePermissionKind): RuntimeIsolationState {
  const declaration = runtimeKindForId(kindId);
  if (value === undefined) return declaration.isolation.defaultState;
  if (typeof value !== "string" || !["enforced", "operator-environment"].includes(value))
    throw permissionError("invalid_runtime_isolation", "Runtime isolation must be enforced or operator-environment.");
  if (!declaration.isolation.states.some((state) => state === value))
    throw permissionError(
      "invalid_runtime_isolation",
      `${kindId} runtime instances do not support ${value} isolation.`,
    );
  return value as RuntimeIsolationState;
}

function permissionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
