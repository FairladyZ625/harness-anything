import type { RuntimeCapabilityName, RuntimeProcessWitness } from "../../kernel/src/index.ts";

export type RuntimeAuthenticationConfigurationState = "configured" | "not-configured" | "invalid";

export interface RuntimeAuthenticationProfileProjection {
  readonly kindId: string;
  readonly profileKind: string;
  readonly state: RuntimeAuthenticationConfigurationState;
  readonly guidance: string;
}

export interface AgentRuntimeProfilesResult {
  readonly ok: true;
  readonly schema: "agent-runtime-auth-profiles/v1";
  readonly profiles: ReadonlyArray<RuntimeAuthenticationProfileProjection>;
}

export interface AgentRuntimeSpawnPayload {
  readonly kindId: "claude-code" | "codex";
  readonly prompt: string;
  readonly cwd: string;
  readonly authenticationProfileKind: string;
  readonly resumeProviderSessionId?: string;
  readonly taskId?: string;
  readonly executionId?: string;
}

export interface AgentRuntimeSessionIdPayload {
  readonly runtimeSessionId: string;
}

export interface AgentRuntimeEventsPayload extends AgentRuntimeSessionIdPayload {
  readonly cursor?: number;
}

export interface AgentRuntimeControlFailure {
  readonly ok: false;
  readonly error: { readonly code: string; readonly hint: string };
}

export interface AgentRuntimeSessionStatus {
  readonly runtimeSessionId: string;
  readonly kindId: string;
  readonly providerSessionId?: string;
  readonly process: RuntimeProcessWitness;
  readonly attachable: boolean;
  readonly capabilities: Readonly<Record<RuntimeCapabilityName, boolean>>;
  readonly clientBinding?: {
    readonly assertion: "client-asserted";
    readonly taskId?: string;
    readonly executionId?: string;
  };
}

export interface AgentRuntimeSessionResult {
  readonly ok: true;
  readonly session: AgentRuntimeSessionStatus;
}

export interface AgentRuntimeStatusResult {
  readonly ok: true;
  readonly schema: "agent-runtime-session-status/v1";
  readonly sessions: ReadonlyArray<AgentRuntimeSessionStatus>;
}

export interface AgentRuntimeEventProjection {
  readonly sequence: number;
  readonly kind: "provider-session" | "heartbeat" | "completed" | "failed" | "exit";
  readonly observedAt: string;
}

export interface AgentRuntimeEventsResult {
  readonly ok: true;
  readonly events: ReadonlyArray<AgentRuntimeEventProjection>;
  readonly nextCursor: number;
}

export interface AgentRuntimeResultProjection {
  readonly runtimeSessionId: string;
  readonly state: "running" | "completed" | "failed" | "unknown";
  readonly exitCode?: number | null;
}

export interface AgentRuntimeResultResult {
  readonly ok: true;
  readonly result: AgentRuntimeResultProjection;
}

export interface AgentRuntimeControlService {
  readonly profiles: () => Promise<AgentRuntimeProfilesResult | AgentRuntimeControlFailure>;
  readonly spawn: (payload: AgentRuntimeSpawnPayload) => Promise<AgentRuntimeSessionResult | AgentRuntimeControlFailure>;
  readonly attach: (payload: AgentRuntimeSessionIdPayload) => Promise<AgentRuntimeSessionResult | AgentRuntimeControlFailure>;
  readonly status: (payload?: Partial<AgentRuntimeSessionIdPayload>) => Promise<AgentRuntimeStatusResult | AgentRuntimeControlFailure>;
  readonly events: (payload: AgentRuntimeEventsPayload) => Promise<AgentRuntimeEventsResult | AgentRuntimeControlFailure>;
  readonly result: (payload: AgentRuntimeSessionIdPayload) => Promise<AgentRuntimeResultResult | AgentRuntimeControlFailure>;
}

export type AgentRuntimeControlPayload = AgentRuntimeSpawnPayload | AgentRuntimeSessionIdPayload | AgentRuntimeEventsPayload;
export type AgentRuntimeControlResult =
  | AgentRuntimeProfilesResult
  | AgentRuntimeSessionResult
  | AgentRuntimeStatusResult
  | AgentRuntimeEventsResult
  | AgentRuntimeResultResult
  | AgentRuntimeControlFailure;
