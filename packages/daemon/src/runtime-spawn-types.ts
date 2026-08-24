import type {
  ActorIdentity,
  AgentRuntimeEventV1,
  RuntimeSession,
  SessionIdentity,
  WriteSource,
} from "../../kernel/src/index.ts";
import type { AgentSkillDeclarationV1 } from "./agent-entities.contract.ts";
import { type AgentRole } from "./agent-entities.contract.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import type { AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import { type DispatchStreamWriter } from "./dispatch-stream.ts";
import { type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import { type JsonObject } from "./protocol/json-rpc-types.ts";
import { type RuntimePermissionMode } from "./runtime-permissions.ts";

export interface RuntimeProcess {
  readonly pid: number;
  readonly onOutput: (listener: (chunk: string, persisted?: boolean) => void) => void;
  readonly onErrorOutput: (listener: (chunk: string) => void) => void;
  readonly onExit: (listener: (code: number | null) => void) => void;
  readonly terminate: () => void;
  readonly terminateTree?: () => Promise<void>;
  readonly release?: () => void;
}

export type RuntimeLauncher = (
  input: PreparedRuntimeLaunch,
  persistence: { readonly rootDir: string; readonly dispatchId: string },
) => RuntimeProcess;

export interface RuntimeDaemonRoute {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly endpoint: string;
}

export type RuntimeBinding = {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
};

export type RuntimeAgent = {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtime_type: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly skills?: readonly AgentSkillDeclarationV1[];
  readonly prompts?: readonly string[];
  readonly preset?: string;
};

export type ActiveRuntime = {
  readonly process: RuntimeProcess;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly dispatchOpId: string;
  readonly instanceId: string;
  readonly kindId: RuntimeInstanceKind;
  readonly permissionMode: RuntimePermissionMode | null;
  readonly agent: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly delegatedBy: Pick<RuntimeAgent, "id" | "name"> | null;
  readonly squadId: string | null;
  readonly binding: RuntimeBinding;
  readonly task: {
    readonly taskId: string;
    readonly executionId: string;
  } | null;
  readonly cwd: string;
  readonly prompt: string;
  readonly promptSource?: string;
  readonly onExitCommand: string | null;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly startedAt: string;
  readonly stream: DispatchStreamWriter;
  buffer: string;
  durableOutputCount: number;
  stdoutObserved: boolean;
  errorBuffer: string;
  errorOverflowed: boolean;
  providerSessionId: string | null;
  resumeProviderSessionId: string | null;
  finalText: string | null;
  failureText: string | null;
  providerOutcome: "succeeded" | "failed" | "unknown" | null;
  writeItemObserved: boolean;
  planObserved: boolean;
  planIncomplete: boolean;
  protocolError: boolean;
  cancelRequested: boolean;
  cancelBinding: RuntimeBinding | null;
  cancelOpId: string | null;
};

export type ProviderFrame = {
  readonly sessionIdentity?: SessionIdentity;
  readonly signals?: readonly AgentRuntimeNativeSignal[];
  readonly finalText?: string;
  readonly failureText?: string;
  readonly outcome?: "succeeded" | "failed" | "unknown";
  readonly writeItemObserved?: boolean;
  readonly planObserved?: boolean;
  readonly planIncomplete?: boolean;
};

export type ResumeProcessEvent =
  | { readonly kind: "output"; readonly chunk: string }
  | { readonly kind: "error"; readonly chunk: string }
  | { readonly kind: "exit"; readonly code: number | null };

export type ResumeProcessObservation = {
  readonly ready: Promise<void>;
  readonly activate: (handlers: {
    readonly output: (chunk: string) => void;
    readonly error: (chunk: string) => void;
    readonly exit: (code: number | null) => void;
  }) => void;
};

export type RuntimeSessionSelection = Pick<
  RuntimeSession,
  "runtimeSessionId" | "providerSessionId" | "instanceId" | "liveness" | "outcome"
>;

export interface RemoteRuntimePersistence {
  readonly existing: (opId: string) => Promise<JsonObject | null>;
  readonly taskContext: (taskId: string) => Promise<{
    readonly executionId: string;
    readonly mission: string;
    readonly packageRoot: string;
    readonly planPath: string;
    readonly plan: string;
  }>;
  readonly readRuntimeSessions: () => Promise<readonly RuntimeSessionSelection[]>;
  readonly publish: (draft: {
    readonly type: AgentRuntimeEventV1["type"];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly opId: string;
    readonly resultBody?: string;
  }) => Promise<{
    readonly event: AgentRuntimeEventV1;
    readonly receipt: JsonObject;
  }>;
  readonly archive: (
    archive: RuntimeDispatchArchive,
  ) => Promise<{ readonly outcome: string; readonly nextAction?: string }>;
}
