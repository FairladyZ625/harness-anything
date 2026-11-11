import { presetMethods } from "@harness-anything/preset/internal/preset-command-contract";
import type { ContractVersion } from "@harness-anything/kernel/contract-version";
import { currentDaemonProtocolVersion } from "./daemon-protocol-identifiers.ts";
export { currentDaemonProtocolVersion } from "./daemon-protocol-identifiers.ts";
import { daemonOwnedProtocolCommands } from "./daemon-protocol-commands.ts";
import {
  daemonGuiActionMethods,
  daemonStreamFacets,
  providerMethods,
  runtimeInstanceAuthMethods,
  runtimeInstanceMethods,
} from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import { daemonRepositoryReadMethods } from "./daemon-protocol-commands.ts";
import type { DaemonSessionEnvironment } from "./daemon-protocol-identifiers.ts";
import {
  allDaemonProtocolMethods,
  daemonProtocolMethods,
  fleetProtocolMethods,
  type DaemonRpcDescriptor,
  type DaemonRpcMethod,
} from "./daemon-protocol-commands.ts";
export {
  accessAdminOperations,
  allDaemonProtocolMethods,
  daemonGuiInvokeFacets,
  daemonProtocolMethods,
  fleetProtocolMethods,
  providerMethods,
  runtimeInstanceAuthMethods,
  runtimeInstanceMethods,
  type DaemonRpcDescriptor,
  type DaemonRpcMethod,
} from "./daemon-protocol-commands.ts";
import type { RpcEnumRule, RpcShape } from "./daemon-protocol-gui-types.ts";
import type { JsonObject, JsonValue } from "./json-rpc-types.ts";
import { daemonGuiActionSchemas, daemonGuiReadSchemas } from "./daemon-protocol-schema-registry.ts";
import type { DaemonStatusResult } from "./daemon-status-contract.ts";
import type { AgentRuntimeQuote } from "../runtime/cloud-dispatch-relay.ts";
export type { DaemonRepoAttachProgress, DaemonStatusResult } from "./daemon-status-contract.ts";
import {
  AGENDA_PIN_CRITERIA,
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
  AGENDA_PIN_CRITERIA,
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
export { builtInRuntimeProviderInputDeclaration } from "./daemon-protocol-commands-runtime-config.ts";

// Build-time projections of the kernel status vocabularies (register:
// packages/kernel/src/domain/status-vocabulary.ts, blueprint 铁律四). This module sits
// on the CLI's eager startup path, so it must not import the kernel barrel — the p50
// overhead gate refuses eager module growth — and deep kernel imports are restricted.
// The status-vocabulary ratchet rejects a stale generated region.

type RpcOptionalRule = "string?" | "string-or-empty?" | "string-null?" | "json?" | "array?" | "boolean?" | "number?";
type RpcOptionalKeys<Fields extends RpcShape["fields"]> = {
  readonly [Key in keyof Fields]-?: Fields[Key] extends RpcOptionalRule | { readonly optional: true } ? Key : never;
}[keyof Fields];
type RpcRequiredKeys<Fields extends RpcShape["fields"]> = Exclude<keyof Fields, RpcOptionalKeys<Fields>>;
type RpcRuleValue<Rule> = Rule extends RpcShape
  ? RpcParamsFromShape<Rule>
  : Rule extends "string" | "string?" | "string-or-empty?" | "string-null?"
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

type DaemonRpcParamOverrides = {
  readonly "protocol.hello": {
    readonly protocolVersion: ContractVersion;
    /** Compatibility window only (2026-11-03 CLI); remove with the schema field by 2026-12-04. */
    readonly buildCommit?: string | null;
    readonly sessionEnvironment?: DaemonSessionEnvironment;
    readonly executionCredential?: string;
    /** A receipt-rendering caller asks the daemon to begin its cooperative build drain. */
    readonly reportStaleBuild?: boolean;
    readonly invokingCommand?: string;
  };
  readonly "repo.agentRuntime.quote": {
    readonly model: string;
    readonly inputTokens?: number;
    readonly inputBytes?: number;
    readonly outputCapTokens?: number;
    readonly codeRun?: boolean;
  };
};

type RepoRpcParams<Payload> = {
  readonly repo: { readonly repoId: string };
  readonly payload: Payload;
};
type PresetRpcMethod = (typeof presetMethods)[number]["method"];
type DaemonGuiReadParams<Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonGuiReadPayloadMap> =
  Method extends "daemon.gui.system.read" | "daemon.gui.home.read"
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
  /** Informational: live workers the exit leaves behind for the next daemon to adopt; not a drain condition. */
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

type DaemonMethodResults = {
  readonly "repo.task.witness.run": DaemonTaskWitnessRunResult;
  readonly "daemon.skillEval.version.register": {
    readonly ok: true;
    readonly skill: import("../skill-eval-runner.ts").SkillEvalSkill;
  };
  readonly "daemon.skillEval.case.add": {
    readonly ok: true;
    readonly case: import("../skill-eval-runner.ts").SkillEvalCaseView;
  };
  readonly "daemon.skillEval.cases.list": {
    readonly ok: true;
    readonly cases: readonly import("../skill-eval-runner.ts").SkillEvalCaseView[];
  };
  readonly "daemon.skillEval.run": {
    readonly ok: true;
    readonly evaluation: import("../skill-eval-runner.ts").SkillEvalRunResult;
  };
};

export interface DaemonTaskWitnessRunResult {
  readonly schema: "command-receipt/v2";
  readonly ok: true;
  readonly command: "task-witness-run";
  readonly outcome: "no_changes";
  readonly witness: {
    readonly taskId: string;
    readonly executionId: string;
    readonly gateId: string;
    readonly witnessId: string | null;
    readonly result: "pass" | "fail" | null;
    readonly diagnostic: string;
    readonly runId: string | null;
    readonly state: import("@harness-anything/kernel").GateRun["state"] | null;
    readonly availability: import("@harness-anything/kernel").GateRun["availability"];
  };
}

type DaemonRpcSuccessResult<Method extends DaemonRpcMethod> = Method extends keyof DaemonMethodResults
  ? DaemonMethodResults[Method]
  : Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonGuiReadResultMap
    ? import("./daemon-protocol-gui-types.ts").DaemonGuiReadResultMap[Method]
    : Method extends keyof import("./daemon-protocol-gui-types.ts").DaemonStreamResultMap
      ? import("./daemon-protocol-gui-types.ts").DaemonStreamResultMap[Method]
      : Method extends "protocol.hello"
        ? DaemonProtocolHelloResult
        : Method extends "daemon.status"
          ? DaemonStatusResult
          : Method extends "daemon.stop"
            ? DaemonStopResult
            : Method extends "repo.agentRuntime.quote"
              ? AgentRuntimeQuote
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
    "Decision-Provider",
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
    "Governed-Entity-W2",
    "Repo-Lifecycle",
    "Ledger-Read",
    "Entity-Pin",
    "Edge-Resident-H1",
    "Fleet-Collab",
  ]),
  commands: daemonOwnedProtocolCommands,
  methods: Object.freeze([
    ...daemonProtocolMethods,
    ...runtimeInstanceMethods,
    ...providerMethods,
    ...runtimeInstanceAuthMethods,
    ...fleetProtocolMethods,
    ...daemonGuiReadMethods,
    ...daemonRepositoryReadMethods,
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
      negativeFixtures: Object.freeze([
        "packages/daemon/fixtures/contracts/w3-daemon-rpc-invalid.json",
        "packages/daemon/fixtures/contracts/gui-task-submit-packet-invalid.json",
      ]),
    },
    ...daemonGuiReadSchemas,
    ...daemonGuiActionSchemas,
  ]),
});
export {
  actionForDaemonMethod,
  commandClassForAction,
  commandDescriptorForAction,
  maybeCommandDescriptorForAction,
  commandIdForDaemonMethod,
  daemonProtocolCommands,
  hasCommandDescriptor,
  hiddenCliCommands,
  hiddenSince,
  resolveThinCliCommand,
  thinCliCommands,
} from "./daemon-protocol-commands.ts";
export { taskActionHelpRows } from "./daemon-protocol-commands-task.ts";
export { daemonGuiActionMethods, daemonGuiStreamFacets, daemonStreamFacets } from "./daemon-protocol-gui-actions.ts";
export { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
export { validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
export type {
  AgendaAwaitsRow,
  AgendaAnsweredRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaPinnedEntityRow,
  AgendaRestartRow,
  AgendaRulingRow,
  AgendaTaskRow,
  AgendaWorkRef,
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
  DaemonTaskDeliveryDiffResult,
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
  isDaemonGuiOnlyActionMethod,
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
  DAEMON_TASK_WIP_SCHEMA,
  DAEMON_WORK_INDEX_SCHEMA,
  DAEMON_WORKSPACE_SUMMARY_SCHEMA,
  DAEMON_WORKSPACE_SCOPE_SCHEMA,
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
export { isolateDaemonTaskSnapshotRows, validateDaemonTaskSnapshotList } from "./daemon-protocol-validate-task.ts";
export { validTaskDispatchRow, validateDaemonWorkspaceSummary } from "./daemon-protocol-validate-relation-query.ts";

export type { TaskAssignmentDirectory } from "./daemon-protocol-gui-types.ts";
