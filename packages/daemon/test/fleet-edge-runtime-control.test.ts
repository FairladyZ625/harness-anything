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

function livenessCancelControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly controlRequestId?: string;
  readonly opId?: string;
  readonly targetNodeId?: string;
  readonly workspaceRevision?: number;
  readonly reason?: string;
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> {
  const runtimeSessionId = overrides.runtimeSessionId ?? "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    controlRequestId = overrides.controlRequestId ?? "ctrl-cancel-1",
    opId = overrides.opId ?? `op-cancel-${runtimeSessionId}-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 10,
    opId,
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:00:00.000Z",
    payload: {
      runtimeSessionId,
      liveness: "live",
      controlRequest: {
        action: "cancel",
        controlRequestId,
        targetNodeId: overrides.targetNodeId ?? "node-a",
        ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
      },
    },
  };
}

function livenessSteerControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly controlRequestId?: string;
  readonly opId?: string;
  readonly targetNodeId?: string;
  readonly prompt?: string;
  readonly workspaceRevision?: number;
  readonly expected?: { readonly dispatchId?: string; readonly version?: number };
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_session_liveness_changed" }> {
  const runtimeSessionId = overrides.runtimeSessionId ?? "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    controlRequestId = overrides.controlRequestId ?? "ctrl-steer-1",
    opId = overrides.opId ?? `op-steer-${runtimeSessionId}-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 11,
    opId,
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:01:00.000Z",
    payload: {
      runtimeSessionId,
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId,
        targetNodeId: overrides.targetNodeId ?? "node-a",
        dispatchId: overrides.dispatchId ?? "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
        prompt: overrides.prompt ?? "Pivot to verification.",
        ...(overrides.expected !== undefined ? { expected: overrides.expected } : {}),
      },
    },
  };
}

function legacyCancelControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly controlRequestId?: string;
  readonly opId?: string;
  readonly targetNodeId?: string;
  readonly workspaceRevision?: number;
  readonly reason?: string;
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_cancel_requested" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-cancel-1",
    opId = overrides.opId ?? `op-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 10,
    opId,
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

function legacySteerControlEvent(overrides: {
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly controlRequestId?: string;
  readonly opId?: string;
  readonly targetNodeId?: string;
  readonly prompt?: string;
  readonly workspaceRevision?: number;
  readonly expected?: { readonly dispatchId?: string; readonly version?: number };
}): Extract<RemoteRuntimeControlEvent, { readonly type: "runtime_steer_requested" }> {
  const controlRequestId = overrides.controlRequestId ?? "ctrl-steer-1",
    opId = overrides.opId ?? `op-${controlRequestId}`;
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: overrides.workspaceRevision ?? 11,
    opId,
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

function makePagedReader(events: readonly RemoteRuntimeControlEvent[]) {
  const calls: Array<{ readonly sessionId: string; readonly afterRevision: number; readonly limit: number }> = [];
  const readControlEventsPage = async (
    runtimeSessionId: string,
    afterRevision: number,
    limit: number,
  ): Promise<readonly RemoteRuntimeControlEvent[]> => {
    calls.push({ sessionId: runtimeSessionId, afterRevision, limit });
    return events
      .filter((event) => event.payload.runtimeSessionId === runtimeSessionId && event.workspaceRevision > afterRevision)
      .sort((left, right) => left.workspaceRevision - right.workspaceRevision)
      .slice(0, limit);
  };
  return { calls, readControlEventsPage };
}

test("kernel validates control events on both liveness_changed (Step-1 N/N-1) and dedicated types", () => {
  const cancel = legacyCancelControlEvent({ reason: "Operator stop" }),
    steer = legacySteerControlEvent({ expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 } }),
    livenessCancel = livenessCancelControlEvent({ reason: "Operator stop" }),
    livenessSteer = livenessSteerControlEvent({
      expected: { dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa", version: 0 },
    }),
    session = baseSession();
  assert.deepEqual(validateCurrentAgentRuntimeEvent(cancel), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(steer), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(livenessCancel), []);
  assert.deepEqual(validateCurrentAgentRuntimeEvent(livenessSteer), []);
  assert.equal(reduceRuntimeSession(session, cancel), session);
  assert.equal(reduceRuntimeSession(session, steer), session);
  assert.equal(reduceRuntimeSession(session, livenessCancel)?.liveness, "live");
  assert.equal(reduceRuntimeSession(session, livenessSteer)?.liveness, "live");

  const badCancel: AgentRuntimeEventV1 = { ...cancel, payload: { ...cancel.payload, controlRequestId: "" } };
  assert.ok(validateCurrentAgentRuntimeEvent(badCancel).length > 0);
  const badSteerExpected = {
    ...livenessSteer,
    payload: {
      ...livenessSteer.payload,
      controlRequest: {
        ...livenessSteer.payload.controlRequest!,
        expected: { taskless: true, taskId: "task_1" },
      },
    },
  };
  assert.ok(validateCurrentAgentRuntimeEvent(badSteerExpected).length > 0);
});

test("edge control consumer short-circuits in O(1) when node holds no active runtime handles", async () => {
  let reads = 0;
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [],
    isRuntimeActive: () => false,
    readControlEventsPage: async () => {
      reads += 1;
      return [livenessCancelControlEvent({})];
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

test("F3: canonical opId deduplication executes independent sessions/actions sharing one controlRequestId and deduplicates replays", async () => {
  const sessionA = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    sessionB = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb",
    active = new Set([sessionA, sessionB]),
    executed: string[] = [];
  const events: RemoteRuntimeControlEvent[] = [
    // Same client controlRequestId="shared-key" used for steer on sessionA, cancel on sessionA, and steer on sessionB.
    livenessSteerControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "shared-key",
      opId: "runtime-steer-req-session-a-shared",
      prompt: "Steer A",
      workspaceRevision: 20,
    }),
    // Duplicate replay of exact same opId must be ignored.
    livenessSteerControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "shared-key",
      opId: "runtime-steer-req-session-a-shared",
      prompt: "Steer A replay",
      workspaceRevision: 21,
    }),
    // Foreign node event must be ignored.
    livenessCancelControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "foreign-cancel",
      targetNodeId: "node-b",
      workspaceRevision: 22,
    }),
    // Same client key on sessionB must ALSO execute!
    livenessSteerControlEvent({
      runtimeSessionId: sessionB,
      controlRequestId: "shared-key",
      opId: "runtime-steer-req-session-b-shared",
      prompt: "Steer B",
      workspaceRevision: 23,
    }),
    // Same client key for cancel on sessionA must ALSO execute!
    livenessCancelControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "shared-key",
      opId: "runtime-cancel-req-session-a-shared",
      workspaceRevision: 24,
    }),
  ];
  const reader = makePagedReader(events);
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: reader.readControlEventsPage,
    executeCancel: async (req) => {
      executed.push(`cancel:${req.runtimeSessionId}:${req.controlRequestId}`);
      active.delete(req.runtimeSessionId);
    },
    executeSteer: async (req) => {
      executed.push(`steer:${req.runtimeSessionId}:${req.controlRequestId}:${req.prompt}`);
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.deepEqual(executed, [
    `steer:${sessionA}:shared-key:Steer A`,
    `steer:${sessionB}:shared-key:Steer B`,
    `cancel:${sessionA}:shared-key`,
  ]);

  // Re-adding sessionA and draining again must not replay already completed opIds.
  active.add(sessionA);
  await consumer.drain();
  assert.equal(executed.length, 3);
});

test("F2: transient disconnect during cancel keeps cancel pending until connectivity recovers while process stays alive", async () => {
  const sessionA = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    active = new Set([sessionA]);
  let cancelAttempts = 0;
  const events = [
    livenessCancelControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "ctrl-cancel-transient",
      workspaceRevision: 30,
    }),
  ];
  const reader = makePagedReader(events);
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: reader.readControlEventsPage,
    executeCancel: async () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:4443");
        (err as Error & { code?: string }).code = "ECONNREFUSED";
        throw err;
      }
      active.delete(sessionA);
    },
    executeSteer: async () => assert.fail("unexpected steer"),
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  assert.equal(cancelAttempts, 1);
  assert.equal(active.has(sessionA), true, "process must remain active after transient failure");
  // Next drain must retry the pending cancel because watermark did not advance past rev 30.
  await consumer.drain();
  assert.equal(cancelAttempts, 2);
  assert.equal(active.has(sessionA), false);
});

test("F2: deferred earlier steer is never masked by a later event succeeding in the same batch", async () => {
  const sessionA = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    active = new Set([sessionA]),
    applied: string[] = [];
  let firstSteerAttempts = 0;
  const events: RemoteRuntimeControlEvent[] = [
    livenessSteerControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "steer-1",
      opId: "op-steer-1",
      prompt: "First steer",
      workspaceRevision: 40,
    }),
    livenessSteerControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "steer-2",
      opId: "op-steer-2",
      prompt: "Second steer",
      workspaceRevision: 41,
    }),
  ];
  const reader = makePagedReader(events);
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: reader.readControlEventsPage,
    executeCancel: async () => assert.fail("unexpected cancel"),
    executeSteer: async (req) => {
      if (req.opId === "op-steer-1") {
        firstSteerAttempts += 1;
        if (firstSteerAttempts === 1)
          throw Object.assign(new Error("provider not bound yet"), { code: "runtime_steer_unavailable" });
      }
      applied.push(req.opId);
    },
    schedule: async (work) => {
      await work();
    },
  });

  // Drain 1: steer-1 deferred, steer-2 applied; watermark MUST NOT advance past rev 40!
  await consumer.drain();
  assert.deepEqual(applied, ["op-steer-2"]);
  // Drain 2: cursor starts at 0 again, retries steer-1 (now succeeds!), skips already-completed steer-2, advances cursor to 41!
  await consumer.drain();
  assert.deepEqual(applied, ["op-steer-2", "op-steer-1"]);
  // Drain 3: cursor is now at 41, zero re-reads of rev 40/41!
  const callsBefore = reader.calls.length;
  await consumer.drain();
  assert.equal(reader.calls[callsBefore]!.afterRevision, 41);
  assert.deepEqual(applied, ["op-steer-2", "op-steer-1"]);
});

test("F2/F5: unexpected errors propagate instead of being swallowed, and terminal steer refusals report correlated rejection", async () => {
  const sessionA = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    active = new Set([sessionA]),
    reported: Array<{ readonly controlRequestId: string; readonly code: string }> = [];
  let reportAttempts = 0;
  const steerMismatch = livenessSteerControlEvent({
    runtimeSessionId: sessionA,
    controlRequestId: "ctrl-steer-mismatch",
    opId: "op-steer-mismatch",
    workspaceRevision: 50,
  });
  const reader = makePagedReader([steerMismatch]);
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: reader.readControlEventsPage,
    executeCancel: async () => assert.fail("unexpected cancel"),
    executeSteer: async () => {
      throw Object.assign(new Error("version mismatch"), { code: "runtime_steer_target_changed" });
    },
    reportSteerRejection: async (req, rejection) => {
      reportAttempts += 1;
      if (reportAttempts === 1) {
        const err = new Error("connect ECONNREFUSED");
        (err as Error & { code?: string }).code = "ECONNREFUSED";
        throw err;
      }
      reported.push({ controlRequestId: req.controlRequestId, code: rejection.code });
    },
    schedule: async (work) => {
      await work();
    },
  });

  // First drain: rejection report hits transient ECONNREFUSED -> stays pending.
  await consumer.drain();
  assert.equal(reported.length, 0);
  // Second drain: rejection report succeeds and completes the op.
  await consumer.drain();
  assert.deepEqual(reported, [{ controlRequestId: "ctrl-steer-mismatch", code: "runtime_steer_target_changed" }]);

  // Unexpected error must propagate cleanly.
  const unexpectedEvent = livenessCancelControlEvent({
    runtimeSessionId: sessionA,
    controlRequestId: "ctrl-unexpected",
    opId: "op-unexpected",
    workspaceRevision: 51,
  });
  const unexpectedConsumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: makePagedReader([unexpectedEvent]).readControlEventsPage,
    executeCancel: async () => {
      throw new TypeError("unexpected invariant bug");
    },
    executeSteer: async () => assert.fail("unexpected steer"),
    schedule: async (work) => {
      await work();
    },
  });
  await assert.rejects(() => unexpectedConsumer.drain(), TypeError);
});

test("F4: G38 bounded cursor reads over large active session set and long history perform O(new_events) work with zero rescans", async () => {
  const sessionIds = Array.from({ length: 40 }, (_, i) => `runtime_${String(i).padStart(24, "0")}`);
  const active = new Set(sessionIds);
  const events: RemoteRuntimeControlEvent[] = [];
  let rev = 1;
  // Seed 200 historical non-control liveness events across sessions.
  for (let round = 0; round < 5; round += 1) {
    for (const sid of sessionIds) {
      events.push({
        schema: "agent-runtime-event/v1",
        eventId: `event-hist-${rev}`,
        workspaceRevision: rev,
        opId: `op-hist-${rev}`,
        type: "runtime_session_liveness_changed",
        actor,
        source: "local",
        occurredAt: "2026-11-21T02:00:00.000Z",
        payload: { runtimeSessionId: sid, liveness: "live" },
      });
      rev += 1;
    }
  }
  let rowsReturned = 0;
  let activeListCalls = 0;
  let activeHasCalls = 0;
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => {
      activeListCalls += 1;
      return [...active];
    },
    isRuntimeActive: (sid) => {
      activeHasCalls += 1;
      return active.has(sid);
    },
    readControlEventsPage: async (sid, afterRevision, limit) => {
      const page = events
        .filter((event) => event.payload.runtimeSessionId === sid && event.workspaceRevision > afterRevision)
        .slice(0, limit);
      rowsReturned += page.length;
      return page;
    },
    executeCancel: async () => undefined,
    executeSteer: async () => undefined,
    schedule: async (work) => {
      await work();
    },
    pageLimit: 16,
  });

  // Initial drain advances cursors across all 40 sessions.
  await consumer.drain();
  assert.equal(rowsReturned, 200);
  assert.equal(activeListCalls, 1);

  // Append 1 new control event and run 5 subsequent drains: total rows scanned must be strictly 1!
  rowsReturned = 0;
  events.push(
    livenessSteerControlEvent({
      runtimeSessionId: sessionIds[0]!,
      controlRequestId: "ctrl-incremental-1",
      workspaceRevision: rev,
    }),
  );
  for (let i = 0; i < 5; i += 1) await consumer.drain();
  assert.equal(rowsReturned, 1, "subsequent drains must read strictly O(new_events) via storage cursor");
  assert.ok(activeHasCalls > 0, "consumer must use O(1) isRuntimeActive checks instead of re-listing all sessions");
  assert.equal(activeListCalls, 6, "activeRuntimeSessionIds must be called once per drain, never per event");
});
