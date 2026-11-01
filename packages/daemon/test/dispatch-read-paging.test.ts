// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjectionQueries } from "@harness-anything/kernel";
import { readAllTaskDispatchPages, readTaskDispatches } from "../src/dispatch-read.ts";
import { FLEET_FRAME_BYTES } from "../src/fleet/command-protocol.ts";
import { encodeFleetFrames } from "../src/fleet/command-transfer.ts";

function largeDispatchProjection(count = 500, reason = "派工原因 / long/path/".repeat(60)) {
  const events = Array.from({ length: count }, (_, index) => ({
    schema: "agent-runtime-event/v1",
    type: "runtime_dispatch_requested",
    occurredAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
    payload: {
      dispatchId: `dispatch_${String(index).padStart(24, "0")}`,
      runtimeSessionId: `runtime-${index}`,
      taskId: "task-one",
      executionId: "execution-one",
      instanceId: "instance-one",
    },
  })) as Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>[];
  const projection = {
    read: () => ({ packagePath: "tasks/task-one", snapshot: { task: { taskId: "task-one", title: "Task one" } } }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: ["task-one"],
      rows: [{ taskId: "task-one", packagePath: "tasks/task-one", sessions: [], title: "Task one" }],
      page: { limit: 500, cursor: null, nextCursor: null },
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeDispatches: () => events,
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => [],
    readRuntimeSessionEvents: () => [],
    readDocument: (path: string) => ({
      document: path.endsWith(".json") ? { body: JSON.stringify({ schema: "runtime-dispatch/v1", reason }) } : null,
    }),
    readLeaseIntervals: () => [],
    readTaskRelationsBySources: () => ({ rows: [] }),
  } as unknown as TaskProjectionQueries;
  return { projection, events };
}

test("large dispatch results use the generic Fleet transfer instead of a byte-fit page", async () => {
  const { projection, events } = largeDispatchProjection();
  const full = readTaskDispatches({ projection, taskId: "task-one" });
  const bytes = Buffer.byteLength(JSON.stringify(full));
  console.log(`unpaged dispatches: ${full.dispatches.length} rows, ${bytes} bytes; Fleet limit ${FLEET_FRAME_BYTES}`);
  assert.ok(bytes > FLEET_FRAME_BYTES);
  assert.equal(full.dispatches.length, events.length);
  const frame = {
    schema: "fleet.operational.read.result/v1" as const,
    messageId: "paging-result",
    inReplyTo: "paging",
    result: full,
  };
  let envelopes = 0;
  for await (const encoded of encodeFleetFrames(frame, "response", "repo")) {
    envelopes += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) <= FLEET_FRAME_BYTES);
  }
  assert.ok(envelopes > 1);
});

test("business task pages retain full rows and complete verdicts", async () => {
  const { projection: original } = largeDispatchProjection(2, "r".repeat(50_000));
  const projection = {
    ...original,
    readDocument: (path: string) => ({
      document: path.endsWith(".json")
        ? {
            body: JSON.stringify({
              schema: "runtime-dispatch/v1",
              reason: "r".repeat(50_000),
              outcome: path.endsWith("1.json") ? "failed" : "succeeded",
            }),
          }
        : null,
    }),
  } as TaskProjectionQueries;
  const first = readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500 });
  assert.ok("page" in first);
  assert.equal(first.dispatches.length, 2);
  assert.equal(first.outcome, "failed");
  let calls = 0;
  const all = await readAllTaskDispatchPages(async (facets) => {
    calls += 1;
    return readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500, ...facets });
  });
  assert.equal(calls, 1, "the complete result no longer requires a byte-fit page");
  assert.equal(all.dispatches.length, 2);
  assert.equal(all.outcome, "failed");
  assert.equal(all.page.nextCursor, null);
});

test("a single oversized row is carried by the generic Fleet transfer", async () => {
  const { projection } = largeDispatchProjection(1, "超大单行".repeat(FLEET_FRAME_BYTES));
  const result = readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500 });
  const frame = {
    schema: "fleet.operational.read.result/v1" as const,
    messageId: "oversized-row",
    inReplyTo: "paging",
    result,
  };
  let envelopes = 0;
  for await (const encoded of encodeFleetFrames(frame, "response", "repo")) {
    envelopes += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) <= FLEET_FRAME_BYTES);
  }
  assert.ok(envelopes > 1);
  assert.equal(result.dispatches.length, 1);
});

test("unpaged internal reads retain canonical order for dispatches with equal start times", () => {
  const { projection: original, events } = largeDispatchProjection(2);
  const tied = events.map((event, index) => ({
    ...event,
    occurredAt: "2026-11-01T00:00:00.000Z",
    payload: { ...event.payload, dispatchId: `dispatch_${(index === 0 ? "b" : "a").repeat(24)}` },
  }));
  const projection = { ...original, readRuntimeDispatches: () => tied } as TaskProjectionQueries;
  const unpaged = readTaskDispatches({ projection, taskId: "task-one" });
  assert.deepEqual(
    unpaged.dispatches.map((row) => row.dispatchId),
    tied.map((event) => event.payload.dispatchId),
  );
  const page = readTaskDispatches({ projection, taskIds: ["task-one"], limit: 16 });
  assert.deepEqual(
    page.dispatches.map((row) => row.dispatchId),
    tied.map((event) => event.payload.dispatchId).sort(),
  );
});

test("member windows retain business limits while large results use the generic Fleet transfer", async () => {
  const { projection: original, events: source } = largeDispatchProjection(500);
  const events = source.map((event) => ({ ...event, payload: { ...event.payload, agentId: "member-one" } })).reverse();
  const sessions = new Map(
    events.map((event) => [
      event.payload.runtimeSessionId,
      {
        runtimeSessionId: event.payload.runtimeSessionId,
        instanceId: "instance-one",
        installationId: "installation-one",
        kindId: "codex",
        definitionSnapshotRef: "artifact:definition",
        providerSessionId: null,
        transcriptRef: null,
        launchGeneration: 1,
        liveness: "exited",
        attachable: false,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: null,
        lastObservedAt: event.occurredAt,
        taskBindings: [{ taskId: "task-one", executionId: "execution-one", boundAt: event.occurredAt }],
      } as RuntimeSession,
    ]),
  );
  const projection = {
    ...original,
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    listEntities: () => [],
    readRuntimeSession: (id: string) => sessions.get(id) ?? null,
    readRuntimeDispatchesByMember: ({ limit }: { limit: number }) => ({
      rows: events.slice(0, limit),
      truncated: limit < events.length,
      sessions: events.map((event) => ({
        runtimeSessionId: event.payload.runtimeSessionId,
        taskIds: ["task-one"],
        latestDecisionId: null,
      })),
    }),
  } as unknown as TaskProjectionQueries;
  const result = readTaskDispatches({ projection, agentId: "member-one", limit: 500 });
  assert.ok("truncated" in result);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.totals, { groups: 1, sessions: 500 });
  assert.equal(result.dispatches.length, 500);
  assert.equal(result.dispatches[0]!.dispatchId, events[0]!.payload.dispatchId);
  assert.equal(
    result.groups.reduce((count, group) => count + group.sessionCount, 0),
    result.dispatches.length,
  );
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(bytes > FLEET_FRAME_BYTES);
  const frame = {
    schema: "fleet.operational.read.result/v1" as const,
    messageId: "member-result",
    inReplyTo: "member-read",
    result,
  };
  let envelopes = 0;
  for await (const encoded of encodeFleetFrames(frame, "response", "repo")) {
    envelopes += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) <= FLEET_FRAME_BYTES);
  }
  assert.ok(envelopes > 1);
  console.log(`member result: ${result.dispatches.length}/500 rows, ${bytes} bytes, truncated=${result.truncated}`);
});
