// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";

import { fixture, owner, taskId, executionId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";

type Receipt = Record<string, unknown>;

test("a rework agent override resolves the declared runtime kind instead of pinning the previous instance", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    autoProviderSession: true,
    extraRuntimeKinds: [
      { instanceId: "agy-li", kindId: "agy", providerId: "google", model: "agy-model" },
      {
        instanceId: "deepseek-harness-li",
        kindId: "deepseek-harness",
        providerId: "deepseek",
        model: "deepseek-v4.1-flash",
      },
    ],
  });
  try {
    for (const declaration of [
      {
        schema: "agent-declaration/v1",
        id: "agy-worker",
        name: "Agy worker",
        instructions: "Implement the first cut on the agy runtime.",
        runtimes: [{ type: "agy", model: "agy-model" }],
        role: "worker",
      },
      {
        schema: "agent-declaration/v1",
        id: "deepseek-worker",
        name: "DeepSeek worker",
        instructions: "Implement the returned cut on the declared DeepSeek runtime.",
        runtimes: [{ type: "deepseek-harness", model: "deepseek-v4.1-flash" }],
        role: "worker",
      },
    ]) {
      const installed = await f.run({ kind: "agent-install", declaration });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    }

    const worker = await f.cell().spawnRuntime(
      {
        agentId: "agy-worker",
        role: "worker",
        taskId,
        runtimeInstanceId: "agy-li",
        model: "agy-model",
        dispatchKey: "task-rework-kind-source",
        prompt: "Implement the first cut.",
      },
      owner,
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const source = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_dispatch_requested" && event.payload.dispatchKey === "task-rework-kind-source",
      );
    assert.ok(source?.type === "runtime_dispatch_requested");
    assert.equal(source.payload.agentId, "agy-worker");
    assert.equal(readDispatchStream(f.root, source.payload.dispatchId)?.header?.instanceId, "agy-li");

    const workerBinding = withPolicyGroup(
      {
        actor: {
          principal: owner.actor.principal,
          executor: { kind: "agent" as const, id: `runtime-session:${source.payload.runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "contributor",
    );
    assert.equal((await f.submit(executionId, workerBinding)).outcome, "applied");

    const returned = (await f.run({
      kind: "task-rework",
      taskId,
      reason: "Move the returned cut to the agent that declares the DeepSeek runtime.",
      agentId: "deepseek-worker",
    })) as Receipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.equal((returned.continuation as Receipt | undefined)?.outcome, "applied", JSON.stringify(returned));

    const continuation = f
      .events()
      .filter(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role !== "reviewer",
      )
      .at(-1);
    assert.equal(continuation?.type, "runtime_dispatch_requested", JSON.stringify(returned));
    assert.equal(continuation.payload.agentId, "deepseek-worker");
    const header = readDispatchStream(f.root, continuation.payload.dispatchId)?.header;
    assert.equal(header?.instanceId, "deepseek-harness-li");
    assert.equal(header?.kindId, "deepseek-harness");
    assert.equal(header?.model, "deepseek-v4.1-flash");
  } finally {
    await f.close();
  }
});
