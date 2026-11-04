// harness-test-tier: fast
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeEventV1,
  RuntimeInstallation,
  RuntimeProviderUnreachable,
  RuntimeSession,
  TaskProjection,
} from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import { validateAgentRuntimeOverview } from "../src/agent-runtime-contract.ts";
import { readTaskDispatches } from "../src/dispatch-read.ts";
import { appendRuntimeWorkerRecord, openDispatchStream, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { noteProviderProgress, noteProviderReconnect } from "../src/runtime-provider-connectivity.ts";
import { isStructuredSuccessResult, parseProviderFrame } from "../src/runtime-spawn-provider-frames.ts";
import { consumeProviderLine } from "../src/runtime-spawn-provider-stream.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

const dispatchId = "dispatch_0123456789abcdef01234567",
  runtimeSessionId = "runtime-provider-stalled",
  taskId = "task-provider-stalled",
  reconnectError = "Reconnecting... 5/5 (failed to connect to websocket: IO error: tls handshake eof)";

type Dispatch = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;

function session(startedAt: string, providerUnreachable: RuntimeProviderUnreachable | null = null): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-codex",
    installationId: "installation-codex",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness: "live",
    attachable: false,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: startedAt,
    ...(providerUnreachable === null ? {} : { providerUnreachable }),
  };
}

function installation(startedAt: string): RuntimeInstallation {
  return {
    installationId: "installation-codex",
    kindId: "codex",
    protocolFamily: "codex",
    hostRef: "host",
    version: "1.0.0",
    discoverySource: "hook",
    effectiveCapabilities: [],
    lastObservedAt: startedAt,
  };
}

function dispatchEvent(startedAt: string): Dispatch {
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: startedAt,
    payload: {
      dispatchId,
      runtimeSessionId,
      taskId,
      executionId: "execution-provider-stalled",
      instanceId: "instance-codex",
      installationId: "installation-codex",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      attemptGroupId: dispatchId,
      attemptIndex: 0,
      role: "implementation",
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "instance-codex",
        installationId: "installation-codex",
        kindId: "codex",
        providerId: "provider-codex",
        model: "gpt-5",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription",
      },
    },
  } as unknown as Dispatch;
}

function projection(startedAt: string, providerUnreachable: RuntimeProviderUnreachable | null = null): TaskProjection {
  const current = session(startedAt, providerUnreachable),
    event = dispatchEvent(startedAt),
    installationRow = installation(startedAt);
  return {
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    read: () => ({
      watermark: 1,
      sourceRevision: 1,
      packagePath: "tasks/task-provider-stalled",
      snapshot: { task: { taskId, title: "provider stalled" } },
    }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: "tasks/task-provider-stalled", sessions: [current], title: "provider stalled" }],
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeSessions: () => [current],
    readRuntimeSession: () => current,
    readRuntimeDispatchesByTaskIds: () => [event],
    readRuntimeDispatch: () => event,
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => [],
    readRuntimeDispatchesBySession: () => [],
    readRuntimeInstallations: () => [installationRow],
    readRuntimeInstallation: () => installationRow,
    readRuntimeSessionEvents: () => [],
    readRuntimeDispatchEventsBySession: () => [],
    currentLease: () => null,
    readDocument: () => ({ document: null }),
    readTaskRelationsBySources: () => ({ rows: [] }),
    readLeaseIntervals: () => [],
    readCanonicalEvents: () => ({ events: [] }),
    readEventWitness: () => null,
  } as unknown as TaskProjection;
}

test("provider reconnect frames surface as stalled, keep last progress and the raw error, and clear on recovery", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-unreachable-")),
    now = Date.now(),
    startedAt = new Date(now - 30 * 60_000).toISOString(),
    progressAt = new Date(now - 20 * 60_000).toISOString(),
    reconnectAt = new Date(now - 19 * 60_000).toISOString(),
    reads = () =>
      makeAgentRuntimeReadModel({
        store: { readContentBlob: () => null },
        projection: projection(startedAt),
        rootDir,
        now: () => new Date(now + 1_000).toISOString(),
      });
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      taskId,
      executionId: "execution-provider-stalled",
      runtimeSessionId,
      instanceId: "instance-codex",
      installationId: "installation-codex",
      kindId: "codex",
      startedAt,
      stallTimeoutMs: 5 * 60_000,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      occurredAt: startedAt,
      pid: process.pid,
    });
    // A real turn starts, then the provider reports a failed connection. The reconnect must not
    // move the progress clock: that bug is what kept the runtime looking "thinking" for 2h16m.
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: progressAt,
      event: { type: "turn.started" },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: reconnectAt,
      event: { type: "error", message: reconnectError },
    });

    const overview = reads().overview({});
    const unreachable = {
      state: "provider_unreachable",
      lastProgressAt: progressAt,
      lastErrorAt: reconnectAt,
      lastError: reconnectError,
    };
    assert.equal(overview.sessions[0]?.liveness, "live");
    assert.deepEqual(overview.sessions[0]?.activity.providerUnreachable, unreachable);
    assert.deepEqual(validateAgentRuntimeOverview(overview), []);

    const dispatch = readTaskDispatches({ projection: projection(startedAt), taskId, rootDir }).dispatches[0]!;
    assert.equal(dispatch.activityStatus, "stalled");
    assert.equal(dispatch.activityObservedAt, progressAt);
    assert.deepEqual(dispatch.providerUnreachable, unreachable);

    // The provider comes back and the same turn makes progress: the classification must disappear
    // even though the historical reconnect record is still in the stream.
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: new Date(now).toISOString(),
      event: { type: "item.completed", item: { type: "agent_message", text: "resumed" } },
    });
    assert.equal(reads().overview({}).sessions[0]?.activity.providerUnreachable, undefined);
    assert.equal(
      readTaskDispatches({ projection: projection(startedAt), taskId, rootDir }).dispatches[0]?.activityStatus,
      "thinking",
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bounded summary keeps the exact last real progress when reconnect frames overflow the tail window", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-long-stream-")),
    now = Date.now(),
    startedAt = new Date(now - 60 * 60_000).toISOString(),
    recentProgressAt = new Date(now - 60_000).toISOString(),
    padding = "x".repeat(10_000);
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      taskId,
      executionId: "execution-provider-stalled",
      runtimeSessionId,
      instanceId: "instance-codex",
      installationId: "installation-codex",
      kindId: "codex",
      startedAt,
      stallTimeoutMs: 5 * 60_000,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      occurredAt: startedAt,
      pid: process.pid,
    });
    // Push the recent real progress beyond the 16KB head window without adding a newer event.
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: new Date(now - 30 * 60_000).toISOString(),
      event: { type: "item.completed", item: { type: "agent_message", text: padding } },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: recentProgressAt,
      event: { type: "item.completed", item: { type: "agent_message", text: "recent progress" } },
    });
    // More than 128KB of reconnect diagnostics follows: the recent progress is now in the gap
    // between the head windows and the tail window. Each frame carries the progress clock it saw.
    let lastReconnectAt = "";
    for (let index = 0; index < 20; index += 1) {
      lastReconnectAt = new Date(now - 50_000 + index * 2_000).toISOString();
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "provider_event",
        occurredAt: lastReconnectAt,
        lastProgressAt: recentProgressAt,
        event: { type: "error", message: `${reconnectError} ${padding}` },
      });
    }
    const summary = readDispatchStreamSummary(rootDir, dispatchId)!;
    assert.equal(summary.lastProgressAt, recentProgressAt);

    const reads = (at: number) =>
      makeAgentRuntimeReadModel({
        store: { readContentBlob: () => null },
        projection: projection(startedAt),
        rootDir,
        now: () => new Date(at).toISOString(),
      });
    // The true stall is one minute: the classification must not fire merely because the progress
    // record fell outside the tail window.
    assert.equal(reads(now).overview({}).sessions[0]?.activity.providerUnreachable, undefined);
    assert.deepEqual(reads(now + 5 * 60_000).overview({}).sessions[0]?.activity.providerUnreachable, {
      state: "provider_unreachable",
      lastProgressAt: recentProgressAt,
      lastErrorAt: lastReconnectAt,
      lastError: `${reconnectError} ${padding}`,
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("legacy reconnect tails without a progress stamp use a conservative bound and do not fire early", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-legacy-stream-")),
    now = Date.now(),
    startedAt = new Date(now - 60 * 60_000).toISOString(),
    recentProgressAt = new Date(now - 60_000).toISOString(),
    padding = "y".repeat(10_000);
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      taskId,
      executionId: "execution-provider-stalled",
      runtimeSessionId,
      instanceId: "instance-codex",
      installationId: "installation-codex",
      kindId: "codex",
      startedAt,
      stallTimeoutMs: 5 * 60_000,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      occurredAt: startedAt,
      pid: process.pid,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: new Date(now - 30 * 60_000).toISOString(),
      event: { type: "item.completed", item: { type: "agent_message", text: padding } },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: recentProgressAt,
      event: { type: "item.completed", item: { type: "agent_message", text: "recent progress" } },
    });
    // Streams written before the stamp existed cannot locate the gap progress in O(1). The
    // conservative bound is the first complete tail record, which is later than that progress.
    for (let index = 0; index < 20; index += 1) {
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "provider_event",
        occurredAt: new Date(now - 50_000 + index * 2_000).toISOString(),
        event: { type: "error", message: `${reconnectError} ${padding}` },
      });
    }
    const summary = readDispatchStreamSummary(rootDir, dispatchId)!;
    assert.ok(Date.parse(summary.lastProgressAt) >= Date.parse(recentProgressAt));
    const overview = makeAgentRuntimeReadModel({
      store: { readContentBlob: () => null },
      projection: projection(startedAt),
      rootDir,
      now: () => new Date(now).toISOString(),
    }).overview({});
    assert.equal(overview.sessions[0]?.activity.providerUnreachable, undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the center serves the classification reported by the executing node without a local stream", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-center-")),
    now = Date.now(),
    startedAt = new Date(now - 60_000).toISOString(),
    reported = {
      state: "provider_unreachable",
      lastProgressAt: new Date(now - 20 * 60_000).toISOString(),
      lastErrorAt: new Date(now - 19 * 60_000).toISOString(),
      lastError: reconnectError,
    } as const,
    reads = (reportedValue: RuntimeProviderUnreachable | null) =>
      makeAgentRuntimeReadModel({
        store: { readContentBlob: () => null },
        projection: projection(startedAt, reportedValue),
        rootDir,
        now: () => new Date(now).toISOString(),
      });
  try {
    const overview = reads(reported).overview({});
    assert.deepEqual(overview.sessions[0]?.activity.providerUnreachable, reported);
    assert.deepEqual(validateAgentRuntimeOverview(overview), []);
    const dispatch = readTaskDispatches({
      projection: projection(startedAt, reported),
      taskId,
      rootDir,
    }).dispatches[0]!;
    assert.equal(dispatch.activityStatus, "stalled");
    assert.deepEqual(dispatch.providerUnreachable, reported);

    // A recovery report clears the center view; no center-side network probe or re-derivation.
    assert.equal(reads(null).overview({}).sessions[0]?.activity.providerUnreachable, undefined);
    const cleared = readTaskDispatches({ projection: projection(startedAt), taskId, rootDir }).dispatches[0]!;
    assert.equal(cleared.activityStatus, "thinking");
    assert.equal(cleared.providerUnreachable, undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the executing node reports the classification and its recovery once each", async () => {
  const now = Date.now(),
    published: { readonly type: string; readonly payload: Record<string, unknown> }[] = [],
    context = {
      exiting: new Set<string>(),
      publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
        published.push({ type, payload });
        return {};
      },
    } as unknown as RuntimeSpawnerContext,
    active = {
      runtimeSessionId,
      stallTimeoutMs: 5 * 60_000,
      binding: {},
      stalledAt: null,
      lastRealProgressAtMs: now - 6 * 60_000,
      providerUnreachable: null,
    } as unknown as ActiveRuntime;
  await noteProviderReconnect(context, active, { attempt: 5, limit: 5, diagnostic: reconnectError }, now);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.type, "runtime_session_liveness_changed");
  assert.deepEqual(published[0]?.payload.providerUnreachable, {
    state: "provider_unreachable",
    lastProgressAt: new Date(now - 6 * 60_000).toISOString(),
    lastErrorAt: new Date(now).toISOString(),
    lastError: reconnectError,
  });

  // Repeating the same failure text is not a new state and must not publish a heartbeat.
  await noteProviderReconnect(context, active, { attempt: 5, limit: 5, diagnostic: reconnectError }, now + 1_000);
  assert.equal(published.length, 1);

  await noteProviderProgress(context, active, now + 2_000);
  assert.equal(published.length, 2);
  assert.equal(published[1]?.payload.providerUnreachable, null);
  assert.equal(active.providerUnreachable, null);

  // Below the threshold a reconnect stays an ordinary observation.
  const calmPublished: unknown[] = [],
    calmContext = {
      exiting: new Set<string>(),
      publishRuntimeEvent: async (_type: string, payload: Record<string, unknown>) => {
        calmPublished.push(payload);
        return {};
      },
    } as unknown as RuntimeSpawnerContext,
    calm = {
      runtimeSessionId,
      stallTimeoutMs: 5 * 60_000,
      binding: {},
      stalledAt: null,
      lastRealProgressAtMs: now - 60_000,
      providerUnreachable: null,
    } as unknown as ActiveRuntime;
  await noteProviderReconnect(calmContext, calm, { attempt: 5, limit: 5, diagnostic: reconnectError }, now);
  assert.deepEqual(calmPublished, []);
});

test("the live persisted worker-host path reports and clears without sliding the progress clock", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-provider-persisted-")),
    now = Date.now(),
    startedAt = new Date(now - 30 * 60_000).toISOString(),
    progressAt = new Date(now - 10 * 60_000).toISOString(),
    padding = "z".repeat(10_000),
    stream = openDispatchStream(rootDir, {
      dispatchId,
      taskId,
      executionId: "execution-provider-stalled",
      runtimeSessionId,
      instanceId: "instance-codex",
      installationId: "installation-codex",
      kindId: "codex",
      startedAt,
      stallTimeoutMs: 5 * 60_000,
    }),
    active = {
      runtimeSessionId,
      kindId: "codex",
      stream,
      durableOutputCount: 0,
      lastRealProgressAtMs: Date.parse(startedAt),
      providerUnreachable: null,
      lossReason: null,
      cancelRequested: false,
      stalledAt: null,
      stallTimeoutMs: 5 * 60_000,
      binding: {},
    } as unknown as ActiveRuntime;
  let clock = Date.parse(progressAt);
  const published: { readonly type: string; readonly payload: Record<string, unknown> }[] = [];
  const context = {
    input: {
      now: () => new Date(clock).toISOString(),
      stream: { publish: () => undefined },
    },
    parseProviderFrame,
    isStructuredSuccessResult,
    bindProvider: async () => undefined,
    markProtocolError: () => assert.fail("valid persisted provider output was rejected"),
    publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
      return {};
    },
    exiting: new Set<string>(),
  } as unknown as RuntimeSpawnerContext;
  const consumePersisted = async (event: Record<string, unknown>, occurredAt: string): Promise<void> => {
    // The worker host writes first; the daemon tails the same record with persisted=true.
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", occurredAt, event });
    clock = Date.parse(occurredAt);
    await consumeProviderLine(context, active, JSON.stringify(event), true);
  };
  try {
    await consumePersisted({ type: "turn.started" }, progressAt);
    assert.equal(active.lastRealProgressAtMs, Date.parse(progressAt));
    // A reconnect flood larger than the 128KB tail window: every persisted frame must still be
    // observed live, and every frame carries a stable marker for the true progress clock.
    let lastReconnectAt = "",
      firstReconnectAt = "";
    for (let index = 0; index < 20; index += 1) {
      lastReconnectAt = new Date(now - 2 * 60_000 + index * 1_000).toISOString();
      if (index === 0) firstReconnectAt = lastReconnectAt;
      await consumePersisted({ type: "error", message: `${reconnectError} ${padding}` }, lastReconnectAt);
    }
    assert.equal(published.length, 1);
    assert.deepEqual(published[0]?.payload.providerUnreachable, {
      state: "provider_unreachable",
      lastProgressAt: progressAt,
      lastErrorAt: firstReconnectAt,
      lastError: `${reconnectError} ${padding}`,
    });
    const summary = readDispatchStreamSummary(rootDir, dispatchId)!;
    assert.equal(summary.lastProgressAt, progressAt);

    // Recovery through the same persisted path clears the report.
    const recoveryAt = new Date(Date.parse(lastReconnectAt) + 1_000).toISOString();
    await consumePersisted({ type: "item.completed", item: { type: "agent_message", text: "resumed" } }, recoveryAt);
    assert.equal(published.length, 2);
    assert.equal(published[1]?.payload.providerUnreachable, null);
    assert.equal(readDispatchStreamSummary(rootDir, dispatchId)!.lastProgressAt, recoveryAt);

    // Adoption replay uses publishSignals=false: it must neither report nor re-stamp.
    const replayActive = { ...active, lastRealProgressAtMs: Date.parse(recoveryAt) } as ActiveRuntime;
    await consumeProviderLine(
      context,
      replayActive,
      JSON.stringify({ type: "error", message: `${reconnectError} ${padding}` }),
      true,
      false,
    );
    assert.equal(published.length, 2);
    assert.equal(readDispatchStreamSummary(rootDir, dispatchId)!.lastProgressAt, recoveryAt);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
