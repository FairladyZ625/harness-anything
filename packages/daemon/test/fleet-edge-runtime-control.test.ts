// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  appendDispatchStreamRecord,
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  countActiveDispatchStreams,
  dispatchStreamPath,
  findLiveDispatchStreamPath,
  openDispatchStream,
  parseRecord,
  readRuntimeWorkerChunk,
} from "../src/daemon-host/dispatch-stream.ts";
import {
  advanceDispatchControlCursor,
  hasPendingSteerReceipts,
  markSteerReceiptAcked,
  PENDING_STEER_RECEIPT_HIGH_WATERMARK,
  pendingSteerReceiptCount,
  prepareDispatchSteerAppend,
  readAllPendingSteerReceipts,
  readDispatchControlCursor,
  readDispatchSteerState,
  readSettledControlOpIdsAboveCursor,
  reconcileDispatchSteerStateFromStream,
  recordPendingSteerReceipt,
  recordSettledControlAboveCursor,
  removeDispatchSteerState,
  steerReceiptOpId,
} from "../src/daemon-host/dispatch-steer-state.ts";
import { readRuntimeDispatchOwner } from "../src/daemon-host/runtime-dispatch-owner-evidence.ts";
import { makeAgentRuntimeReadModel } from "../src/daemon-host/agent-runtime-read.ts";
import { validateAgentRuntimeSession } from "../src/daemon-host/agent-runtime-contract.ts";
import { reduceDispatchLifecycle } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { steerRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import { createActiveRuntime } from "../src/daemon-host/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import {
  findRuntimeSteerHeader,
  readRuntimeSteerVersion,
  runtimeSteerTarget,
} from "../src/daemon-host/runtime-steer-target.ts";
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
    // Same client controlRequestId="shared-key" used for steer on sessionA, steer on sessionB, and later cancel on sessionA.
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
  // Same client key for cancel on sessionA arriving in the next round must ALSO execute!
  events.push(
    livenessCancelControlEvent({
      runtimeSessionId: sessionA,
      controlRequestId: "shared-key",
      opId: "runtime-cancel-req-session-a-shared",
      workspaceRevision: 24,
    }),
  );
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
      "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE workspace_revision > ? AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') IN ('runtime_session_provider_bound', 'runtime_session_liveness_changed') AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND json_extract(event_json, '$.payload.controlReceipt.status') = 'applied' AND json_extract(event_json, '$.payload.controlReceipt.steerVersion') IS NOT NULL ORDER BY workspace_revision DESC LIMIT ?",
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

test("F11/F14: reduceRuntimeSession matches N-1 bb7e55c90 (throws after exit) and pending rejections replay after exit", async () => {
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
  // F11: Both N-1 (bb7e55c90) and N reducers forbid runtime_session_liveness_changed after exit.
  assert.throws(() => reduceRuntimeSession(exitedSession, lateReceiptEvent), /already exited/u);

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

test("F4: bounded pending receipt index and O(1) direct header resolution never open archived or foreign dispatch streams", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f4-bounded-index-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  // Seed 25 archived dispatch streams; make one archived file unreadable (0o000) to prove zero archive reads!
  let unreadableArchivePath = "";
  for (let i = 0; i < 25; i += 1) {
    const id = `dispatch_${String(i).padStart(24, "0")}`;
    openDispatchStream(rootDir, {
      dispatchId: id,
      taskId: null,
      executionId: null,
      runtimeSessionId: `runtime_${String(i).padStart(24, "0")}`,
      instanceId: "inst-1",
      startedAt: "2026-11-21T02:00:00.000Z",
    });
    archiveDispatchStream(rootDir, id);
    if (i === 12) {
      unreadableArchivePath = dispatchStreamPath(rootDir, id);
      chmodSync(unreadableArchivePath, 0o000);
      t.after(() => {
        if (existsSync(unreadableArchivePath)) chmodSync(unreadableArchivePath, 0o600);
      });
    }
  }
  assert.equal(countActiveDispatchStreams(rootDir), 0, "archived streams must not count as active");
  assert.equal(hasPendingSteerReceipts(rootDir), false, "empty pending receipt index must be O(1) false");
  assert.deepEqual(readAllPendingSteerReceipts(rootDir), []);

  // Create one live target + 10 non-target active streams; make a non-target active stream unreadable (0o000)
  // to prove direct O(1) resolution never enumerates or reads unrelated active streams.
  const targetDispatchId = "dispatch_ffffffffffffffffffffffff",
    targetSessionId = "runtime_ffffffffffffffffffffffff";
  openDispatchStream(rootDir, {
    dispatchId: targetDispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId: targetSessionId,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:05:00.000Z",
  });
  let unreadableActivePath = "";
  for (let i = 0; i < 10; i += 1) {
    const otherId = `dispatch_${String(100 + i).padStart(24, "0")}`;
    openDispatchStream(rootDir, {
      dispatchId: otherId,
      taskId: null,
      executionId: null,
      runtimeSessionId: `runtime_${String(100 + i).padStart(24, "0")}`,
      instanceId: "inst-1",
      startedAt: "2026-11-21T02:05:00.000Z",
    });
    if (i === 5) {
      unreadableActivePath = dispatchStreamPath(rootDir, otherId);
      chmodSync(unreadableActivePath, 0o000);
      t.after(() => {
        if (existsSync(unreadableActivePath)) chmodSync(unreadableActivePath, 0o600);
      });
    }
  }

  assert.equal(countActiveDispatchStreams(rootDir), 1);
  assert.ok(findLiveDispatchStreamPath(rootDir, targetDispatchId) !== null);
  assert.equal(findLiveDispatchStreamPath(rootDir, "dispatch_000000000000000000000001"), null);

  const header = findRuntimeSteerHeader(
    rootDir,
    { runtimeSessionId: targetSessionId },
    { knownDispatchId: targetDispatchId, skipLeafScan: true },
  );
  assert.equal(header?.dispatchId, targetDispatchId);
  const target = runtimeSteerTarget(rootDir, "repo-f4", header!, "running", undefined, targetDispatchId);
  assert.equal(target.leafDispatchId, targetDispatchId);
  assert.equal(target.version, 0);

  // Record a pending receipt on an archived dispatch and verify O(1) index lookup + ack cleanup.
  const archivedDispatchId = "dispatch_000000000000000000000003",
    archivedSessionId = "runtime_000000000000000000000003";
  const rcptOpId = recordPendingSteerReceipt(rootDir, archivedDispatchId, "repo-f4", archivedSessionId, {
    status: "rejected",
    controlRequestId: "ctrl-archived-1",
    requestOpId: "op-archived-1",
    reasonCode: "runtime_steer_target_changed",
  });
  assert.equal(rcptOpId, steerReceiptOpId("repo-f4", archivedSessionId, "op-archived-1"));
  assert.equal(hasPendingSteerReceipts(rootDir), true);
  assert.equal(readAllPendingSteerReceipts(rootDir).length, 1);
  markSteerReceiptAcked(rootDir, archivedDispatchId, "repo-f4", archivedSessionId, rcptOpId);
  assert.equal(hasPendingSteerReceipts(rootDir), false);
  assert.deepEqual(readAllPendingSteerReceipts(rootDir), []);
});

test("F12: unified durable controlCursorRevision survives daemon restart across >512 steers and recovers stream/sidecar crashes", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f12-restart-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_121212121212121212121212",
    runtimeSessionId = "runtime_121212121212121212121212";
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:00:00.000Z",
  });

  // Part A: Process 600 (>512) remote steers on one session, then restart consumer from scratch!
  const allEvents: RemoteRuntimeControlEvent[] = [];
  for (let i = 1; i <= 600; i += 1) {
    allEvents.push(
      livenessSteerControlEvent({
        runtimeSessionId,
        dispatchId,
        controlRequestId: `ctrl-${i}`,
        opId: `op-steer-${i}`,
        prompt: `Steer #${i}`,
        workspaceRevision: i,
      }),
    );
  }
  const executedFirst: string[] = [];
  const consumer1 = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [runtimeSessionId],
    isRuntimeActive: (id) => id === runtimeSessionId,
    readDurableCursor: () => readDispatchControlCursor(rootDir, dispatchId),
    advanceDurableCursor: (_sid, rev) => advanceDispatchControlCursor(rootDir, dispatchId, rev),
    readControlEventsPage: async (sid, afterRevision, limit) => {
      const page = allEvents
        .filter((e) => e.payload.runtimeSessionId === sid && e.workspaceRevision > afterRevision)
        .slice(0, limit);
      return { events: page, scannedToRevision: page.length < limit ? 600 : page.at(-1)!.workspaceRevision };
    },
    executeCancel: async () => undefined,
    executeSteer: async (req) => {
      executedFirst.push(req.opId);
    },
    schedule: async (work) => {
      await work();
    },
    pageLimit: 64,
    maxPagesPerDrain: 16,
  });
  for (let round = 0; round < 12 && executedFirst.length < 600; round += 1) {
    await consumer1.drain();
  }
  assert.equal(executedFirst.length, 600);
  assert.equal(readDispatchControlCursor(rootDir, dispatchId), 600);

  // Restart with a fresh consumer (empty in-memory completedOpIds & scanCursorBySession):
  // ZERO of the 600 earlier steers may be re-read or re-delivered!
  const executedAfterRestart: string[] = [];
  const seenAfterRevisions: number[] = [];
  const consumer2 = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [runtimeSessionId],
    isRuntimeActive: (id) => id === runtimeSessionId,
    readDurableCursor: () => readDispatchControlCursor(rootDir, dispatchId),
    advanceDurableCursor: (_sid, rev) => advanceDispatchControlCursor(rootDir, dispatchId, rev),
    readControlEventsPage: async (sid, afterRevision, limit) => {
      seenAfterRevisions.push(afterRevision);
      const page = allEvents
        .filter((e) => e.payload.runtimeSessionId === sid && e.workspaceRevision > afterRevision)
        .slice(0, limit);
      return { events: page, scannedToRevision: 600 };
    },
    executeCancel: async () => undefined,
    executeSteer: async (req) => {
      executedAfterRestart.push(req.opId);
    },
    schedule: async (work) => {
      await work();
    },
  });
  await consumer2.drain();
  assert.deepEqual(seenAfterRevisions, [600], "restarted consumer must resume strictly at durable cursor 600");
  assert.deepEqual(executedAfterRestart, [], "zero earlier steers may re-execute after restart (>512 opIds)");

  // Part B: Crash between write-ahead prepare + stream append and sidecar commit!
  const streamPath = dispatchStreamPath(rootDir, dispatchId);
  prepareDispatchSteerAppend(rootDir, dispatchId, {
    opId: "op-crash-wal-1",
    version: 1,
    streamOffsetBefore: 0,
  });
  appendDispatchStreamRecord(streamPath, {
    kind: "steer_requested",
    opId: "op-crash-wal-1",
    runtimeSessionId,
    version: 1,
    prompt: "Written right before crash",
  });
  // Without calling recordDispatchSteerRequest, readRuntimeSteerVersion must detect pendingAppend and reconcile!
  const seenAfterWalCrash = new Set<string>();
  const recoveredVersion1 = readRuntimeSteerVersion(rootDir, dispatchId, seenAfterWalCrash);
  assert.equal(recoveredVersion1, 1);
  assert.equal(seenAfterWalCrash.has("op-crash-wal-1"), true);

  // Part C: Unprepared crash (raw stream append leaving stale valid sidecar) reconciled on daemon adoption!
  appendDispatchStreamRecord(streamPath, {
    kind: "steer_requested",
    opId: "op-crash-tail-2",
    runtimeSessionId,
    version: 2,
    prompt: "Raw append before crash",
  });
  const reconciled = reconcileDispatchSteerStateFromStream(
    rootDir,
    dispatchId,
    streamPath,
    readRuntimeWorkerChunk,
    parseRecord,
    { forceTailScan: true },
  );
  assert.equal(reconciled?.version, 2);
  assert.equal(reconciled?.opIds.includes("op-crash-tail-2"), true);
});

test("F13: full page of deferred steers never blocks or starves a subsequent cancel event (with SQLite partial index)", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f13-cancel-priority-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Runtime Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "runtime@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
  const repoId = "f13-repo",
    sessionId = "runtime_131313131313131313131313",
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
  // Persist 10 steers (exceeding pageLimit=4) followed by 1 cancel at rev 12.
  for (let i = 1; i <= 10; i += 1) {
    appendEvent({
      schema: "agent-runtime-event/v1",
      eventId: `evt-steer-${i}`,
      opId: `op-steer-${i}`,
      type: "runtime_session_liveness_changed",
      actor,
      source: "local",
      occurredAt: "2026-11-21T02:00:01.000Z",
      payload: {
        runtimeSessionId: sessionId,
        liveness: "live",
        controlRequest: {
          action: "steer",
          controlRequestId: `ctrl-steer-${i}`,
          targetNodeId: "node-a",
          dispatchId: "dispatch_131313131313131313131313",
          prompt: `Deferred steer ${i}`,
        },
      },
    });
  }
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-cancel-after-full-page",
    opId: "op-cancel-after-full-page",
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:00:02.000Z",
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlRequest: {
        action: "cancel",
        controlRequestId: "ctrl-cancel-urgent",
        targetNodeId: "node-a",
      },
    },
  });
  projection.catchUp();

  // Verify SQLite uses event_index_runtime_cancel_control for cancel_control_request filter!
  const db = new DatabaseSync(projection.path, { readOnly: true });
  t.after(() => db.close());
  const cancelPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE workspace_revision > ? AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND (json_extract(event_json, '$.type') = 'runtime_cancel_requested' OR (json_extract(event_json, '$.type') = 'runtime_session_liveness_changed' AND json_extract(event_json, '$.payload.controlRequest.action') = 'cancel')) ORDER BY workspace_revision ASC LIMIT ?",
    )
    .all(0, sessionId, 1) as { detail: string }[];
  assert.ok(
    cancelPlan.some((row) => row.detail.includes("event_index_runtime_cancel_control")),
    `expected event_index_runtime_cancel_control partial index, got: ${JSON.stringify(cancelPlan)}`,
  );

  const active = new Set([sessionId]);
  const executionOrder: string[] = [];
  const consumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [...active],
    isRuntimeActive: (id) => active.has(id),
    readControlEventsPage: async (sid, afterRevision, limit) => {
      const cut = projection.readCut();
      const events = projection.readRuntimeSessionEventsByType(
        sid,
        ["runtime_session_liveness_changed", "runtime_cancel_requested", "runtime_steer_requested"],
        { afterRevision, limit, filter: "control_request" },
      ) as readonly RemoteRuntimeControlEvent[];
      const maxRev = events.reduce((highest, event) => Math.max(highest, event.workspaceRevision), afterRevision);
      return { events, scannedToRevision: events.length < limit ? Math.max(maxRev, cut.watermark) : maxRev };
    },
    readCancelControlEvent: async (sid, afterRevision) => {
      const cut = projection.readCut();
      const events = projection.readRuntimeSessionEventsByType(
        sid,
        ["runtime_session_liveness_changed", "runtime_cancel_requested"],
        { afterRevision, limit: 1, filter: "cancel_control_request" },
      ) as readonly RemoteRuntimeControlEvent[];
      const event = events[0] ?? null;
      return { event, scannedToRevision: event ? event.workspaceRevision : cut.watermark };
    },
    executeCancel: async (req) => {
      executionOrder.push(`cancel:${req.controlRequestId}`);
      active.delete(req.runtimeSessionId);
    },
    executeSteer: async (req) => {
      executionOrder.push(`steer:${req.controlRequestId}`);
      throw Object.assign(new Error("still unavailable"), { code: "runtime_steer_unavailable" });
    },
    schedule: async (work) => {
      await work();
    },
    pageLimit: 4,
    maxPagesPerDrain: 1,
  });

  // Drain 1 saturates deferredSteers (4 steers == pageLimit), yet MUST immediately discover and execute cancel FIRST!
  await consumer.drain();
  assert.equal(
    active.has(sessionId),
    false,
    "cancel must terminate session immediately despite full page of deferred steers",
  );
  assert.equal(executionOrder[0], "cancel:ctrl-cancel-urgent", "cancel must execute before deferred steers");
});

test("F4: readRuntimeDispatchOwner performs O(1) owner lookup with zero liveness history scans", () => {
  let livenessScanCalls = 0;
  const owner = readRuntimeDispatchOwner(
    {
      readRuntimeSession: () => baseSession("runtime_f4owner0000000000000000"),
      readRuntimeDispatch: () =>
        ({
          schema: "agent-runtime-event/v1",
          eventId: "evt-disp",
          opId: "op-disp",
          type: "runtime_dispatch_requested",
          workspaceRevision: 1,
          actor,
          source: { kind: "node", nodeId: "node-a" },
          occurredAt: "2026-11-21T02:00:00.000Z",
          payload: {
            dispatchId: "dispatch_f40000000000000000000001",
            runtimeSessionId: "runtime_f4owner0000000000000000",
            instanceId: "instance-1",
            installationId: "install-1",
            kindId: "codex",
            dispatchKey: "k1",
            definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
            startedAt: "2026-11-21T02:00:00.000Z",
          },
        }) as unknown as Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>,
      readRuntimeSessionEventsByType: () => {
        livenessScanCalls += 1;
        throw new Error("readRuntimeDispatchOwner must never scan liveness history");
      },
    } as never,
    "runtime_f4owner0000000000000000",
  );
  assert.equal(owner?.payload.dispatchId, "dispatch_f40000000000000000000001");
  assert.equal(livenessScanCalls, 0);
});

test("F12: pending receipt store retains >512 items without loss, out-of-order backpressure prevents eviction on restart, and rejection persists before cursor advances", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f12-backpressure-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_12f12f12f12f12f12f12f12f",
    runtimeSessionId = "runtime_12f12f12f12f12f12f12f12f";
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:00:00.000Z",
  });

  // Part A: Record 520 pending receipts across dispatches (>512); item 513..520 must NEVER drop earlier items!
  for (let i = 1; i <= 520; i += 1) {
    const dId = `dispatch_${String(i).padStart(24, "0")}`;
    recordPendingSteerReceipt(rootDir, dId, "repo-f12", `runtime_${String(i).padStart(24, "0")}`, {
      status: "applied",
      controlRequestId: `ctrl-bulk-${i}`,
      requestOpId: `op-bulk-${i}`,
      steerVersion: 1,
    });
  }
  assert.equal(pendingSteerReceiptCount(rootDir), 520, "all 520 pending receipts must be retained without drop");
  assert.equal(readAllPendingSteerReceipts(rootDir)[0]?.outcome.requestOpId, "op-bulk-1");
  assert.equal(readAllPendingSteerReceipts(rootDir)[519]?.outcome.requestOpId, "op-bulk-520");

  // While pending receipts >= 512, consumer backpressures steers while STILL executing cancel immediately!
  let steerCallsUnderBackpressure = 0;
  let cancelCallsUnderBackpressure = 0;
  const bpEvents: RemoteRuntimeControlEvent[] = [
    livenessSteerControlEvent({
      runtimeSessionId,
      dispatchId,
      controlRequestId: "ctrl-bp-steer",
      opId: "op-bp-steer",
      prompt: "Blocked by receipt backpressure",
      workspaceRevision: 10,
    }),
    {
      schema: "agent-runtime-event/v1",
      eventId: "evt-bp-cancel",
      opId: "op-bp-cancel",
      type: "runtime_session_liveness_changed",
      workspaceRevision: 11,
      actor,
      source: "local",
      occurredAt: "2026-11-21T02:00:01.000Z",
      payload: {
        runtimeSessionId,
        liveness: "live",
        controlRequest: {
          action: "cancel",
          controlRequestId: "ctrl-bp-cancel",
          targetNodeId: "node-a",
        },
      },
    },
  ];
  const bpConsumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [runtimeSessionId],
    isRuntimeActive: (id) => id === runtimeSessionId,
    isSteerBackpressured: () => pendingSteerReceiptCount(rootDir) >= PENDING_STEER_RECEIPT_HIGH_WATERMARK,
    readControlEventsPage: async (_sid, afterRevision, limit) => ({
      events: bpEvents.filter((e) => e.workspaceRevision > afterRevision).slice(0, limit),
      scannedToRevision: 11,
    }),
    readCancelControlEvent: async (_sid, afterRevision) => {
      const cancel = bpEvents.find((e) => e.workspaceRevision > afterRevision && e.opId === "op-bp-cancel") ?? null;
      return { event: cancel, scannedToRevision: 11 };
    },
    executeCancel: async () => {
      cancelCallsUnderBackpressure += 1;
    },
    executeSteer: async () => {
      steerCallsUnderBackpressure += 1;
    },
    schedule: async (work) => {
      await work();
    },
  });
  await bpConsumer.drain();
  assert.equal(steerCallsUnderBackpressure, 0, "receipt backlog >= 512 must backpressure steers");
  assert.equal(cancelCallsUnderBackpressure, 1, "cancel must never be blocked by receipt backpressure");

  // Part B: Early deferred steer pins cursor while later steers succeed out-of-order; restart must NEVER re-deliver them!
  const oooEvents: RemoteRuntimeControlEvent[] = [1, 2, 3, 4, 5, 6].map((rev) =>
    livenessSteerControlEvent({
      runtimeSessionId,
      dispatchId,
      controlRequestId: `ctrl-ooo-${rev}`,
      opId: `op-ooo-${rev}`,
      prompt: `OOO steer ${rev}`,
      workspaceRevision: rev,
    }),
  );
  let allowFirst = false;
  const executedOoo: string[] = [];
  const makeOooConsumer = () =>
    createFleetEdgeRuntimeControlConsumer({
      nodeId: () => "node-a",
      activeRuntimeSessionIds: () => [runtimeSessionId],
      isRuntimeActive: (id) => id === runtimeSessionId,
      readDurableCursor: () => readDispatchControlCursor(rootDir, dispatchId),
      advanceDurableCursor: (_sid, rev) => advanceDispatchControlCursor(rootDir, dispatchId, rev),
      readSettledAboveCursor: () => readSettledControlOpIdsAboveCursor(rootDir, dispatchId),
      recordSettledAboveCursor: (_sid, opId, rev) => recordSettledControlAboveCursor(rootDir, dispatchId, opId, rev),
      maxOutOfOrderSteers: 3,
      readControlEventsPage: async (_sid, afterRevision, limit) => ({
        events: oooEvents.filter((e) => e.workspaceRevision > afterRevision).slice(0, limit),
        scannedToRevision: 6,
      }),
      executeCancel: async () => undefined,
      executeSteer: async (req) => {
        if (req.opId === "op-ooo-1" && !allowFirst) {
          throw Object.assign(new Error("temporarily busy"), { code: "runtime_steer_unavailable" });
        }
        executedOoo.push(req.opId);
      },
      schedule: async (work) => {
        await work();
      },
      pageLimit: 6,
      maxPagesPerDrain: 1,
    });
  const ooo1 = makeOooConsumer();
  await ooo1.drain();
  // op-ooo-1 deferred, op-ooo-2..4 succeeded (hitting maxOutOfOrderSteers=3), op-ooo-5..6 backpressured!
  assert.deepEqual(executedOoo, ["op-ooo-2", "op-ooo-3", "op-ooo-4"]);
  assert.equal(readDispatchControlCursor(rootDir, dispatchId), 0, "cursor stays pinned below deferred rev 1");
  assert.equal(readSettledControlOpIdsAboveCursor(rootDir, dispatchId).length, 3);

  // Restart with fresh consumer while op-ooo-1 is still pinned: op-ooo-2..4 must NOT re-execute!
  const ooo2 = makeOooConsumer();
  await ooo2.drain();
  assert.deepEqual(executedOoo, ["op-ooo-2", "op-ooo-3", "op-ooo-4"], "settled out-of-order opIds survive restart");

  // Unblock op-ooo-1: cursor jumps forward, prunes settledAboveCursor, and drains op-ooo-5..6!
  allowFirst = true;
  await ooo2.drain();
  await ooo2.drain();
  assert.deepEqual(executedOoo, ["op-ooo-2", "op-ooo-3", "op-ooo-4", "op-ooo-1", "op-ooo-5", "op-ooo-6"]);
  assert.equal(readDispatchControlCursor(rootDir, dispatchId), 6);
  assert.deepEqual(readSettledControlOpIdsAboveCursor(rootDir, dispatchId), []);

  // Part C: Rejection persistence failure keeps cursor pinned BEFORE the rejected revision!
  const rejDispatch = "dispatch_121212121212121212121299",
    rejSession = "runtime_121212121212121212121299";
  openDispatchStream(rootDir, {
    dispatchId: rejDispatch,
    taskId: null,
    executionId: null,
    runtimeSessionId: rejSession,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:00:00.000Z",
  });
  let failRejectionPersist = true;
  const rejEvent = livenessSteerControlEvent({
    runtimeSessionId: rejSession,
    dispatchId: rejDispatch,
    controlRequestId: "ctrl-rej-1",
    opId: "op-rej-1",
    prompt: "Target mismatch",
    workspaceRevision: 50,
  });
  const rejConsumer = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => "node-a",
    activeRuntimeSessionIds: () => [rejSession],
    isRuntimeActive: (id) => id === rejSession,
    readDurableCursor: () => readDispatchControlCursor(rootDir, rejDispatch),
    advanceDurableCursor: (_sid, rev) => advanceDispatchControlCursor(rootDir, rejDispatch, rev),
    readControlEventsPage: async (_sid, afterRevision) => ({
      events: afterRevision < 50 ? [rejEvent] : [],
      scannedToRevision: 50,
    }),
    executeCancel: async () => undefined,
    executeSteer: async () => {
      throw Object.assign(new Error("mismatch"), { code: "runtime_steer_target_changed" });
    },
    reportSteerRejection: async () => {
      if (failRejectionPersist) throw Object.assign(new Error("disk busy"), { code: "busy" });
    },
    schedule: async (work) => {
      await work();
    },
  });
  await rejConsumer.drain();
  assert.equal(
    readDispatchControlCursor(rootDir, rejDispatch),
    49,
    "cursor must NOT advance past rev 50 while rejection persistence is deferred",
  );
  failRejectionPersist = false;
  await rejConsumer.drain();
  assert.equal(readDispatchControlCursor(rootDir, rejDispatch), 50, "cursor advances once rejection persists");
});

test("F17: legacy stream hydration preserves existing steer version before cursor write, and adopted N-1 worker rejects remote steer while preserving local steer", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f17-rolling-upgrade-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_171717171717171717171717",
    runtimeSessionId = "runtime_171717171717171717171717";
  // Create a legacy stream WITHOUT steerReceiptProtocolVersion and WITHOUT a sidecar file!
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "inst-1",
    startedAt: "2026-11-21T02:00:00.000Z",
    binding: { actor, source: { kind: "node", nodeId: "node-a" } },
    executionOwner: { nodeId: "node-a" },
  });
  removeDispatchSteerState(rootDir, dispatchId);
  const streamPath = dispatchStreamPath(rootDir, dispatchId);
  for (let v = 1; v <= 3; v += 1) {
    appendDispatchStreamRecord(streamPath, {
      kind: "steer_requested",
      opId: `op-legacy-${v}`,
      runtimeSessionId,
      version: v,
      prompt: `Legacy steer ${v}`,
    });
  }
  assert.equal(readDispatchSteerState(rootDir, dispatchId), null, "legacy stream begins with no sidecar");

  // Advancing controlCursorRevision on a rolling upgrade MUST hydrate version=3 instead of writing version=0!
  advanceDispatchControlCursor(rootDir, dispatchId, 42);
  const hydrated = readDispatchSteerState(rootDir, dispatchId);
  assert.equal(hydrated?.version, 3, "rolling-upgrade cursor write must preserve legacy steer version=3");
  assert.equal(hydrated?.controlCursorRevision, 42);
  assert.deepEqual(hydrated?.opIds, ["op-legacy-1", "op-legacy-2", "op-legacy-3"]);

  // Adopted N-1 worker (`steerReceiptCapable: false`) rejects remote steer with runtime_steer_unsupported
  // while local steer STILL succeeds and increments version 3 -> 4!
  const active = createActiveRuntime({
    process: {
      pid: 99999,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    dispatchId,
    runtimeSessionId,
    dispatchOpId: "op-disp-17",
    instanceId: "inst-1",
    kindId: "codex",
    resolvedProviderDirectory: null,
    permissionMode: null,
    agent: null,
    role: null,
    delegatedBy: null,
    squadId: null,
    publicationOwner: "runtime",
    parentRuntimeSessionId: null,
    binding: { actor, source: { kind: "node", nodeId: "node-a" } },
    task: null,
    decisionReviewTarget: null,
    schedule: null,
    cwd: rootDir,
    prompt: "legacy worker",
    onExitCommand: null,
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
    tokenLimit: null,
    stallTimeoutMs: 60_000,
    lastProgressAtMs: Date.now(),
    steerReceiptCapable: false,
    startedAt: "2026-11-21T02:00:00.000Z",
    stream: {} as never,
    resumeProviderSessionId: null,
    providerSessionId: "thread-legacy-1",
  });
  const spawnerContext = {
    input: {
      repoId: "repo-f17",
      rootDir,
      runtimeNode: { nodeId: "node-a" },
      now: () => "2026-11-21T02:01:00.000Z",
      remote: {
        readDispatchLifecycle: async () => ({
          status: "ready",
          watermark: 42,
          sourceRevision: 42,
          rows: [
            {
              attempt: {
                dispatchId,
                runtimeSessionId,
                kindId: "codex",
                phase: "running",
                process: "alive",
                stopProof: "none",
                outcome: null,
                fence: { verified: true, owner: "node:node-a" },
              },
              policy: { processAlive: true, canSteer: true, attemptSettled: false, groupSettled: false },
              controlLeafDispatchId: dispatchId,
            },
          ],
        }),
      },
    },
    processes: new Map([[runtimeSessionId, active]]),
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;

  await assert.rejects(
    steerRuntime(
      spawnerContext,
      { runtimeSessionId, prompt: "Remote steer against N-1 worker" },
      { actor, source: { kind: "node", nodeId: "node-a" } },
      { remoteControlRequestId: "ctrl-remote-n1", remoteControlOpId: "op-remote-n1" },
    ),
    { code: "runtime_steer_unsupported" },
  );
  assert.equal(readRuntimeSteerVersion(rootDir, dispatchId), 3, "rejected remote steer must not mutate version");

  const localSteer = await steerRuntime(
    spawnerContext,
    { runtimeSessionId, prompt: "Local steer still allowed on adopted N-1 worker", expected: { version: 3 } },
    { actor, source: { kind: "node", nodeId: "node-a" } },
  );
  assert.equal(localSteer.outcome, "applied");
  assert.equal(readRuntimeSteerVersion(rootDir, dispatchId), 4);
});

test("F18: controlRequest and controlReceipt carrier events preserve exact unknown/stale liveness, attachable, lastObservedAt, and attempt.process", () => {
  const unknownSession: RuntimeSession = {
    ...baseSession("runtime_f18000000000000000000000"),
    liveness: "unknown",
    attachable: false,
    lastObservedAt: "2026-11-21T01:00:00.000Z",
  };
  const controlReqEvent: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "evt-f18-req",
    opId: "op-f18-req",
    type: "runtime_session_liveness_changed",
    workspaceRevision: 10,
    actor,
    source: "local",
    occurredAt: "2026-11-21T02:00:00.000Z",
    payload: {
      runtimeSessionId: unknownSession.runtimeSessionId,
      liveness: "live", // even if carrier field says live, reducer MUST preserve unknown!
      controlRequest: {
        action: "cancel",
        controlRequestId: "ctrl-f18-cancel",
        targetNodeId: "node-a",
      },
    },
  };
  const afterReq = reduceRuntimeSession(unknownSession, controlReqEvent);
  assert.strictEqual(
    afterReq,
    unknownSession,
    "controlRequest must not mutate unknown liveness/attachable/lastObservedAt",
  );

  const providerBoundReceipt: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "evt-f18-rcpt",
    opId: "op-f18-rcpt",
    type: "runtime_session_provider_bound",
    workspaceRevision: 11,
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T02:01:00.000Z",
    payload: {
      runtimeSessionId: unknownSession.runtimeSessionId,
      providerSessionId: unknownSession.providerSessionId!,
      transcriptRef: unknownSession.transcriptRef!,
      controlReceipt: {
        action: "steer",
        controlRequestId: "ctrl-f18-steer",
        requestOpId: "op-f18-steer",
        status: "rejected",
        reasonCode: "runtime_cancelled",
      },
    },
  };
  assert.deepEqual(validateCurrentAgentRuntimeEvent(providerBoundReceipt), []);
  assert.strictEqual(
    reduceRuntimeSession(unknownSession, providerBoundReceipt),
    unknownSession,
    "controlReceipt on provider_bound must preserve unknown session unchanged",
  );
  // Also survives after exit!
  const exitedSession: RuntimeSession = { ...unknownSession, liveness: "exited", outcome: "cancelled" };
  assert.strictEqual(
    reduceRuntimeSession(exitedSession, providerBoundReceipt),
    exitedSession,
    "F5: controlReceipt on provider_bound must persist cleanly even after session exited",
  );

  // Dispatch lifecycle attempt.process must stay "unknown" (never flipped to "alive")!
  const dispatchReq: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "evt-f18-disp",
    opId: "op-f18-disp",
    type: "runtime_dispatch_requested",
    workspaceRevision: 1,
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T01:00:00.000Z",
    payload: {
      dispatchId: "dispatch_f18000000000000000000000",
      runtimeSessionId: unknownSession.runtimeSessionId,
      instanceId: "instance-1",
      installationId: "install-1",
      kindId: "codex",
      dispatchKey: "k-f18",
      definitionSnapshotRef: unknownSession.definitionSnapshotRef,
      startedAt: "2026-11-21T01:00:00.000Z",
    },
  };
  const step1 = reduceDispatchLifecycle(null, dispatchReq);
  assert.equal(step1.kind, "applied");
  const step2 = reduceDispatchLifecycle(step1.group, {
    schema: "agent-runtime-event/v1",
    eventId: "evt-f18-unknown",
    opId: "op-f18-unknown",
    type: "runtime_session_liveness_changed",
    workspaceRevision: 2,
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T01:05:00.000Z",
    payload: { runtimeSessionId: unknownSession.runtimeSessionId, liveness: "unknown" },
  });
  assert.equal(step2.kind, "applied");
  assert.equal(step2.group.attempts[0]?.process, "unknown");
  const step3 = reduceDispatchLifecycle(step2.group, {
    ...controlReqEvent,
    source: { kind: "node", nodeId: "node-a" },
  });
  if (step3.kind === "applied") {
    assert.equal(
      step3.group.attempts[0]?.process,
      "unknown",
      "dispatch-lifecycle must not promote unknown process to alive on control carrier",
    );
  } else {
    assert.equal(step3.kind, "ignored");
  }
});

test("F19: controlReceipts cursor pagination reaches >500 receipts and requestOpId point lookup uses partial index", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-f19-receipts-page-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Runtime Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "runtime@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
  const repoId = "f19-repo",
    sessionId = "runtime_191919191919191919191919",
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
    eventId: "evt-inst-19",
    opId: "op-inst-19",
    type: "runtime_installation_observed",
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T02:00:00.000Z",
    payload: {
      installationId: "install-1",
      kindId: "codex",
      protocolFamily: "codex",
      hostRef: "host:local",
      version: "1.0.0",
      discoverySource: "wrapper",
      capabilities: ["attach"],
    },
  });
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-start-19",
    opId: "op-start-19",
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
  appendEvent({
    schema: "agent-runtime-event/v1",
    eventId: "evt-bind-19",
    opId: "op-bind-19",
    type: "runtime_session_provider_bound",
    actor,
    source: { kind: "node", nodeId: "node-a" },
    occurredAt: "2026-11-21T02:00:01.000Z",
    payload: {
      runtimeSessionId: sessionId,
      providerSessionId: "thread-19",
      transcriptRef: "provider:codex/thread-19",
    },
  });
  for (let i = 1; i <= 520; i += 1) {
    appendEvent({
      schema: "agent-runtime-event/v1",
      eventId: `evt-rcpt-19-${i}`,
      opId: `op-rcpt-19-${i}`,
      type: "runtime_session_provider_bound",
      actor,
      source: { kind: "node", nodeId: "node-a" },
      occurredAt: "2026-11-21T02:00:02.000Z",
      payload: {
        runtimeSessionId: sessionId,
        providerSessionId: "thread-19",
        transcriptRef: "provider:codex/thread-19",
        controlReceipt: {
          action: "steer",
          controlRequestId: `ctrl-19-${i}`,
          requestOpId: `op-req-19-${i}`,
          status: "applied",
          steerVersion: i,
        },
      },
    });
  }
  projection.catchUp();

  const readModel = makeAgentRuntimeReadModel({ projection, store });
  // Default read omits controlReceipts & controlReceiptsPage.
  const defaultRead = readModel.session({ runtimeSessionId: sessionId });
  assert.deepEqual(validateAgentRuntimeSession(defaultRead), []);
  assert.equal(defaultRead.session.controlReceipts, undefined);
  assert.equal(defaultRead.controlReceiptsPage, undefined);

  // Page 1 returns 500 receipts with hasMore=true and nextCursor.
  const page1 = readModel.session({ runtimeSessionId: sessionId, includeControlReceipts: true });
  assert.deepEqual(validateAgentRuntimeSession(page1), []);
  assert.equal(page1.session.controlReceipts?.length, 500);
  assert.equal(page1.controlReceiptsPage?.hasMore, true);
  assert.ok(page1.controlReceiptsPage?.nextCursor?.startsWith("receipt:"));

  // Page 2 resumes from nextCursor and returns receipts #501..#520 with hasMore=false!
  const page2 = readModel.session({
    runtimeSessionId: sessionId,
    controlReceiptsCursor: page1.controlReceiptsPage!.nextCursor!,
  });
  assert.deepEqual(validateAgentRuntimeSession(page2), []);
  assert.equal(page2.session.controlReceipts?.length, 20);
  assert.equal(page2.session.controlReceipts?.[0]?.requestOpId, "op-req-19-501");
  assert.equal(page2.session.controlReceipts?.[19]?.requestOpId, "op-req-19-520");
  assert.equal(page2.controlReceiptsPage?.hasMore, false);
  assert.equal(page2.controlReceiptsPage?.nextCursor, null);

  // Point lookup by requestOpId reads receipt #515 directly in O(1)!
  const point = readModel.session({
    runtimeSessionId: sessionId,
    controlReceiptRequestOpId: "op-req-19-515",
  });
  assert.deepEqual(validateAgentRuntimeSession(point), []);
  assert.equal(point.session.controlReceipts?.length, 1);
  assert.equal(point.session.controlReceipts?.[0]?.controlRequestId, "ctrl-19-515");
  assert.equal(point.session.controlReceipts?.[0]?.steerVersion, 515);

  // Verify SQLite uses event_index_runtime_control_receipt_req partial index for requestOpId lookup!
  const db = new DatabaseSync(projection.path, { readOnly: true });
  t.after(() => db.close());
  const reqPlan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE workspace_revision > ? AND json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.payload.runtimeSessionId') = ? AND json_extract(event_json, '$.type') IN ('runtime_session_provider_bound', 'runtime_session_liveness_changed') AND json_extract(event_json, '$.payload.controlReceipt.requestOpId') IS NOT NULL AND json_extract(event_json, '$.payload.controlReceipt.requestOpId') = ? ORDER BY workspace_revision ASC LIMIT ?",
    )
    .all(0, sessionId, "op-req-19-515", 1) as { detail: string }[];
  assert.ok(
    reqPlan.some((row) => row.detail.includes("event_index_runtime_control_receipt_req")),
    `expected event_index_runtime_control_receipt_req partial index, got: ${JSON.stringify(reqPlan)}`,
  );
});
