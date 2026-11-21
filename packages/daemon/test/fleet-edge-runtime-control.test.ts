// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import {
  reduceRuntimeSession,
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
} from "../src/daemon-host/dispatch-stream.ts";
import { readRuntimeSteerVersion } from "../src/daemon-host/runtime-steer-target.ts";
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

test("F4: real SQLite partial indexes & watermark advancement avoid scanning non-matching tails and deferred suffixes", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f4-sqlite-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Runtime Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "runtime@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
  const repoId = "f4-sqlite-repo",
    sessionId = "runtime_000000000000000000000042",
    store = makeTaskEventStore({ rootDir, repoId }),
    projection = makeTaskProjection({ rootDir, eventStore: store });
  t.after(async () => {
    projection.close();
    await store.drain();
  });
  let rev = 1;
  const appendEvent = (event: Omit<AgentRuntimeEventV1, "workspaceRevision">) => {
    const full = { ...event, workspaceRevision: rev } as AgentRuntimeEventV1;
    store.append({
      event: full,
      plan: canonicalEventWritePlan(full, "agent-runtime/v1", full.opId),
      blobs: [],
    });
    rev += 1;
  };
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-start",
    opId: "op-start",
    type: "runtime_session_started",
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T02:00:00.000Z",
    payload: {
      runtimeSessionId: sessionId,
      instanceId: "inst-1",
      installationId: "install-1",
      kindId: "codex",
      definitionSnapshotRef: `artifact:runtime-definition/sha256/${"a".repeat(64)}`,
      launchGeneration: 1,
      attachable: true,
    },
  });
  // Seed 250 non-control liveness events, 1 control request, 1 applied steer receipt, then 200 more non-control events.
  for (let i = 0; i < 250; i += 1) {
    appendEvent({
      schema: "agent-runtime-event/v1",
      eventId: `evt-noise-a-${i}`,
      opId: `op-noise-a-${i}`,
      type: "runtime_session_liveness_changed",
      actor,
      source: { kind: "node", nodeId: "node-a" },
      occurredAt: "2026-11-21T02:00:01.000Z",
      payload: { runtimeSessionId: sessionId, liveness: "live" },
    });
  }
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-ctrl-1",
    opId: "op-ctrl-1",
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:00:02.000Z",
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlRequest: {
        action: "steer",
        controlRequestId: "ctrl-sqlite-1",
        targetNodeId: "node-a",
        dispatchId: "dispatch_000000000000000000000042",
        prompt: "Bounded steer",
      },
    },
  });
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-rcpt-1",
    opId: "op-rcpt-1",
    type: "runtime_session_liveness_changed",
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T02:00:03.000Z",
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlReceipt: {
        action: "steer",
        controlRequestId: "ctrl-sqlite-1",
        requestOpId: "op-ctrl-1",
        status: "applied",
        steerVersion: 3,
      },
    },
  });
  for (let i = 0; i < 200; i += 1) {
    appendEvent({
      schema: "agent-runtime-event/v1",
      eventId: `evt-noise-b-${i}`,
      opId: `op-noise-b-${i}`,
      type: "runtime_session_liveness_changed",
      actor,
      source: { kind: "node", nodeId: "node-a" },
      occurredAt: "2026-11-21T02:00:04.000Z",
      payload: { runtimeSessionId: sessionId, liveness: "live" },
    });
  }
  projection.catchUp();

  // Verify SQLite query planner uses the partial indexes (zero full-session non-control scans).
  const db = new DatabaseSync(projection.path, { readOnly: true });
  t.after(() => db.close());
  const controlPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE workspace_revision > ? AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND (json_extract(event_json, '$.type') IN ('runtime_cancel_requested', 'runtime_steer_requested') OR (json_extract(event_json, '$.type') = 'runtime_session_liveness_changed' AND json_extract(event_json, '$.payload.controlRequest') IS NOT NULL)) ORDER BY workspace_revision LIMIT ?",
    )
    .all(0, sessionId, 64) as { detail: string }[];
  assert.ok(
    controlPlan.some((row) => row.detail.includes("event_index_runtime_control")),
    `expected event_index_runtime_control partial index, got: ${JSON.stringify(controlPlan)}`,
  );
  const receiptPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE workspace_revision > ? AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') = 'runtime_session_liveness_changed' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND json_extract(event_json, '$.payload.controlReceipt.status') = 'applied' AND json_extract(event_json, '$.payload.controlReceipt.steerVersion') IS NOT NULL ORDER BY workspace_revision DESC LIMIT ?",
    )
    .all(0, sessionId, 1) as { detail: string }[];
  assert.ok(
    receiptPlan.some((row) => row.detail.includes("event_index_runtime_applied_steer_receipt")),
    `expected event_index_runtime_applied_steer_receipt partial index, got: ${JSON.stringify(receiptPlan)}`,
  );

  // Verify Center applied steer version lookup returns strictly 1 row (latest steerVersion = 3).
  const latestApplied = projection.readRuntimeSessionEventsByType(sessionId, ["runtime_session_liveness_changed"], {
    filter: "applied_steer_receipt",
    order: "desc",
    limit: 1,
  });
  assert.equal(latestApplied.length, 1);
  assert.equal(
    latestApplied[0]?.type === "runtime_session_liveness_changed"
      ? latestApplied[0].payload.controlReceipt?.steerVersion
      : null,
    3,
  );

  // Verify watermark advances across non-matching tails AND deferred items do not re-scan storage suffixes.
  const seenAfterRevisions: number[] = [];
  let steerAttempts = 0;
  let steerShouldDefer = true;
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [sessionId],
    isRuntimeActive: (id) => id === sessionId,
    readControlEventsPage: async (sid, afterRevision, limit) => {
      seenAfterRevisions.push(afterRevision);
      const cut = projection.readCut();
      const events = projection.readRuntimeSessionEventsByType(
        sid,
        ["runtime_session_liveness_changed", "runtime_cancel_requested", "runtime_steer_requested"],
        { afterRevision, limit, filter: "control_request" },
      ) as readonly RemoteRuntimeControlEvent[];
      const maxRev = events.reduce((highest, event) => Math.max(highest, event.workspaceRevision), afterRevision);
      return {
        events,
        scannedToRevision: events.length < limit ? Math.max(maxRev, cut.watermark) : maxRev,
      };
    },
    executeCancel: async () => undefined,
    executeSteer: async () => {
      steerAttempts += 1;
      if (steerShouldDefer) throw Object.assign(new Error("transient ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
    schedule: async (work) => {
      await work();
    },
  });

  await consumer.drain();
  const watermarkAfterInitial = projection.readCut().watermark;
  assert.equal(steerAttempts, 1);

  // Append 100 more non-control liveness events while op-ctrl-1 is deferred; subsequent drains must start at watermarkAfterInitial (never re-scanning rev 0..watermarkAfterInitial)!
  for (let i = 0; i < 100; i += 1) {
    appendEvent({
      schema: "agent-runtime-event/v1",
      eventId: `evt-noise-c-${i}`,
      opId: `op-noise-c-${i}`,
      type: "runtime_session_liveness_changed",
      actor,
      source: { kind: "node", nodeId: "node-a" },
      occurredAt: "2026-11-21T02:00:05.000Z",
      payload: { runtimeSessionId: sessionId, liveness: "live" },
    });
  }
  projection.catchUp();
  const watermarkAfterTail = projection.readCut().watermark;

  await consumer.drain();
  await consumer.drain();
  assert.equal(seenAfterRevisions[0], 0);
  assert.equal(
    seenAfterRevisions[1],
    watermarkAfterInitial,
    "must advance cursor across non-matching tail even when item is deferred",
  );
  assert.equal(seenAfterRevisions[2], watermarkAfterTail, "must advance cursor across empty tail page");

  steerShouldDefer = false;
  await consumer.drain();
  assert.equal(steerAttempts, 4, "deferred item retried from memory and completed once recovered");
  await consumer.drain();
  assert.equal(steerAttempts, 4, "completed item never re-runs");
});

test("F4: readRuntimeSteerVersion reads O(1) sidecar without scanning multi-MB dispatch transcript from offset 0", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f4-sidecar-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_000000000000000000000099",
    runtimeSessionId = "runtime_000000000000000000000099";
  const writer = openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:00:00.000Z",
  });
  const bigChunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 32; i += 1)
    writer.appendProviderEvent({ type: "agent_message", text: bigChunk }, "2026-11-21T02:00:01.000Z");
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "steer_requested",
    opId: "steer-op-1",
    runtimeSessionId,
    version: 1,
    prompt: "First",
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "steer_requested",
    opId: "steer-op-2",
    runtimeSessionId,
    version: 2,
    prompt: "Second",
  });
  // Overwrite the .jsonl transcript with empty content to prove readRuntimeSteerVersion does NOT scan .jsonl at all!
  writeFileSync(dispatchStreamPath(rootDir, dispatchId), "");
  const seen = new Set<string>();
  const version = readRuntimeSteerVersion(rootDir, dispatchId, seen);
  assert.equal(version, 2);
  assert.deepEqual([...seen], ["steer-op-1", "steer-op-2"]);
});

test("F5: late controlReceipt on exited session preserves liveness=exited and pending rejection receipts replay after exit", async () => {
  const exitedSession: RuntimeSession = {
    ...baseSession(),
    liveness: "exited",
    attachable: false,
    outcome: "failed",
    exitCode: 1,
  };
  const lateReceiptEvent: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "evt-late-rcpt",
    workspaceRevision: 99,
    opId: "op-late-rcpt",
    type: "runtime_session_liveness_changed",
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T03:00:00.000Z",
    payload: {
      runtimeSessionId: exitedSession.runtimeSessionId,
      liveness: "live",
      controlReceipt: {
        action: "steer",
        controlRequestId: "ctrl-late-1",
        requestOpId: "op-req-1",
        status: "rejected",
        reasonCode: "steer_dropped",
      },
    },
  };
  const reduced = reduceRuntimeSession(exitedSession, lateReceiptEvent);
  assert.notEqual(reduced, exitedSession, "late controlReceipt must be persisted instead of no_changes");
  assert.equal(reduced?.liveness, "exited", "late controlReceipt must never reopen exited liveness");
  assert.equal(reduced?.attachable, false);

  // Verify pending rejection receipt replays even after session becomes inactive.
  const active = new Set([exitedSession.runtimeSessionId]);
  const steerEvent = livenessSteerControlEvent({
    runtimeSessionId: exitedSession.runtimeSessionId,
    controlRequestId: "ctrl-rej-replay",
    opId: "op-rej-replay",
    workspaceRevision: 12,
  });
  let reportCalls = 0;
  let reportShouldFail = true;
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: async (_sid, afterRevision) => (afterRevision < 12 ? [steerEvent] : []),
    executeCancel: async () => undefined,
    executeSteer: async () => {
      throw Object.assign(new Error("version mismatch"), { code: "runtime_steer_target_changed" });
    },
    reportSteerRejection: async () => {
      reportCalls += 1;
      if (reportShouldFail) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
    schedule: async (work) => {
      await work();
    },
  });
  await consumer.drain();
  assert.equal(reportCalls, 1);
  // Session exits while Center is unreachable; replay must still deliver the rejection receipt!
  active.clear();
  reportShouldFail = false;
  await consumer.drain();
  assert.equal(reportCalls, 2);
  await consumer.drain();
  assert.equal(reportCalls, 2, "acknowledged rejection receipt must not replay again");
});
