// harness-test-tier: fast
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
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
    readDispatchLifecycle: lifecycleReadForSync(
      events.map(({ payload }, index) => ({
        runtimeSessionId: payload.runtimeSessionId,
        dispatchId: payload.dispatchId,
        attemptSettled: true,
        outcome: index % 2 ? "failed" : "succeeded",
      })),
    ),
    readTaskIndex(query: { readonly taskIds?: readonly string[] } = {}) {
      return {
        rows: (query.taskIds ?? []).map((taskId) => ({ taskId, title: "Task one", packagePath: "tasks/task-one" })),
      };
    },
    read: () => ({ packagePath: "tasks/task-one", snapshot: { task: { taskId: "task-one", title: "Task one" } } }),
    readTaskRuntimeBatch: () => ({
      status: "ready",
      taskIds: ["task-one"],
      rows: [{ taskId: "task-one", packagePath: "tasks/task-one", sessions: [], title: "Task one" }],
      page: { limit: 500, cursor: null, nextCursor: null },
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeDispatchesByTaskIds: (taskIds: readonly string[]) =>
      events.filter(
        (candidate) => candidate.payload.taskId !== undefined && taskIds.includes(candidate.payload.taskId),
      ),
    readCut: () => ({ status: "ready", watermark: 1, sourceRevision: 1 }),
    readRuntimeSession: () => null,
    readRuntimeDispatchPage: ({
      taskIds,
      cursor,
      limit,
    }: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]) => {
      const selected = events
        .filter(
          (event) =>
            (!taskIds || taskIds.includes(event.payload.taskId!)) &&
            (!cursor ||
              event.occurredAt > cursor.startedAt ||
              (event.occurredAt === cursor.startedAt && event.payload.dispatchId > cursor.dispatchId)),
        )
        .sort(
          (a, b) =>
            a.occurredAt.localeCompare(b.occurredAt) || a.payload.dispatchId.localeCompare(b.payload.dispatchId),
        );
      const rows = selected.slice(0, limit).map((event) => ({ event, outcome: null })),
        last = rows.at(-1)?.event;
      return {
        rows,
        done: selected.length <= limit,
        nextCursor:
          selected.length > limit && last ? { startedAt: last.occurredAt, dispatchId: last.payload.dispatchId } : null,
      };
    },
    readRuntimeDispatchByResumeSource: () => null,
    readRuntimeDispatchesByAttemptGroup: () => [],
    readRuntimeSessionEvents: () => [],
    readRuntimeSessionEventsByType: () => [],
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
  const projection = {
    ...original,
    readRuntimeDispatchesByTaskIds: () => tied,
    readRuntimeDispatchPage: () => ({
      rows: [...tied]
        .sort((a, b) => a.payload.dispatchId.localeCompare(b.payload.dispatchId))
        .map((event) => ({ event, outcome: null })),
      done: true,
      nextCursor: null,
    }),
  } as TaskProjectionQueries;
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

for (const history of [2, 2000])
  test(`task dispatch page bounds selected task history ${history}`, async () => {
    const { projection } = largeDispatchProjection(history, "reason");
    let reads = 0;
    const bounded = {
      ...projection,
      read: () => {
        throw new Error("a dispatch page must not load the complete task aggregate");
      },
      readTaskRuntimeBatch: () => {
        throw new Error("a dispatch page must not expand task session history");
      },
      readRuntimeDispatchesByTaskIds: () => {
        throw new Error("a dispatch page must not expand task dispatch history");
      },
      readDispatchLifecycle: (...args: Parameters<TaskProjectionQueries["readDispatchLifecycle"]>) => {
        reads++;
        return projection.readDispatchLifecycle(...args);
      },
    } as TaskProjectionQueries;
    const first = readTaskDispatches({ projection: bounded, taskIds: ["task-one"], limit: 1 });
    assert.ok("page" in first);
    assert.equal(first.dispatches.length, 1);
    assert.equal(reads, 1);
    assert.ok(first.page.nextCursor);
    const next = readTaskDispatches({
      projection: bounded,
      taskIds: ["task-one"],
      limit: 1,
      cursor: first.page.nextCursor,
    });
    assert.equal(next.dispatches.length, 1);
    assert.notEqual(first.dispatches[0]!.dispatchId, next.dispatches[0]!.dispatchId);
  });

test("task dispatch history drains past a page boundary and stops at the reader done receipt", async () => {
  const { projection: original } = largeDispatchProjection(3, "reason");
  let reads = 0;
  const projection = {
    ...original,
    readRuntimeDispatchPage: (query: Parameters<TaskProjectionQueries["readRuntimeDispatchPage"]>[0]) => {
      reads++;
      const page = original.readRuntimeDispatchPage(query),
        last = page.rows.at(-1)?.event;
      return {
        ...page,
        nextCursor:
          page.nextCursor ?? (last ? { startedAt: last.occurredAt, dispatchId: last.payload.dispatchId } : null),
      };
    },
  } as TaskProjectionQueries;
  const all = await readAllTaskDispatchPages((facets) =>
    Promise.resolve(readTaskDispatches({ projection, taskIds: ["task-one"], limit: 1, ...facets })),
  );
  assert.equal(reads, 3, "done ends the drain even when storage retains its tail cursor");
  assert.equal(all.dispatches.length, 3);
  assert.equal(new Set(all.dispatches.map(({ dispatchId }) => dispatchId)).size, 3);
  assert.equal(all.page.nextCursor, null);
});
