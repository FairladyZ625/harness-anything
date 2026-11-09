import type { TaskProjection } from "@harness-anything/kernel";
import {
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";

const actor = { principal: { personId: "person-runtime" }, executor: null } as const;
let revision = 0;

export function runtimeEvent(type: AgentRuntimeEventV1["type"], payload: Record<string, unknown>): AgentRuntimeEventV1 {
  revision += 1;
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: `event-lifecycle-${revision}`,
    workspaceRevision: revision,
    opId: `op-lifecycle-${revision}`,
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: `2026-11-08T00:00:${String(revision).padStart(2, "0")}.000Z`,
    type,
    payload,
  } as AgentRuntimeEventV1;
  const errors = validateCurrentAgentRuntimeEvent(event);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return event;
}

export const requested = (dispatchId: string, runtimeSessionId: string, attemptGroupId?: string) =>
  runtimeEvent("runtime_dispatch_requested", {
    dispatchId,
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId: "codex",
    dispatchKey: `${dispatchId}-key`,
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    definitionSnapshot: {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-fixture",
      installationId: "installation-codex",
      kindId: "codex",
      providerId: "openai",
      model: "codex-fixture",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    ...(attemptGroupId ? { attemptGroupId, attemptIndex: 1 } : {}),
  });
export const started = (runtimeSessionId: string) =>
  runtimeEvent("runtime_session_started", {
    runtimeSessionId,
    instanceId: "codex-fixture",
    installationId: "installation-codex",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
    launchGeneration: 1,
    attachable: false,
  });
export const outcome = (runtimeSessionId: string, value: string, attempt?: Record<string, unknown>) =>
  runtimeEvent("runtime_session_outcome_observed", {
    runtimeSessionId,
    outcome: value,
    exitCode: null,
    resultRef: `artifact:runtime-result/sha256/${"0".repeat(64)}`,
    result: null,
    ...(attempt ? { attempt } : {}),
  });

export function history(): AgentRuntimeEventV1[] {
  revision = 0;
  return [
    // A fallback group: the first attempt schedules a successor, which is still running.
    requested("dispatch-a", "session-a"),
    started("session-a"),
    runtimeEvent("runtime_session_exited", { runtimeSessionId: "session-a" }),
    outcome("session-a", "failed", { classification: "provider_quota", reason: "quota", fallbackState: "scheduled" }),
    requested("dispatch-a2", "session-a2", "dispatch-a"),
    started("session-a2"),
    // A dispatch whose owner lost sight of the process: it keeps its slot and blocks its owner.
    requested("dispatch-b", "session-b"),
    started("session-b"),
    runtimeEvent("runtime_session_liveness_changed", { runtimeSessionId: "session-b", liveness: "unknown" }),
    // A finished dispatch.
    requested("dispatch-c", "session-c"),
    started("session-c"),
    runtimeEvent("runtime_session_exited", { runtimeSessionId: "session-c" }),
    outcome("session-c", "succeeded"),
  ];
}

export function snapshot(projection: Pick<TaskProjection, "readDispatchLifecycle">) {
  const active = projection.readDispatchLifecycle({ by: "active", instanceId: "codex-fixture", limit: 10 }),
    points = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: ["dispatch-a", "dispatch-c"] }),
    session = projection.readDispatchLifecycle({ by: "session", runtimeSessionId: "session-b" });
  return { active, points, session };
}
