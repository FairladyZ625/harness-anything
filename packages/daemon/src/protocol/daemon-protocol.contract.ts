import { presetMethods } from "../../../preset/src/preset-command-contract.ts";
import type { ContractVersion } from "../../../kernel/src/domain/contract-version.ts";
import { effectiveDaemonOwnedProtocolCommands } from "./daemon-protocol-commands.ts";
import { daemonGuiActionMethods, daemonGuiStreamFacets } from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import { optionalEnum, shape } from "./daemon-protocol-gui-types.ts";
import { daemonGuiActionSchemas, daemonGuiReadSchemas } from "./daemon-protocol-schema-registry.ts";
import {
  daemonRepoModeWords,
  daemonRepoModeWordsAreExact,
  decisionStateWords,
  executionStateWords,
  executionV1StateWords,
  leasePhaseWords,
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
  packageDispositionWords,
  receiptOutcomeWords,
  relationStateWords,
  reviewVerdictWords,
  taskStatusWords,
};

export const currentDaemonProtocolVersion = Object.freeze({ major: 1, minor: 0 }) satisfies ContractVersion;

// Wire-validator mirrors of the kernel status vocabularies (register:
// packages/kernel/src/domain/status-vocabulary.ts, blueprint 铁律四). This module sits
// on the CLI's eager startup path, so it must not import the kernel barrel — the p50
// overhead gate refuses eager module growth — and deep kernel imports are restricted.
// The mirrors stay plain data; the status-vocabulary ratchet gate locks them against
// the kernel vocabularies so they cannot drift.
export const daemonProtocolMethods = Object.freeze([
  {
    id: "protocol.hello",
    phase: "W3",
    method: "protocol.hello",
    requiresRepo: false,
    params: shape({ protocolVersion: shape({ major: "number", minor: "number" }), sessionEnvironment: "json?" }),
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
      rootDir: "string",
      repoId: "string",
      mode: optionalEnum(daemonRepoModeWords),
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
    id: "repo.task.run",
    phase: "W3",
    method: "repo.task.run",
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
        permissionMode: "string?",
        isolationState: "string?",
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
  ...daemonGuiStreamFacets,
]);

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
  ]),
  commands: effectiveDaemonOwnedProtocolCommands,
  methods: Object.freeze([
    ...daemonProtocolMethods,
    ...runtimeInstanceMethods,
    ...runtimeInstanceAuthMethods,
    ...fleetProtocolMethods,
    ...daemonGuiReadMethods,
    ...daemonGuiActionMethods,
    ...daemonGuiStreamFacets,
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
export { daemonGuiActionMethods, daemonGuiStreamFacets } from "./daemon-protocol-gui-actions.ts";
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
  DaemonGuiStreamMethod,
  DaemonGuiStreamPayloadMap,
  DaemonGuiStreamResultMap,
  DaemonHostOnlyGuiReadMethod,
  DaemonProtocolErrorResult,
  DaemonRelationQueryPayload,
  DaemonTaskDispatchesPayload,
  DaemonTaskDispatchesResult,
  DaemonTaskDocumentListResult,
  DaemonTaskQueryPayload,
  DaemonTaskSnapshotListResult,
  DaemonWorkspaceSummaryResult,
  ExecutionEvidenceProjection,
  GuiSubmissionV1,
  ObserveTailCursor,
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
  daemonMethodAcceptsPayloadExecutor,
  DaemonProtocolContractError,
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  isDaemonGuiStreamMethod,
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
  DAEMON_OBSERVE_TAIL_SCHEMA,
  DAEMON_GUI_COMMAND_RECEIPT_SCHEMA,
  DAEMON_PROTOCOL_ERROR_SCHEMA,
  DAEMON_RELATION_GRAPH_SCHEMA,
  DAEMON_SQUAD_ENTITY_CATALOG_SCHEMA,
  DAEMON_SQUAD_ENTITY_DETAIL_SCHEMA,
  DAEMON_SQUAD_RUN_LIST_SCHEMA,
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
  daemonProtocolError,
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
export { validateDaemonTaskSnapshotList, validateDaemonWorkspaceSummary } from "./daemon-protocol-validate-task.ts";
