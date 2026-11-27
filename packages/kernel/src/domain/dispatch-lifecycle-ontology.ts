import { cloudSandboxPolicy } from "./runtime-execution-target.ts";
import { DEFAULT_DISPATCH_INSTANCE_CAPACITY, DISPATCH_LIFECYCLE_PAGE_LIMIT } from "./dispatch-lifecycle.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

/** Runtime aggregate declarations for dec_AEB05951C69E47FCE53E53C341/CH1 consumer cutover. */
export const dispatchLifecyclePolicies = [
  cloudSandboxPolicy,
  {
    id: "orphan-runtime-recovery",
    ownerRef: "runtime-session/runtime_session_outcome_observed",
    unit: "current RuntimeSession attempt and lease generation",
    bounds:
      "Repository admin recovery requires the original principal to be absent, a reason, and accepted stop evidence or an explicit unreachable ruling. Release uses the current terminal attempt's task, execution, and unreleased lease generation.",
    defaultValue: null,
    version: 1,
    scope: "center runtime terminal publication and task lease release",
    reason: "dec_B3802F58B1A80FBFC5AB8111CC/CH1 preserves original ownership while recording the acting administrator.",
    fixtures: [
      "packages/kernel/test/contracts/dispatch-lifecycle.test.ts",
      "packages/daemon/test/orphan-runtime-recovery.integration.test.ts",
    ],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/orphan-runtime-recovery.ts#orphanRuntimeLeaseStop:84674658c0e82d91fe7bfbf5424fcdcf",
        route: "orphan runtime lease release",
      },
    ],
  },
  {
    id: "dispatch-reservations",
    ownerRef: "runtime-session/run",
    unit: "provider slots / lifecycle capability",
    bounds:
      "Positive safe-integer capacity (default 64); reserved/held occupy a slot until accepted stop proof; recovering owners fail closed. Only a verified current running leaf with a declared provider steering strategy can steer; process liveness and attach remain independent of steering support. CLI steering uses interrupt-resume, ACP steering uses cancel-reprompt in the same session, and agy/zcode have no steering strategy. Only closed stopped groups hand off; consent waits for group closure even after delivery registration; group closure releases workspace ownership. A task admits only one implementation target until accepted stop proof, across instances and nodes, even after task lease release. An unconfirmed cloud stop revokes write authority and retains capacity until the admitting host reports a matched termination receipt.",
    defaultValue: DEFAULT_DISPATCH_INSTANCE_CAPACITY,
    version: 4,
    scope: "center-accepted dispatch lifecycle",
    reason: "Consumers use the reducer policy; node observations do not grant capacity or authority.",
    fixtures: [
      "packages/kernel/test/contracts/dispatch-lifecycle.test.ts",
      "packages/daemon/test/task-execution-arrangement.integration.test.ts",
      "packages/daemon/test/dispatch-lifecycle-consumers.integration.test.ts",
      "packages/daemon/test/runtime-steer-compare.test.ts",
      "packages/daemon/test/dispatch-read-lifecycle.test.ts",
      "packages/daemon/test/runtime-steering-capability.test.ts",
      "packages/daemon/test/runtime-worker-acp.test.ts",
      "packages/daemon/test/runtime-execution-target.integration.test.ts",
    ],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host/repo-cell-runtime-ingress.ts#appendAuxiliaryRuntimeIngress:bafde6c7428425b528f1814ff097ad5a",
      "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-repository-api.ts#createDaemonHostRepositoryApi.readNodeAutoClaimCandidates:921904248fd7c6864080e58564307106",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-control.ts#enforceRuntimeSpendCap:75d51b45ad4eaca54efd2fc7ad7ee991",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:c62f0c68b8807afea23f9471a77da597",
      "policy:packages/daemon:packages/daemon/src/daemon-host/squad-coordinator-publication.ts#makeSquadPublicationController.publishState:c33102c3afb14ad57596688874a8b88c",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:a491cd99bd418e1cb55841e3c427c91b",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:2ef193c4cf48dd763a7480a2729b2bf2",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#DEFAULT_DISPATCH_INSTANCE_CAPACITY:dd334dec9f46f5f11fb1d1dd3f7ff1c0",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchLifecycleView.policy:3a6cd80bd1b1fb5c482691be5feb32d9",
      "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-scheduling.ts#acpSteer.strategy:b4f689d42498817801d5dc27fd5c915d",
      "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-scheduling.ts#runtimeSteering.claude.strategy:5dc5f329f5b0f1fdf005e4997f8915a6",
      "policy:packages/kernel:packages/kernel/src/domain/runtime-instance-scheduling.ts#runtimeSteering.codex.strategy:5dc5f329f5b0f1fdf005e4997f8915a6",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-control.ts#steerRuntime.refuse:1e1fcd3898c968cf1017328d0d3f16b5",
      "policy:packages/daemon:packages/daemon/src/daemon-host/dispatch-read.ts#unsettledCutReviewDispatches.rows.shallow:00191b086680e4e98da6ac785758b04a",
      "policy:packages/application:packages/application/src/queries/task-query-read.ts#makeTaskQueryReadModel.agenda.awaitingRuling:632767b9b836887b526c540ca6ec1de4",
      "policy:packages/application:packages/application/src/queries/task-query-read.ts#makeTaskQueryReadModel.agenda.awaitingRuling:c6e10f3bdbdac92ac14cf8e1b3956656",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle:c41671665f96a2179bde52064ae469c8",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle:b9f7804a5216d05b525d0a06811c57cd",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle.ruling:009d57c1b7f3765c6a9fd1b3f0b1a793",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt:6dba184e3b1114eae18563b6b97332b8",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt.task.leaseVersion:2ab8993af980b44a91f1a45b2613c14a",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt.task.leaseReleased:0918a2f9659dad6c63671c8ae06c7017",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceTaskInput.leaseReleased:0918a2f9659dad6c63671c8ae06c7017",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceTaskInput.leaseReleased:498048790eb1a34fc0e663022331a4c4",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceTaskInput.next.process:c6ae80d4256e00eff93d27c88ddea7ed",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:63605f8a41fedb841529e78733cab616",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt.process:fa83101db8a4eb6f0cd97ba2992000f8",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:48a3fe14a3312d70e7455c4ee250ac58",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:1a0c1f96aeada60fa9bab7ff3c6ce7ea",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:14cce213856acfa3802e6a745d6e1f56",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:14cce213856acfa3802e6a745d6e1f56:2",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt.process:c6ae80d4256e00eff93d27c88ddea7ed",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-adoption.ts#restoreRuntime:d39fbef62f44828009059f3f0ce2fd2c",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-adoption.ts#adoptRuntimes.attempts:3acc8e2fd2bd500969e418a061417356",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-adoption.ts#adoptRuntimes.attempts.entry.promise:63ba9e7ca07c56c87c38c0eb197a549e",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-control.ts#cancelRuntime:f5df1a0d1e12f3f5c929f18372136fb9",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-settlement.ts#publishExit:60f86f6f5bf22a6150394316d146f8be",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#groupPhase:171d9f15c52731280169438855ac1d16",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reservationState:5a6b67dc8e36505999c566a5eb523563",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reservationState:1a22eb8370060eb30e748ffda9d9be05",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchCapacityDisposition:f9b6a19348e2b50782ed3aaa79349fe2",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchCapacityDisposition:9a9507c167c8949ad9b9d98b1f83e043",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchLifecycleView.policy.blockerCode:6123979e07a7a1d5d8b476ef89781c3c",
    ].map((candidateId) => ({ candidateId, route: "readDispatchLifecycle" })),
  },
  {
    id: "execution-credential",
    ownerRef: "runtime-session/runtime_session_started",
    unit: "authenticated execution",
    bounds:
      "Exact person, source, dispatch and task/execution binding; unexpired credential and lifecycle write permission, with current submitted-worker publication and terminal-settlement exceptions.",
    defaultValue: null,
    version: 1,
    scope: "center-accepted dispatch lifecycle",
    reason: "Consumers use the reducer policy; node observations do not grant capacity or authority.",
    fixtures: ["packages/daemon/test/runtime-execution-credential.test.ts"],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-execution-scope.ts#requireCurrentExecutionScope:4b633614a3b936acec73c1d27becb9d0",
    ].map((candidateId) => ({ candidateId, route: "readDispatchLifecycle" })),
  },
  {
    id: "handoff-source",
    ownerRef: "action:runtime-handoff-export",
    unit: "settled opted-in Codex source",
    bounds:
      "Task/execution/agent and provider session required; canonical canHandoff and complete outcome evidence required.",
    defaultValue: null,
    version: 1,
    scope: "center-accepted dispatch lifecycle",
    reason: "Consumers use the reducer policy; node observations do not grant capacity or authority.",
    fixtures: ["packages/daemon/test/runtime-handoff.integration.test.ts"],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-handoff-store.ts#runRuntimeHandoffAction:e377f735156e6329291914303a5c00e7",
    ].map((candidateId) => ({ candidateId, route: "readDispatchLifecycle" })),
  },
  // dec_7E44897ECDCAEF2B92EC66A260/CH1: the remaining runtime-session kernel values.
  {
    id: "dispatch-lifecycle-page",
    ownerRef: "runtime-session/run",
    unit: "dispatch groups per read",
    bounds:
      "Dispatch lifecycle reads and admission scans return or accept at most 100 groups or dispatch ids per page.",
    defaultValue: DISPATCH_LIFECYCLE_PAGE_LIMIT,
    version: 1,
    scope: "center dispatch lifecycle reads",
    reason: "Bound lifecycle reads with the existing page size; callers continue to page instead of scanning.",
    fixtures: ["packages/kernel/test/contracts/dispatch-lifecycle.test.ts"],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#DISPATCH_LIFECYCLE_PAGE_LIMIT:3465c2b2feb754fa72eaab22d40c1efe",
    ].map((candidateId) => ({ candidateId, route: "DISPATCH_LIFECYCLE_PAGE_LIMIT" })),
  },
  {
    id: "runtime-attempt-record",
    ownerRef: "runtime-session/runtime_dispatch_requested",
    unit: "attempt index / attempt outcome",
    bounds:
      "A dispatch request's attemptIndex is a non-negative integer when present, and its cloud execution target names a registered host; an observed outcome attempt carries only its declared classification, reason and fallback fields. Handoff packets report a known failure only for failed, unknown or stopped attempts, with the error clipped to 500 characters.",
    defaultValue: null,
    version: 1,
    scope: "runtime session events and handoff packets",
    reason: "Attempt records are evidence, not retry authority; the existing shape checks are declared once.",
    fixtures: [
      "packages/kernel/test/contracts/runtime-session-action.test.ts",
      "packages/kernel/test/handoff-packet.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/agent-runtime.ts#validateAgentRuntimePayloadFields:2f154e232f9b5aaa8f34ed945c55873e",
      "policy:packages/kernel:packages/kernel/src/domain/agent-runtime.ts#validateAgentRuntimePayloadFields:d414e72c89c251c45f5e4fba8c81516a",
      "policy:packages/kernel:packages/kernel/src/domain/agent-runtime.ts#validateAgentRuntimePayloadFields:dd2ef093bbcda3d6ec5575a89f38b657",
      "policy:packages/kernel:packages/kernel/src/handoff-packet.ts#failureList:36c6074f0b2268c178b00030c123d468",
    ].map((candidateId) => ({ candidateId, route: "runtime attempt record" })),
  },
  {
    id: "runtime-mcp-policy",
    ownerRef: "runtime-session/run",
    unit: "MCP inheritance policy (disabled | inherit)",
    bounds:
      "Effective host MCP inheritance resolves Dispatch > Agent > Runtime Instance > 'disabled'. Only codex and claude declare capabilities.mcp='supported'; other kinds reject 'inherit' fail-closed. Codex emits --ignore-user-config only when disabled under operator-environment; Claude emits --strict-mcp-config whenever disabled.",
    defaultValue: "disabled",
    version: 1,
    scope: "runtime instance configuration, agent declaration, dispatch spawn, adoption, and GUI/CLI controls",
    reason:
      "Unattended dispatches must not silently inherit ambient host MCP servers unless explicitly permitted via supported precedence.",
    fixtures: ["packages/daemon/test/runtime-mcp-policy.test.ts", "packages/cli/test/runtime-mcp-policy-cli.test.ts"],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-instance-store.ts#openRuntimeInstanceStore.command.updated.mcpPolicy:598f48448e2dd4d68d8417b65484b600",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-launch-config.ts#launchArgs.args:87389b96d515f84ff8b3fe4b924c2b90",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-launch-config.ts#launchArgs.args:45c61b510d71675c56eb9c6c79a01a85",
      "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts#daemonActionRoutes.mcpPolicy:7f9318b109c62120f4b0ba2305c64206",
      "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts#runtimeInstanceMethods.params.payload.mcpPolicy:7f9318b109c62120f4b0ba2305c64206",
      "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts#runtimeInstanceMethods.params.payload.mcpPolicy:90dba27cca667387b692c8f2bbf7339c",
      "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-rpc-validation.ts#validateNamedActionPayload:6eedd1565c328655ece2dd367650d422",
      "policy:packages/daemon:packages/daemon/src/runtime-engine/runtime-permissions.ts#resolveRuntimeMcpPolicy:530fe8a3cae5a7d85322a8c675c04852",
      "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-spawn-adoption.ts#adoptableMetadata:07f97fbfbfd0d7354baaca0be82565a6",
      "policy:packages/gui:packages/gui/src/preload/allowlist.ts#runtimeInstanceCreateProblem:2e92c6e8fa016915e95b3a2e519d3715",
      "policy:packages/gui:packages/gui/src/renderer/components/DispatchDialog.tsx#DispatchDialog.buildRequest:bbebe9445fddc6365fce4307fc002c27",
      "policy:packages/gui:packages/gui/src/renderer/runtime-instance-form.ts#buildRuntimeInstanceCreatePayload:a4343e019d20c83b1905f13990b1b745",
      "policy:packages/gui:packages/gui/src/renderer/runtime-instance-form.ts#buildRuntimeInstanceUpdatePayload:489491eb4b0023f476c9f1700080f5c6",
      "policy:packages/kernel:packages/kernel/src/domain/agent-squad-schema.ts#AGENT_DECLARATION_V1_SCHEMA.properties.mcpPolicy:011e7e580252423f8491d6ec2ca84711",
      "policy:packages/cli:packages/cli/src/cli/thin-command-runtime-instance-update.ts#parseRuntimeInstanceUpdate.mcpPolicy:6cba98852757dce509c2360980bc0e57",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#prepareAgentEntityInstall:9560851e132f2e2ed17f43aa1f8c34ab",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#applyAgentRuntimeOverrides.mcpPolicy:9f63e1d5398000d9accec24d1e3afb6a",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#applyAgentRuntimeOverrides:4ddfd7824080ae52a917240d0b76ddd4",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#readAgentEntityDeclarationSource:824793f378927ed1c22a0bb84435f92c",
      "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#readAgentEntityDeclarationSource.withOverride:a22abc29ccefa629214a55ebf98a84c8",
      "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/agent-entity-contract.ts#agentMcpPolicyError:bd365f101f6f79b1c33bdd657352fb50",
      "policy:packages/daemon:packages/daemon/src/daemon-host/gui-s3-control.ts#validateRuntimeSpawnReceipt.errors.mcpPolicy:4d74ef4f44eaba9c914694bf5b0f17c9",
    ].map((candidateId) => ({ candidateId, route: "runtime mcp policy" })),
  },
] as const satisfies readonly OntologyPolicyDeclaration[];

/** The receipt is the sole source of current display/agenda/consent conclusions. */
export const dispatchLifecycleJudgment = {
  id: "dispatch-lifecycle-read",
  symbol: "packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchLifecycleHasPendingWork",
  inputs: ["readonly DispatchLifecycleRead[]"],
  output: "boolean",
  failureCodes: [],
  explain:
    "Project the center lifecycle cut, including unavailable/pending state; consumers only compose those policies over their indexed execution rows.",
  consumers: ["packages/application/src/queries/task-query-read.ts"],
  sources: [],
} as const satisfies OntologyJudgmentDeclaration;
// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonRuntimeSessionPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.sessionDto.attemptChain:fd82fa4d3f11f92b2b835daa6b6a0ba5",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.sessionDto.attemptChain",
    "attemptChain = detail.attemptChain === true ? input.readAttemptChain?.(session.runtimeSessionId) : undefined,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.readRuntimeSessionById.candidates.limit:84d5701d2773edd2d7075dc1615f708c",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.readRuntimeSessionById.candidates.limit",
    ".readRuntimeSessionPage({ limit: 8, afterRuntimeSessionId: runtimeSessionId })",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.readSessionGroupInputs.dispatches.shallow:00191b086680e4e98da6ac785758b04a",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.readSessionGroupInputs.dispatches.shallow",
    "...(unsettledOnly ? { shallow: true } : {}),",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.session.dto.attemptChain:14d0762c2a4e9497984a3bcef48b5748",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#makeAgentRuntimeReadModel.session.dto.attemptChain",
    "{ attemptChain: true, context: true },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#sessionGroupsQuery:114905f6432233f8b0ca8a1b00093f97",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#sessionGroupsQuery",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#sessionGroupsQuery.limit:13e34ed06a7f8e0b91c55872c8faef0b",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#sessionGroupsQuery.limit",
    'limit: typeof limit === "number" ? limit : 200,',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#overviewQuery:08e907891399e385fd46dad90280fddd",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#overviewQuery",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#overviewQuery.limit:5b9089c35509a9df61ead8005a774475",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#overviewQuery.limit",
    'limit: typeof payload.limit === "number" ? payload.limit : null,',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#CONTROL_RECEIPTS_DEFAULT_LIMIT:09578efe5364ecdfaeebbb37a219f021",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#CONTROL_RECEIPTS_DEFAULT_LIMIT",
    "const CONTROL_RECEIPTS_DEFAULT_LIMIT = 500;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#CONTROL_RECEIPTS_MAX_LIMIT:4ff8b8e114c2f48d0dce350e4911c49b",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#CONTROL_RECEIPTS_MAX_LIMIT",
    "const CONTROL_RECEIPTS_MAX_LIMIT = 500;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#readSessionControlReceipts.events.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#readSessionControlReceipts.events.limit",
    "limit: 1,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#readSessionControlReceipts.hasMore.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#readSessionControlReceipts.hasMore.limit",
    "limit: 1,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#runtimeSessionTarget:8421dc0737d3a7b15f44d51f0a83d4e8",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#runtimeSessionTarget",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-read.ts#runtimeSessionTarget.controlReceiptsLimit:6bb93896e32ae507c9b44d3773c1ed8b",
    "packages/daemon/src/daemon-host/agent-runtime-read.ts#runtimeSessionTarget.controlReceiptsLimit",
    'controlReceiptsLimit: typeof controlReceiptsLimit === "number" ? controlReceiptsLimit : null,',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-stream.ts#BUFFER_LIMIT:a18e2d7cd087689da1cdcf957be93f10",
    "packages/daemon/src/daemon-host/agent-runtime-stream.ts#BUFFER_LIMIT",
    "const BUFFER_LIMIT = 32,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-stream.ts#validateAgentRuntimeAttachEvent:ec07371839e42d2c84ea69efe396fcb1",
    "packages/daemon/src/daemon-host/agent-runtime-stream.ts#validateAgentRuntimeAttachEvent",
    "return allowed &&",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-token-usage.ts#windowDispatches.page.limit:bf38217595aafee0d2b364031d7e7000",
    "packages/daemon/src/daemon-host/agent-runtime-token-usage.ts#windowDispatches.page.limit",
    "limit: 200,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-runtime-token-usage.ts#validateAgentRuntimeTokenUsage:acae5077ef34610dd5953a85c09bd548",
    "packages/daemon/src/daemon-host/agent-runtime-token-usage.ts#validateAgentRuntimeTokenUsage",
    "return isRecord(value) &&",
  ],
  [
    "policy:packages/application:packages/application/src/commands/entity-action-runtime-session.ts#compileRuntimeSessionDraft:d03e2d428abfb3b4114994b23051f290",
    "packages/application/src/commands/entity-action-runtime-session.ts#compileRuntimeSessionDraft",
    'if (draft.event.type === "runtime_session_outcome_observed" && (!claim || draft.resultBody === undefined))',
  ],
] as const;

export const daemonResidentCeoPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.residentCeoService.service.runtime.run.receipt.mcpPolicy:10b79b4f8c0b0052d770c191c1551d40",
    "residentCeoRuntime",
    "Resident CEO runtime turns use the disabled MCP policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.page.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "residentCeoInbox",
    "Resident CEO inbox reads use the bounded page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.receipt.limit:5fe71253427187a597c501af26bb9f84",
    "residentCeoInbox",
    "Resident CEO peer inbox scans use the bounded 20-item page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.page.limit:bf38217595aafee0d2b364031d7e7000",
    "residentCeoInbox",
    "Resident CEO event reads use the bounded page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#buildResidentCeoPeerPrompt:11661183103d11112a6e7623dadf7ebe",
    "residentCeoDelegation",
    "Resident CEO emits structured delegation proposal prompts only under approval-gated policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#lookupOpenPeerRequest.receipt.limit:5fe71253427187a597c501af26bb9f84",
    "residentCeoDelegation",
    "Resident CEO peer request lookup uses the bounded 20-item page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.residentCeo:aef06d760255c24353dbf1eb0e7fbd62",
    "residentCeoHistory",
    "Resident CEO history RPC enforces a positive integer limit when provided.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-action-routes.ts#daemonActionRoutes.params.payload.limit:01756949446e0e6666f8f2734b5d34fc",
    "residentCeoHistory",
    "Resident CEO history RPC declares an optional numeric limit parameter.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/protocol/daemon-protocol-validate-resident-ceo.ts#isValidResidentCeoProfileValue:7d58a8aae3b613cceececf6795dbff1a",
    "residentCeoExecutionPolicy",
    "Daemon Resident CEO wire validator checks optional Phase 2/3 executionPolicy field type.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#makeResidentCeoDelegationExecutor.supersedeTask.lease:d3239ee575bedbec62c58895d0b71a30",
    "residentCeoDelegation",
    "Resident CEO supersedeTask inspects projected lease presence before cancelling a superseded task.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#makeResidentCeoDelegationExecutor.supersedeTask:f5514f6f64533eccd5816f28d905a3c3",
    "residentCeoDelegation",
    "Resident CEO supersedeTask releases expired orphaned leases non-forcibly before cancelling.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#makeResidentCeoDelegationExecutor.supersedeTask:10f386931409c69a8dc757f7de578fd4",
    "residentCeoDelegation",
    "Resident CEO supersedeTask fails closed if releasing an expired orphaned lease is not applied.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#makeResidentCeoDelegationExecutor.supersedeTask:ba8b7c546aa12688a02d1cd7f36ec37f",
    "residentCeoDelegation",
    "Resident CEO supersedeTask refuses to supersede tasks holding an active unexpired lease.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#makeResidentCeoDelegationExecutor.supersedeTask.execDetail:5a7d7b3fcfaac535dc31cc8736f5b723",
    "residentCeoDelegation",
    "Resident CEO supersedeTask includes execution id detail when surfacing active-lease refusal.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn:e4023be11ba35917effadb3f203700a6",
    "residentCeoDelegation",
    "Resident CEO records structured proposals instead of advisory replies only under approval-gated policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn.tier0Count:662083f8cc10560db44035f318683c64",
    "residentCeoTieredActions",
    "Resident CEO tracks per-turn Tier 0 action executions against the hard cap on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn:2b5ebce2fe09c33c9eb2d0af61de0af8",
    "residentCeoTieredActions",
    "Resident CEO fail-closed rejects Tier 2 actions on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn:56c8f36ee12dc2478a8bdadd4df6b216",
    "residentCeoTieredActions",
    "Resident CEO records denied audit entries for invalid structured actions on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO tags invalid action denials with their tier on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn:5deb79f6578f85fc307e20504bfc33e4",
    "residentCeoTieredActions",
    "Resident CEO routes Tier 0 actions through per-turn rate limits and allowlist checks on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO tags Tier 0 rate-limit denials on peer turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#extractTaskSnapshot.lease:0a0a2e5514a35793c372e35ea1e68f33",
    "residentCeoTieredActions",
    "Resident CEO extracts task lease snapshots from task-show receipts for secondary lease checks.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#buildResidentCeoHumanChatPrompt:6f49431f9231c1341f98f63ea5e4bd7f",
    "residentCeoTieredActions",
    "Resident CEO emits structured Tier 0/1 action prompt guidance on human-chat only under approval-gated policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#makeResidentCeoExtendedActionMethods.archiveOrCancelUnleased:fd4526595dbdea06736277c8b13b0925",
    "residentCeoTieredActions",
    "Resident CEO verifies expired own-lease release succeeded before cancelling an unleased task.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn:1578209e8b1792b0f850666545372d90",
    "residentCeoTieredActions",
    "Resident CEO executes declarative actions on human-chat only under approval-gated policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn.tier0Count:662083f8cc10560db44035f318683c64",
    "residentCeoTieredActions",
    "Resident CEO enforces the per-turn Tier 0 action cap on human-chat turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn:782b5de21488e2cd114b9d05e727d105",
    "residentCeoTieredActions",
    "Resident CEO fail-closed rejects Tier 2 actions even on owner human-chat turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn:f863e0fe5c19205977c33d6117a277fd",
    "residentCeoTieredActions",
    "Resident CEO records denied audit entries for invalid structured actions on human-chat turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO tags invalid action denials with their tier on human-chat turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn:e58b94d39ff84b0874d0e9a612f92456",
    "residentCeoTieredActions",
    "Resident CEO routes Tier 0 actions through the per-turn cap and owner-direct executor on human-chat.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO tags Tier 0 rate-limit denials on human-chat turns.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-action-executor.ts#settleResidentCeoHumanChatTurn.tier:4f64871c217fe3773f0cccfe18e74d2c:2",
    "residentCeoTieredActions",
    "Resident CEO tags Tier 1 action receipts on human-chat turns.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#RESIDENT_CEO_MAX_TIER0_ACTIONS_PER_TURN:2d6f17bd9be6ce4989efb5b7cead0c3e",
    "residentCeoTieredActions",
    "Resident CEO caps Tier 0 collaborative actions at 3 per wake turn.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoLeaseBlock.hasOwnExpiredLease:d20d7aef825ad8e820b95ba24f3e082a",
    "residentCeoTieredActions",
    "Resident CEO allows cleanup when no lease or a released lease is present.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoLeaseBlock:b17dc7397ee2edc13e814315375b63ad",
    "residentCeoTieredActions",
    "Resident CEO treats null or released task leases as unblocking.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoLeaseBlock.expiresMs:e716a230031c441ad80da702d3a59f51",
    "residentCeoTieredActions",
    "Resident CEO parses lease expiration timestamps when checking active leases.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoLeaseBlock:d0db6c39c4eb27d1e1bbd1ab92d374f9",
    "residentCeoTieredActions",
    "Resident CEO blocks Tier 1 cleanup or startup whenever an unexpired held or reserving lease exists.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoLeaseBlock.holderPersonId:a8a04919db3307cfce9f7dc438d53dfe",
    "residentCeoTieredActions",
    "Resident CEO inspects lease principal ownership before permitting expired-lease cleanup.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#rejectedAction.tier:8c76679046418eb45b8a3b94eb52ce06",
    "residentCeoTieredActions",
    "Resident CEO marks malformed or unknown actions as rejected during turn parsing.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:1259b205335b0f5297b1885b49e23ae2",
    "residentCeoTieredActions",
    "Resident CEO classifies forbidden Tier 2 actions explicitly during turn parsing.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO classifies peer_ask as a Tier 0 collaborative action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord:cee881fcd7a997505002b5104b8544f1",
    "residentCeoTieredActions",
    "Resident CEO requires a non-empty claim for answered Tier 0 peer_reply actions.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:459db4af512dfcab4c9e974898d14656:2",
    "residentCeoTieredActions",
    "Resident CEO classifies peer_reply as a Tier 0 collaborative action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:459db4af512dfcab4c9e974898d14656:3",
    "residentCeoTieredActions",
    "Resident CEO classifies runtime_steer as a Tier 0 collaborative action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO classifies promote_and_dispatch as a Tier 1 reversible action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:4f64871c217fe3773f0cccfe18e74d2c:2",
    "residentCeoTieredActions",
    "Resident CEO classifies start_and_dispatch_existing as a Tier 1 reversible action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:4f64871c217fe3773f0cccfe18e74d2c:3",
    "residentCeoTieredActions",
    "Resident CEO classifies archive_or_cancel_unleased as a Tier 1 reversible action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseSingleActionRecord.tier:4f64871c217fe3773f0cccfe18e74d2c:4",
    "residentCeoTieredActions",
    "Resident CEO classifies doc_sync_plan as a Tier 1 reversible action.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseResidentCeoTurnActions.tier:8c76679046418eb45b8a3b94eb52ce06",
    "residentCeoTieredActions",
    "Resident CEO rejects non-object entries inside a structured actions array.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#parseResidentCeoTurnActions.actions.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO falls back to a Tier 1 promote_and_dispatch proposal on unstructured peer delegations.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#denyTier0Access.allowed:f0ce3ef598574b1ebe708af042563f87",
    "residentCeoTieredActions",
    "Resident CEO denies Tier 0 collaborative actions when policy or allowlist guards fail.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#allowTier0Access.allowed:d3583fbbe4fa23918ff42c68ae84c60d",
    "residentCeoTieredActions",
    "Resident CEO permits Tier 0 collaborative actions under owner-direct or allowlist-auto trust.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoTier0Access:19855867423f330d1ca220cd98324480",
    "residentCeoTieredActions",
    "Resident CEO Tier 0 access evaluation requires explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo-actions.ts#evaluateResidentCeoOwnerDirectApproval:df45cef069b39bc125b23b2ad3fb8fe5",
    "residentCeoTieredActions",
    "Resident CEO owner-direct fastpath requires explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.approveProposal.deniedAudit.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO audits denied Tier 1 proposal executions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.approveProposal.audit.tier:4f64871c217fe3773f0cccfe18e74d2c",
    "residentCeoTieredActions",
    "Resident CEO audits executed Tier 1 proposals.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.targetRef:c8316d69885b12ef0661c6a0b15c78cf",
    "residentCeoTieredActions",
    "Resident CEO resolves target reference for Tier 0 peer_reply actions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.targetRef:d12620a91c5b7e2f64738948a90f5b9b",
    "residentCeoTieredActions",
    "Resident CEO resolves target reference for Tier 0 peer_ask actions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.access.targetPersonId:b3206c53266cebc593887f21debfa29d",
    "residentCeoTieredActions",
    "Resident CEO passes destination person id when checking Tier 0 peer_ask access.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.access.targetPeerRequestId:5524cb1f618a3e99a731280ad9625ace",
    "residentCeoTieredActions",
    "Resident CEO passes destination request id when checking Tier 0 peer_reply access.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.deniedAudit.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO audits denied Tier 0 collaborative actions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO returns denied Tier 0 action receipts.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action:95755ebb14263349ad1fde64298fab01",
    "residentCeoTieredActions",
    "Resident CEO dispatches authorized Tier 0 peer_ask executions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action:9289f228928e626b998fdc62e322335b",
    "residentCeoTieredActions",
    "Resident CEO dispatches authorized Tier 0 peer_reply executions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.failedAudit.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO audits failed Tier 0 collaborative action executions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.tier:459db4af512dfcab4c9e974898d14656:2",
    "residentCeoTieredActions",
    "Resident CEO returns failed Tier 0 action receipts.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.successAudit.tier:459db4af512dfcab4c9e974898d14656",
    "residentCeoTieredActions",
    "Resident CEO audits succeeded Tier 0 collaborative action executions.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.executeTier0Action.tier:459db4af512dfcab4c9e974898d14656:3",
    "residentCeoTieredActions",
    "Resident CEO returns succeeded Tier 0 action receipts.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.recordTier2Rejection.audit.tier:1259b205335b0f5297b1885b49e23ae2",
    "residentCeoTieredActions",
    "Resident CEO audits fail-closed Tier 2 action rejections.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.recordTier2Rejection.tier:1259b205335b0f5297b1885b49e23ae2",
    "residentCeoTieredActions",
    "Resident CEO returns denied Tier 2 action receipts.",
  ],
  [
    "policy:packages/gui:packages/gui/src/renderer/api-client-resident-ceo.ts#isResidentCeoProfile:7d58a8aae3b613cceececf6795dbff1a",
    "residentCeoExecutionPolicy",
    "GUI Resident CEO wire guard tolerates omitted Phase 2/3 executionPolicy while checking string type when present.",
  ],
  [
    "policy:packages/gui:packages/gui/src/renderer/views/ResidentCeoView.tsx#ResidentCeoView.historyQuery.queryFn.limit:281836eca24c2eb78d50f8542399ca4d",
    "residentCeoHistory",
    "GUI Resident CEO cockpit requests the bounded 100-entry persisted conversation timeline.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#listResidentCeoHistoryEntries.limit:eba8fd443e16bbaec961dd9f8bfe43c9",
    "residentCeoHistory",
    "Resident CEO history projection clamps positive integer limits to the bounded 100-entry retention ceiling.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed:5901726fc470828d319870e7e7bcc4d9",
    "residentCeoExecutionPolicy",
    "Resident CEO write actions require explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoAutoApproval:a95900d267414754d1c9627eee2f8b93",
    "residentCeoExecutionPolicy",
    "Resident CEO allowlist auto-approval requires explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#createResidentCeoProfile:08f270fc2b07c6f7ddcfa00ad67d112f",
    "residentCeoExecutionPolicy",
    "Resident CEO profile creation enforces valid execution policy and bounded heartbeat interval.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#checkResidentCeoGatePreconditions:7188e0b1b563047165cc4c5c40a9f495",
    "residentCeoApprovalGate",
    "Resident CEO approval gate preconditions require explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed when deterministic preconditions are unmet.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:2",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed on provider or transport errors.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:3",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed when selected option is unrecognized.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:4",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed on abstain option insufficient_information.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:5",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed when Decider selects require_human_approval.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:6",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed when approve_low_risk confidence is missing.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:ecae9f54f5851a040147a46f3f70a8fa:7",
    "residentCeoApprovalGate",
    "Resident CEO approval gate fails closed when approve_low_risk confidence is below minConfidence.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoGateDecision.allowAutoPromote:7b92a32a854808f8f3ce383852ccd840",
    "residentCeoApprovalGate",
    "Resident CEO approval gate permits auto-promotion only when deterministic preconditions and calibrated confidence threshold hold.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.commitProfileMutation.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "residentCeoProfileCas",
    "Resident CEO profile mutations retry optimistic CAS conflicts with a bounded 4-attempt ceiling.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.commitProfileMutation:5c2f8dd8bfc1d1749c78cdabdbb1d1cc",
    "residentCeoProfileCas",
    "Resident CEO profile CAS retry rethrows immediately on non-conflict errors or after the final attempt.",
  ],
] as const;

export const residentCeoJudgments = [
  {
    id: "resident-ceo-principal",
    symbol: "packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoPrincipal",
    inputs: ["ResidentCeoProfile", "principalPersonId"],
    output: "void or ResidentCeoProfileError",
    failureCodes: ["resident_ceo_principal_mismatch"],
    explain: "A resident CEO profile may only be read or updated by its anchored principal person.",
    consumers: [
      "packages/application/src/resident-ceo.ts",
      "packages/daemon/src/daemon-host/daemon-host-runtime-api.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoPrincipal:c8c638e607792c3b9b5abdb5048786bd",
        route: "assertResidentCeoPrincipal",
      },
    ],
  },
  {
    id: "resident-ceo-execution-policy",
    symbol: "packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed",
    inputs: ["ResidentCeoProfile", "operation"],
    output: "void or ResidentCeoProfileError",
    failureCodes: ["resident_ceo_advisory_only"],
    explain:
      "Resident CEO delegation proposal creation, approval, and rejection require explicit approval-gated execution policy.",
    consumers: ["packages/application/src/resident-ceo.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed:e325546d97d4576b94f165c0426257a3",
        route: "assertResidentCeoExecutionAllowed",
      },
    ],
  },
] as const;
