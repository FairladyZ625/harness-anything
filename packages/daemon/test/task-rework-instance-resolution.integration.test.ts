// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";

import { fixture, owner, taskId, executionId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import {
  createMultiVendorHarness,
  latestReviewerDispatchFor,
  multiVendorReviewerOwner,
} from "./fixtures/reviewer-cross-vendor-lru.ts";

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

test("reviewer dispatches use the same project interception launch port", async () => {
  const global = { id: "global", pattern: "npm publish" },
    reviewerRule = { id: "reviewer", agent: "closeout-reviewer", pattern: "git push" },
    f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      commandInterceptions: [global, reviewerRule],
    });
  try {
    await f.install();
    await f.submit();
    assert.deepEqual(f.launches.at(-1)?.commandInterceptions, [global, reviewerRule]);
  } finally {
    await f.close();
  }
});

test(
  "same-task rework preserves instance/model on :resume-fallback and honors explicit manual override",
  { timeout: 90_000 },
  async () => {
    const h = await createMultiVendorHarness(),
      actorOwner = multiVendorReviewerOwner;
    try {
      await h.installAgents();

      // Impl on codex-1 (openai) -> avoids openai -> picks agy-1 (row 0 tie-breaker) R1.
      const t = await h.createAndImplementTask("task-resume-fallback", "exe-rf-1", "codex-1", "impl-rf-1");
      await h.submitCut("task-resume-fallback", "exe-rf-1");
      const rf1 = latestReviewerDispatchFor(h, "task-resume-fallback");
      assert.equal(rf1.payload.instanceId, "agy-1");
      await h.recordReviewVerdict(
        "task-resume-fallback",
        t.packagePath,
        "exe-rf-1",
        rf1.payload.dispatchId,
        rf1.payload.runtimeSessionId,
        "changes_requested",
      );
      await h.settleLast(rf1.payload.runtimeSessionId, { bindSession: true });

      // Simulate runtime_resume_failed -> :resume-fallback keeps agy-1 & gemini-3.1-pro-high.
      h.setFailNextResume(true);
      assert.equal(
        (await h.cell.run({ kind: "task-start", taskId: "task-resume-fallback", executionId: "exe-rf-2" }, actorOwner))
          .outcome,
        "applied",
      );
      await h.submitCut("task-resume-fallback", "exe-rf-2");
      const rfFallback = latestReviewerDispatchFor(h, "task-resume-fallback");
      assert.match(rfFallback.payload.dispatchKey, /:resume-fallback$/u);
      assert.equal(rfFallback.payload.instanceId, "agy-1");
      assert.equal(rfFallback.payload.definitionSnapshot?.model, "gemini-3.1-pro-high");
      await h.recordReviewVerdict(
        "task-resume-fallback",
        t.packagePath,
        "exe-rf-2",
        rfFallback.payload.dispatchId,
        rfFallback.payload.runtimeSessionId,
        "changes_requested",
      );
      await h.settleLast(rfFallback.payload.runtimeSessionId, { bindSession: false });

      // Explicit manual override (--instance codex-1 --model gpt-5.4) via task-dispatch-review wins over round affinity & avoidVendor.
      assert.equal(
        (await h.cell.run({ kind: "task-start", taskId: "task-resume-fallback", executionId: "exe-rf-3" }, actorOwner))
          .outcome,
        "applied",
      );
      const maintainer = withPolicyGroup(
        { actor: { principal: actorOwner.actor.principal, executor: null }, source: "local" },
        "maintainer",
      );
      assert.equal(
        (
          await h.cell.run(
            {
              kind: "settings-update",
              roles: { defaultReviewer: "missing-reviewer" },
              dispatchKey: "defer-auto-review",
            },
            maintainer,
          )
        ).outcome,
        "applied",
      );
      await h.submitCut("task-resume-fallback", "exe-rf-3");
      const manual = await h.cell.run(
        {
          kind: "task-dispatch-review",
          taskIds: ["task-resume-fallback"],
          agentId: "closeout-reviewer",
          runtimeInstanceId: "codex-1",
          model: "gpt-5.4",
        },
        maintainer,
      );
      assert.equal(manual.outcome, "applied", JSON.stringify(manual));
      const explicitDispatch = latestReviewerDispatchFor(h, "task-resume-fallback");
      assert.equal(explicitDispatch.payload.instanceId, "codex-1");
      assert.equal(explicitDispatch.payload.definitionSnapshot?.model, "gpt-5.4");
      await h.recordReviewVerdict(
        "task-resume-fallback",
        t.packagePath,
        "exe-rf-3",
        explicitDispatch.payload.dispatchId,
        explicitDispatch.payload.runtimeSessionId,
        "approved",
      );
      await h.settleLast(explicitDispatch.payload.runtimeSessionId, { bindSession: true });
    } finally {
      await h.close();
    }
  },
);
