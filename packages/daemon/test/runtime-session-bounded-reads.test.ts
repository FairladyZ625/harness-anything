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
  const [local, , allowed] = await resolveRuntimeDispatchResources({}, undefined, projectionOf(history), new Map());
  assert.deepEqual(allowed, ["instance-a", "instance-b"]);
  assert.deepEqual(
    local.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-a", "runtime-open-b", "runtime-open-c"],
  );
  assert.equal(local.length, 3);
  assert.equal(
    history.reads.reduce((sum, read) => sum + read.returned, 0),
    3,
    `rows read: ${JSON.stringify(history.reads)}`,
  );
});

test("a resume additionally point-reads its native session, settled or not, in id order", async () => {
  const history = sessionHistory();
  const [local] = await resolveRuntimeDispatchResources(
    {},
    undefined,
    projectionOf(history),
    new Map(),
    "native-resumed",
  );
  // Same order the full history read produced, so `find(providerSessionId)` picks the same row.
  assert.deepEqual(
    local.map(({ runtimeSessionId }) => runtimeSessionId),
    ["runtime-open-a", "runtime-open-b", "runtime-open-c", "runtime-settled-00007"],
  );
  assert.equal(local.find((row) => row.providerSessionId === "native-resumed")?.runtimeSessionId, "runtime-open-c");
  // The settled row keeps its canonical liveness; unsettled rows follow the local process map.
  assert.deepEqual(
    local.map(({ liveness }) => liveness),
    ["unknown", "unknown", "unknown", "exited"],
  );
  assert.ok(
    history.reads.every((read) => read.query !== undefined) &&
      history.reads.reduce((sum, read) => sum + read.returned, 0) === 3 + 2,
    `rows read: ${JSON.stringify(history.reads)}`,
  );
});

test("remote dispatch sends the same bounded queries to its replica", async () => {
  const history = sessionHistory();
  const [local] = await resolveRuntimeDispatchResources(
    {},
    { readRuntimeSessions: async (query) => history.readRuntimeSessions(query) } as NonNullable<
      RuntimeSpawnerInput["remote"]
    >,
    null,
    new Map(),
    "native-resumed",
  );
  assert.equal(local.length, 4);
  assert.deepEqual(
    history.reads.map(({ query }) => query),
    [{ unsettledOnly: true }, { providerSessionId: "native-resumed" }],
  );
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
