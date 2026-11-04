// harness-test-tier: fast
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeEventV1,
  RuntimeInstallation,
  RuntimeSession,
  TaskProjection,
} from "@harness-anything/kernel";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";
import { validateAgentRuntimeOverview } from "../src/agent-runtime-contract.ts";
import { readTaskDispatches } from "../src/dispatch-read.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";

const dispatchId = "dispatch_0123456789abcdef01234567",
  runtimeSessionId = "runtime-provider-stalled",
  taskId = "task-provider-stalled",
  reconnectError = "Reconnecting... 5/5 (failed to connect to websocket: IO error: tls handshake eof)";

type Dispatch = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;

function session(startedAt: string): RuntimeSession {
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

function projection(startedAt: string): TaskProjection {
  const current = session(startedAt),
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
