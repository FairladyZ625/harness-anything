// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

test(
  "completion uses an installed override, reuses the cut dispatch after a lost response/reopen, and requires later owner consent",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const configured = await f.run({ kind: "settings-update", defaultReviewer: "selected-reviewer" });
      assert.equal(configured.outcome, "applied", JSON.stringify(configured));
      const selectedMissing = await f.complete();
      assert.equal(selectedMissing.code, "review_missing", JSON.stringify(selectedMissing));
      assert.match(JSON.stringify((selectedMissing as Record<string, unknown>).next), /selected-reviewer/u);
      assert.match(JSON.stringify((selectedMissing as Record<string, unknown>).next), /--default-reviewer/u);
      assert.equal(f.launches.length, 0);
      const restored = await f.run({ kind: "settings-update", defaultReviewer: "closeout-reviewer" });
      assert.equal(restored.outcome, "applied", JSON.stringify(restored));
      const first = (await f.complete(true)) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      assert.equal(f.launches.length, 1);
      assert.equal(f.launches[0]!.instanceId, "review-first");
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      assert.match(f.launches[0]!.prompt, /RecordReview/u);
      assert.match(f.launches[0]!.prompt, new RegExp(`artifacts/reports/${String(first.dispatchId)}`));
      // Provider has not exited: this independent queue write must nevertheless finish.
      const write = await f.run({
        kind: "fact-record",
        taskId,
        statement: "Queue accepts writes while reviewer runs.",
        evidenceSource: "test:pending-reviewer",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      });
      assert.equal(write.outcome, "applied", JSON.stringify(write));
      const retry = (await f.complete()) as Record<string, unknown>;
      assert.equal(retry.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 1);
      await f.reopen();
      const recovered = (await f.complete()) as Record<string, unknown>;
      assert.equal(recovered.dispatchId, first.dispatchId);
      assert.equal(recovered.runtimeSessionId, first.runtimeSessionId);
      assert.equal(f.launches.length, 1);
      assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 1);
      const reviewed = await f.review(String(first.runtimeSessionId), "review-current");
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const additional = await f.review(String(first.runtimeSessionId), "review-additional");
      assert.equal(additional.outcome, "applied", JSON.stringify(additional));
      const noConsent = await f.complete();
      assert.equal(noConsent.code, "consent_missing", JSON.stringify(noConsent));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 0);
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
      assert.equal(f.events().filter((event) => event.type === "review_consent_recorded").length, 1);
      const consent = f.events().find((event) => event.type === "review_consent_recorded");
      assert.ok(consent?.type === "review_consent_recorded");
      assert.equal(consent.payload.consent.reviewId, "review-additional");
      assert.equal(f.events().filter((event) => event.type === "task_completed").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("completion dispatches the bundled reviewer with no installed declaration and accepts its review", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0]!.instanceId, "ambient-first");
    assert.equal(f.launches[0]!.model, "flash-model");
    assert.match(f.launches[0]!.prompt, /Independently review the submitted execution/u);
    const reviewed = await f.review(String(result.runtimeSessionId), "review-bundled");
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const completed = await f.complete(true);
    assert.equal(completed.outcome, "applied", JSON.stringify(completed));
  } finally {
    await f.close();
  }
});

test("completion reviewer settlement keeps the report the reviewer authored at the dispatch report path", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    const dispatchId = String(result.dispatchId),
      authored = "# Closeout review\n\n- verdict: `approved`\n\nThe authored report, not the final message.\n";
    assert.equal(
      await f.settleReview(
        dispatchId,
        String(result.runtimeSessionId),
        "Independent review registered; report written to the dispatch report path.",
        authored,
      ),
      "succeeded",
    );
    assert.equal(readFileSync(f.reportPath(dispatchId), "utf8"), authored);
  } finally {
    await f.close();
  }
});

test("completion reviewer settlement archives the final message when no report was authored", async () => {
  const f = await fixture();
  try {
    const result = (await f.complete()) as Record<string, unknown>;
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.equal(
      await f.settleReview(
        String(result.dispatchId),
        String(result.runtimeSessionId),
        "# Independent review\n\nApproved.\n",
      ),
      "succeeded",
    );
  } finally {
    await f.close();
  }
});

test("bundled reviewer without a ready instance returns configuration guidance", async () => {
  const f = await fixture(false, false, false, true);
  try {
    f.disableInstances();
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /configured default model/u);
    assert.deepEqual(result.diagnostic, { kind: "failure", code: "agent_runtime_unavailable" });
    assert.equal(f.launches.length, 0);
  } finally {
    await f.close();
  }
});

test("completion requires a declared reviewer model instead of selecting the ambient default", async () => {
  const f = await fixture();
  try {
    // Omit model entirely, as in an unconstrained runtime_type=any declaration.
    const installed = await f.run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "closeout-reviewer",
        name: "Unconstrained reviewer",
        instructions: "Review the submitted delivery.",
        runtime_type: "any",
        instance: "ambient-first",
      },
    });
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /model/u);
    assert.equal(f.launches.length, 0, "an unconfigured reviewer must not launch the ambient model");
  } finally {
    await f.close();
  }
});

test(
  "an amended submitted cut rejects the old canonical reviewer and dispatches a fresh reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    try {
      await f.install();
      const first = (await f.complete()) as Record<string, unknown>;
      assert.equal(first.code, "review_missing", JSON.stringify(first));
      const closeoutPath = path.join(f.root, "harness", f.packagePath, "closeout.md");
      writeFileSync(
        closeoutPath,
        readFileSync(closeoutPath, "utf8").replace("Reviewed delivery ", "Amended reviewed delivery "),
      );
      let amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      for (let attempt = 0; amended.outcome === "pending" && attempt < 4; attempt += 1) {
        await waitForFixturePublication(f.cell(), amended.opId, owner);
        amended = await f.run({ kind: "task-submit", taskId, executionId, amend: true });
      }
      assert.equal(amended.outcome, "applied", JSON.stringify(amended));
      const stale = await f.review(String(first.runtimeSessionId), "review-stale");
      assert.equal(stale.code, "invalid_proof", JSON.stringify(stale));
      assert.match(stale.rejectionExplanation ?? "", /earlier submission cut/u);
      const second = (await f.complete()) as Record<string, unknown>;
      assert.equal(second.code, "review_missing", JSON.stringify(second));
      assert.notEqual(second.dispatchId, first.dispatchId);
      assert.equal(f.launches.length, 2);
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);
test("completion with an unavailable declared model returns guidance without launching an ambient instance", async () => {
  const f = await fixture(false, true);
  try {
    await f.install();
    f.disableInstances();
    const result = await f.complete();
    assert.equal(result.code, "review_missing", JSON.stringify(result));
    assert.match(JSON.stringify((result as Record<string, unknown>).next), /ready compatible instance/u);
    assert.deepEqual(result.diagnostic, { kind: "failure", code: "agent_model_unavailable" });
    assert.match(result.rejectionExplanation ?? "", /No enabled runtime instance declares model review-model/u);
    assert.equal(f.launches.length, 0);
    assert.equal(f.events().filter((event) => event.type === "runtime_dispatch_requested").length, 0);
  } finally {
    await f.close();
  }
});

test(
  "artifact delivery reaches the same independent review and completion after reopening",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, true);
    try {
      await f.install();
      await f.reopen();
      const artifactPath = path.join(f.root, "harness", f.packagePath, "artifacts/delivery.md");
      writeFileSync(artifactPath, "Latest replacement must not be reviewed.\n");
      const republished = await f.run({ kind: "doc-submit", taskId });
      if (republished.outcome === "pending") await waitForFixturePublication(f.cell(), republished.opId, owner);
      else assert.equal(republished.outcome, "applied", JSON.stringify(republished));
      const dispatched = await f.complete();
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1);
      assert.match(f.launches[0]!.prompt, /Frozen artifact evidence/u);
      assert.match(f.launches[0]!.prompt, /Effective completion gates: none/u);
      assert.match(f.launches[0]!.prompt, /artifact-only.*ci.*code-doc-reconciliation.*do not apply/u);
      assert.doesNotMatch(f.launches[0]!.prompt, /Honor every gate declared by the task/u);
      assert.doesNotMatch(f.launches[0]!.prompt, /Latest replacement must not be reviewed/u);
      const submittedShow = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        task: { completionGateIds: string[] };
      };
      assert.deepEqual(submittedShow.task.completionGateIds, []);
      const session = String((dispatched as unknown as Record<string, unknown>).runtimeSessionId);
      const reviewed = await f.review(session, "artifact-reviewed");
      if (reviewed.outcome === "pending") await waitForFixturePublication(f.cell(), reviewed.opId, owner);
      else assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const complete = await f.complete(true);
      assert.equal(complete.outcome, "applied", JSON.stringify(complete));
      const final = f
        .events()
        .filter((event) => event.type === "task_completed")
        .at(-1);
      assert.equal(final?.payload.task.status, "done");
      await f.reopen();
      const shown = await f.run({ kind: "task-show", taskId });
      assert.equal(JSON.parse(String(shown.evidence)).task.status, "done");
    } finally {
      await f.close();
    }
  },
);

test(
  "commit delivery with an artifact anchor carries both the commit and frozen report through review",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, true);
    try {
      await f.install();
      const dispatched = (await f.complete()) as Record<string, unknown>;
      assert.equal(dispatched.code, "review_missing", JSON.stringify(dispatched));
      assert.equal(f.launches.length, 1);
      const submitted = f
        .events()
        .filter((event) => event.type === "execution_submitted")
        .at(-1);
      assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
      const submission = submitted.payload.execution.submission;
      assert.match(submission.commitSha!, /^[0-9a-f]{40}$/u);
      assert.ok(submission.deliverables.includes("README.md"));
      assert.equal(submission.artifacts?.length, 1);
      assert.match(submission.outputs[0]!, /^Artifact-Anchor: .*hybrid\.md@[1-9][0-9]*$/u);
      assert.match(f.launches[0]!.prompt, /Frozen hybrid evidence/u);
      assert.match(f.launches[0]!.prompt, /Effective completion gates: code-doc-reconciliation/u);
      const shown = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        task: { completionGateIds: string[] };
      };
      assert.deepEqual(shown.task.completionGateIds, ["code-doc-reconciliation"]);
      const reviewed = await f.review(String(dispatched.runtimeSessionId), "hybrid-reviewed");
      if (reviewed.outcome === "pending") await waitForFixturePublication(f.cell(), reviewed.opId, owner);
      else assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const completed = await f.complete(true);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    } finally {
      await f.close();
    }
  },
);
