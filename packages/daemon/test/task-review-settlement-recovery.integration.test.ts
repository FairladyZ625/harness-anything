// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { submissionDigest } from "@harness-anything/kernel";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-credential.ts";
import { executionId, fixture, reviewerExecutionBinding, taskId } from "./task-completion-review.fixture.ts";

for (const registeredByWorker of [true, false]) {
  test(
    registeredByWorker
      ? "an explicitly registered review remains the terminal settlement control"
      : "settlement records a dispatch report through the real Review action before publishing success",
    { timeout: 20_000 },
    async () => {
      const f = await fixture(false, true, false, false, false, {
        autoSubmit: false,
        closeoutProfile: "standard",
      });
      try {
        await f.install();
        await f.submit();
        const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
        assert.ok(dispatch?.type === "runtime_dispatch_requested");
        const { dispatchId, runtimeSessionId } = dispatch.payload,
          reviewId = `review-${dispatchId}`,
          packet = `${f.packagePath}/artifacts/reports/${dispatchId}.json`,
          report = f.reportPath(dispatchId);
        mkdirSync(path.dirname(report), { recursive: true });
        writeFileSync(report, "# Review\n\nVerified the submitted execution and its frozen evidence.\n");
        writeFileSync(
          path.join(f.root, "harness", packet),
          JSON.stringify({
            verdict: "approved",
            reason: "Verified the submitted execution and its frozen evidence.",
            evidenceChecked: ["submitted execution", "closeout.md"],
            findings: [],
          }),
        );
        if (registeredByWorker) {
          const binding = reviewerExecutionBinding(runtimeSessionId, dispatchId),
            executionPrincipal = await readRuntimeExecutionPrincipal(
              await binding.keycloakAuthorization.center(),
              dispatchId,
            );
          const registered = await f
            .cell()
            .run(
              { kind: "task-review-execution", taskId, executionId, reviewId, fromFile: `harness/${packet}` },
              { ...binding, executionPrincipal },
            );
          assert.equal(registered.outcome, "applied", JSON.stringify(registered));
        }
        assert.equal(
          f.events().filter((event) => event.type === "review_recorded").length,
          registeredByWorker ? 1 : 0,
          "the recovery case must begin with physical artifacts and no registered Review",
        );

        const outcome = await f.settleReview(dispatchId, runtimeSessionId, "Report written.");
        const terminal = f
          .events()
          .find(
            (event) =>
              event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
          );
        assert.ok(terminal?.type === "runtime_session_outcome_observed");
        assert.equal(outcome, "succeeded", JSON.stringify(terminal.payload));
        const records = f.events().filter((event) => event.type === "review_recorded");
        assert.equal(records.length, 1, "settlement must produce one real Review, including when already registered");
        const recorded = records[0]!;
        assert.equal(recorded.payload.review.reviewId, reviewId);
        assert.equal(recorded.payload.review.taskId, taskId);
        assert.equal(recorded.payload.review.executionId, executionId);
        assert.equal(recorded.payload.review.actor.executor?.id, `runtime-session:${runtimeSessionId}`);
        assert.deepEqual(recorded.payload.review.actor.principal, dispatch.actor.principal);
        const submitted = f.events().find((event) => event.type === "execution_submitted");
        assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
        assert.equal(
          recorded.payload.review.submissionDigest,
          submissionDigest(submitted.payload.execution.submission),
        );
        assert.ok(
          recorded.workspaceRevision < terminal.workspaceRevision,
          "Review acceptance precedes terminal success",
        );
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "settlement cannot take reviewer identity from an artifact's self-reported actor",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, { autoSubmit: false, closeoutProfile: "standard" });
    try {
      await f.install();
      await f.submit();
      const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      const { dispatchId, runtimeSessionId } = dispatch.payload,
        report = f.reportPath(dispatchId);
      mkdirSync(path.dirname(report), { recursive: true });
      writeFileSync(report, "# Review\n\nReport with a self-reported actor.\n");
      writeFileSync(
        report.replace(/\.md$/u, ".json"),
        JSON.stringify({
          verdict: "approved",
          reason: "An artifact cannot nominate its own reviewer identity.",
          evidenceChecked: ["submitted execution"],
          findings: [],
          resolutions: [],
          actor: { principal: { personId: "another-person" }, executor: null },
        }),
      );
      assert.equal(await f.settleReview(dispatchId, runtimeSessionId, "Report written."), "failed");
      assert.equal(f.events().filter((event) => event.type === "review_recorded").length, 0);
    } finally {
      await f.close();
    }
  },
);
