export type RuntimeEventRuntime = "human" | "claude-code" | "codex" | "zcode" | "antigravity";

export const runtimeEventKinds = ["session", "turn", "step", "tool", "approval", "interrupt", "result", "cost"] as const;
export const runtimeEventResultStatuses = ["started", "succeeded", "failed", "cancelled", "unknown"] as const;
export const runtimeEventApprovalDecisions = ["approved", "rejected", "timeout", "unknown"] as const;
export const runtimeEventInterruptActions = ["pause", "cancel", "resume", "append", "branch", "unknown"] as const;

export type RuntimeEventKind = typeof runtimeEventKinds[number];
export type RuntimeEventResultStatus = typeof runtimeEventResultStatuses[number];
export type RuntimeEventApprovalDecision = typeof runtimeEventApprovalDecisions[number];
export type RuntimeEventInterruptAction = typeof runtimeEventInterruptActions[number];

export interface RuntimeEventRecord {
  readonly schema: "runtime-event/v1";
  readonly eventId: string;
  readonly recordedAt: string;
  readonly kind: RuntimeEventKind;
  readonly session: {
    readonly sessionId: string;
    readonly runtime: RuntimeEventRuntime | "unknown";
    readonly taskId?: string;
    readonly decisionId?: string;
    readonly factRef?: string;
  };
  readonly turn: {
    readonly turnId: string;
    readonly index?: number;
    readonly role?: "user" | "assistant" | "system" | "tool" | "unknown";
  } | null;
  readonly step: {
    readonly stepId: string;
    readonly parentStepId?: string;
    readonly name?: string;
  } | null;
  readonly tool: {
    readonly toolName: string;
    readonly callId?: string;
    readonly errorCode?: string;
  } | null;
  readonly approval: {
    readonly approvalId: string;
    readonly decision: RuntimeEventApprovalDecision;
    readonly scope?: string;
  } | null;
  readonly interrupt: {
    readonly interruptId: string;
    readonly action: RuntimeEventInterruptAction;
    readonly reason?: string;
  } | null;
  readonly result: {
    readonly status: RuntimeEventResultStatus;
    readonly summary?: string;
    readonly errorCode?: string;
  } | null;
  readonly cost: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly wallMs?: number;
    readonly model?: string;
    readonly amountUsd?: number;
  } | null;
}

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
