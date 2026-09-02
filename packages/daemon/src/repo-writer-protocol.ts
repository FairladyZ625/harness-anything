import type { DaemonRepoMode, EventPublicationKillpoint, ReceiptDiagnostic } from "../../kernel/src/index.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import type { AgentRuntimeNativeSignal } from "./agent-runtime-stream.ts";
import type { FleetRoster } from "./fleet-center-admission.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { diagnosticForError } from "./receipt-guidance.ts";
import type { RepoBootstrapInput } from "./repo-bootstrap.ts";
import type { RepoCellBinding, RepoTaskAction, RuntimeIngressAction } from "./repo-cell-types.ts";
import type { RuntimeAttemptTerminal, RuntimeDaemonRoute } from "./runtime-spawn.ts";

export const REPO_WRITER_PROTOCOL_VERSION = 1 as const;

export interface RepoWriterBootstrapV1 {
  readonly schema: "harness-repo-writer-bootstrap/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly config: {
    readonly repoId: string;
    readonly rootDir: string;
    readonly ownerId: string;
    readonly mode?: DaemonRepoMode;
    readonly authoredBranch?: string;
    readonly runtimeDaemonRoute?: RuntimeDaemonRoute;
    readonly bootstrap?: RepoBootstrapInput;
    readonly walMaterializationTestFault?: {
      readonly point: "before_materialization" | "worker_exit" | "after_git_commit" | "after_git_ref_update";
      readonly failures: number;
    };
  };
  readonly capabilities: {
    readonly now: boolean;
    readonly killpoint: boolean;
    readonly shouldStop: boolean;
    readonly runtimeInstances: boolean;
    readonly prepareRuntimeLaunch: boolean;
    readonly prepareWorkerGitEnvironment: boolean;
    readonly runtimeLaunch: boolean;
    readonly runtimeSignal: boolean;
    readonly fleetRoster: boolean;
    readonly storeOpened: boolean;
  };
}

export interface RepoWriterRequestV1 {
  readonly schema: "harness-repo-writer-request/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly method:
    | "run"
    | "presetRun"
    | "spawnRuntime"
    | "cancelRuntime"
    | "runtimeIngress"
    | "settlePendingMaterialization"
    | "catalog";
  readonly payload: unknown;
  readonly binding?: SerializableRepoCellBindingV1;
  readonly writerEpoch: SerializableRepoCellBindingV1["writerEpochFence"] | null;
}

export interface RepoWriterReceiptV1 {
  readonly schema: "harness-repo-writer-receipt/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly outcome: "ok" | "error";
  readonly value?: unknown;
  readonly error?: SerializedWriterErrorV1;
}

export interface RepoWriterCancelV1 {
  readonly schema: "harness-repo-writer-cancel/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface RepoWriterStatusV1 {
  readonly schema: "harness-repo-writer-status/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly kind: "ready" | "cut" | "status" | "closed";
  readonly status?: unknown;
  readonly bootstrapReceipt?: unknown;
  readonly error?: SerializedWriterErrorV1;
}

export interface RepoWriterControlV1 {
  readonly schema: "harness-repo-writer-control/v1";
  readonly protocolVersion: typeof REPO_WRITER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly command: "recover" | "drain" | "crash" | "beginBulkWrite" | "finishBulkWrite";
}

export type RepoWriterMessageV1 =
  | RepoWriterBootstrapV1
  | RepoWriterRequestV1
  | RepoWriterReceiptV1
  | RepoWriterCancelV1
  | RepoWriterStatusV1
  | RepoWriterControlV1;

export type SerializableRepoCellBindingV1 = Omit<RepoCellBinding, "assertWriterEpoch" | "withWriterEpochFence">;

export interface SerializedWriterErrorV1 {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly code: string | null;
  readonly data: JsonObject | null;
  readonly diagnostic: ReceiptDiagnostic | null;
}

export type RepoWriterCapabilityName =
  | "now"
  | "killpoint"
  | "shouldStop"
  | "runtimeInstances"
  | "prepareRuntimeLaunch"
  | "prepareWorkerGitEnvironment"
  | "runtimeLaunch"
  | "runtimeTerminate"
  | "runtimeTerminateTree"
  | "bootstrap"
  | "runtimeOutcome"
  | "runtimeSignal"
  | "attemptTerminal"
  | "lifecycle"
  | "storeOpened"
  | "fleetRoster";

export interface RepoWriterCapabilityCallV1 {
  readonly schema: "harness-repo-writer-capability-call/v1";
  readonly callId: string;
  readonly capability: RepoWriterCapabilityName;
  readonly payload: unknown;
  readonly sync?: { readonly state: SharedArrayBuffer; readonly bytes: SharedArrayBuffer };
}

export interface RepoWriterCapabilityResultV1 {
  readonly schema: "harness-repo-writer-capability-result/v1";
  readonly callId: string;
  readonly outcome: "ok" | "error";
  readonly value?: unknown;
  readonly error?: SerializedWriterErrorV1;
}

export interface RuntimeProcessEventV1 {
  readonly schema: "harness-repo-writer-runtime-process-event/v1";
  readonly processId: string;
  readonly kind: "output" | "error" | "exit";
  readonly chunk?: string;
  readonly persisted?: boolean;
  readonly code?: number | null;
}

export type RepoWriterRunPayload = {
  readonly action: RepoTaskAction;
};
export type RepoWriterRuntimeIngressPayload = { readonly action: RuntimeIngressAction };
export type RepoWriterPrepareLaunchPayload = {
  readonly instanceId: string;
  readonly request: Parameters<NonNullable<RepoWriterInputPorts["prepareRuntimeLaunch"]>>[1];
};
export interface RepoWriterInputPorts {
  readonly runtimeInstances?: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch?: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment?: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
  readonly now?: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly shouldStop?: () => boolean;
  readonly fleetRoster?: () => FleetRoster | null;
  readonly onRuntimeOutcome?: (event: unknown) => void;
  readonly onRuntimeSignal?: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => void;
  readonly onAttemptTerminal?: (terminal: RuntimeAttemptTerminal) => void;
}

export function serializeWriterError(error: unknown): SerializedWriterErrorV1 {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
    code: typeof record?.code === "string" ? record.code : null,
    data: isJsonRecord(record?.data) ? (record.data as JsonObject) : null,
    diagnostic: diagnosticForError(error) ?? null,
  };
}

export function deserializeWriterError(error: SerializedWriterErrorV1): Error {
  return Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.data ? { data: error.data } : {}),
    ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
