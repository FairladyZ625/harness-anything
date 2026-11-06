// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, owner, taskId, executionId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

type Receipt = Record<string, unknown>;

// This file owns its fake identity realm: rework dispatch keys are deterministic
// for the fixture task and must not reuse another test's execution principal.
test("fresh and agent-override rework dispatches resolve project interception rules at the common launch port", async () => {
  const global = { id: "global", pattern: "npm publish" },
    firstRule = { id: "first", agent: "first-worker", pattern: "scripts/first" },
    nextRule = { id: "next", agent: "next-worker", pattern: "scripts/next" },
    reviewerRule = { id: "reviewer", agent: "closeout-reviewer", pattern: "git push" },
    f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      commandInterceptions: [global, firstRule, nextRule, reviewerRule],
      // The controlled provider has no OS process. Match the existing stopped-PID
      // fixtures rather than claiming the test runner is a detached worker group.
      runtimePid: 2_147_483_646,
    });
  try {
    for (const id of ["first-worker", "next-worker"])
      assert.equal(
        (
          await f.run({
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id,
              name: id,
              instructions: "Implement.",
              runtimes: [{ type: "codex", model: "review-model" }],
              role: "worker",
            },
          })
        ).outcome,
        "applied",
      );
    const spawned = await f
      .cell()
      .spawnRuntime(
        { agentId: "first-worker", role: "worker", taskId, prompt: "Implement.", dispatchKey: "interception-first" },
        owner,
      );
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    assert.deepEqual(f.launches.at(-1)?.commandInterceptions, [global, firstRule]);
    const source = f
      .events()
      .find(
        (event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchKey === "interception-first",
      );
    assert.ok(source?.type === "runtime_dispatch_requested");
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
    const returned = await f.run({
      kind: "task-rework",
      taskId,
      reason: "Use the next agent.",
      agentId: "next-worker",
    });
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.equal((returned.continuation as Receipt)?.outcome, "applied", JSON.stringify(returned));
    assert.deepEqual(f.launches.at(-1)?.commandInterceptions, [global, nextRule]);
  } finally {
    await f.close();
  }
});
