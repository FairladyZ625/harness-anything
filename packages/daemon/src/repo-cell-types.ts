import { makeTaskLifecycleService } from "../../application/src/task-lifecycle-service.ts";
import {
  type ActorIdentity,
  type AgentRuntimeEventV1,
  type CanonicalEventCut,
  type DaemonRepoMode,
  type WriteReceipt,
  type WriteSource,
} from "../../kernel/src/index.ts";
import { type PresetRunReceiptV1 } from "../../preset/src/index.ts";
import { type AgentRuntimeAttachSubscription, type AgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import type { FleetAssignmentScope } from "./fleet/contract.ts";
import { type ReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { openGuiCatalog } from "./gui-catalog.ts";
import {
  type DaemonGuiReadMethod,
  type DaemonGuiReadResultMap,
  type ObserveTailResult,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { type RepoBootstrapReceipt } from "./repo-bootstrap.ts";
import { type TerminalHost, type TrustedTerminalLaunch } from "./terminal-host.ts";

export type RepoTaskAction = Readonly<Record<string, unknown>> & {
  readonly kind: string;
};

export interface RepoCellBinding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly sessionEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly roles?: readonly string[];
  readonly commandClasses?: readonly string[];
  readonly docWriteAllowed?: boolean;
  readonly assignmentScope?: FleetAssignmentScope;
  readonly writerEpoch?: number;
  readonly assertWriterEpoch?: () => void;
  readonly withWriterEpochFence?: <T>(operation: () => T) => T;
}

export type RuntimeIngressAction =
  | {
      readonly kind: "event";
      readonly type: AgentRuntimeEventV1["type"];
      readonly payload: Readonly<Record<string, unknown>>;
      readonly opId: string;
      readonly resultBody?: string;
    }
  | { readonly kind: "archive"; readonly archive: RuntimeDispatchArchive };

export type TaskCreateReceipt = WriteReceipt & {
  readonly summary: string;
  readonly taskId: string;
  readonly status: "planned";
  readonly packagePath: string;
  readonly generatedPaths: readonly string[];
  readonly presetDigest: string;
  readonly scaffoldDigest: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly outputShape: string;
  readonly completionGates: readonly string[];
  readonly commitSha: string | null;
  readonly dryRun: boolean;
};

export type TaskProgressReceipt = WriteReceipt & {
  readonly summary: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly progressPath: string;
  readonly eventId: string;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly worktreeVisible: true;
};

export interface RepoCellStatus {
  readonly repoId: string;
  readonly rootDir: string;
  readonly mode: DaemonRepoMode | null;
  readonly state: "warming" | "attached" | "unavailable" | "closed";
  readonly generation: number | null;
  readonly queueDepth: number | null;
  readonly lastError: string | null;
  readonly causeClass: "data-shape" | "infrastructure" | "projection" | null;
  readonly recoveryMs: number | null;
}

export type RepoCellReadMethod = Exclude<
  DaemonGuiReadMethod,
  | "daemon.gui.system.read"
  | "daemon.gui.control.receipt"
  | "repo.gui.catalog.snapshot"
  | "repo.gui.catalog.preset.read"
  | "repo.terminal.sessions.list"
>;

export type RepoCellTerminal = Omit<TerminalHost, "spawn" | "spawnTrusted" | "input" | "resize" | "terminate"> & {
  readonly spawn: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["spawn"]>;
  readonly spawnTrusted: (
    input: TrustedTerminalLaunch,
    binding: RepoCellBinding,
  ) => ReturnType<TerminalHost["spawnTrusted"]>;
  readonly input: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["input"]>;
  readonly resize: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["resize"]>;
  readonly terminate: (payload: JsonObject, binding: RepoCellBinding) => ReturnType<TerminalHost["terminate"]>;
};

export interface RepoCell {
  readonly bootstrapReceipt?: RepoBootstrapReceipt;
  readonly run: (action: RepoTaskAction, binding: RepoCellBinding, signal?: AbortSignal) => Promise<WriteReceipt>;
  readonly presetRun: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<PresetRunReceiptV1>;
  readonly spawnRuntime: (payload: JsonObject, binding: RepoCellBinding) => Promise<JsonObject>;
  readonly cancelRuntime: (payload: JsonObject, binding: RepoCellBinding) => Promise<JsonObject>;
  readonly runtimeIngress: (action: RuntimeIngressAction, binding: RepoCellBinding) => Promise<JsonObject>;
  readonly catalog: ReturnType<typeof openGuiCatalog>;
  readonly terminal: RepoCellTerminal;
  readonly read: <M extends RepoCellReadMethod>(
    method: M,
    payload?: Readonly<Record<string, unknown>>,
  ) => Promise<DaemonGuiReadResultMap[M]>;
  readonly workspaceSummary: () => DaemonGuiReadResultMap["repo.workspace.summary.read"];
  readonly observeTail: (
    payload: unknown,
    daemon: { readonly userRoot: string; readonly daemonId: string },
  ) => Promise<ObserveTailResult>;
  readonly replica: ReplicaCutSource;
  readonly verifyReadiness: () => Promise<{
    readonly cellState: "attached";
    readonly l2State: "ready";
  }>;
  readonly attach: (runtimeSessionId: string, afterCursor: string) => Promise<AgentRuntimeAttachSubscription>;
  readonly runtime: Pick<AgentRuntimeStreamHub, "publish" | "issueWitnessToken" | "bindWitness">;
  readonly status: () => RepoCellStatus;
  readonly close: () => Promise<void>;
}

export type DaemonGuiReadHandlers = {
  readonly [M in RepoCellReadMethod]: (payload: Readonly<Record<string, unknown>>) => DaemonGuiReadResultMap[M];
};

export type Snapshot = Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"];

export type PublicPublication = {
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
};

export const leaseTtlMs = 24 * 60 * 60 * 1_000;

export const runtimeIngressEventTypes: readonly AgentRuntimeEventV1["type"][] = [
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
  "runtime_dispatch_outcome_unknown",
];
