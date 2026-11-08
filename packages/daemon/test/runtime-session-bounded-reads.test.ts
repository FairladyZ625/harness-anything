// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionReadQuery, TaskProjection } from "@harness-anything/kernel";
import { admitHandoffDispatch } from "../src/runtime-handoff-store.ts";
import { assertNativeResumeNotExported } from "../src/runtime-resume-admission.ts";
import { resolveRuntimeDispatchResources } from "../src/runtime-spawn-allowlist.ts";
import type { RuntimeSessionSelection, RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";

const settledHistory = 2000;

/** A long settled history with three unsettled sessions; every read reports the rows it returned. */
function sessionHistory() {
  const rows: RuntimeSessionSelection[] = [];
  for (let index = 0; index < settledHistory; index += 1)
    rows.push({
      runtimeSessionId: `runtime-settled-${String(index).padStart(5, "0")}`,
      providerSessionId: index === 7 ? "native-resumed" : `native-${index}`,
      instanceId: index % 2 ? "instance-a" : "instance-b",
      liveness: "exited",
      outcome: "succeeded",
      providerUnreachable: null,
    });
  rows.push(
    {
      runtimeSessionId: "runtime-open-a",
      providerSessionId: "native-open-a",
      instanceId: "instance-a",
      liveness: "live",
      outcome: null,
      providerUnreachable: null,
    },
    {
      runtimeSessionId: "runtime-open-b",
      providerSessionId: null,
      instanceId: "instance-b",
      liveness: "unknown",
      outcome: null,
      providerUnreachable: null,
    },
    {
      runtimeSessionId: "runtime-open-c",
      providerSessionId: "native-resumed",
      instanceId: "instance-a",
      liveness: "live",
      outcome: null,
      providerUnreachable: null,
    },
  );
  const reads: { readonly query: RuntimeSessionReadQuery | undefined; readonly returned: number }[] = [];
  const readRuntimeSessions = (query?: RuntimeSessionReadQuery) => {
    const result = rows
      .filter(
        (row) =>
          (!query?.unsettledOnly || row.outcome === null) &&
          (query?.providerSessionId === undefined || row.providerSessionId === query.providerSessionId),
      )
      .sort((a, b) => (a.runtimeSessionId < b.runtimeSessionId ? -1 : 1));
    reads.push({ query, returned: result.length });
    return result;
  };
  return { reads, readRuntimeSessions };
}

const projectionOf = (history: ReturnType<typeof sessionHistory>) =>
  ({
    readRuntimeSessions: history.readRuntimeSessions,
    readRuntimeDispatch: () => null,
    getEntity: () => ({ value: { runtime: { allowedInstances: ["instance-a", "instance-b"] } } }),
  }) as unknown as TaskProjection;

test("dispatch reads the unsettled set, not the settled history", async () => {
  const history = sessionHistory();
  const [canonical, , allowed] = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history));
  assert.deepEqual(allowed, ["instance-a", "instance-b"]);
  assert.deepEqual(
    canonical.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-a", "runtime-open-b", "runtime-open-c"],
  );
  assert.equal(
    history.reads.reduce((sum, read) => sum + read.returned, 0),
    3,
    `rows read: ${JSON.stringify(history.reads)}`,
  );
});

test("a resume additionally point-reads its native session, settled or not, in id order", async () => {
  const history = sessionHistory();
  const [canonical] = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history), "native-resumed");
  // Same order the full history read produced, so `find(providerSessionId)` picks the same row.
  assert.deepEqual(
    canonical.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-a", "runtime-open-b", "runtime-open-c", "runtime-settled-00007"],
  );
  assert.equal(canonical.find((row) => row.providerSessionId === "native-resumed")?.runtimeSessionId, "runtime-open-c");
  assert.ok(
    history.reads.every((read) => read.query !== undefined) &&
      history.reads.reduce((sum, read) => sum + read.returned, 0) === 3 + 2,
    `rows read: ${JSON.stringify(history.reads)}`,
  );
});

test("remote dispatch sends the same bounded queries to its replica", async () => {
  const history = sessionHistory();
  const [canonical] = await resolveRuntimeDispatchResources(
    {},
    { readRuntimeSessions: async (query) => history.readRuntimeSessions(query) } as NonNullable<
      RuntimeSpawnerInput["remote"]
    >,
    null,
    "native-resumed",
  );
  assert.equal(canonical.length, 4);
  assert.deepEqual(
    history.reads.map(({ query }) => query),
    [{ unsettledOnly: true }, { providerSessionId: "native-resumed" }],
  );
});

test("instance load is the lifecycle reservation count, paged per instance and blind to process maps", async () => {
  const history = sessionHistory(),
    queries: unknown[] = [],
    row = (attemptGroupId: string, capacity: "reserved" | "held" | "released") => ({
      dispatchId: `dispatch-${attemptGroupId}`,
      runtimeSessionId: `runtime-${attemptGroupId}`,
      attemptGroupId,
      groupVersion: 1,
      attempt: { phase: "running", process: "alive", stopProof: "unproven", capacity, outcome: null },
    }),
    pages: Record<string, { rows: unknown[]; nextCursor: string | null }> = {
      "instance-a:": { rows: [row("g1", "held"), row("g2", "released")], nextCursor: "g2" },
      "instance-a:g2": { rows: [row("g3", "reserved")], nextCursor: null },
    },
    projection = {
      ...projectionOf(history),
      readDispatchLifecycle: (query: { instanceId?: string; afterGroupId?: string }) => {
        queries.push(query);
        return {
          status: "ready",
          watermark: 1,
          sourceRevision: 1,
          ...(pages[`${String(query.instanceId)}:${query.afterGroupId ?? ""}`] ?? { rows: [], nextCursor: null }),
        };
      },
    } as unknown as TaskProjection;
  const [, , , , instanceLoad] = await resolveRuntimeDispatchResources({}, undefined, projection);
  assert.equal(instanceLoad("instance-a"), 2, "released capacity is free; reserved and held both occupy");
  assert.equal(instanceLoad("instance-b"), 0);
  assert.deepEqual(queries, [
    { by: "active", instanceId: "instance-a", limit: 100 },
    { by: "active", instanceId: "instance-a", limit: 100, afterGroupId: "g2" },
    { by: "active", instanceId: "instance-b", limit: 100 },
  ]);
});

test("native resume export checks read only the named provider session", () => {
  const history = sessionHistory();
  assertNativeResumeNotExported("/nonexistent-root", "native-resumed", projectionOf(history));
  admitHandoffDispatch(
    { rootDir: "/nonexistent-root", projection: projectionOf(history) } as never,
    { resumeProviderSessionId: "native-resumed" },
    {} as never,
  );
  assert.deepEqual(history.reads, [
    { query: { providerSessionId: "native-resumed" }, returned: 2 },
    { query: { providerSessionId: "native-resumed" }, returned: 2 },
  ]);
});
