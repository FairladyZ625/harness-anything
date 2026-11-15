// harness-test-tier: fast
import assert from "node:assert/strict";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import test from "node:test";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { prepareRuntimeInstance, resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";
import {
  agentRuntimeAmbiguityWarning,
  selectedRuntimeInstance,
  createRuntimeInstanceDispatchState,
} from "../src/runtime-instance-selection.ts";

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
  allowedInstanceIds: instances.map((row) => row.instanceId),
  now,
});

for (const selectionStrategy of ["sticky", "lru"] as const) {
  test(`F1: ${selectionStrategy} ignores a remote node's same-named instance load`, () => {
    const remote = lifecycleReadForSync([
      { runtimeSessionId: "remote-a", dispatchId: "remote-a", instanceId: "pro-a", owner: "node:remote" },
    ])({ by: "active", limit: 100 });
    assert.equal(remote.status, "ready");
    if (remote.status !== "ready") throw new Error("fixture not ready");
    const localState = createRuntimeInstanceDispatchState(),
      remoteState = createRuntimeInstanceDispatchState();
    remoteState.activate("remote-a", "pro-a");
    assert.equal(remoteState.readActiveLoads().get("pro-a"), 1);
    assert.equal(localState.readActiveLoads().size, 0);
    const request = {
      ...input([instance("pro-a", 1), instance("pro-b", 1)]),
      selectionStrategy,
      capacity: remote.rows,
      dispatchState: localState,
    };
    assert.equal(resolveRuntimeInstanceCandidates(request)[0], "pro-a");
  });
}

test("F1: node-local activation is idempotent and releases only the settled attempt", async () => {
  const state = createRuntimeInstanceDispatchState(),
    activate = (runtimeSessionId: string, instanceId: string) => state.activate(runtimeSessionId, instanceId);
  activate("x-a", "pro-a");
  activate("y-b", "pro-b");
  assert.deepEqual(
    [...state.readActiveLoads()],
    [
      ["pro-a", 1],
      ["pro-b", 1],
    ],
  );
  activate("adopted-a", "pro-a");
  activate("adopted-a", "pro-a");
  assert.equal(state.readActiveLoads().get("pro-a"), 2);
  state.deactivate("x-a");
  assert.equal(state.readActiveLoads().get("pro-a"), 1);
  state.deactivate("adopted-a");
  assert.equal(state.readActiveLoads().has("pro-a"), false);
  const preview = await prepareRuntimeInstance(
    { ...input([instance("pro-b", 1), instance("pro-a", 1)]), dispatchState: state, dryRun: true },
    async (id) => id,
  );
  assert.equal(preview.instanceId, "pro-a");
  assert.equal(state.lastDispatchedAt.size, 0, "a preview reads local load without changing recency");
  state.deactivate("y-b");
  assert.equal(state.readActiveLoads().size, 0);
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
      ...createRuntimeInstanceDispatchState(),
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
      ...createRuntimeInstanceDispatchState(),
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
      ...createRuntimeInstanceDispatchState(),
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
    const dispatchState = createRuntimeInstanceDispatchState();
    for (const { attempt } of capacity.rows) dispatchState.activate(attempt.runtimeSessionId, attempt.instanceId);
    dispatchState.recordDispatch("pro-b");
    const request = {
      ...input([instance("pro-a", 1), instance("pro-b", 1)]),
      selectionStrategy,
      dispatchState,
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

test("cross-row lru rotates across heterogeneous runtime rows while sticky preserves row priority", async () => {
  const pool: readonly RuntimeInstanceSummary[] = [
    { ...instance("agy-1", 1, ["gemini-3.1-pro-high"]), kindId: "agy" },
    { ...instance("deepseek-1", 1, ["deepseek-v4.1-flash"]), kindId: "deepseek-harness" },
    { ...instance("codex-1", 1, ["gpt-5.4"]), kindId: "codex" },
  ];
  const baseAgent = {
    id: "closeout-reviewer",
    name: "Closeout Reviewer",
    instructions: "Review",
    runtimes: [
      { type: "agy", model: "gemini-3.1-pro-high" },
      { type: "deepseek-harness", model: "deepseek-v4.1-flash" },
      { type: "codex", model: "gpt-5.4" },
    ],
  };
  const lruLastDispatched = new Map<string, number>();
  let sequence = 0;
  const lruState = {
    ...createRuntimeInstanceDispatchState(),
    lastDispatchedAt: lruLastDispatched,
    recordDispatch: (id: string) => {
      lruLastDispatched.set(id, ++sequence);
    },
  };
  const lruOrder: string[] = [];
  for (let i = 0; i < 4; i++) {
    const selected = await prepareRuntimeInstance(
      {
        agent: { ...baseAgent, selectionStrategy: "lru" },
        instances: pool,
        sessions: [],
        allowedInstanceIds: pool.map((row) => row.instanceId),
        dispatchState: lruState,
        now,
      },
      async (id) => id,
    );
    lruOrder.push(selected.instanceId);
  }
  assert.deepEqual(lruOrder, ["agy-1", "deepseek-1", "codex-1", "agy-1"]);

  const stickyLastDispatched = new Map<string, number>();
  let stickySeq = 0;
  const stickyState = {
    ...createRuntimeInstanceDispatchState(),
    lastDispatchedAt: stickyLastDispatched,
    recordDispatch: (id: string) => {
      stickyLastDispatched.set(id, ++stickySeq);
    },
  };
  const stickyOrder: string[] = [];
  for (let i = 0; i < 3; i++) {
    const selected = await prepareRuntimeInstance(
      {
        agent: { ...baseAgent, selectionStrategy: "sticky" },
        instances: pool,
        sessions: [],
        allowedInstanceIds: pool.map((row) => row.instanceId),
        dispatchState: stickyState,
        now,
      },
      async (id) => id,
    );
    stickyOrder.push(selected.instanceId);
  }
  assert.deepEqual(stickyOrder, ["agy-1", "agy-1", "agy-1"]);
});

test("first-review avoidVendor avoids same vendor within same tier, rotates heterogeneous pool, and falls back smoothly", async () => {
  const pool: readonly RuntimeInstanceSummary[] = [
    { ...instance("agy-1", 1, ["gemini-3.1-pro-high"]), kindId: "agy" },
    { ...instance("deepseek-1", 1, ["deepseek-v4.1-flash"]), kindId: "deepseek-harness" },
    { ...instance("codex-1", 1, ["gpt-5.4"]), kindId: "codex" },
  ];
  const multiReviewer = {
    id: "closeout-reviewer",
    name: "Closeout Reviewer",
    instructions: "Review",
    selectionStrategy: "lru" as const,
    runtimes: [
      { type: "agy", model: "gemini-3.1-pro-high" },
      { type: "deepseek-harness", model: "deepseek-v4.1-flash" },
      { type: "codex", model: "gpt-5.4" },
    ],
  };
  // Google implementation -> avoid google (agy-1), rotate between deepseek-1 and codex-1
  const makeState = () => {
    const lastDispatchedAt = new Map<string, number>();
    let seq = 0;
    return {
      ...createRuntimeInstanceDispatchState(),
      lastDispatchedAt,
      recordDispatch: (id: string) => {
        lastDispatchedAt.set(id, ++seq);
      },
    };
  };
  const googleImplState = makeState();
  const googleAvoided: string[] = [];
  for (let i = 0; i < 3; i++) {
    googleAvoided.push(
      (
        await prepareRuntimeInstance(
          {
            agent: multiReviewer,
            avoidVendor: "google",
            instances: pool,
            sessions: [],
            allowedInstanceIds: pool.map((row) => row.instanceId),
            dispatchState: googleImplState,
            now,
          },
          async (id) => id,
        )
      ).instanceId,
    );
  }
  assert.deepEqual(googleAvoided, ["deepseek-1", "codex-1", "deepseek-1"]);

  // OpenAI implementation -> avoid openai (codex-1), rotate between agy-1 and deepseek-1
  const openaiImplState = makeState();
  const openaiAvoided: string[] = [];
  for (let i = 0; i < 3; i++) {
    openaiAvoided.push(
      (
        await prepareRuntimeInstance(
          {
            agent: multiReviewer,
            avoidVendor: "openai",
            instances: pool,
            sessions: [],
            allowedInstanceIds: pool.map((row) => row.instanceId),
            dispatchState: openaiImplState,
            now,
          },
          async (id) => id,
        )
      ).instanceId,
    );
  }
  assert.deepEqual(openaiAvoided, ["agy-1", "deepseek-1", "agy-1"]);

  // Smooth fallback to same-vendor when all heterogeneous instances are disabled/cooling
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: multiReviewer,
      avoidVendor: "google",
      instances: [pool[0]!, { ...pool[1]!, enabled: false }, pool[2]!],
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      health: [cooling("codex-1")],
      now,
    }),
    ["agy-1"],
  );

  // Higher tier (tier 1) still precedes same-tier avoidVendor preference over tier 2
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: multiReviewer,
      avoidVendor: "google",
      instances: [pool[0]!, { ...pool[1]!, tier: 2 }, { ...pool[2]!, tier: 2 }],
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      now,
    }),
    ["agy-1", "deepseek-1", "codex-1"],
  );
});

test("preferredInstanceId soft affinity beats LRU and avoidVendor, falls back when unavailable, and yields to explicit overrides", () => {
  const pool: readonly RuntimeInstanceSummary[] = [
    { ...instance("agy-1", 1, ["gemini-3.1-pro-high"]), kindId: "agy" },
    { ...instance("deepseek-1", 1, ["deepseek-v4.1-flash"]), kindId: "deepseek-harness" },
    { ...instance("codex-1", 1, ["gpt-5.4"]), kindId: "codex" },
  ];
  const multiReviewer = {
    id: "closeout-reviewer",
    name: "Closeout Reviewer",
    instructions: "Review",
    selectionStrategy: "lru" as const,
    runtimes: [
      { type: "agy", model: "gemini-3.1-pro-high" },
      { type: "deepseek-harness", model: "deepseek-v4.1-flash" },
      { type: "codex", model: "gpt-5.4" },
    ],
  };
  const dispatchState = {
    ...createRuntimeInstanceDispatchState(),
    lastDispatchedAt: new Map([
      ["deepseek-1", 10],
      ["codex-1", 1],
    ]),
    recordDispatch: () => {},
  };
  // Soft affinity keeps deepseek-1 ahead of fresher codex-1 and even if avoidVendor="deepseek"
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: multiReviewer,
      preferredInstanceId: "deepseek-1",
      avoidVendor: "google",
      instances: pool,
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      dispatchState,
      now,
    }),
    ["deepseek-1", "codex-1", "agy-1"],
  );
  // Unavailable preferredInstanceId smoothly falls back to heterogeneous pool
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: multiReviewer,
      preferredInstanceId: "deepseek-1",
      avoidVendor: "google",
      instances: pool,
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      health: [cooling("deepseek-1")],
      dispatchState,
      now,
    }),
    ["codex-1", "agy-1"],
  );
  // Explicit --instance or --model or agent.instance ignores soft hints
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: multiReviewer,
      requested: "agy-1",
      explicitlyRequested: true,
      preferredInstanceId: "deepseek-1",
      avoidVendor: "google",
      instances: pool,
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      now,
    }),
    ["agy-1"],
  );
  assert.deepEqual(
    resolveRuntimeInstanceCandidates({
      agent: { ...multiReviewer, instance: "agy-1" },
      requested: "agy-1",
      preferredInstanceId: "deepseek-1",
      avoidVendor: "google",
      instances: pool,
      sessions: [],
      allowedInstanceIds: ["agy-1", "deepseek-1", "codex-1"],
      now,
    }),
    ["agy-1"],
  );
});
