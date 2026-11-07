// harness-test-tier: fast
// Edge dispatches execute their provider stream on the edge node, but `repo.task.dispatches`
// behind `ha task dispatches` is served by the center. These cases pin the two fields that were
// lost at that boundary: the transcript ref the executing node already published, and the live
// provider activity that never reached the center's projection. The center-shaped projection
// below deliberately has no local dispatch stream, exactly like the center daemon.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjection } from "@harness-anything/kernel";
import { dispatchProviderActivity } from "../src/dispatch-activity.ts";
import { readTaskDispatches } from "../src/dispatch-read.ts";
import { noteProviderProgress } from "../src/runtime-provider-connectivity.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

const dispatchId = "dispatch_5beaecffdf966066d2816b0d",
  runtimeSessionId = "runtime_c55acf69e24aca9e79143d30",
  taskId = "task_edge_activity",
  taskPackagePath = "tasks/task_edge_activity";
type Dispatch = Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;

/** The instances named by the incident: the DeepSeek Harness worker on ds-bailian and the Codex
 *  worker on codex-api. `dispatchProviderActivity` falls through to the shared ACP vocabulary for
 *  the deepseek-harness kind, so both kinds must reduce the same tool frame to `tool`. */
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
  readonly activity?: RuntimeSession["activity"];
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
    ...(input.activity === undefined ? {} : { activity: input.activity }),
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
      executionId: "execution-edge",
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
function centerProjection(session: RuntimeSession): TaskProjection {
  const event = dispatchEvent(session, session.lastObservedAt);
  return {
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    read: () => ({
      watermark: 1,
      sourceRevision: 1,
      packagePath: taskPackagePath,
      snapshot: { task: { taskId, title: "edge dispatch" } },
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
    readDocument: () => ({ document: null }),
    readTaskRelationsBySources: () => ({ rows: [] }),
    readLeaseIntervals: () => [],
    readCanonicalEvents: () => ({ events: [] }),
    readEventWitness: () => null,
  } as unknown as TaskProjection;
}

function activeEdgeRuntime(input: {
  readonly kindId: string;
  readonly instanceId: string;
  readonly frame: Record<string, unknown>;
  readonly now: number;
  readonly startedAt: string;
}): ActiveRuntime {
  return {
    runtimeSessionId,
    dispatchId,
    kindId: input.kindId,
    instanceId: input.instanceId,
    binding: {},
    stalledAt: null,
    providerUnreachable: null,
    lastRealProgressAtMs: input.now,
    lastProgressAtMs: input.now,
    lastProviderActivity: dispatchProviderActivity(input.kindId, input.frame),
    lastActivityReportedAtMs: Date.parse(input.startedAt),
  } as unknown as ActiveRuntime;
}

test("an edge dispatch row carries the transcript ref the executing node published", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-edge-transcript-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const startedAt = "2026-11-07T11:40:00.000Z",
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

for (const instance of edgeInstances) {
  test(`the executing node reports ${instance.instanceId} provider activity to the center`, async () => {
    const now = Date.parse("2026-11-07T12:20:00.000Z"),
      startedAt = new Date(now - 40 * 60_000).toISOString(),
      published: { readonly type: string; readonly payload: Record<string, unknown> }[] = [],
      context = {
        input: { now: () => new Date(now).toISOString() },
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
          published.push({ type, payload });
          return {};
        },
      } as unknown as RuntimeSpawnerContext,
      active = activeEdgeRuntime({
        kindId: instance.kindId,
        instanceId: instance.instanceId,
        frame: instance.toolFrame,
        now,
        startedAt,
      });
    await noteProviderProgress(context, active, now);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.type, "runtime_session_liveness_changed");
    assert.deepEqual(published[0]?.payload.activity, {
      providerActivity: "tool",
      lastProgressAt: new Date(now).toISOString(),
    });
  });
}
