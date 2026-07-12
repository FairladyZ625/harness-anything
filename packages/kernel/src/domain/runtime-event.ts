export type RuntimeEventRuntime = "human" | "claude-code" | "codex" | "zcode" | "antigravity";

export const runtimeEventKinds = ["session", "turn", "step", "tool", "approval", "interrupt", "result", "cost"] as const;
export const runtimeEventResultStatuses = ["started", "succeeded", "failed", "cancelled", "unknown"] as const;
export const runtimeEventApprovalDecisions = ["approved", "rejected", "timeout", "unknown"] as const;
export const runtimeEventInterruptActions = ["pause", "cancel", "resume", "append", "branch", "unknown"] as const;

export type RuntimeEventKind = typeof runtimeEventKinds[number];
export type RuntimeEventResultStatus = typeof runtimeEventResultStatuses[number];
export type RuntimeEventApprovalDecision = typeof runtimeEventApprovalDecisions[number];
export type RuntimeEventInterruptAction = typeof runtimeEventInterruptActions[number];

export function isRuntimeEventKind(value: string): value is RuntimeEventKind {
  return (runtimeEventKinds as ReadonlyArray<string>).includes(value);
}

export function isRuntimeEventApprovalDecision(value: string): value is RuntimeEventApprovalDecision {
  return (runtimeEventApprovalDecisions as ReadonlyArray<string>).includes(value);
}

export function isRuntimeEventInterruptAction(value: string): value is RuntimeEventInterruptAction {
  return (runtimeEventInterruptActions as ReadonlyArray<string>).includes(value);
}

export function isRuntimeEventResultStatus(value: string): value is RuntimeEventResultStatus {
  return (runtimeEventResultStatuses as ReadonlyArray<string>).includes(value);
}
