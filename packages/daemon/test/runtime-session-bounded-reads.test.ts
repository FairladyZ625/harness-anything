// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionReadQuery, TaskProjection } from "@harness-anything/kernel";
import { admitHandoffDispatch } from "../src/runtime-handoff-store.ts";
import { assertNativeResumeNotExported } from "../src/runtime-resume-admission.ts";
import { resolveRuntimeDispatchResources } from "../src/runtime-spawn-allowlist.ts";
import { createRuntimeInstanceDispatchState } from "../src/runtime-instance-selection.ts";
import type { RuntimeSessionSelection, RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

const settledHistory = 12_995;

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
  const events = [
    lifecycleEvent("R", "runtime-open-a", {
      instanceId: "instance-a",
      source: "local",
    }),
    lifecycleEvent("S", "runtime-open-a", { instanceId: "instance-a", source: "local" }),
    lifecycleEvent("R", "runtime-open-b", { instanceId: "instance-b", source: "local" }),
    lifecycleEvent("R", "runtime-open-c", { instanceId: "instance-a", source: "local" }),
    lifecycleEvent("S", "runtime-open-c", { instanceId: "instance-a", source: "local" }),
  ];
  const lifecycleQueries: import("@harness-anything/kernel").DispatchLifecycleQuery[] = [],
    readDispatchLifecycle = dispatchLifecycleReadOf(() => events),
    trackedDispatchLifecycleRead = (query: import("@harness-anything/kernel").DispatchLifecycleQuery) => {
      lifecycleQueries.push(query);
      return readDispatchLifecycle(query);
    };
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
  return { reads, readRuntimeSessions, lifecycleQueries, readDispatchLifecycle: trackedDispatchLifecycleRead };
}

const projectionOf = (history: ReturnType<typeof sessionHistory>) =>
  ({
    readRuntimeSessions: history.readRuntimeSessions,
    readDispatchLifecycle: history.readDispatchLifecycle,
    readRuntimeDispatch: () => null,
    getEntity: () => ({ value: { runtime: { allowedInstances: ["instance-a", "instance-b"] } } }),
  }) as unknown as TaskProjection;

// dec_DA1602487428A58E8B446ECE38/CH3: node-local load is not repository lifecycle/history.
test("dispatch reads node-local handles and no repository lifecycle or 12,995-session history", async () => {
  const history = sessionHistory();
  const active = new Map([
      ["runtime-open-a", { instanceId: "instance-a" }],
      ["runtime-open-b", { instanceId: "instance-b" }],
      ["runtime-open-c", { instanceId: "instance-a" }],
    ]),
    state = createRuntimeInstanceDispatchState();
  for (const [runtimeSessionId, { instanceId }] of active) state.activate(runtimeSessionId, instanceId);
  const [local, , allowed] = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history));
  assert.deepEqual(allowed, ["instance-a", "instance-b"]);
  assert.deepEqual([...active.keys()], ["runtime-open-a", "runtime-open-b", "runtime-open-c"]);
  assert.equal(
    [...state.readActiveLoads().values()].reduce((sum, load) => sum + load, 0),
    3,
  );
  assert.deepEqual(
    [...state.readActiveLoads()],
    [
      ["instance-a", 2],
      ["instance-b", 1],
    ],
  );
  assert.deepEqual(local, [], "ordinary dispatch never needs session rows for its capacity ranking");
  assert.deepEqual(history.reads, []);
  assert.deepEqual(history.lifecycleQueries, []);
});

test("a resume additionally point-reads its native session, settled or not, in id order", async () => {
  const history = sessionHistory();
  const resources = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history), "native-resumed");
  const [local] = resources;
  // The named query retains the same resume choice without importing repository-scoped load.
  assert.deepEqual(
    local.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-c", "runtime-settled-00007"],
  );
  assert.equal(local.find((row) => row.providerSessionId === "native-resumed")?.runtimeSessionId, "runtime-open-c");
  assert.equal(resources.length, 4);
  // The point read contributes resume metadata; load comes from local runtime owners.
  assert.deepEqual(
    local.map(({ liveness }) => liveness),
    ["live", "exited"],
  );
  assert.deepEqual(history.reads, [{ query: { providerSessionId: "native-resumed" }, returned: 2 }]);
  assert.deepEqual(history.lifecycleQueries, []);
});

test("remote dispatch sends the same bounded queries to its canonical read port", async () => {
  const history = sessionHistory();
  const resources = await resolveRuntimeDispatchResources(
    {},
    {
      readRuntimeSessions: async (query) => history.readRuntimeSessions(query),
      readDispatchLifecycle: history.readDispatchLifecycle,
    } as NonNullable<RuntimeSpawnerInput["remote"]>,
    null,
    "native-resumed",
  );
  const [local] = resources;
  assert.equal(local.length, 2);
  assert.equal(resources.length, 4);
  assert.deepEqual(
    history.reads.map(({ query }) => query),
    [{ providerSessionId: "native-resumed" }],
  );
  assert.deepEqual(history.lifecycleQueries, []);
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
