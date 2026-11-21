// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceRuntimeSession,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  createFleetEdgeRuntimeControlConsumer,
  type RemoteRuntimeControlEvent,
} from "../src/daemon-host/fleet-edge-runtime-control.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;

function baseSession(runtimeSessionId = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa"): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-1",
    installationId: "install-1",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
    providerSessionId: "thread-1",
    transcriptRef: "provider:codex/thread-1",
    launchGeneration: 1,
    liveness: "live",
    attachable: true,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: "2026-11-21T02:00:00.000Z",
  };
}

function cancelControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly controlRequestId?: string;
  readonly targetNodeId?: string;
  readonly workspaceRevision?: number;
  readonly reason?: string;
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_cancel_requested" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-cancel-1";
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${controlRequestId}`,
    workspaceRevision: overrides.workspaceRevision ?? 10,
    opId: `op-${controlRequestId}`,
    type: "runtime_cancel_requested",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:00:00.000Z",
    payload: {
      runtimeSessionId: overrides.runtimeSessionId ?? "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      controlRequestId,
      targetNodeId: overrides.targetNodeId ?? "node-a",
      ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    },
  };
}

function steerControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly controlRequestId?: string;
  readonly targetNodeId?: string;
  readonly prompt?: string;
  readonly workspaceRevision?: number;
  readonly expected?: { readonly dispatchId?: string; readonly version?: number };
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_steer_requested" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-steer-1";
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${controlRequestId}`,
    workspaceRevision: overrides.workspaceRevision ?? 11,
    opId: `op-${controlRequestId}`,
    type: "runtime_steer_requested",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:01:00.000Z",
    payload: {
      runtimeSessionId: overrides.runtimeSessionId ?? "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      dispatchId: overrides.dispatchId ?? "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      controlRequestId,
      targetNodeId: overrides.targetNodeId ?? "node-a",
      prompt: overrides.prompt ?? "Pivot to verification.",
      ...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
    },
  };
}

test("kernel validates runtime_cancel_requested and runtime_steer_requested and keeps RuntimeSession state unchanged", () => {
  const cancel = cancelControlEvent({ reason: "Operator stop" }),
    steer = steerControlEvent({ expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 } }),
    session = baseSession();
  assert.deepEqual(validateCurrentAgentRuntimeEvent(cancel), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(steer), []);
  assert.equal(reduceRuntimeSession(session, cancel), session);
  assert.equal(reduceRuntimeSession(session, steer), session);

  const badCancel: AgentRuntimeEventV1 = {
    ...cancel,
    payload: { ...cancel.payload, controlRequestId: "" },
  };
  assert.ok(validateCurrentAgentRuntimeEvent(badCancel).length > 0);
  const badReason: AgentRuntimeEventV1 = {
    ...cancel,
    payload: { ...cancel.payload, reason: "" },
  };
  assert.ok(validateCurrentAgentRuntimeEvent(badReason).length > 0);
  const badSteerPrompt: AgentRuntimeEventV1 = {
    ...steer,
    payload: { ...steer.payload, prompt: "" },
  };
  assert.ok(validateCurrentAgentRuntimeEvent(badSteerPrompt).length > 0);
  const badSteerExpected = {
    ...steer,
    payload: { ...steer.payload, expected: { taskless: true, taskId: "task_1" } },
  };
  assert.ok(validateCurrentAgentRuntimeEvent(badSteerExpected).length > 0);
});

test("edge control consumer short-circuits in O(1) when node holds no active runtime handles", async () => {
  let reads = 0;
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [],
    readControlEvents: async () => {
      reads += 1;
      return [cancelControlEvent({})];
    },
    executeCancel: async () => assert.fail("must not execute cancel"),
    executeSteer: async () => assert.fail("must not execute steer"),
    schedule: async (work) => {
      await work();
    },
  });
  await consumer.drain();
  assert.equal(reads, 0);
});

test("edge control consumer ignores foreign node events, deduplicates replayed controlRequestIds, and respects revision order", async () => {
  const active = new Set(["runtime_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  const executed: string[] = [];
  const events: RemoteRuntimeControlEvent[] = [
    steerControlEvent({
      controlRequestId: "ctrl-steer-1",
      targetNodeId: "node-a",
      prompt: "First steer",
      workspaceRevision: 20,
    }),
    cancelControlEvent({
      controlRequestId: "ctrl-foreign-cancel",
      targetNodeId: "node-b",
      workspaceRevision: 21,
    }),
    steerControlEvent({
      controlRequestId: "ctrl-steer-1",
      targetNodeId: "node-a",
      prompt: "Replayed steer",
      workspaceRevision: 22,
    }),
    cancelControlEvent({
      controlRequestId: "ctrl-cancel-1",
      targetNodeId: "node-a",
      workspaceRevision: 23,
    }),
  ];
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    readControlEvents: async (ids) => {
      assert.deepEqual(ids, ["runtime_aaaaaaaaaaaaaaaaaaaaaaaa"]);
      return events;
    },
    executeCancel: async (sid) => {
      executed.push(`cancel:${sid}`);
      active.delete(sid);
    },
    executeSteer: async (event) => {
      executed.push(`steer:${event.payload.controlRequestId}:${event.payload.prompt}`);
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.deepEqual(executed, ["steer:ctrl-steer-1:First steer", "cancel:runtime_aaaaaaaaaaaaaaaaaaaaaaaa"]);

  // Re-adding session and draining the same events must not replay already applied controlRequestIds.
  active.add("runtime_aaaaaaaaaaaaaaaaaaaaaaaa");
  await consumer.drain();
  assert.deepEqual(executed, ["steer:ctrl-steer-1:First steer", "cancel:runtime_aaaaaaaaaaaaaaaaaaaaaaaa"]);
});

test("edge control consumer retries transient runtime_steer_unavailable until provider session binds", async () => {
  const active = new Set(["runtime_aaaaaaaaaaaaaaaaaaaaaaaa"]);
  let attempts = 0;
  const event = steerControlEvent({ controlRequestId: "ctrl-steer-retry", workspaceRevision: 30 });
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    readControlEvents: async () => [event],
    executeCancel: async () => assert.fail("unexpected cancel"),
    executeSteer: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("not bound yet"), { code: "runtime_steer_unavailable" });
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.equal(attempts, 1);
  await consumer.drain();
  assert.equal(attempts, 2);
  // Once applied, subsequent drains skip it.
  await consumer.drain();
  assert.equal(attempts, 2);
});
