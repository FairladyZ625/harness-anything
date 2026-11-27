// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSteerMode } from "@harness-anything/kernel";
import {
  createFleetEdgeRuntimeControlConsumer,
  extractRemoteControlRequest,
  type RemoteRuntimeControlEvent,
  type RemoteSteerControlRequest,
} from "../src/daemon-host/fleet-edge-runtime-control.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;

function livenessSteerEvent(overrides: {
  readonly opId?: string;
  readonly controlRequestId?: string;
  readonly workspaceRevision?: number;
  readonly mode?: RuntimeSteerMode;
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-steer-1",
    opId = overrides.opId ?? `op-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 11,
    opId,
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-27T01:00:00.000Z",
    payload: {
      runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId,
        targetNodeId: "node-edge-a",
        dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
        prompt: "Focus on verification.",
        ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
        expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 },
      },
    },
  };
}

function directSteerEvent(overrides: {
  readonly opId?: string;
  readonly controlRequestId?: string;
  readonly workspaceRevision?: number;
  readonly mode?: RuntimeSteerMode;
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_steer_requested" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-direct-1",
    opId = overrides.opId ?? `op-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 12,
    opId,
    type: "runtime_steer_requested",
    actor,
    source: "local",
    occurredAt: "2026-11-27T01:01:00.000Z",
    payload: {
      runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      controlRequestId,
      targetNodeId: "node-edge-a",
      prompt: "Focus on verification.",
      ...(overrides.mode !== undefined ? { mode: overrides.mode } : {}),
      expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 },
    },
  };
}

test("PR 1A reader-first N/N-1 compat (dec_659E15CF, dec_A7A88E2079CA1DE548234A6CC3): extractRemoteControlRequest keeps N-1 frames without mode identical and preserves optional mode", () => {
  const legacyLiveness = extractRemoteControlRequest(livenessSteerEvent({}));
  assert.deepEqual(legacyLiveness, {
    kind: "steer",
    opId: "op-ctrl-steer-1",
    workspaceRevision: 11,
    runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    controlRequestId: "ctrl-steer-1",
    targetNodeId: "node-edge-a",
    prompt: "Focus on verification.",
    expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 },
  });
  assert.equal("mode" in legacyLiveness!, false);

  const legacyDirect = extractRemoteControlRequest(directSteerEvent({}));
  assert.equal(legacyDirect?.kind, "steer");
  assert.equal("mode" in legacyDirect!, false);

  for (const mode of ["auto", "queue", "interrupt"] as const) {
    const fromLiveness = extractRemoteControlRequest(livenessSteerEvent({ controlRequestId: `ctrl-${mode}`, mode }));
    assert.equal(fromLiveness?.kind, "steer");
    assert.equal((fromLiveness as RemoteSteerControlRequest).mode, mode);

    const fromDirect = extractRemoteControlRequest(directSteerEvent({ controlRequestId: `direct-${mode}`, mode }));
    assert.equal(fromDirect?.kind, "steer");
    assert.equal((fromDirect as RemoteSteerControlRequest).mode, mode);
  }
});

test("edge runtime control consumer executes both legacy mode-less steers and optional mode steers cleanly", async () => {
  const events: readonly RemoteRuntimeControlEvent[] = [
    livenessSteerEvent({ controlRequestId: "ctrl-legacy", workspaceRevision: 20 }),
    livenessSteerEvent({ controlRequestId: "ctrl-queue", workspaceRevision: 21, mode: "queue" }),
    directSteerEvent({ controlRequestId: "ctrl-interrupt", workspaceRevision: 22, mode: "interrupt" }),
  ];
  const executed: RemoteSteerControlRequest[] = [];
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-edge-a",
    activeRuntimeSessionIds: () => ["runtime_aaaaaaaaaaaaaaaaaaaaaaaa"],
    isRuntimeActive: () => true,
    readControlEventsPage: async (_sessionId, afterRevision, limit) =>
      events.filter((event) => event.workspaceRevision > afterRevision).slice(0, limit),
    executeCancel: async () => assert.fail("unexpected cancel"),
    executeSteer: async (request) => {
      executed.push(request);
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.equal(executed.length, 3);
  assert.equal("mode" in executed[0]!, false);
  assert.equal(executed[0]?.controlRequestId, "ctrl-legacy");
  assert.equal(executed[1]?.controlRequestId, "ctrl-queue");
  assert.equal(executed[1]?.mode, "queue");
  assert.equal(executed[2]?.controlRequestId, "ctrl-interrupt");
  assert.equal(executed[2]?.mode, "interrupt");
});
