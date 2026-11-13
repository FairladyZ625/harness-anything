import { DEFAULT_DISPATCH_INSTANCE_CAPACITY, DISPATCH_LIFECYCLE_PAGE_LIMIT } from "./dispatch-lifecycle.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

/** Runtime aggregate declarations for dec_AEB05951C69E47FCE53E53C341/CH1 consumer cutover. */
export const dispatchLifecyclePolicies = [
  {
    id: "dispatch-reservations",
    ownerRef: "runtime-session/run",
    unit: "provider slots / lifecycle capability",
    bounds:
      "Positive safe-integer capacity (default 64); reserved/held occupy a slot until accepted stop proof; recovering owners fail closed. Only a verified current running leaf can steer or attach; only closed stopped groups hand off; consent waits for group closure even after delivery registration; group closure releases workspace ownership.",
    defaultValue: DEFAULT_DISPATCH_INSTANCE_CAPACITY,
    version: 2,
    scope: "center-accepted dispatch lifecycle",
    reason: "Consumers use the reducer policy; node observations do not grant capacity or authority.",
    fixtures: [
      "packages/kernel/test/contracts/dispatch-lifecycle.test.ts",
      "packages/daemon/test/dispatch-lifecycle-consumers.integration.test.ts",
      "packages/daemon/test/runtime-steer-compare.test.ts",
      "packages/daemon/test/dispatch-read-lifecycle.test.ts",
    ],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host-repository-api.ts#createDaemonHostRepositoryApi.readNodeAutoClaimCandidates:921904248fd7c6864080e58564307106",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#enforceRuntimeSpendCap:75d51b45ad4eaca54efd2fc7ad7ee991",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:c62f0c68b8807afea23f9471a77da597",
      "policy:packages/daemon:packages/daemon/src/squad-coordinator-publication.ts#makeSquadPublicationController.publishState:c33102c3afb14ad57596688874a8b88c",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:a491cd99bd418e1cb55841e3c427c91b",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:2ef193c4cf48dd763a7480a2729b2bf2",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#DEFAULT_DISPATCH_INSTANCE_CAPACITY:dd334dec9f46f5f11fb1d1dd3f7ff1c0",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchLifecycleView.policy:38656b30234234b5e2e033952b6a7d93",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#steerRuntime.refuse:1e1fcd3898c968cf1017328d0d3f16b5",
      "policy:packages/daemon:packages/daemon/src/dispatch-read.ts#unsettledCutReviewDispatches.rows.shallow:00191b086680e4e98da6ac785758b04a",
      "policy:packages/daemon:packages/daemon/src/task-query-read.ts#makeTaskQueryReadModel.agenda.awaitingRuling:632767b9b836887b526c540ca6ec1de4",
      "policy:packages/daemon:packages/daemon/src/task-query-read.ts#makeTaskQueryReadModel.agenda.awaitingRuling:c6e10f3bdbdac92ac14cf8e1b3956656",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle:c41671665f96a2179bde52064ae469c8",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle:b9f7804a5216d05b525d0a06811c57cd",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceDispatchLifecycle.ruling:009d57c1b7f3765c6a9fd1b3f0b1a793",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt:009d52db3e38266ed1a99f48762cb2fe",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt.task.leaseVersion:2ab8993af980b44a91f1a45b2613c14a",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#admit.attempt.task.leaseReleased:0918a2f9659dad6c63671c8ae06c7017",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceTaskInput.leaseReleased:0918a2f9659dad6c63671c8ae06c7017",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#reduceTaskInput.leaseReleased:498048790eb1a34fc0e663022331a4c4",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:63605f8a41fedb841529e78733cab616",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt.process:fa83101db8a4eb6f0cd97ba2992000f8",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#advanceAttempt:48a3fe14a3312d70e7455c4ee250ac58",
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
      "policy:packages/daemon:packages/daemon/src/runtime-execution-scope.ts#requireCurrentExecutionScope:4b633614a3b936acec73c1d27becb9d0",
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
      "policy:packages/daemon:packages/daemon/src/runtime-handoff-store.ts#runRuntimeHandoffAction:e377f735156e6329291914303a5c00e7",
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
      "A dispatch request's attemptIndex is a non-negative integer when present; an observed outcome attempt carries only its declared classification, reason and fallback fields. Handoff packets report a known failure only for failed, unknown or stopped attempts, with the error clipped to 500 characters.",
    defaultValue: null,
    version: 1,
    scope: "runtime session events and handoff packets",
    reason: "Attempt records are evidence, not retry authority; the existing shape checks are declared once.",
    fixtures: [
      "packages/kernel/test/contracts/runtime-session-action.test.ts",
      "packages/kernel/test/handoff-packet.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/agent-runtime.ts#validateAgentRuntimePayloadFields:9306d05d3442a560bd8e326ed3ad21c8",
      "policy:packages/kernel:packages/kernel/src/domain/agent-runtime.ts#validateAgentRuntimePayloadFields:d414e72c89c251c45f5e4fba8c81516a",
      "policy:packages/kernel:packages/kernel/src/handoff-packet.ts#failureList:36c6074f0b2268c178b00030c123d468",
    ].map((candidateId) => ({ candidateId, route: "runtime attempt record" })),
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
  consumers: ["packages/daemon/src/task-query-read.ts"],
  sources: [],
} as const satisfies OntologyJudgmentDeclaration;
