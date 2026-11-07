// harness-test-tier: fast
// Edge dispatches execute their provider stream on the edge node, while `repo.task.dispatches`
// behind `ha task dispatches` is served by the center. The center keeps the canonical row; the
// read on the executing node must join back the evidence that only exists there: the live
// activity judgment and the transcript ref. The center-shaped projection below deliberately has
// no local dispatch stream, exactly like the center daemon. The two instances named by the
// incident are covered: the DeepSeek Harness worker on ds-bailian and the Codex worker on
// codex-api.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjection } from "@harness-anything/kernel";
import { readTaskDispatches, withLocalDispatchStreamEvidence } from "../src/dispatch-read.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";

const dispatchId = "dispatch_5beaecffdf966066d2816b0d",
  runtimeSessionId = "runtime_c55acf69e24aca9e79143d30",
  taskId = "task_edge_activity",
  taskPackagePath = "tasks/task_edge_activity",
  executionId = "execution_edge_activity";
type Dispatch = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;

const edgeInstances = [
  {
    kindId: "deepseek-harness",
    instanceId: "ds-bailian",
    toolFrame: { type: "acp.update", update: { sessionUpdate: "tool_call" } },
  },
  {
    kindId: "codex",
    instanceId: "codex-api",
    toolFrame: { type: "item.started", item: { type: "command_execution" } },
  },
] as const;

function edgeSession(input: {
  readonly kindId: string;
  readonly instanceId: string;
  readonly transcriptRef: string | null;
  readonly lastObservedAt: string;
}): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: input.instanceId,
    installationId: "installation-edge",
    kindId: input.kindId,
    definitionSnapshotRef: "artifact:runtime-definition/edge",
    providerSessionId: "provider-session-edge",
    transcriptRef: input.transcriptRef,
    launchGeneration: 1,
    liveness: "live",
    attachable: true,
    taskBindings: [],
    outcome: null,
    exitCode: null,
    resultRef: null,
    lastObservedAt: input.lastObservedAt,
  };
}

function dispatchEvent(session: RuntimeSession, startedAt: string): Dispatch {
  return {
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: startedAt,
    payload: {
      dispatchId,
      runtimeSessionId,
      taskId,
      executionId,
      instanceId: session.instanceId,
      definitionSnapshotRef: session.definitionSnapshotRef,
      attemptGroupId: dispatchId,
      attemptIndex: 0,
      role: "implementation",
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: session.instanceId,
        installationId: session.installationId,
        kindId: session.kindId,
        providerId: session.instanceId,
        model: "test-model",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "api-key",
      },
    },
  } as unknown as Dispatch;
}

/** A center-side projection: the canonical session plus its dispatch event, and no local stream. */
function centerProjection(
  session: RuntimeSession,
  options: {
    readonly taskStatus?: string;
    readonly archive?: Record<string, unknown>;
  } = {},
): TaskProjection {
  const event = dispatchEvent(session, session.lastObservedAt),
    dispatchDocumentPath = `${taskPackagePath}/artifacts/dispatches/${dispatchId}.json`;
  return {
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    read: () => ({
      watermark: 1,
      sourceRevision: 1,
      packagePath: taskPackagePath,
      snapshot: {
        task: {
          taskId,
          title: "edge dispatch",
          ...(options.taskStatus === undefined ? {} : { status: options.taskStatus }),
        },
      },
    }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: [taskId],
      rows: [{ taskId, packagePath: taskPackagePath, sessions: [session], title: "edge dispatch" }],
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeSession: () => session,
    readRuntimeDispatchesByTaskIds: () => [event],
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => [],
    readRuntimeSessionEventsByType: () => [],
    readDocument: (documentPath: string) =>
      options.archive && documentPath === dispatchDocumentPath
        ? { document: { path: documentPath, body: JSON.stringify(options.archive) } }
        : { document: null },
    readTaskRelationsBySources: () => ({ rows: [] }),
    readLeaseIntervals: () => [],
    readCanonicalEvents: () => ({ events: [] }),
    readEventWitness: () => null,
  } as unknown as TaskProjection;
}

/** The executing node's own stream: a live process plus one provider frame of the named kind. */
function writeEdgeStream(input: {
  readonly rootDir: string;
  readonly instance: (typeof edgeInstances)[number];
  readonly startedAt: string;
  readonly frameAt: string;
}): void {
  openDispatchStream(input.rootDir, {
    dispatchId,
    taskId,
    executionId,
    runtimeSessionId,
    instanceId: input.instance.instanceId,
    kindId: input.instance.kindId,
    startedAt: input.startedAt,
  });
  appendRuntimeWorkerRecord(input.rootDir, dispatchId, {
    kind: "process_started",
    occurredAt: input.startedAt,
    pid: process.pid,
  });
  appendRuntimeWorkerRecord(input.rootDir, dispatchId, {
    kind: "provider_event",
    occurredAt: input.frameAt,
    event: input.instance.toolFrame,
  });
}

test("an edge dispatch row carries the transcript ref the executing node published", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-transcript-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const startedAt = "2026-11-07T03:40:00.000Z",
    transcriptRef = `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
    row = readTaskDispatches({
      projection: centerProjection(
        edgeSession({ kindId: "deepseek-harness", instanceId: "ds-bailian", transcriptRef, lastObservedAt: startedAt }),
      ),
      taskId,
      rootDir,
    }).dispatches[0]!;
  assert.equal(row.eventStreamRef, transcriptRef);
});

test("a settled edge dispatch keeps its transcript ref from the archived dispatch document", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-archive-transcript-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const startedAt = "2026-11-07T03:40:00.000Z",
    transcriptRef = `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
    row = readTaskDispatches({
      projection: centerProjection(
        edgeSession({ kindId: "codex", instanceId: "codex-api", transcriptRef: null, lastObservedAt: startedAt }),
        { archive: { schema: "runtime-dispatch/v1", eventStreamRef: transcriptRef } },
      ),
      taskId,
      rootDir,
    }).dispatches[0]!;
  assert.equal(row.eventStreamRef, transcriptRef);
});

test("an ended edge dispatch still gets its transcript ref from the local stream", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-ended-")),
    now = Date.now(),
    startedAt = new Date(now - 40 * 60_000).toISOString(),
    frameAt = new Date(now - 30 * 60_000).toISOString();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeEdgeStream({ rootDir, instance: edgeInstances[1], startedAt, frameAt });
  const ended: RuntimeSession = {
    ...edgeSession({
      kindId: "codex",
      instanceId: "codex-api",
      transcriptRef: null,
      lastObservedAt: frameAt,
    }),
    liveness: "exited",
    outcome: "succeeded",
    exitCode: 0,
  };
  const row = readTaskDispatches({ projection: centerProjection(ended), taskId }).dispatches[0]!;
  assert.equal(row.status, "succeeded");
  assert.equal(row.eventStreamRef, null);
  const [joined] = withLocalDispatchStreamEvidence([row], { rootDir, nowMs: now });
  assert.equal(joined?.activityStatus, "unknown");
  assert.equal(joined?.eventStreamRef, `file:.harness/runtime/dispatches/${dispatchId}.jsonl`);
});

for (const instance of edgeInstances) {
  test(`the executing node joins ${instance.instanceId} activity into the center's running row`, (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-activity-")),
      now = Date.now(),
      startedAt = new Date(now - 40 * 60_000).toISOString(),
      frameAt = new Date(now - 5_000).toISOString(),
      transcriptRef = `file:.harness/runtime/dispatches/${dispatchId}.jsonl`;
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    writeEdgeStream({ rootDir, instance, startedAt, frameAt });
    const row = readTaskDispatches({
      projection: centerProjection(
        edgeSession({
          kindId: instance.kindId,
          instanceId: instance.instanceId,
          transcriptRef,
          lastObservedAt: startedAt,
        }),
      ),
      taskId,
    }).dispatches[0]!;
    // Negative control: with no stream on this node the center can only see the session's
    // 40-minute-old start observation, so it must call the working dispatch silent.
    assert.equal(row.activityStatus, "silent");
    assert.equal(row.eventStreamRef, transcriptRef);
    const [joined] = withLocalDispatchStreamEvidence([row], { rootDir, nowMs: now });
    assert.equal(joined?.activityStatus, "tool");
    assert.equal(joined?.activityObservedAt, frameAt);
    assert.equal(joined?.activityIdleMinutes, 0);
    assert.equal(joined?.eventStreamRef, transcriptRef);
    assert.equal(joined?.providerUnreachable, undefined);
  });
}

test("a submitted implementation stays waiting even when local provider frames keep arriving", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-waiting-")),
    now = Date.now(),
    startedAt = new Date(now - 40 * 60_000).toISOString(),
    frameAt = new Date(now - 5_000).toISOString();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeEdgeStream({ rootDir, instance: edgeInstances[0], startedAt, frameAt });
  const row = readTaskDispatches({
    projection: centerProjection(
      edgeSession({
        kindId: edgeInstances[0].kindId,
        instanceId: edgeInstances[0].instanceId,
        transcriptRef: null,
        lastObservedAt: startedAt,
      }),
      { taskStatus: "submitted" },
    ),
    taskId,
  }).dispatches[0]!;
  assert.equal(row.activityStatus, "waiting");
  const [joined] = withLocalDispatchStreamEvidence([row], { rootDir, nowMs: now });
  assert.equal(joined?.activityStatus, "waiting");
});
