// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

type Receipt = Record<string, unknown>;

function reviewerActor(runtimeSessionId: string) {
  return {
    actor: {
      principal: owner.actor.principal,
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    },
    source: "local" as const,
  };
}

function runtimeSessionId(receipt: unknown): string {
  const steps = ((receipt as Receipt).steps as readonly Receipt[] | undefined) ?? [];
  const session = steps.find((step) => typeof step.runtimeSessionId === "string")?.runtimeSessionId;
  assert.equal(typeof session, "string", JSON.stringify(receipt));
  return session;
}

async function taskStatus(f: Awaited<ReturnType<typeof fixture>>): Promise<{ status: string; iteration: number }> {
  const shown = (await f.run({ kind: "task-show", taskId })) as Receipt;
  const evidence = JSON.parse(String(shown.evidence)) as { task: { status: string; iteration: number } };
  return { status: evidence.task.status, iteration: evidence.task.iteration };
}

async function recordReview(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  reviewId: string,
  verdict: "approved" | "changes_requested",
) {
  const packet = `${f.packagePath}/artifacts/reports/${reviewId}.json`,
    report = `${f.packagePath}/artifacts/reports/${reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId}.md`;
  mkdirSync(path.dirname(path.join(f.root, "harness", packet)), { recursive: true });
  writeFileSync(path.join(f.root, "harness", report), `# Review ${reviewId}\n\nPhysical review findings.\n`);
  writeFileSync(
    path.join(f.root, "harness", packet),
    JSON.stringify({
      verdict,
      reason: verdict === "approved" ? "The submitted cut is sound." : "The submitted cut needs revision.",
      evidenceChecked: ["closeout.md"],
    }),
  );
  return f
    .cell()
    .run(
      { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
      reviewerActor(sessionId),
    );
}

test("owner forward is the only path from submitted into independent review and completion is mechanical", async () => {
  const f = await fixture(false, true, false, false, false, undefined, {
    autoSubmit: false,
    autoForward: false,
  });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(await taskStatus(f), { status: "submitted", iteration: 0 });
    assert.equal(f.launches.length, 0, "submit must not dispatch a reviewer");

    const stopped = (await f.complete()) as Receipt;
    assert.equal(stopped.outcome, "op_rejected", JSON.stringify(stopped));
    assert.equal(f.launches.length, 0, "complete must not repair a missing owner forward");

    const premature = await recordReview(f, "unbound-reviewer", "review-before-forward", "approved");
    assert.equal(premature.outcome, "op_rejected", JSON.stringify(premature));
    assert.equal(premature.code, "invalid_transition", JSON.stringify(premature));

    const forwarded = await f.forward();
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });
    assert.equal(f.launches.length, 1, "the owner forward dispatches exactly one reviewer");
    const reviewed = await f.review(runtimeSessionId(forwarded), "review-approved");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    const noConsent = await f.complete();
    assert.equal(noConsent.code, "consent_missing", JSON.stringify(noConsent));
    assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    assert.equal((await f.consent("review-approved")).outcome, "applied");
    const completed = await f.complete();
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal((await taskStatus(f)).status, "done");
    assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
  } finally {
    await f.close();
  }
});

test("changes requested remains in review until the owner returns the cut with instructions", async () => {
  const f = await fixture();
  try {
    await f.install();
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const reviewed = await recordReview(
      f,
      dispatch.payload.runtimeSessionId,
      "review-changes-requested",
      "changes_requested",
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });

    const returned = await f.returnCut("Revise the evidence and resubmit.", "review-changes-requested");
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    assert.equal(f.launches.length, 1, "the reviewer verdict must not dispatch implementation work");
  } finally {
    await f.close();
  }
});

test("concurrent owner rulings and completions have one state-transition winner", async () => {
  const f = await fixture(false, true, false, false, false, undefined, {
    autoSubmit: false,
    autoForward: false,
  });
  try {
    await f.install();
    await f.submit();
    const rulings = await Promise.all([
      f.forward("Forward after owner inspection."),
      f.returnCut("Return after owner inspection."),
    ]);
    const appliedRulings = rulings.filter((receipt) => receipt.outcome === "applied").length,
      rejectedRulings = rulings.filter((receipt) => receipt.outcome === "op_rejected").length;
    assert.ok(appliedRulings === 1 || appliedRulings === 2, JSON.stringify(rulings));
    assert.equal(appliedRulings + rejectedRulings, 2, JSON.stringify(rulings));

    if ((await taskStatus(f)).status === "active") return;
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    assert.equal((await f.review(dispatch.payload.runtimeSessionId, "review-concurrent")).outcome, "applied");
    assert.equal((await f.consent("review-concurrent")).outcome, "applied");
    const completions = await Promise.all([f.complete(), f.complete()]);
    assert.equal(
      completions.every((receipt) => receipt.outcome === "applied"),
      true,
      JSON.stringify(completions),
    );
    assert.equal(completions[0]!.opId, completions[1]!.opId, "duplicate completion replays one durable receipt");
    assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
  } finally {
    await f.close();
  }
});
