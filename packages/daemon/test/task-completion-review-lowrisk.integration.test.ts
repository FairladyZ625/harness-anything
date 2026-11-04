// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

type Receipt = Record<string, unknown>;

async function taskStatus(f: Awaited<ReturnType<typeof fixture>>): Promise<{ status: string; iteration: number }> {
  const shown = (await f.run({ kind: "task-show", taskId })) as Receipt;
  const evidence = JSON.parse(String(shown.evidence)) as { task: { status: string; iteration: number } };
  return { status: evidence.task.status, iteration: evidence.task.iteration };
}

// A real low-risk cut is submitted by an implementation worker; the owner's semantic return must
// continue that worker, not require the owner to start one. The fixture's fake provider starts the
// source worker, and the rework continuation resumes or falls back with the same identity.
test("a review-exempt low-risk cut returns to rework and resumes its worker", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    autoProviderSession: true,
    submitCommit: true,
    create: { riskTier: "low", presetId: "standard-task" },
  });
  try {
    await f.install();
    const worker = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        runtimeInstanceId: "review-second",
        dispatchKey: "task-rework-lowrisk-worker",
        prompt: "Implement the low-risk first cut.",
      },
      owner,
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const source = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_dispatch_requested" && event.payload.dispatchKey === "task-rework-lowrisk-worker",
      );
    assert.ok(source?.type === "runtime_dispatch_requested");
    await f.waitForProviderBinding(source.payload.dispatchId, "review-provider-session");
    const workerBinding = withPolicyGroup(
      withPolicyGroup(
        {
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${source.payload.runtimeSessionId}` },
          },
          source: "local" as const,
        },
        "contributor",
      ),
      "maintainer",
    );
    const submitted = await f.submit(executionId, workerBinding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(await taskStatus(f), { status: "submitted", iteration: 0 });
    assert.equal(f.launches.length, 1, "a review-exempt cut dispatches no reviewer");

    // Retire the source worker before the return, so the continuation proves a stopped writer
    // instead of racing a live checkout.
    assert.equal((await f.cancel(source.payload.runtimeSessionId)).outcome, "applied");
    await f.reopen();

    const returned = (await f.run({
      kind: "task-rework",
      taskId,
      reason: "CEO semantic acceptance: narrow the assertion.",
    })) as Receipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.equal(f.launches.length, 2, JSON.stringify(returned));
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    assert.match(f.launches.at(-1)!.prompt, /# Owner return/u);
    assert.match(f.launches.at(-1)!.prompt, /CEO semantic acceptance: narrow the assertion\./u);

    const returnEvent = f
      .events()
      .filter((event) => event.type === "submission_returned")
      .at(-1);
    assert.ok(returnEvent?.type === "submission_returned");
    assert.equal(returnEvent.payload.reviewId, undefined);
    assert.equal(returnEvent.payload.reason, "CEO semantic acceptance: narrow the assertion.");
  } finally {
    await f.close();
  }
});
