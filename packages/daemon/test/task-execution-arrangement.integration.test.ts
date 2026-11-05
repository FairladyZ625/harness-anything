// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { submissionDigest } from "@harness-anything/kernel";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

type F = Awaited<ReturnType<typeof fixture>>;
type Receipt = Record<string, unknown>;
const workerBinding = (runtimeSessionId: string) =>
  withPolicyGroup(
    withPolicyGroup(
      {
        actor: {
          principal: owner.actor.principal,
          executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "contributor",
    ),
    "maintainer",
  );
function cut(f: F) {
  const event = f
    .events()
    .filter((event) => event.type === "execution_submitted")
    .at(-1)!;
  assert.equal(event.type, "execution_submitted");
  assert.ok(event.payload.execution.submission);
  return {
    executionId: event.payload.execution.executionId,
    submissionDigest: submissionDigest(event.payload.execution.submission),
  };
}
function workers(f: F) {
  return f.events().filter((event) => event.type === "runtime_dispatch_requested" && event.payload.role !== "reviewer");
}
async function changes(f: F, id: string, target = executionId) {
  const reviewer = f
    .events()
    .filter((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer")
    .at(-1)!;
  assert.equal(reviewer.type, "runtime_dispatch_requested");
  const report = `${f.packagePath}/artifacts/reports/${id}.md`,
    packet = `${f.packagePath}/artifacts/reports/${id}.json`;
  mkdirSync(path.dirname(path.join(f.root, "harness", report)), { recursive: true });
  writeFileSync(path.join(f.root, "harness", report), "# Review\n\nFix the returned cut.\n");
  writeFileSync(
    path.join(f.root, "harness", packet),
    JSON.stringify({
      verdict: "changes_requested",
      reason: "Fix the returned cut.",
      evidenceChecked: ["closeout.md"],
      findings: [{ findingId: id, blocking: true, text: "Fix this." }],
      resolutions: [],
    }),
  );
  return f.cell().run(
    {
      kind: "task-review-execution",
      taskId,
      executionId: target,
      reviewId: `review-${id}`,
      fromFile: `harness/${packet}`,
    },
    withPolicyGroup(workerBinding(reviewer.payload.runtimeSessionId), "admin"),
  );
}
const arrange = (f: F, extra: Receipt = {}) =>
  f.run({ kind: "task-rework", taskId, ...cut(f), takeover: true, reason: "这一轮由我安排", ...extra });

test("owner first reserves only the returned round; duplicate takeover does not dispatch and the next submission restores automatic rework", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    assert.equal((await f.submit()).outcome, "applied");
    const shown = await f.run({ kind: "task-show", taskId });
    const payload = JSON.parse(String(shown.evidence));
    assert.deepEqual(payload.reworkTargets, [cut(f)], "show provides the exact takeover cut without a probing write");
    const reserved = await arrange(f);
    assert.equal(reserved.outcome, "applied", JSON.stringify(reserved));
    const returned = await changes(f, "owner-first");
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.equal(
      (returned as Receipt).continuation && ((returned as Receipt).continuation as Receipt).mode,
      "owner",
      JSON.stringify(returned),
    );
    assert.equal(workers(f).length, 0);
    const repeated = await arrange(f);
    assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
    assert.equal(workers(f).length, 0);
    assert.equal((await f.run({ kind: "task-start", taskId, executionId: "owner-round" })).outcome, "applied");
    assert.equal((await f.submit("owner-round")).outcome, "applied");
    const next = await changes(f, "automatic-next", "owner-round");
    assert.equal(next.outcome, "applied", JSON.stringify(next));
    assert.equal(workers(f).length, 1, JSON.stringify(next));
  } finally {
    await f.close();
  }
});

test("automatic first: owner replacement waits for old runtime outcome, duplicate requests reuse the dispatch, stale cut and fence cannot submit", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false, autoProviderSession: true });
  try {
    await f.install();
    assert.equal((await f.submit()).outcome, "applied");
    assert.equal((await changes(f, "automatic-first")).outcome, "applied");
    const old = workers(f).at(-1)!;
    assert.equal(old.type, "runtime_dispatch_requested");
    const replaced = await arrange(f, { agentId: "closeout-reviewer" });
    assert.equal(replaced.outcome, "applied", JSON.stringify(replaced));
    assert.equal(((replaced as Receipt).continuation as Receipt)?.outcome, "applied", JSON.stringify(replaced));
    const events = f.events(),
      next = workers(f).at(-1)!;
    assert.equal(next.type, "runtime_dispatch_requested");
    const exit = events.findIndex(
      (event) =>
        event.type === "runtime_session_outcome_observed" &&
        event.payload.runtimeSessionId === old.payload.runtimeSessionId,
    );
    assert.ok(exit >= 0);
    assert.ok(events.findIndex((event) => event.eventId === next.eventId) > exit);
    assert.equal(workers(f).length, 2);
    const repeat = await arrange(f, { agentId: "closeout-reviewer" });
    assert.equal(repeat.outcome, "applied", JSON.stringify(repeat));
    assert.equal(workers(f).length, 2, "no second continuation");
    const stale = await arrange(f, { submissionDigest: `sha256:${"f".repeat(64)}` });
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    const oldSubmit = await f.submit(old.payload.executionId!, workerBinding(old.payload.runtimeSessionId));
    assert.equal(oldSubmit.outcome, "op_rejected", JSON.stringify(oldSubmit));
    assert.equal(workers(f).length, 2);
    await f.waitForProviderBinding(next.payload.dispatchId, "review-provider-session-new");
    assert.equal((await f.cancel(next.payload.runtimeSessionId)).outcome, "applied");
    const resumed = await f.cell().spawnRuntime(
      {
        taskId,
        agentId: "closeout-reviewer",
        dispatchId: next.payload.dispatchId,
        dispatchKey: "owner-arranged-resume",
        prompt: "Resume this same owner-arranged round.",
      },
      owner,
    );
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    assert.equal(
      workers(f).length,
      3,
      "an explicit resume inherits the accepted arrangement rather than getting stranded",
    );
  } finally {
    await f.close();
  }
});

for (const code of ["runtime_process_group_unproven", "remote_disconnected"]) {
  test(`takeover preserves an incomplete handoff after ${code} and never launches a replacement`, async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      beforeRuntimeStop: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    try {
      await f.install();
      assert.equal((await f.submit()).outcome, "applied");
      assert.equal((await changes(f, `failed-${code}`)).outcome, "applied");
      assert.equal(workers(f).length, 1);
      for (let i = 0; i < 2; i += 1) {
        const failed = await arrange(f, { agentId: "closeout-reviewer" });
        assert.equal(failed.outcome, "applied", JSON.stringify(failed));
        const continuation = (failed as Receipt).continuation as Receipt;
        assert.equal(continuation.outcome, "op_rejected", JSON.stringify(failed));
        assert.equal(continuation.code, code, JSON.stringify(failed));
        assert.equal(workers(f).length, 1);
      }
      assert.equal((await f.run({ kind: "task-start", taskId })).outcome, "op_rejected");
    } finally {
      await f.close();
    }
  });
}

test("owner accepted during automatic cancellation fences that continuation, and cancellation does not hold the center queue", async () => {
  const stopReached = Promise.withResolvers<void>(),
    allowStop = Promise.withResolvers<void>();
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    beforeRuntimeStop: async () => {
      stopReached.resolve();
      await allowStop.promise;
    },
  });
  try {
    await f.install();
    const source = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        dispatchKey: "arrangement-race-source",
        prompt: "Implement the first cut.",
      },
      owner,
    );
    assert.equal(source.outcome, "applied", JSON.stringify(source));
    assert.equal((await f.submit(executionId, workerBinding(String(source.runtimeSessionId)))).outcome, "applied");
    const automatic = changes(f, "race");
    await stopReached.promise;
    const takeover = arrange(f, { agentId: "closeout-reviewer" });
    const interleaved = await f.run({ kind: "task-amend", taskId, patches: [{ field: "pinned", value: "true" }] });
    assert.equal(interleaved.outcome, "applied", JSON.stringify(interleaved));
    assert.ok(
      f
        .events()
        .some(
          (event) => event.type === "task_amended" && event.payload.mutation.fields.includes("executionArrangement"),
        ),
      "owner intent was accepted while automatic cancellation was pending",
    );
    allowStop.resolve();
    const [reviewed, arranged] = await Promise.all([automatic, takeover]);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    assert.equal(arranged.outcome, "applied", JSON.stringify(arranged));
    assert.equal(workers(f).length, 2, "source plus exactly one owner replacement");
    assert.equal(((arranged as Receipt).continuation as Receipt)?.outcome, "applied", JSON.stringify(arranged));
  } finally {
    allowStop.resolve();
    await f.close();
  }
});

test("a changes_requested review recovered during runtime settlement uses the same return handoff", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false, closeoutProfile: "standard" });
  try {
    await f.install();
    assert.equal((await f.submit()).outcome, "applied");
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested")!;
    assert.equal(dispatch.type, "runtime_dispatch_requested");
    const report = f.reportPath(dispatch.payload.dispatchId);
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, "# Review\n\nThe cut requires another implementation pass.\n");
    writeFileSync(
      report.replace(/\.md$/u, ".json"),
      JSON.stringify({
        verdict: "changes_requested",
        reason: "Fix the cut.",
        evidenceChecked: ["closeout.md"],
        findings: [{ findingId: "recovered", blocking: true, text: "Fix this." }],
        resolutions: [],
      }),
    );
    assert.equal(
      await f.settleReview(
        dispatch.payload.dispatchId,
        dispatch.payload.runtimeSessionId,
        "Review recorded in the task package.",
      ),
      "succeeded",
    );
    await f.waitForLaunches(2);
    assert.equal(
      (await f.run({ kind: "task-amend", taskId, patches: [{ field: "pinned", value: "true" }] })).outcome,
      "applied",
    );
    assert.equal(workers(f).length, 1);
    assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 1);
  } finally {
    await f.close();
  }
});

test("a review-exempt low-risk takeover returns and hands over in one request", async () => {
  const f = await fixture(false, true, true, false, false, { autoSubmit: false, create: { riskTier: "low" } });
  try {
    await f.install();
    assert.equal((await f.submit()).outcome, "applied");
    assert.equal(f.launches.length, 0);
    const result = await arrange(f);
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    assert.equal(((result as Receipt).continuation as Receipt)?.mode, "owner", JSON.stringify(result));
    assert.equal(f.launches.length, 0);
    assert.equal((await f.run({ kind: "task-start", taskId, executionId: "lowrisk-owner" })).outcome, "applied");
  } finally {
    await f.close();
  }
});
