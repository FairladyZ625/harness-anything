// harness-test-tier: fast
import assert from "node:assert/strict";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import test from "node:test";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { prepareRuntimeInstance, resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
import { agentRuntimeAmbiguityWarning, selectedRuntimeInstance } from "../src/runtime-instance-selection.ts";

const instance = (instanceId: string, tier: number, models = ["Hydrogen"]): RuntimeInstanceSummary =>
  ({
    instanceId,
    tier,
    models,
    enabled: true,
    kindId: "agy",
    authReadiness: { status: "ready", code: null, hint: null },
  }) as RuntimeInstanceSummary;
const agent = { id: "worker", name: "Worker", instructions: "Run", runtimes: [{ type: "agy", model: "Hydrogen" }] };
const now = "2026-11-14T00:00:00.000Z";
const cooling = (instanceId: string) => ({
  instanceId,
  cooldownUntil: "2026-11-15T00:00:00.000Z",
  frozen: false,
  frozenUntil: null,
  failureStreak: 1,
  reason: "quota",
  lastFailureAt: now,
  lastResetAt: null,
});
const input = (instances: readonly RuntimeInstanceSummary[]) => ({
  agent,
  instances,
  sessions: [],
  capacity: [],
  allowedInstanceIds: instances.map((row) => row.instanceId),
  now,
});

test("CH3: tier precedes static preference; cooling the Pro pool spills into compatible Ultra", () => {
  const instances = [instance("ultra", 2), instance("pro", 1)];
  const request = { ...input(instances), agent: { ...agent, preferredInstances: ["ultra"] } };
  assert.deepEqual(resolveRuntimeInstanceCandidates(request), ["pro", "ultra"]);
  assert.deepEqual(resolveRuntimeInstanceCandidates({ ...request, health: [cooling("pro")] }), ["ultra"]);
});

test("CH3: model switches isolate Carbon Ultra even when every Hydrogen Pro is cooling", () => {
  const request = input([instance("ultra", 2, ["Carbon"]), instance("pro", 1)]);
  assert.deepEqual(resolveRuntimeInstanceCandidates(request), ["pro"]);
  assert.throws(() => resolveRuntimeInstanceCandidates({ ...request, health: [cooling("pro")] }), {
    code: "runtime_model_not_ready",
  });
});

test("CH3: only local enabled allowed ready instances participate; exhausted tier spills at prepare", async () => {
  const instances = [
    instance("ultra", 2),
    instance("pro", 1),
    { ...instance("disabled", 1), enabled: false },
    instance("not-allowed", 1),
  ];
  const request = { ...input(instances), allowedInstanceIds: ["ultra", "pro", "disabled", "remote-only"] };
  assert.deepEqual(resolveRuntimeInstanceCandidates(request), ["pro", "ultra"]);
  const attempted: string[] = [];
  const selected = await prepareRuntimeInstance(request, async (id) => {
    attempted.push(id);
    if (id === "pro") throw Object.assign(new Error("full"), { code: "runtime_capacity_exhausted" });
    return id;
  });
  assert.deepEqual(attempted, ["pro", "ultra"]);
  assert.equal(selected.instanceId, "ultra");
});

for (const strategy of ["sticky", "lru"] as const) {
  test(`CH3: ${strategy} uses O(1) selected-instance state across idle dispatches`, async () => {
    const lastDispatchedAt = new Map<string, number>();
    let sequence = 0;
    const dispatchState = {
      lastDispatchedAt,
      recordDispatch: (id: string) => {
        lastDispatchedAt.set(id, ++sequence);
      },
    };
    const request = {
      ...input([instance("pro-a", 1), instance("pro-b", 1)]),
      selectionStrategy: strategy,
      dispatchState,
    };
    const selected: string[] = [];
    for (let run = 0; run < 4; run++)
      selected.push((await prepareRuntimeInstance(request, async (id) => id)).instanceId);
    assert.deepEqual(
      selected,
      strategy === "sticky" ? ["pro-a", "pro-a", "pro-a", "pro-a"] : ["pro-a", "pro-b", "pro-a", "pro-b"],
    );
    assert.equal(sequence, 4);
  });
}

test("CH3: explicit same-kind pool and selected strategy silence ambiguity; cross-kind intent still warns", () => {
  const runtimeInstances = [instance("pro-a", 1), instance("pro-b", 1)];
  assert.equal(agentRuntimeAmbiguityWarning({ agent, runtimeInstances }), null);
  const mixed = [...runtimeInstances, { ...instance("codex", 1), kindId: "codex" }];
  const unbound = { ...agent, runtimes: [] };
  assert.equal(
    agentRuntimeAmbiguityWarning({ agent: unbound, runtimeInstances: mixed })?.code,
    "agent_runtime_instance_ambiguous",
  );
  assert.equal(
    agentRuntimeAmbiguityWarning({ agent: { ...unbound, selectionStrategy: "lru" }, runtimeInstances: mixed }),
    null,
  );
});

test("CH3: receipt truthfully includes instance tier and effective strategy", () => {
  const selection = selectedRuntimeInstance({
    agent,
    instances: [instance("ultra", 2)],
    selected: "ultra",
    selectionStrategy: "lru",
  });
  assert.equal(selection.tier, 2);
  assert.equal(selection.selectionStrategy, "lru");
  assert.match(selection.reason, /tier 2.*lru/u);
});

test("CH3: Agent strategy overrides repository strategy and LRU recency wins over soft preference", () => {
  const request = {
    ...input([instance("pro-a", 1), instance("pro-b", 1)]),
    selectionStrategy: "sticky" as const,
    agent: { ...agent, selectionStrategy: "lru" as const, preferredInstances: ["pro-a"] },
    dispatchState: {
      lastDispatchedAt: new Map([
        ["pro-a", 2],
        ["pro-b", 1],
      ]),
      recordDispatch: () => {},
    },
  };
  assert.deepEqual(resolveRuntimeInstanceCandidates(request), ["pro-b", "pro-a"]);
  assert.equal(selectedRuntimeInstance({ ...request, selected: "pro-b" }).selectionStrategy, "lru");
});

test("CH3: concurrent preparations see the previous selection before its provider completes", async () => {
  const lastDispatchedAt = new Map<string, number>();
  let sequence = 0;
  const request = {
    ...input([instance("pro-a", 1), instance("pro-b", 1)]),
    selectionStrategy: "lru" as const,
    dispatchState: {
      lastDispatchedAt,
      recordDispatch: (id: string) => {
        lastDispatchedAt.set(id, ++sequence);
      },
    },
  };
  const barrier = Promise.withResolvers<void>();
  const first = prepareRuntimeInstance(request, async (id) => {
    await barrier.promise;
    return id;
  });
  const second = prepareRuntimeInstance(request, async (id) => id);
  barrier.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map((row) => row.instanceId),
    ["pro-a", "pro-b"],
  );
});

for (const selectionStrategy of ["sticky", "lru"] as const) {
  test(`CH3: ${selectionStrategy} favors idle instances over busy ones; LRU minimizes load before recency`, () => {
    const capacity = lifecycleReadForSync([
      { runtimeSessionId: "a1", dispatchId: "a1", instanceId: "pro-a" },
      { runtimeSessionId: "a2", dispatchId: "a2", instanceId: "pro-a" },
      { runtimeSessionId: "b1", dispatchId: "b1", instanceId: "pro-b" },
    ])({ by: "active", limit: 100 });
    assert.equal(capacity.status, "ready");
    if (capacity.status !== "ready") throw new Error("fixture not ready");
    const request = {
      ...input([instance("pro-a", 1), instance("pro-b", 1)]),
      selectionStrategy,
      capacity: capacity.rows,
      dispatchState: { lastDispatchedAt: new Map([["pro-b", 100]]), recordDispatch: () => {} },
    };
    if (selectionStrategy === "lru") assert.equal(resolveRuntimeInstanceCandidates(request)[0], "pro-b");
    assert.equal(
      resolveRuntimeInstanceCandidates({
        ...request,
        instances: [...request.instances, instance("idle", 1)],
        allowedInstanceIds: [...request.allowedInstanceIds, "idle"],
      })[0],
      "idle",
    );
  });
}
