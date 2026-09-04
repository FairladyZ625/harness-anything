import { presetMethods } from "../../../preset/src/preset-command-contract.ts";
import type { ContractVersion } from "../../../kernel/src/domain/contract-version.ts";
import type { FleetTaskAction } from "../fleet/contract.ts";
import { daemonOwnedProtocolCommands } from "./daemon-protocol-commands.ts";
import { daemonGuiActionMethods, daemonStreamFacets } from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import type { DaemonSessionEnvironment } from "./daemon-protocol-identifiers.ts";
import { optionalEnum, shape, type RpcEnumRule, type RpcShape } from "./daemon-protocol-gui-types.ts";
import type { JsonObject, JsonValue } from "./json-rpc-types.ts";
import { daemonGuiActionSchemas, daemonGuiReadSchemas } from "./daemon-protocol-schema-registry.ts";
import {
  daemonRepoModeWords,
  daemonRepoModeWordsAreExact,
  decisionStateWords,
  executionStateWords,
  executionV1StateWords,
  leasePhaseWords,
  materializationStateWords,
  packageDispositionWords,
  receiptOutcomeWords,
  relationStateWords,
  reviewVerdictWords,
  taskStatusWords,
} from "./daemon-protocol-vocabulary.ts";
export {
  daemonRepoModeWords,
  daemonRepoModeWordsAreExact,
  decisionStateWords,
  executionStateWords,
  executionV1StateWords,
  leasePhaseWords,
  materializationStateWords,
  packageDispositionWords,
  receiptOutcomeWords,
  relationStateWords,
  reviewVerdictWords,
  taskStatusWords,
};

export const currentDaemonProtocolVersion = Object.freeze({ major: 1, minor: 0 }) satisfies ContractVersion;

// Build-time projections of the kernel status vocabularies (register:
// packages/kernel/src/domain/status-vocabulary.ts, blueprint 铁律四). This module sits
// on the CLI's eager startup path, so it must not import the kernel barrel — the p50
// overhead gate refuses eager module growth — and deep kernel imports are restricted.
// The status-vocabulary ratchet rejects a stale generated region.
export const daemonProtocolMethods = Object.freeze([
  {
    id: "protocol.hello",
    phase: "W3",
    method: "protocol.hello",
    requiresRepo: false,
    params: shape({
      protocolVersion: shape({ major: "number", minor: "number" }),
      sessionEnvironment: "json?",
      reportStaleBuild: "boolean?",
    }),
  },
  {
    id: "daemon.status",
    phase: "W3",
    method: "daemon.status",
    requiresRepo: false,
    params: shape({}),
  },
  {
    id: "daemon.stop",
    phase: "W3",
    method: "daemon.stop",
    requiresRepo: false,
    params: shape({}),
  },
  {
    id: "daemon.repo.bootstrap",
    phase: "W3",
    method: "daemon.repo.bootstrap",
    requiresRepo: false,
    params: shape({
      rootDir: "string",
      repoId: "string",
      personId: "string",
      displayName: "string",
      name: "string?",
      addNpmScripts: "boolean?",
      configureOnly: "boolean?",
    }),
  },
  {
    id: "daemon.repo.register",
    phase: "W3",
    method: "daemon.repo.register",
    requiresRepo: false,
    params: shape({
      rootDir: "string?",
      repoId: "string",
      displayName: "string?",
      mode: optionalEnum(daemonRepoModeWords),
      endpoint: "string?",
      connectionId: "string?",
    }),
  },
  {
    id: "daemon.repo.update",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.repo.update",
    requiresRepo: false,
    params: shape({
      repoId: "string",
      displayName: "string?",
      mode: optionalEnum(daemonRepoModeWords),
      endpoint: "string?",
      connectionId: "string?",
      state: optionalEnum(["enabled", "disabled"] as const),
    }),
  },
  {
    id: "daemon.repo.unregister",
    phase: "W3",
    method: "daemon.repo.unregister",
    requiresRepo: false,
    params: shape({ repoId: "string" }),
  },
  {
    id: "daemon.connection.register",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.register",
    requiresRepo: false,
    params: shape({ connectionId: "string?", displayName: "string?", endpoint: "string" }),
  },
  {
    id: "daemon.connection.update",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.update",
    requiresRepo: false,
    params: shape({
      connectionId: "string",
      displayName: "string?",
      endpoint: "string?",
      state: optionalEnum(["enabled", "disabled"] as const),
    }),
  },
  {
    id: "daemon.connection.unregister",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.unregister",
    requiresRepo: false,
    params: shape({ connectionId: "string" }),
  },
  {
    id: "daemon.connection.probe",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.probe",
    requiresRepo: false,
    params: shape({ endpoint: "string" }),
  },
  {
    id: "repo.task.run",
    phase: "W3",
    method: "repo.task.run",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ action: shape({ kind: "string" }, true) }),
    }),
  },
  {
    id: "repo.task.read",
    phase: "W3",
    method: "repo.task.read",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ action: shape({ kind: "string" }, true) }),
    }),
  },
] as const);

export const runtimeInstanceMethods = Object.freeze([
  {
    id: "daemon.runtimeInstance.create",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.create",
    requiresRepo: false,
    params: shape({
      payload: shape({
        instanceId: "string",
        name: "string",
        kindId: "string",
        installationId: "string?",
        providerId: "string",
        models: "array",
        defaultModel: "string?",
        permissionMode: "string?",
        isolationState: "string?",
        claude: "json?",
        codex: "json?",
        agy: "json?",
        authMode: "string",
        credentialRef: "string?",
      }),
    }),
    guiBridgeMethod: "createRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.list",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.list",
    requiresRepo: false,
    params: shape({ payload: shape({ all: "boolean?" }) }),
    guiBridgeMethod: "listRuntimeInstances",
  },
  {
    id: "daemon.runtimeInstance.show",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.show",
    requiresRepo: false,
    params: shape({
      payload: shape({ instanceId: "string", probe: "boolean?" }),
    }),
    guiBridgeMethod: "showRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.update",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.update",
    requiresRepo: false,
    params: shape({
      payload: shape({
        instanceId: "string",
        name: "string?",
        installationId: "string?",
        models: "array?",
        defaultModel: "string?",
        baseUrl: "string?",
        permissionMode: "string?",
        isolationState: "string?",
        fast: "boolean?",
        enabled: "boolean?",
      }),
    }),
    guiBridgeMethod: "updateRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.delete",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.delete",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string" }) }),
    guiBridgeMethod: "deleteRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.githubCredential.set",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.githubCredential.set",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string", githubCredentialRef: "string" }) }),
  },
  {
    id: "daemon.runtimeInstance.githubCredential.unset",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.githubCredential.unset",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string" }) }),
  },
] as const);

export const runtimeInstanceAuthMethods = Object.freeze([
  {
    id: "repo.runtimeInstance.auth.login",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.login",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
    guiBridgeMethod: "signInRuntimeInstance",
  },
  {
    id: "repo.runtimeInstance.auth.logout",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.logout",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
    guiBridgeMethod: "signOutRuntimeInstance",
  },
] as const);

export const fleetProtocolMethods = Object.freeze([
  {
    id: "daemon.fleet.center.start",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.center.start",
    requiresRepo: false,
    params: shape({
      payload: shape({
        port: "number",
        keyPath: "string",
        certPath: "string",
        rosterPath: "string",
        quotaBytes: "number",
        bind: "string?",
        stateRoot: "string?",
      }),
    }),
  },
  {
    id: "daemon.fleet.edge.sync",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.edge.sync",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string?",
        rosterPath: "string?",
        assignmentId: "string",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        servername: "string?",
        timeoutMs: "number",
      }),
    }),
  },
  {
    id: "daemon.fleet.task.run",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.task.run",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string?",
        rosterPath: "string?",
        servername: "string?",
        assignmentId: "string",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        waitTimeoutMs: "number?",
        workspaceRoot: "string?",
        action: "json",
      }),
    }),
  },
  {
    id: "daemon.fleet.doc.sync",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.doc.sync",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string?",
        rosterPath: "string?",
        servername: "string?",
        assignmentId: "string",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        dryRun: "boolean?",
        paths: "array?",
        timeoutMs: "number?",
      }),
    }),
  },
  {
    id: "daemon.fleet.conflict.exit",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.conflict.exit",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string?",
        rosterPath: "string?",
        servername: "string?",
        assignmentId: "string",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        action: {
          values: ["resolve", "discard-local", "overwrite-center"],
          optional: false,
        },
        conflictId: "string",
      }),
    }),
  },
] as const);

export const allDaemonProtocolMethods = Object.freeze([
  ...daemonProtocolMethods,
  ...runtimeInstanceMethods,
  ...runtimeInstanceAuthMethods,
  ...fleetProtocolMethods,
  ...presetMethods,
  ...daemonGuiReadMethods,
  ...daemonGuiActionMethods,
  ...daemonStreamFacets,
]);

type DaemonRpcDescriptor = (typeof allDaemonProtocolMethods)[number];
export type DaemonRpcMethod = DaemonRpcDescriptor["method"];

type RpcOptionalRule = "string?" | "string-null?" | "json?" | "array?" | "boolean?" | "number?";
type RpcOptionalKeys<Fields extends RpcShape["fields"]> = {
  readonly [Key in keyof Fields]-?: Fields[Key] extends RpcOptionalRule | { readonly optional: true } ? Key : never;
}[keyof Fields];
type RpcRequiredKeys<Fields extends RpcShape["fields"]> = Exclude<keyof Fields, RpcOptionalKeys<Fields>>;
type RpcRuleValue<Rule> = Rule extends RpcShape
  ? RpcParamsFromShape<Rule>
  : Rule extends "string" | "string?" | "string-null?"
    ? Rule extends "string-null?"
      ? string | null
      : string
    : Rule extends "number" | "number?"
      ? number
      : Rule extends "boolean?"
        ? boolean
        : Rule extends "json" | "json?"
          ? JsonObject
          : Rule extends "array" | "array?"
            ? ReadonlyArray<JsonValue>
            : Rule extends RpcEnumRule
              ? Rule["values"][number]
              : never;

/** Compile-time counterpart of the runtime RpcShape validator. */
export type RpcParamsFromShape<Shape extends RpcShape> = Readonly<
  { [Key in RpcRequiredKeys<Shape["fields"]>]: RpcRuleValue<Shape["fields"][Key]> } & {
    [Key in RpcOptionalKeys<Shape["fields"]>]?: RpcRuleValue<Shape["fields"][Key]>;
  }
>;

type DescriptorParams<Method extends DaemonRpcMethod, Descriptor = DaemonRpcDescriptor> = Descriptor extends {
  readonly method: infer Methods;
  readonly params: infer Params extends RpcShape;
}
  ? Method extends Methods
    ? RpcParamsFromShape<Params>
    : never
  : never;

type DaemonFleetChannelPayload = {
  readonly host: string;
  readonly port: number;
  readonly caPath: string;
  readonly servername?: string;
  readonly nodeId: string;
  readonly credential?: string;
  readonly rosterPath?: string;
  readonly assignmentId: string;
  readonly repoId: string;
  readonly viewRoot: string;
  readonly quotaBytes: number;
};
export type DaemonFleetTaskAction = FleetTaskAction;
type DaemonFleetTaskPayload = DaemonFleetChannelPayload & {
  readonly workspaceRoot?: string;
  readonly waitTimeoutMs?: number;
  readonly action:
    | DaemonFleetTaskAction
    | {
        readonly kind: "fleet-runtime";
        readonly method:
          | "repo.agentRuntime.spawn"
          | "repo.agentRuntime.cancel"
          | "repo.agentRuntime.overview"
          | "repo.agentRuntime.sessions.read";
        readonly payload: JsonObject;
      }
    | { readonly kind: "fleet-schedule"; readonly payload: JsonObject };
};
type DaemonFleetDocSyncPayload = DaemonFleetChannelPayload & {
  readonly workspaceRoot: string;
  readonly dryRun?: boolean;
  readonly paths?: readonly string[];
  readonly timeoutMs?: number;
};
type DaemonFleetConflictExitPayload = DaemonFleetChannelPayload & {
  readonly workspaceRoot: string;
  readonly action: "resolve" | "discard-local" | "overwrite-center";
  readonly conflictId: string;
};

type DaemonRpcParamOverrides = {
  readonly "protocol.hello": {
    readonly protocolVersion: ContractVersion;
    readonly sessionEnvironment?: DaemonSessionEnvironment;
    /** A receipt-rendering caller asks the daemon to begin its cooperative build drain. */
    readonly reportStaleBuild?: boolean;
  };
  readonly "daemon.fleet.task.run": { readonly payload: DaemonFleetTaskPayload };
  readonly "daemon.fleet.doc.sync": { readonly payload: DaemonFleetDocSyncPayload };
  readonly "daemon.fleet.conflict.exit": { readonly payload: DaemonFleetConflictExitPayload };
};

type RepoRpcParams<Payload> = {
  readonly repo: { readonly repoId: string };
  readonly payload: Payload;
};
type PresetRpcMethod = (typeof presetMethods)[number]["method"];
type DaemonGuiReadParams<Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap> =
  Method extends "daemon.gui.system.read"
    ? Readonly<Record<string, never>>
    : Method extends "daemon.gui.control.receipt"
      ? { readonly payload: import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap[Method] }
      : import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap[Method] extends Readonly<Record<string, never>>
        ? { readonly repo: { readonly repoId: string } }
        : RepoRpcParams<import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap[Method]>;

type DaemonRpcParamsFor<Method extends DaemonRpcMethod> = Method extends keyof DaemonRpcParamOverrides
  ? DaemonRpcParamOverrides[Method]
  : Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonStreamPayloadMap
    ? RepoRpcParams<import("./daemon-protocol-gui-types.ts").DaemonStreamPayloadMap[Method]>
    : Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap
      ? DaemonGuiReadParams<Method>
      : Method extends PresetRpcMethod
        ? RepoRpcParams<JsonObject>
        : DescriptorParams<Method>;

export interface DaemonProtocolHelloResult {
  readonly ok: true;
  readonly protocolVersion: ContractVersion;
  readonly methods: readonly DaemonRpcMethod[];
  readonly build: { readonly commit: string | null };
  readonly warning?: DaemonBuildStaleNotice;
}

export interface DaemonBuildDrainStatus {
  readonly liveRuntimeSessions: number;
  readonly pendingWrites: number;
  readonly attachingRepositories: number;
}

export interface DaemonBuildStaleNotice extends DaemonBuildDrainStatus {
  readonly code: "daemon_build_stale";
  readonly loadedBuildId: string | null;
  readonly diskBuildId: string | null;
  readonly message: string;
}

export interface DaemonStopResult {
  readonly ok: true;
  readonly command: "daemon-stop";
  readonly pid: number;
}

export interface DaemonRepoAttachProgress {
  readonly phase: "opening" | "recovering" | "catching-up";
  readonly applied: number | null;
  readonly total: number | null;
  readonly watermark: number | null;
}

export interface DaemonStatusResult {
  readonly ok: true;
  readonly daemonId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly entry: "source" | "dist";
  readonly build: {
    readonly version: string;
    readonly commit: string | null;
    readonly loadedBuildId: string | null;
    readonly diskBuildId: string | null;
    readonly drifted: boolean;
  };
  readonly connections: readonly {
    readonly id: string;
    readonly kind: "local" | "remote-endpoint" | "fleet-center";
    readonly displayName: string;
    readonly state: "enabled" | "disabled";
    readonly endpoint?: string;
  }[];
  readonly repos: readonly {
    readonly repoId: string;
    readonly rootDir: string;
    readonly mode: "local" | "remote-proxy" | "remote-center" | "remote-edge" | null;
    readonly state: "warming" | "attached" | "unavailable" | "closed";
    readonly generation: number | null;
    readonly queueDepth: number | null;
    readonly lastError: string | null;
    readonly causeClass: "data-shape" | "infrastructure" | "projection" | null;
    readonly recoveryMs: number | null;
    readonly materialization: {
      readonly state: (typeof materializationStateWords)[number];
      readonly lastCheckpointRevision: number;
      readonly lastCheckpointAt: string | null;
      readonly pendingWalEvents: number;
      readonly retryElapsedMs?: number;
      readonly reason?: "git_diverged" | "deterministic_failure" | "retry_budget_exhausted";
      readonly lastError?: string;
    } | null;
    readonly attach?: DaemonRepoAttachProgress;
  }[];
  readonly summary: string;
}

type DaemonRpcSuccessResult<Method extends DaemonRpcMethod> =
  Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonGuiReadResultMap
    ? import("./daemon-protocol-gui-types.ts").DaemonGuiReadResultMap[Method]
    : Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonStreamResultMap
      ? import("./daemon-protocol-gui-types.ts").DaemonStreamResultMap[Method]
      : Method extends "protocol.hello"
        ? DaemonProtocolHelloResult
        : Method extends "daemon.status"
          ? DaemonStatusResult
          : Method extends "daemon.stop"
            ? DaemonStopResult
            : Method extends "repo.preset.run.start" | "repo.preset.run.status"
              ? object
              : Method extends import("./daemon-protocol-gui-types.ts").DaemonGuiActionMethod
                ? import("./daemon-protocol-gui-types.ts").DaemonGuiActionResult
                : Readonly<Record<string, unknown>>;

/**
 * Authoritative method dictionary shared by the daemon dispatcher and every client.
 * Runtime validation remains the trust boundary; this map preserves its method/params/result
 * correlation through TypeScript instead of erasing it to JsonObject.
 */
export type DaemonRpcMethodMap = {
  readonly [Method in DaemonRpcMethod]: {
    readonly params: DaemonRpcParamsFor<Method>;
    readonly result:
      | DaemonRpcSuccessResult<Method>
      | import("./daemon-protocol-gui-types.ts").DaemonProtocolErrorResult;
  };
};

export type DaemonRpcParams<Method extends DaemonRpcMethod> = DaemonRpcMethodMap[Method]["params"];
export type DaemonRpcResult<Method extends DaemonRpcMethod> = DaemonRpcMethodMap[Method]["result"];

/** Parsed values are JSON-compatible at every nested object boundary. */
export type DaemonRpcWireValue<Value> =
  Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<DaemonRpcWireValue<Item>>
    : Value extends object
      ? Value & JsonObject & { readonly [Key in keyof Value]: DaemonRpcWireValue<Value[Key]> }
      : Value;
export type DaemonRpcWireParams<Method extends DaemonRpcMethod> = DaemonRpcWireValue<DaemonRpcParams<Method>>;
export type DaemonRpcCall<Method extends DaemonRpcMethod = DaemonRpcMethod> = Method extends DaemonRpcMethod
  ? { readonly method: Method; readonly params: DaemonRpcWireParams<Method> }
  : never;

export const DAEMON_RPC_SCHEMA = Object.freeze({
  id: "w3-daemon-rpc/v1",
  methods: allDaemonProtocolMethods.map(({ method, params }) => ({ method, params })),
});

export const daemonGuiInvokeFacets = Object.freeze([
  ...daemonGuiReadMethods,
  ...daemonGuiActionMethods,
  ...runtimeInstanceMethods.filter((method) => "guiBridgeMethod" in method),
  ...runtimeInstanceAuthMethods,
]);

export const jsonRpcMethodContracts = Object.freeze(
  allDaemonProtocolMethods.map(({ method, requiresRepo }) => ({
    method,
    requiresRepo,
    sinceVersion: currentDaemonProtocolVersion,
    deprecatedSince: null,
  })),
);

export default Object.freeze({
  id: "w3-daemon-protocol",
  phases: Object.freeze([
    "W3",
    "W2-GUI",
    "DocSync-B",
    "Runtime-B",
    "DecisionFact-A",
    "DecisionFact-B",
    "Migration-A",
    "W5-GUI-S2",
    "W5-GUI-S3",
    "Runtime-Instances-S1",
    "Runtime-Instances-S3",
    "Fleet-Wiring",
    "B2-S1",
    "G6-A",
    "G8",
    "Schedule-S3",
    "Settings-Kind",
    "Schedule-S4",
    "Persons-Registry",
    "PLT-TestEng-W1",
    "Schedule-S5",
    "Ontology-Explain-A",
    "Relation-G3c",
    "PLT-Ontology-4.1",
    "Governed-Entity-W1-B",
    "Ontology-4.1b",
    "Ontology-4.1c",
    "PLT-EdgeGUI-W2",
    "Governed-Entity-W1-D",
    "Governed-Entity-W1-F",
    "Governed-Entity-W2-0",
    "Governed-Entity-W2-B",
  ]),
  commands: daemonOwnedProtocolCommands,
  methods: Object.freeze([
    ...daemonProtocolMethods,
    ...runtimeInstanceMethods,
    ...runtimeInstanceAuthMethods,
    ...fleetProtocolMethods,
    ...daemonGuiReadMethods,
    ...daemonGuiActionMethods,
    ...daemonStreamFacets,
  ]),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([
    {
      id: DAEMON_RPC_SCHEMA.id,
      schema: "packages/daemon/src/protocol/daemon-protocol.contract.ts#DAEMON_RPC_SCHEMA",
      parser: "packages/daemon/src/protocol/daemon-protocol.contract.ts#validateDaemonRpcCall",
      writer: "packages/daemon/src/protocol/daemon-protocol.contract.ts#serializeDaemonRpcCall",
      error: "packages/daemon/src/protocol/daemon-protocol.contract.ts#DaemonProtocolContractError",
      negativeFixtures: Object.freeze(["packages/daemon/fixtures/contracts/w3-daemon-rpc-invalid.json"]),
    },
    ...daemonGuiReadSchemas,
    ...daemonGuiActionSchemas,
  ]),
});
export {
  actionForDaemonMethod,
  commandClassForAction,
  commandDescriptorForAction,
  daemonProtocolCommands,
  resolveThinCliCommand,
  thinCliCommands,
} from "./daemon-protocol-commands.ts";
export { taskActionHelpRows } from "./daemon-protocol-commands-task.ts";
export { daemonGuiActionMethods, daemonGuiStreamFacets, daemonStreamFacets } from "./daemon-protocol-gui-actions.ts";
export { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
export { validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
export type {
  AgendaAwaitingRow,
  AgendaTaskRow,
  DaemonAgendaPayload,
  DaemonAgendaResult,
  DaemonGuiActionMethod,
  DaemonGuiActionResult,
  DaemonGuiReadMethod,
  DaemonGuiReadPayloadMap,
  DaemonGuiReadResultMap,
  DaemonGuiRpcReadMethod,
  DaemonStreamMethod,
  DaemonStreamPayloadMap,
  DaemonStreamResultMap,
  DaemonHostOnlyGuiReadMethod,
  DaemonProtocolErrorResult,
  DaemonDecisionListPayload,
  DaemonDecisionListResult,
  DaemonDecisionSummaryRow,
  DaemonFactSummaryRow,
  DaemonRelationGraphFacet,
  DaemonRelationGraphFacetPayload,
  DaemonRelationGraphFacetResult,
  DaemonRelationGraphEdgeRow,
  DaemonRelationGraphFullResult,
  DaemonRelationGraphResult,
  DaemonRelationQueryPayload,
  DaemonTaskDispatchesPayload,
  DaemonTaskDispatchesResult,
  DaemonTaskDocumentListResult,
  DaemonTaskQueryPayload,
  DaemonTaskSnapshotInvalidRow,
  DaemonTaskSnapshotListResult,
  DaemonWorkspaceSummaryResult,
  ExecutionEvidenceProjection,
  GuiSubmissionV1,
  ObserveTailCursor,
  ObserveTailDirection,
  ObserveTailKind,
  ObserveTailPayload,
  ObserveTailResult,
  TaskDispatchRow,
  TaskDocumentListEntryRow,
  TaskPlacementSupplement,
} from "./daemon-protocol-gui-types.ts";
export { canonicalRoot, endpointIdentity, safePath, workspaceId } from "./daemon-protocol-identifiers.ts";
export type {
  CanonicalRoot,
  DaemonSessionEnvironment,
  EndpointIdentity,
  SafePath,
  WorkspaceId,
} from "./daemon-protocol-identifiers.ts";
export {
  daemonMethodAcceptsPayload,
  daemonMethodAcceptsPayloadExecutor,
  DaemonProtocolContractError,
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  isDaemonStreamMethod,
  parseDaemonRpcParams,
  serializeDaemonRpcCall,
  validateDaemonRpcCall,
} from "./daemon-protocol-rpc-validation.ts";
export {
  CATALOG_REREAD_RECEIPT_SCHEMA,
  DAEMON_AGENDA_SCHEMA,
  DAEMON_AGENT_ENTITY_CATALOG_SCHEMA,
  DAEMON_AGENT_ENTITY_DETAIL_SCHEMA,
  DAEMON_AGENT_RUNTIME_ATTACH_EVENT_SCHEMA,
  DAEMON_AGENT_RUNTIME_ATTACH_SCHEMA,
  DAEMON_AGENT_RUNTIME_EVENTS_SCHEMA,
  DAEMON_AGENT_RUNTIME_OVERVIEW_SCHEMA,
  DAEMON_AGENT_RUNTIME_SESSION_GROUPS_SCHEMA,
  DAEMON_AGENT_RUNTIME_SESSION_SCHEMA,
  DAEMON_AGENT_SKILL_CATALOG_SCHEMA,
  DAEMON_CONTROL_RECEIPT_SCHEMA,
  DAEMON_CI_OBSERVATORY_SCHEMA,
  DAEMON_DECISION_LIST_SCHEMA,
  DAEMON_DOCUMENT_READ_SCHEMA,
  DAEMON_ENTITY_ACTION_EXPLANATION_SCHEMA,
  DAEMON_OBSERVE_TAIL_SCHEMA,
  DAEMON_GUI_COMMAND_RECEIPT_SCHEMA,
  DAEMON_PROTOCOL_ERROR_SCHEMA,
  DAEMON_RELATION_GRAPH_SCHEMA,
  DAEMON_SQUAD_ENTITY_CATALOG_SCHEMA,
  DAEMON_SQUAD_ENTITY_DETAIL_SCHEMA,
  DAEMON_SQUAD_RUN_LIST_SCHEMA,
  DAEMON_SQUAD_RUN_READ_SCHEMA,
  DAEMON_TASK_DISPATCHES_SCHEMA,
  DAEMON_TASK_DOCUMENT_LIST_SCHEMA,
  DAEMON_TASK_SNAPSHOT_LIST_SCHEMA,
  DAEMON_WORKSPACE_SUMMARY_SCHEMA,
  GUI_CATALOG_PRESET_SCHEMA,
  GUI_CATALOG_SNAPSHOT_SCHEMA,
  GUI_SYSTEM_STATUS_SCHEMA,
  TERMINAL_ATTACH_EVENT_SCHEMA,
  TERMINAL_ATTACH_SCHEMA,
  TERMINAL_CONTROL_RECEIPT_SCHEMA,
  TERMINAL_DETACH_ACK_SCHEMA,
  TERMINAL_INPUT_ACK_SCHEMA,
  TERMINAL_SESSION_LIST_SCHEMA,
} from "./daemon-protocol-schema-ids.ts";
export { daemonGuiActionSchemas, daemonGuiReadSchemas } from "./daemon-protocol-schema-registry.ts";
export { validateGuiSubmission } from "./daemon-protocol-validate-entities.ts";
export {
  validateDaemonAgenda,
  validateDaemonDecisionList,
  validateDaemonRelationGraph,
} from "./daemon-protocol-validate-projections.ts";
export {
  daemonCommandReceiptRejectionCode,
  daemonProtocolError,
  invalidParamsReceipt,
  makeDaemonCommandReceipt,
  serializeDaemonAgenda,
  serializeDaemonDecisionList,
  serializeDaemonDocumentRead,
  serializeDaemonProtocolError,
  serializeDaemonRelationGraph,
  serializeDaemonTaskDispatches,
  serializeDaemonTaskDocumentList,
  serializeDaemonTaskSnapshotList,
  serializeDaemonWorkspaceSummary,
  serializeObserveTailResult,
  validateDaemonDocumentRead,
  validateDaemonGuiCommandReceipt,
  validateDaemonProtocolError,
  validateDaemonTaskDispatches,
  validateDaemonTaskDocumentList,
} from "./daemon-protocol-validate-results.ts";
export {
  isolateDaemonTaskSnapshotRows,
  validateDaemonTaskSnapshotList,
  validateDaemonWorkspaceSummary,
} from "./daemon-protocol-validate-task.ts";
