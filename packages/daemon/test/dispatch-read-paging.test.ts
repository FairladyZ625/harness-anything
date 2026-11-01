// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { readTaskDispatches } from "../src/dispatch-read.ts";
import { FLEET_FRAME_BYTES, serializeFleetFrame } from "../src/fleet/command-protocol.ts";

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

test("dispatch cursor pages fit Fleet even when all 500 long rows belong to one task", () => {
  const { projection, events } = largeDispatchProjection();
  const full = readTaskDispatches({ projection, taskId: "task-one" });
  const bytes = Buffer.byteLength(JSON.stringify(full));
  console.log(`unpaged dispatches: ${full.dispatches.length} rows, ${bytes} bytes; Fleet limit ${FLEET_FRAME_BYTES}`);
  assert.ok(bytes > FLEET_FRAME_BYTES);
  const ids: string[] = [],
    cursors = new Set<string>();
  let maxBytes = 0;
  let cursor: string | undefined;
  do {
    const page = readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500, ...(cursor ? { cursor } : {}) });
    assert.ok("page" in page);
    const frame = {
      schema: "fleet.operational.read.result/v1" as const,
      messageId: "paging-result",
      inReplyTo: "paging",
      result: page,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= FLEET_FRAME_BYTES, "dispatch page exceeds Fleet frame");
    maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(frame)));
    serializeFleetFrame(frame);
    ids.push(...page.dispatches.map((row) => row.dispatchId));
    cursor = page.page.nextCursor ?? undefined;
    if (cursor) {
      assert.ok(!cursors.has(cursor));
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  assert.deepEqual(
    ids,
    events.map((event) => event.payload.dispatchId),
  );
  assert.ok(cursors.size > 1, "the fixture must cross more than one page boundary");
  console.log(`dispatch pages: ${cursors.size + 1}; max frame ${maxBytes} bytes; all ${ids.length} rows retained`);
});

test("each byte page's aggregate verdict describes its returned rows", () => {
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
  assert.ok("page" in first && first.page.nextCursor);
  assert.equal(first.dispatches.length, 1);
  assert.equal(first.outcome, "succeeded");
  const last = readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500, cursor: first.page.nextCursor });
  assert.ok("page" in last);
  assert.equal(last.page.nextCursor, null);
  assert.equal(last.outcome, "failed");
});
