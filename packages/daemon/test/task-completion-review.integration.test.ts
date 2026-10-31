// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

import { grantTestPolicyGroups, revokeTestPolicyActions, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { dispatchStreamPath, readDispatchStream } from "../src/dispatch-stream.ts";

/** The principal that records rework-driving verdicts: a person of its own, so denying its
 * runtime-spawn (which kills the automatic worker continuation at admission) never touches the
 * owner's permissions this file's other tests rely on. A reviewer never needs to spawn. */
const REWORK_REVIEWER_PERSON = "completion-rework-reviewer";

type Receipt = Record<string, unknown>;

function reviewerActor(runtimeSessionId: string) {
  return withPolicyGroup(
    {
      actor: {
        principal: owner.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      source: "local" as const,
    },
    "admin",
  );
}

function runtimeSessionId(receipt: unknown): string {
  const steps = ((receipt as Receipt).steps as readonly Receipt[] | undefined) ?? [];
  const session = steps.find((step) => typeof step.runtimeSessionId === "string")?.runtimeSessionId;
  assert.equal(typeof session, "string", JSON.stringify(receipt));
  return session;
}

/** The reviewer's own process settles after registering; consent only stands on settled lanes. */
async function settleReviewerDispatch(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const dispatch = f
    .events()
    .filter((event) => event.type === "runtime_dispatch_requested")
    .at(-1);
  assert.ok(dispatch?.type === "runtime_dispatch_requested");
  const outcome = await f.settleReview(
    dispatch.payload.dispatchId,
    dispatch.payload.runtimeSessionId,
    "Reviewed and recorded.",
  );
  assert.ok(["succeeded", "stopped", "failed"].includes(outcome), `dispatch settled as ${String(outcome)}`);
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
  reviewExecutionId = executionId,
  binding: typeof owner | ReturnType<typeof reviewerActor> = reviewerActor(sessionId),
  findings: readonly Record<string, unknown>[] = [
    { findingId: "fixture-finding", blocking: true, text: "Fixture review requires another pass." },
  ],
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
      findings,
      resolutions: [],
    }),
  );
  return f.cell().run(
    {
      kind: "task-review-execution",
      taskId,
      executionId: reviewExecutionId,
      reviewId,
      fromFile: `harness/${packet}`,
    },
    binding,
  );
}

test("submit enters independent review automatically and completion still requires owner consent", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    create: { riskTier: "high" },
  });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });
    assert.equal(f.launches.length, 1, "submit dispatches the reviewer");

    const stopped = (await f.complete()) as Receipt;
    assert.equal(stopped.outcome, "op_rejected", JSON.stringify(stopped));
    assert.equal(f.launches.length, 1, "complete must not dispatch another reviewer");

    const selfReview = await recordReview(f, "implementer", "review-self", "approved", executionId, owner);
    assert.equal(selfReview.outcome, "op_rejected", JSON.stringify(selfReview));
    assert.equal(selfReview.code, "actor_unauthorized", JSON.stringify(selfReview));

    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });
    const reviewed = await f.review(runtimeSessionId(submitted), "review-approved");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    const noConsent = await f.complete();
    assert.equal(noConsent.code, "consent_missing", JSON.stringify(noConsent));
    assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
    await settleReviewerDispatch(f);
    assert.equal((await f.consent("review-approved")).outcome, "applied");
    const completed = await f.complete();
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal((await taskStatus(f)).status, "done");
    assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
  } finally {
    await f.close();
  }
});

test("a low declaration raised to high freezes the assessed tier and consent without GUI acceptance", async () => {
  const f = await fixture(false, true, true, false, false, {
    autoSubmit: false,
    guiDelivery: true,
    submitCommit: true,
    create: { riskTier: "low" },
  });
  try {
    await f.install();
    const tools = path.join(f.root, "tools");
    mkdirSync(tools, { recursive: true });
    writeFileSync(
      path.join(tools, "task-risk-manifest.json"),
      JSON.stringify({
        schema: "task-risk-manifest/v1",
        scripts: [
          {
            id: "fixture-high-floor",
            command: [
              process.execPath,
              "-e",
              "process.stdout.write(JSON.stringify({ schema: 'task-risk-tier-result/v1', minimumTier: 'high', reasons: ['fixture high floor'] }));",
            ],
          },
        ],
      }),
    );

    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = f.events().find((candidate) => candidate.type === "execution_submitted");
    assert.ok(event?.type === "execution_submitted");
    const submission = event.payload.execution.submission;
    assert.ok(submission);
    const assessment = submission.riskTierAssessment;
    assert.ok(assessment, "the accepted submission freezes its risk assessment");
    assert.equal(assessment.declaredTier, "low");
    assert.equal(assessment.effectiveTier, "high");
    assert.match(assessment.deliveryBaseSha ?? "", /^[0-9a-f]{40}$/u);
    assert.match(assessment.deliveryHeadSha ?? "", /^[0-9a-f]{40}$/u);
    assert.deepEqual(assessment.matchedPathReviewers, []);
    assert.equal(
      submission.completionContract.closeoutGates.consent,
      false,
      "risk-floor escalation changes review only",
    );
    assert.equal(Object.hasOwn(assessment, "guiAcceptanceRequired"), false);
    assert.ok(!submission.completionContract.gates.some((gate) => gate.gateId === "gui-acceptance"));
    assert.match(assessment.reasons.join("\n"), /fixture high floor/u);
    console.info(`SUBMISSION_RISK_TIER_ASSESSMENT ${JSON.stringify(assessment)}`);
  } finally {
    await f.close();
  }
});

test("a low-tier packages/gui delivery freezes no GUI acceptance gate", async () => {
  const f = await fixture(false, true, true, false, false, {
    autoSubmit: false,
    guiDelivery: true,
    submitCommit: true,
    create: { riskTier: "low" },
  });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = f.events().find((candidate) => candidate.type === "execution_submitted");
    assert.ok(event?.type === "execution_submitted");
    const submission = event.payload.execution.submission;
    assert.ok(submission);
    assert.equal(submission.riskTierAssessment?.effectiveTier, "low");
    assert.equal(Object.hasOwn(submission.riskTierAssessment!, "guiAcceptanceRequired"), false);
    assert.ok(!submission.completionContract.gates.some((gate) => gate.gateId === "gui-acceptance"));
  } finally {
    await f.close();
  }
});

test("medium tier preserves the repository's resolved consent gate", async () => {
  const f = await fixture(false, true, true, false, false, {
    autoSubmit: false,
    create: { riskTier: "medium" },
  });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = f.events().find((candidate) => candidate.type === "execution_submitted");
    assert.ok(event?.type === "execution_submitted");
    const submission = event.payload.execution.submission;
    assert.ok(submission);
    assert.equal(submission.riskTierAssessment?.effectiveTier, "medium");
    assert.equal(submission.completionContract.closeoutGates.consent, true);
  } finally {
    await f.close();
  }
});

test("a lightweight task's forward order upgrades the cut into the review corridor instead of deadlocking", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    create: { riskTier: "low" },
  });
  try {
    await f.install();
    // A task-package-artifact delivery: file the artifact, sync it, and anchor it in the closeout.
    const report = `${f.packagePath}/artifacts/delivery.md`;
    mkdirSync(path.dirname(path.join(f.root, "harness", report)), { recursive: true });
    writeFileSync(path.join(f.root, "harness", report), "Lightweight delivery evidence.\n");
    const synced = (await f.run({ kind: "doc-submit", taskId })) as Receipt;
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    writeFileSync(
      path.join(f.root, "harness", f.packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nReviewed delivery artifact:${report}@${String(synced.revision)}\n\n` +
        "## Verification\n\nREADME bytes checked.\n\n## Residual Risk\n\nNone.\n\n" +
        "## Same Mechanism Elsewhere\n\nReview dispatch retry.\n",
    );
    const submitted = (await f.run({ kind: "task-submit", taskId, executionId })) as Receipt;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(f.launches.length, 0, "the lightweight submit itself dispatches no reviewer");
    // The forward order retired with the manual corridor: a review-lifted cut has no lane into
    // review, and dispatch-review says so instead of advising a nonexistent command.
    const advised = (await f.run({ kind: "task-dispatch-review", taskIds: [taskId] })) as Receipt;
    assert.equal(advised.outcome, "op_rejected", JSON.stringify(advised));
    assert.match(String(advised.rejectionExplanation), /has no automatic review requirement; its cut lifted review/u);
    // The lifted profile completes straight off submitted; no verdict is owed.
    const completed = (await f.complete()) as Receipt;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal((await taskStatus(f)).status, "done");
  } finally {
    await f.close();
  }
});

test("a changes_requested verdict below the budget reopens rework in the same write", async () => {
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
    // Below the default budget (2) the verdict itself is the return order: the round reopens
    // atomically and the continuation rides the same receipt (dec_E369B861 CH3).
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    const continuation = (reviewed as Receipt).continuation as { mode?: string } | undefined;
    assert.ok(continuation, "the rework continuation rides the review receipt");
    assert.equal(continuation?.mode, "fresh", "this fixture submitted without a dispatch, so the worker is fresh");
    assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 1);
  } finally {
    await f.close();
  }
});

test("automatic rework settles the submitting worker before launching its continuation", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false, autoProviderSession: true });
  try {
    await f.install();
    const worker = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        dispatchKey: "task-rework-live-submitter-worker",
        prompt: "Implement the first cut, submit it, then continue the current turn.",
      },
      owner,
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const source = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.dispatchKey === "task-rework-live-submitter-worker",
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
    assert.equal(
      f
        .events()
        .some(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.runtimeSessionId === source.payload.runtimeSessionId,
        ),
      false,
      "the submitting worker is still active after submit",
    );

    const reviewer = f
      .events()
      .find((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
    assert.ok(reviewer?.type === "runtime_dispatch_requested");
    const reviewed = await recordReview(
      f,
      reviewer.payload.runtimeSessionId,
      "review-live-submitter-changes",
      "changes_requested",
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));

    const events = f.events(),
      sourceOutcomeIndex = events.findIndex(
        (event) =>
          event.type === "runtime_session_outcome_observed" &&
          event.payload.runtimeSessionId === source.payload.runtimeSessionId,
      ),
      continuationIndex = events.findIndex(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role !== "reviewer" &&
          event.payload.runtimeSessionId !== source.payload.runtimeSessionId,
      );
    assert.ok(continuationIndex >= 0, "the review must dispatch the rework continuation");
    assert.ok(sourceOutcomeIndex >= 0, "the old worker must be settled before rework starts");
    assert.ok(continuationIndex > sourceOutcomeIndex, "the continuation must launch after old-worker settlement");
    assert.equal(
      events[sourceOutcomeIndex]?.type === "runtime_session_outcome_observed"
        ? events[sourceOutcomeIndex].payload.outcome
        : undefined,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("the rework budget stops the loop and leaves the cut to the owner", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    const dispatchReview = async (roundExecutionId: string, reviewId: string) => {
      const dispatch = f
        .events()
        .filter((event) => event.type === "runtime_dispatch_requested")
        .at(-1);
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      // runtime-spawn is revoked around the verdict so the automatic worker continuation is
      // denied at admission: like delivery-baseline-rework's unavailable spawner, the failed
      // continuation leaves the reopened round without a spawned execution, and each rework
      // round starts like any other. The owner's group grants are restored right after.
      grantTestPolicyGroups([REWORK_REVIEWER_PERSON], "admin");
      revokeTestPolicyActions(REWORK_REVIEWER_PERSON, "completion-review", ["runtime-spawn"]);
      const reviewed = (await recordReview(
        f,
        dispatch.payload.runtimeSessionId,
        reviewId,
        "changes_requested",
        roundExecutionId,
        withPolicyGroup(
          {
            actor: {
              principal: { personId: REWORK_REVIEWER_PERSON },
              executor: { kind: "agent" as const, id: `runtime-session:${dispatch.payload.runtimeSessionId}` },
            },
            source: "local" as const,
          },
          "admin",
        ),
      )) as Receipt;
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      return reviewed;
    };
    // Round 1 and 2 reopen below the default budget of 2; the third verdict only records.
    assert.equal((await f.submit()).outcome, "applied");
    await dispatchReview(executionId, "review-budget-1");
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    let capped: Receipt | undefined;
    for (const [index, roundExecutionId] of ["execution-review-budget-2", "execution-review-budget-3"].entries()) {
      const started = (await f.run({ kind: "task-start", taskId, executionId: roundExecutionId })) as Receipt;
      assert.equal(started.outcome, "applied", `round ${String(index + 2)} start: ${JSON.stringify(started)}`);
      const submitted = (await f.submit(roundExecutionId)) as Receipt;
      assert.equal(submitted.outcome, "applied", `round ${String(index + 2)} submit: ${JSON.stringify(submitted)}`);
      capped = await dispatchReview(roundExecutionId, `review-budget-${index + 2}`);
    }
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 2 });
    assert.match(
      String(JSON.stringify(capped?.warnings ?? [])),
      /rework budget is exhausted/u,
      "the capped receipt names the owner's disposition lanes",
    );
  } finally {
    await f.close();
  }
});

test("concurrent review verdicts have one state-transition winner", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    await f.submit();
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    // The manual forward/return race retired with the commands; the surviving race is two
    // verdicts on one cut: whichever records first drives the state, the other is refused.
    const rulings = await Promise.all([
      recordReview(f, dispatch.payload.runtimeSessionId, "review-race-changes", "changes_requested"),
      recordReview(f, dispatch.payload.runtimeSessionId, "review-race-approved", "approved"),
    ]);
    const appliedRulings = rulings.filter((receipt) => receipt.outcome === "applied").length,
      rejectedRulings = rulings.filter((receipt) => receipt.outcome === "op_rejected").length;
    assert.ok(appliedRulings >= 1, JSON.stringify(rulings));
    assert.equal(appliedRulings + rejectedRulings, 2, JSON.stringify(rulings));
    const status = await taskStatus(f);
    assert.ok(
      (status.status === "active" && status.iteration === 1) ||
        (status.status === "in_review" && status.iteration === 0),
      JSON.stringify(status),
    );
    if (status.status === "active") return;
    const approved = f
      .events()
      .find((event) => event.type === "review_recorded" && event.payload.review.verdict === "approved");
    assert.ok(approved?.type === "review_recorded");
    await settleReviewerDispatch(f);
    assert.equal((await f.consent("review-race-approved")).outcome, "applied");
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

test.skip("sibling complete refuses unfinished sources and missing facts, then closes B without execution or duplicate review", async () => {
  const f = await fixture(false, true, true, false, false, { autoSubmit: false });
  try {
    const target = "task-resolved-target";
    await f.createPlannedTask(target, "docs-task");
    const fact = f.events().find((event) => event.type === "fact_recorded");
    assert.ok(fact?.type === "fact_recorded");
    const action = {
      kind: "task-complete",
      taskId: target,
      resolvedBy: taskId,
      resolutionRationale: "The reviewed README delivery resolves the duplicate report on main",
      resolutionFact: `fact/${fact.factId}`,
    };
    const missing = await f.run({ ...action, resolutionFact: undefined });
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    const unfinished = await f.run(action);
    assert.equal(unfinished.outcome, "op_rejected", JSON.stringify(unfinished));
    assert.match(JSON.stringify(unfinished), /Complete|Wait|complete/u);
    await f.install();
    const forwarded = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
    assert.equal((await f.review(runtimeSessionId(forwarded), "review-sibling")).outcome, "applied");
    await settleReviewerDispatch(f);
    assert.equal((await f.consent("review-sibling")).outcome, "applied");
    assert.equal((await f.complete()).outcome, "applied");
    const completed = await f.run(action);
    if (completed.outcome === "pending") {
      await f.cell().settlePendingMaterialization("sibling completion publication");
    }
    const settled = completed.outcome === "pending" ? await f.run(action) : completed;
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    const replay = await f.run(action);
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(replay.opId, settled.opId);
    const targetEvents = f.events().filter((event) => event.taskId === target);
    assert.equal(targetEvents.filter((event) => event.type === "task_completed").length, 1);
    assert.equal(
      targetEvents.filter((event) => event.type === "execution_started" || event.type === "review_recorded").length,
      0,
    );
    await f.reopen();
    const shown = await f.run({ kind: "task-show", taskId: target });
    assert.match(JSON.stringify(shown), /siblingResolution/u);
    assert.match(JSON.stringify(shown), /task-completion-review/u);
  } finally {
    await f.close();
  }
});

test("a done lightweight source without independent review cannot resolve a sibling", async () => {
  const f = await fixture(false, true, true, false, false, {
    create: { riskTier: "low" },
  });
  try {
    await f.createPlannedTask("task-unreviewed-target");
    assert.equal((await f.complete()).outcome, "applied");
    const fact = f.events().find((event) => event.type === "fact_recorded");
    assert.ok(fact?.type === "fact_recorded");
    const result = await f.run({
      kind: "task-complete",
      taskId: "task-unreviewed-target",
      resolvedBy: taskId,
      resolutionRationale: "A claims to fix B",
      resolutionFact: `fact/${fact.factId}`,
    });
    assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
    assert.match(JSON.stringify(result), /approved review, consent/u);
  } finally {
    await f.close();
  }
});

// 2026-10-23 (task_cffec8b1 / PR #3922): consent applied over an approved data-migration review
// while the functional re-review was still running, and the owner merged on that receipt. Consent
// is the owner's confirmation that every review lane on this cut concluded, not that one approved
// verdict happens to exist.
test("consent refuses an approved review while another review dispatch on the cut is still running", async () => {
  const f = await fixture(false, true, false, false, false, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.run({ kind: "task-dispatch-review", taskIds: [taskId] })).outcome, "applied");
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    // The independent lane's approved verdict lands while the dispatched functional re-review runs.
    const approved = await recordReview(
      f,
      "migration-reviewer",
      "review-migration-approved",
      "approved",
      executionId,
      undefined,
      [],
    );
    assert.equal(approved.outcome, "applied", JSON.stringify(approved));
    const consentOf = () =>
      f.run({ kind: "task-review-consent", taskId, executionId, reviewId: "review-migration-approved" });

    const refused = (await consentOf()) as Receipt;
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "review_dispatch_unsettled", JSON.stringify(refused));
    assert.match(String(refused.rejectionExplanation), new RegExp(dispatch.payload.dispatchId, "u"));
    assert.match(String(refused.rejectionExplanation), /ha runtime status --task .* --wait/u);
    assert.equal(
      f.events().filter((event) => event.type === "review_consent_recorded").length,
      0,
      "a refused consent records nothing",
    );

    // Cancelling the outstanding dispatch reaches its own verdict, so the refusal lifts. The receipt is
    // the completion signal: `cancelRuntime` awaits `publishExit`, which publishes the canonical
    // outcome before `controlReceipt` builds the response (runtime-spawn-control.ts:51 →
    // runtime-spawn-settlement.ts:437-450). Reading the ledger without awaiting it reads a window, not
    // a verdict.
    await f.cancel(dispatch.payload.runtimeSessionId);
    await f.awaitOutcome(dispatch.payload.runtimeSessionId);
    const consented = await consentOf();
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
  } finally {
    await f.close();
  }
});

/**
 * The canonical terminal events recorded for one session, in ledger order. `runtime_session_cancelled`
 * already reduces liveness to `exited` (agent-runtime.ts:907-916), so the `runtime_session_exited` that
 * `publishTerminalOutcome` still attempts afterwards compiles to `no_changes` and writes nothing. The
 * cancel path's canonical sequence is therefore `cancelled → outcome_observed`.
 */
function terminalEventsFor(
  f: Awaited<ReturnType<typeof fixture>>,
  runtimeSessionId: string,
): { readonly type: string; readonly revision: number }[] {
  return f
    .events()
    .filter(
      (event) =>
        (event.type === "runtime_session_cancelled" ||
          event.type === "runtime_session_exited" ||
          event.type === "runtime_session_outcome_observed") &&
        event.payload.runtimeSessionId === runtimeSessionId,
    )
    .map((event) => ({ type: event.type, revision: event.workspaceRevision }));
}

// 2026-10-24 (task_89267edc): `cancelRuntime` awaits `publishExit`, which reaches its single
// settlement entry and publishes the canonical outcome before `controlReceipt` builds the response
// (runtime-spawn-control.ts:51 → runtime-spawn-settlement.ts:444/:450). So the receipt is already a
// completion signal: when it resolves, the canonical outcome must be readable — no polling, no
// `awaitOutcome`, no grace. The flake was this test dropping that receipt and then reading the ledger
// at whatever point `awaitOutcome` happened to return, which is a different, earlier signal.
test("a cancel receipt is returned only after the canonical outcome is readable", async () => {
  const f = await fixture(false, true, false, false, false, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.run({ kind: "task-dispatch-review", taskIds: [taskId] })).outcome, "applied");
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const runtimeSessionId = dispatch.payload.runtimeSessionId;

    const recorded = (await f.cancel(runtimeSessionId), terminalEventsFor(f, runtimeSessionId));
    // The receipt alone must already imply the outcome: `cancelled` first, outcome last, nothing pending.
    assert.deepEqual(
      recorded.map(({ type }) => type),
      ["runtime_session_cancelled", "runtime_session_outcome_observed"],
      `runtime session ${runtimeSessionId} has no settled canonical outcome after its cancel receipt returned`,
    );
    const outcome = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
    assert.ok(outcome?.type === "runtime_session_outcome_observed");
    assert.equal(outcome.payload.outcome, "cancelled");
    // Causality, not co-occurrence: the outcome's commit is the last revision the settlement produced,
    // so no terminal append can still be in flight behind the receipt.
    assert.equal(outcome.workspaceRevision, Math.max(...recorded.map(({ revision }) => revision)));
  } finally {
    await f.close();
  }
});

test("consent applies once every review dispatch on the cut reached its terminal verdict", async () => {
  const f = await fixture(false, true, false, false, false, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.run({ kind: "task-dispatch-review", taskIds: [taskId] })).outcome, "applied");
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const reviewId = `review-${dispatch.payload.dispatchId}`,
      consentOf = () => f.run({ kind: "task-review-consent", taskId, executionId, reviewId });
    assert.equal((await f.review(dispatch.payload.runtimeSessionId, reviewId)).outcome, "applied");
    // The approved verdict alone is not the confirmation: the reviewer is still running.
    assert.equal(((await consentOf()) as Receipt).code, "review_dispatch_unsettled");
    assert.equal(
      await f.settleReview(dispatch.payload.dispatchId, dispatch.payload.runtimeSessionId, "Reviewed."),
      "succeeded",
    );
    const consented = await consentOf();
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
  } finally {
    await f.close();
  }
});

// An owner can return a current cut before any reviewer has recorded a verdict. The owner reason is
// the worker's continuation context, and the existing rework dispatch path still launches it.
test("an owner returns an unreviewed cut to implementation", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    const submitted = await f.submit();
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });

    // An owner may return any current cut, including an approved but unconsented one.
    const launchesBefore = f.launches.length,
      unconsented = (await f.run({ kind: "task-rework", taskId, reason: "CI is red." })) as Receipt;
    assert.equal(unconsented.outcome, "applied", JSON.stringify(unconsented));
    assert.equal(f.launches.length, launchesBefore + 1, "an owner return dispatches the worker");
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    assert.match(f.launches.at(-1)!.prompt, /CI is red/u);

    const returnEvent = f
      .events()
      .filter((event) => event.type === "submission_returned")
      .at(-1);
    assert.ok(returnEvent?.type === "submission_returned");
    assert.equal(returnEvent.payload.reviewId, undefined);
    assert.equal(returnEvent.payload.reason, "CI is red.");
  } finally {
    await f.close();
  }
});

test("an owner rework with no provider session falls back to a fresh worker dispatch", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false, autoProviderSession: true });
  try {
    await f.install();
    const worker = await f.cell().spawnRuntime(
      {
        agentId: "closeout-reviewer",
        role: "worker",
        taskId,
        dispatchKey: "task-rework-missing-provider-session-worker",
        prompt: "Implement the first cut.",
      },
      owner,
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    const source = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.dispatchKey === "task-rework-missing-provider-session-worker",
      );
    assert.ok(source?.type === "runtime_dispatch_requested");
    assert.equal(source.payload.role, "worker");
    const sourceCwd = path.resolve(f.launches.at(-1)!.cwd);
    await f.waitForProviderBinding(source.payload.dispatchId, "review-provider-session");
    assert.equal(readDispatchStream(f.root, source.payload.dispatchId)?.providerSessionId, "review-provider-session");

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
    const reviewer = f
      .events()
      .find((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
    assert.ok(reviewer?.type === "runtime_dispatch_requested");
    const reviewed = await f.review(reviewer.payload.runtimeSessionId, "review-missing-provider-session-approved");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    await settleReviewerDispatch(f);
    assert.equal((await f.consent("review-missing-provider-session-approved")).outcome, "applied");
    await f.reopen();
    const sourceStreamPath = dispatchStreamPath(f.root, source.payload.dispatchId),
      sourceStream = readFileSync(sourceStreamPath, "utf8")
        .split("\n")
        .filter((line) => !line.includes('"kind":"provider_binding"'))
        .join("\n");
    writeFileSync(sourceStreamPath, sourceStream);
    assert.equal(readDispatchStream(f.root, source.payload.dispatchId)?.providerSessionId, null);

    const returned = (await f.run({ kind: "task-rework", taskId, reason: "Pre-merge CI is red." })) as Receipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const continuation = returned.continuation as Receipt | undefined;
    assert.equal(continuation?.outcome, "applied", JSON.stringify(returned));
    assert.equal(continuation?.mode, "fresh", JSON.stringify(returned));

    const dispatches = f
      .events()
      .filter(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role !== "reviewer",
      );
    assert.equal(dispatches.length, 2, JSON.stringify(dispatches));
    const fresh = dispatches.at(-1)!;
    assert.equal(fresh.type, "runtime_dispatch_requested");
    assert.equal(fresh.payload.resumedFromDispatchId, undefined, "fallback must be a new dispatch");
    assert.equal(fresh.payload.agentId, source.payload.agentId, "fallback keeps the submitting worker identity");
    assert.equal(readDispatchStream(f.root, fresh.payload.dispatchId)?.providerSessionId, null);
    assert.match(f.launches.at(-1)!.prompt, /# Owner return/u);
    assert.match(f.launches.at(-1)!.prompt, /Pre-merge CI is red/u);
    assert.match(f.launches.at(-1)!.prompt, /# Previous submitted conclusion/u);
    assert.equal(path.resolve(f.launches.at(-1)!.cwd), sourceCwd, "fallback keeps the submitting worker worktree");
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
  } finally {
    await f.close();
  }
});

test("a worker resubmission after consented CI rework dispatches the next reviewer", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    await f.install();
    const first = (await f.submit()) as Receipt;
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    const reviewed = await f.review(runtimeSessionId(first), "review-round-one");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    await settleReviewerDispatch(f);
    assert.equal((await f.consent("review-round-one")).outcome, "applied");

    const returned = (await f.run({ kind: "task-rework", taskId, reason: "CI is red." })) as Receipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const workerDispatch = f
      .events()
      .filter(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role !== "reviewer",
      )
      .at(-1);
    assert.ok(workerDispatch?.type === "runtime_dispatch_requested");
    const shown = (await f.run({ kind: "task-show", taskId })) as Receipt,
      snapshot = JSON.parse(String(shown.evidence)) as { executions: { executionId: string; state: string }[] },
      next = snapshot.executions.find((execution) => execution.state === "active");
    assert.ok(next, JSON.stringify(snapshot));
    const worker = withPolicyGroup(
      {
        actor: {
          principal: owner.actor.principal,
          executor: { kind: "agent" as const, id: `runtime-session:${workerDispatch.payload.runtimeSessionId}` },
        },
        source: "local" as const,
      },
      "contributor",
    );
    const submitted = (await f
      .cell()
      .run({ kind: "task-submit", taskId, executionId: next.executionId }, worker)) as Receipt;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const reviewDispatches = f
      .events()
      .filter((event) => event.type === "runtime_dispatch_requested" && event.payload.role === "reviewer");
    assert.ok(
      reviewDispatches.some(
        (event) => event.type === "runtime_dispatch_requested" && event.payload.executionId === next.executionId,
      ),
      "the resubmitted round dispatches a reviewer for its new execution",
    );
  } finally {
    await f.close();
  }
});
