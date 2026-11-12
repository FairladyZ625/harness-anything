// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionReadQuery, TaskProjection } from "@harness-anything/kernel";
import { admitHandoffDispatch } from "../src/runtime-handoff-store.ts";
import { assertNativeResumeNotExported } from "../src/runtime-resume-admission.ts";
import { resolveRuntimeDispatchResources } from "../src/runtime-spawn-allowlist.ts";
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

test("dispatch reads active lifecycle pages, not the 12,995-session history", async () => {
  const history = sessionHistory();
  const [local, , allowed, , capacity] = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history));
  assert.deepEqual(allowed, ["instance-a", "instance-b"]);
  assert.deepEqual(
    capacity.map(({ attempt }) => attempt.runtimeSessionId),
    ["runtime-open-a", "runtime-open-b", "runtime-open-c"],
  );
  assert.equal(capacity.length, 3);
  assert.deepEqual(local, [], "ordinary dispatch never needs session rows for its capacity ranking");
  assert.deepEqual(history.reads, []);
  assert.deepEqual(history.lifecycleQueries, [{ by: "active", limit: 100 }]);
});

test("a resume additionally point-reads its native session, settled or not, in id order", async () => {
  const history = sessionHistory();
  const [local, , , , capacity] = await resolveRuntimeDispatchResources(
    {},
    undefined,
    projectionOf(history),
    "native-resumed",
  );
  // The named session query retains the same resume choice; capacity travels in its own receipt.
  assert.deepEqual(
    local.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-c", "runtime-settled-00007"],
  );
  assert.equal(local.find((row) => row.providerSessionId === "native-resumed")?.runtimeSessionId, "runtime-open-c");
  assert.equal(capacity.length, 3);
  // The session point read contributes resume metadata; active load comes from the lifecycle view.
  assert.deepEqual(
    local.map(({ liveness }) => liveness),
    ["live", "exited"],
  );
  assert.deepEqual(history.reads, [{ query: { providerSessionId: "native-resumed" }, returned: 2 }]);
  assert.deepEqual(history.lifecycleQueries, [{ by: "active", limit: 100 }]);
});

test("remote dispatch sends the same bounded queries to its canonical read port", async () => {
  const history = sessionHistory();
  const [local, , , , capacity] = await resolveRuntimeDispatchResources(
    {},
    {
      readRuntimeSessions: async (query) => history.readRuntimeSessions(query),
      readDispatchLifecycle: history.readDispatchLifecycle,
    } as NonNullable<RuntimeSpawnerInput["remote"]>,
    null,
    "native-resumed",
  );
  assert.equal(local.length, 2);
  assert.equal(capacity.length, 3);
  assert.deepEqual(
    history.reads.map(({ query }) => query),
    [{ providerSessionId: "native-resumed" }],
  );
  assert.deepEqual(history.lifecycleQueries, [{ by: "active", limit: 100 }]);
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
