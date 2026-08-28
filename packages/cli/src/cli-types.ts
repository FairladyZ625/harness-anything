export type RuntimeCwd = Readonly<Record<string, string>>;

export type RuntimeBatchEntry = {
  readonly instance: string;
  readonly agent?: string;
  readonly to?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly prompt?: string;
  readonly mission?: string;
  readonly cwd?: string | RuntimeCwd;
  readonly task?: string;
};

export type RuntimeBatchDeclaration = {
  readonly maxConcurrency: number;
  readonly dispatches: readonly RuntimeBatchEntry[];
};

export type RuntimeBatchResult = {
  readonly index: number;
  readonly instance: string;
  readonly agent: string | null;
  readonly to: string | null;
  readonly status: "succeeded" | "failed" | "rejected" | "unknown";
  readonly outcome: string | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly code: string | null;
  readonly reason: string | null;
  readonly reportPath: string | null;
  readonly resultText: string | null;
};

export type SquadRunAction = {
  readonly kind: "squad-run";
  readonly squadId: string;
  readonly runtimeInstanceId: string;
  readonly prompt?: string;
  readonly effort?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly cwd: Readonly<Record<string, string>>;
  readonly taskId: string;
};

export type AgentCreateAction = {
  readonly kind: "agent-create";
  readonly runtimeInstanceId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly effort?: string;
  readonly model?: string;
  readonly cwd: Readonly<Record<string, string>>;
  readonly taskId?: string;
};

export const runtimeBatchDefaultConcurrency = 2,
  runtimeBatchMaxConcurrency = 32;
