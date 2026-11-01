// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession, TaskProjectionQueries } from "@harness-anything/kernel";
import { assertFleetReadFits, readAllTaskDispatchPages, readTaskDispatches } from "../src/dispatch-read.ts";
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

test("each byte page's aggregate verdict describes its returned rows, and complete consumers retain the full verdict", async () => {
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
  let calls = 0;
  const all = await readAllTaskDispatchPages(async (facets) => {
    calls += 1;
    return readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500, ...facets });
  });
  assert.equal(calls, 2, "the final receipt must stop the drain without a third read");
  assert.equal(all.dispatches.length, 2);
  assert.equal(all.outcome, "failed");
  assert.equal(all.page.nextCursor, null);
});

test("a single oversized row reports its actual bytes, frame cap and actionable pagination hint", () => {
  const { projection } = largeDispatchProjection(1, "超大单行".repeat(FLEET_FRAME_BYTES));
  assert.throws(
    () => readTaskDispatches({ projection, taskIds: ["task-one"], limit: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "fleet_read_too_large");
      assert.match(error.message, /reply is \d+ bytes/u);
      assert.match(error.message, /98304 bytes/u);
      assert.match(error.message, /limit:16.*cursor:page.nextCursor/u);
      console.log(`${error.code}: ${error.message}`);
      return true;
    },
  );
});

test("the shared Fleet read guard rejects other oversized read families before serialization", () => {
  assert.throws(() => assertFleetReadFits({ nodes: ["n".repeat(FLEET_FRAME_BYTES)] }, "repo.fleet.overview.read"), {
    code: "fleet_read_too_large",
    message: /98304 bytes.*pagination require sliced Fleet transport/u,
  });
});

test("member windows shrink by bytes while retaining newest rows, matching groups and full-history totals", () => {
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
  assert.equal(result.truncated, true);
  assert.deepEqual(result.totals, { groups: 1, sessions: 500 });
  assert.ok(result.dispatches.length > 0 && result.dispatches.length < 500);
  assert.equal(result.dispatches[0]!.dispatchId, events[0]!.payload.dispatchId);
  assert.equal(
    result.groups.reduce((count, group) => count + group.sessionCount, 0),
    result.dispatches.length,
  );
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(bytes < FLEET_FRAME_BYTES);
  console.log(`member window: ${result.dispatches.length}/500 rows, ${bytes} bytes, truncated=${result.truncated}`);
});
