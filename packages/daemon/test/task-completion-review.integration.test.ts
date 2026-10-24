// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

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
  const f = await fixture(false, true, false, false, false, undefined, {
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

test("a low declaration raised to high freezes the assessed tier, consent, and configured GUI acceptance", async () => {
  const f = await fixture(false, true, true, false, false, undefined, {
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
        lowGuiAcceptance: true,
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
    assert.equal(assessment.guiAcceptanceRequired, true);
    assert.ok(submission.completionContract.gates.some((gate) => gate.gateId === "gui-acceptance"));
    assert.match(assessment.reasons.join("\n"), /fixture high floor/u);
    console.info(`SUBMISSION_RISK_TIER_ASSESSMENT ${JSON.stringify(assessment)}`);
  } finally {
    await f.close();
  }
});

test("medium tier preserves the repository's resolved consent gate", async () => {
  const f = await fixture(false, true, true, false, false, undefined, {
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
  const f = await fixture(false, true, false, false, false, undefined, {
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
    // The deadloop's other end: dispatch-review advises the forward order, so that order must work.
    const advised = (await f.run({ kind: "task-dispatch-review", taskIds: [taskId] })) as Receipt;
    assert.equal(advised.outcome, "op_rejected", JSON.stringify(advised));
    assert.match(
      String(advised.rejectionExplanation),
      /ha task adjudicate [^;]+ --forward/u,
      "the triage advice still names the forward order",
    );
    const forwarded = await f.forward();
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });
    assert.equal(f.launches.length, 1, "the forward order dispatches exactly one reviewer");
    // The upgrade is real: until the verdict lands, completion owes its review.
    const early = (await f.complete()) as Receipt;
    assert.equal(early.outcome, "op_rejected", JSON.stringify(early));
    assert.equal(early.code, "review_missing", JSON.stringify(early));
    assert.match(String(early.rejectionExplanation), /no recorded review/u);
    const reviewed = await f.review(runtimeSessionId(forwarded), "review-lightweight-upgrade");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    // Consent stays lifted with the profile: the approved verdict is the only added requirement.
    const completed = (await f.complete()) as Receipt;
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    assert.equal((await taskStatus(f)).status, "done");
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

    // A mistaken forward on the already-reviewed cut is refused before the write queue (2026-09-28
    // defect: it waited minutes behind a stalled publication) and names the same-cut return order.
    const mistaken = (await f.run({
      kind: "task-adjudicate",
      taskId,
      forward: true,
      reason: "Owner mistakenly re-forwards the reviewed cut.",
    })) as Receipt;
    assert.equal(mistaken.outcome, "op_rejected", JSON.stringify(mistaken));
    assert.equal(mistaken.code, "invalid_transition", JSON.stringify(mistaken));
    assert.match(String(mistaken.rejectionExplanation), /already in review after submit/u);
    assert.deepEqual(mistaken.nextActions, [
      'ha task adjudicate task-completion-review --forward --reviewer <agent> --note "<why>"',
      'ha task adjudicate task-completion-review --return --review-id review-changes-requested --note "<the owner\'s rework instruction>"',
    ]);
    assert.equal(f.launches.length, 1, "the refused forward dispatches no new reviewer");
    assert.deepEqual(await taskStatus(f), { status: "in_review", iteration: 0 });

    const returned = await f.returnCut("Revise the evidence and resubmit.", "review-changes-requested");
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    assert.deepEqual(await taskStatus(f), { status: "active", iteration: 1 });
    assert.equal(f.launches.length, 1, "the reviewer verdict must not dispatch implementation work");
  } finally {
    await f.close();
  }
});

test("manual review return succeeds even after reaching the review return budget", async () => {
  const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false, autoForward: false });
  try {
    await f.install();
    const dispatchReview = async (roundExecutionId: string, reviewId: string) => {
      const dispatch = f
        .events()
        .filter((event) => event.type === "runtime_dispatch_requested")
        .at(-1);
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      const reviewed = await recordReview(
        f,
        dispatch.payload.runtimeSessionId,
        reviewId,
        "changes_requested",
        roundExecutionId,
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const returned = await f.run({
        kind: "task-adjudicate",
        taskId,
        executionId: roundExecutionId,
        return: true,
        workerMode: "none",
        reviewId,
        reason: `Revise round ${roundExecutionId}.`,
      });
      assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    };
    // Submit dispatches each round's reviewer automatically; only the returns stay manual.
    assert.equal((await f.submit()).outcome, "applied");
    await dispatchReview(executionId, "review-budget-1");
    for (const [index, roundExecutionId] of ["execution-review-budget-2", "execution-review-budget-3"].entries()) {
      assert.equal((await f.run({ kind: "task-start", taskId, executionId: roundExecutionId })).outcome, "applied");
      assert.equal((await f.run({ kind: "task-submit", taskId, executionId: roundExecutionId })).outcome, "applied");
      await dispatchReview(roundExecutionId, `review-budget-${index + 2}`);
    }
    assert.equal(f.events().filter((event) => event.type === "submission_returned").length, 3);
  } finally {
    await f.close();
  }
});

test("concurrent owner rulings and completions have one state-transition winner", async () => {
  const f = await fixture(false, true, false, false, false, undefined, {
    autoSubmit: false,
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
    await settleReviewerDispatch(f);
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

test.skip("sibling complete refuses unfinished sources and missing facts, then closes B without execution or duplicate review", async () => {
  const f = await fixture(false, true, true, false, false, undefined, { autoForward: false });
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
    const forwarded = await f.forward();
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
  const f = await fixture(false, true, true, false, false, undefined, {
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
  const f = await fixture(false, true, false, false, false, undefined, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.forward()).outcome, "applied");
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    // The independent lane's approved verdict lands while the dispatched functional re-review runs.
    const approved = await recordReview(f, "migration-reviewer", "review-migration-approved", "approved");
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
  const f = await fixture(false, true, false, false, false, undefined, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.forward()).outcome, "applied");
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
  const f = await fixture(false, true, false, false, false, undefined, {
    closeoutProfile: "standard",
  });
  try {
    await f.install();
    assert.equal((await f.forward()).outcome, "applied");
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
