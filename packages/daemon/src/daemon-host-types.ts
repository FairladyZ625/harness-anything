import { type DaemonRepoMode, type WriteReceipt } from "../../kernel/src/index.ts";
import type {
  AgentRuntimeAttachEvent,
  AgentRuntimeAttachSubscription,
  AgentRuntimeNativeSignal,
  AgentRuntimeWitnessBinding,
  AgentRuntimeWitnessToken,
} from "./agent-runtime-stream.ts";
import { type DaemonBuildStatus } from "./build-identity.ts";
import type { DaemonControlReceipt, TerminalAttachSubscription } from "./gui-s3-control.ts";
import { type DaemonGuiReadResultMap, type DaemonGuiRpcReadMethod } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { type RepoBootstrapRequest } from "./repo-bootstrap.ts";
import { type RepoCell, type RepoCellStatus, type RepoTaskAction, type RuntimeIngressAction } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface DaemonHost {
  readonly run: (repoId: string, action: RepoTaskAction, auth: DaemonAuthenticationContext) => Promise<WriteReceipt>;
  readonly presetRun: (
    repoId: string,
    action: RepoTaskAction,
    auth: DaemonAuthenticationContext,
  ) => ReturnType<RepoCell["presetRun"]>;
  readonly replica: (repoId: string) => RepoCell["replica"];
  readonly read: <M extends DaemonGuiRpcReadMethod>(
    repoId: string,
    method: M,
    payload: Readonly<Record<string, unknown>>,
    auth: DaemonAuthenticationContext,
  ) => Promise<DaemonGuiReadResultMap[M]>;
  readonly attach: (
    repoId: string,
    runtimeSessionId: string,
    afterCursor: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<AgentRuntimeAttachSubscription>;
  readonly spawnRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly cancelRuntime: (
    repoId: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly runtimeIngress: (
    repoId: string,
    action: RuntimeIngressAction,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly terminalAttach: (
    repoId: string,
    sessionId: string,
    afterSeq: number,
    auth: DaemonAuthenticationContext,
  ) => Promise<TerminalAttachSubscription>;
  readonly terminalAction: (
    repoId: string,
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly runtimeInstanceAuth: (
    repoId: string,
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly system: (auth: DaemonAuthenticationContext) => JsonObject;
  readonly runtimeInstance: (
    method: string,
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
  ) => Promise<JsonObject>;
  readonly requestControl: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<DaemonControlReceipt>;
  readonly controlReceipt: (operationId: string, auth: DaemonAuthenticationContext) => DaemonControlReceipt;
  readonly issueRuntimeWitness: (
    repoId: string,
    runtimeSessionId: string,
    auth: DaemonAuthenticationContext,
  ) => Promise<AgentRuntimeWitnessToken>;
  readonly bindRuntimeWitness: (repoId: string, token: string) => AgentRuntimeWitnessBinding;
  readonly publishRuntimeWitness: (
    repoId: string,
    token: string,
    signal: AgentRuntimeNativeSignal,
  ) => AgentRuntimeAttachEvent;
  readonly bootstrap: (
    request: RepoBootstrapRequest,
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly admin: (
    request:
      | {
          readonly kind: "register";
          readonly rootDir: string;
          readonly repoId: string;
          readonly mode?: DaemonRepoMode;
        }
      | { readonly kind: "unregister"; readonly repoId: string },
    auth: DaemonAuthenticationContext,
  ) => Promise<Record<string, unknown>>;
  readonly fleet: {
    readonly startCenter: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly edgeSync: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
    readonly edgeRuntime: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
  };
  readonly status: () => {
    readonly daemonId: string;
    readonly pid: number;
    readonly startedAt: string;
    readonly build: DaemonBuildStatus & { readonly version: string };
    readonly repos: readonly RepoCellStatus[];
    readonly summary: string;
  };
  readonly startAttachments: () => void;
  readonly attachmentsSettled: () => Promise<void>;
  readonly close: () => Promise<void>;
}
