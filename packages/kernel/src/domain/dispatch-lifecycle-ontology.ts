import { DEFAULT_DISPATCH_INSTANCE_CAPACITY } from "./dispatch-lifecycle.ts";
import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Runtime aggregate declarations for dec_AEB05951C69E47FCE53E53C341/CH1 consumer cutover. */
export const dispatchLifecyclePolicies = [
  {
    id: "dispatch-reservations",
    ownerRef: "runtime-session/run",
    unit: "provider slots / lifecycle capability",
    bounds:
      "Positive safe-integer capacity (default 64); reserved/held occupy a slot until accepted stop proof; recovering owners fail closed. Only current running leaf can steer; only closed stopped groups hand off; group closure releases workspace ownership.",
    defaultValue: DEFAULT_DISPATCH_INSTANCE_CAPACITY,
    version: 1,
    scope: "center-accepted dispatch lifecycle",
    reason: "Consumers use the reducer policy; node observations do not grant capacity or authority.",
    fixtures: [
      "packages/kernel/test/contracts/dispatch-lifecycle.test.ts",
      "packages/daemon/test/dispatch-lifecycle-consumers.integration.test.ts",
      "packages/daemon/test/runtime-steer-compare.test.ts",
    ],
    sources: [
      "policy:packages/daemon:packages/daemon/src/daemon-host-repository-api.ts#createDaemonHostRepositoryApi.readNodeAutoClaimCandidates:921904248fd7c6864080e58564307106",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#enforceRuntimeSpendCap:75d51b45ad4eaca54efd2fc7ad7ee991",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:c62f0c68b8807afea23f9471a77da597",
      "policy:packages/daemon:packages/daemon/src/squad-coordinator-publication.ts#makeSquadPublicationController.publishState:c33102c3afb14ad57596688874a8b88c",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:a491cd99bd418e1cb55841e3c427c91b",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchAdmissionBlocker:2ef193c4cf48dd763a7480a2729b2bf2",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#DEFAULT_DISPATCH_INSTANCE_CAPACITY:dd334dec9f46f5f11fb1d1dd3f7ff1c0",
      "policy:packages/kernel:packages/kernel/src/domain/dispatch-lifecycle.ts#dispatchLifecycleView.policy:99bf81d661cf787576dcf339a1fc69ab",
      "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#steerRuntime.refuse:1e1fcd3898c968cf1017328d0d3f16b5",
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
] as const satisfies readonly OntologyPolicyDeclaration[];
