// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { submissionDigest, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-credential.ts";
import { executionId, fixture, owner, reviewerExecutionBinding, taskId } from "./task-completion-review.fixture.ts";

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
        assert.equal(
          path.resolve(f.launches[0]!.cwd),
          path.resolve(f.root, "harness", f.packagePath),
          "a task-package reviewer without a detached worktree runs in its canonical package",
        );
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
  "settlement rejects an approved packet when every local command fails before recovery",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
    });
    try {
      await f.install();
      await f.submit();
      const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(dispatch?.type === "runtime_dispatch_requested");
      const { dispatchId, runtimeSessionId } = dispatch.payload,
        snapshotCwd = readDispatchStream(f.root, dispatchId)?.header.cwd,
        report = f.reportPath(dispatchId),
        packet = report.replace(/\.md$/u, ".json");
      assert.ok(snapshotCwd, "review dispatch must record its immutable snapshot cwd");
      assert.equal(existsSync(snapshotCwd), true, "the snapshot exists while the reviewer is running");
      mkdirSync(path.dirname(report), { recursive: true });
      writeFileSync(report, "# Review\n\nApproved packet without successful local evidence.\n");
      writeFileSync(
        packet,
        JSON.stringify({
          verdict: "approved",
          reason: "The reviewer claims the submitted execution is acceptable.",
          evidenceChecked: ["submitted execution", "closeout.md"],
          findings: [],
        }),
      );

      assert.equal(
        f.events().filter((event) => event.type === "review_recorded").length,
        0,
        "the approved packet must not already be registered",
      );
      assert.equal(await f.settleReview(dispatchId, runtimeSessionId, "Report written.", null, 1), "failed");

      const terminal = f
        .events()
        .find(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        );
      assert.ok(terminal?.type === "runtime_session_outcome_observed");
      assert.equal(terminal.payload.outcome, "failed");
      assert.equal(terminal.payload.attempt?.classification, "gate_red");
      assert.equal(
        existsSync(snapshotCwd),
        false,
        `a non-provider failure terminal also reclaims the snapshot (cwd=${snapshotCwd}, root=${f.root})`,
      );
      assert.equal(
        f.events().filter((event) => event.type === "review_recorded").length,
        0,
        "an approved packet without successful local command evidence must never be persisted",
      );
    } finally {
      await f.close();
    }
  },
);

test("consent settles a failed reviewer predecessor whose canonical successor belongs to another cut", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "standard",
    providerRoundBackoffBaseSeconds: 300,
  });
  try {
    await f.install();
    await f.submit();
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const { dispatchId, runtimeSessionId } = dispatch.payload,
      reviewId = `review-${dispatchId}`;
    assert.equal((await f.review(runtimeSessionId, reviewId)).outcome, "applied");

    f.failPending();
    assert.equal(await f.awaitOutcome(runtimeSessionId), "failed");
    const terminal = f
      .events()
      .find(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
    assert.ok(terminal?.type === "runtime_session_outcome_observed");
    assert.equal(terminal.payload.attempt?.classification, "provider_quota");

    const submitted = f.events().find((event) => event.type === "execution_submitted");
    assert.ok(submitted?.type === "execution_submitted" && submitted.payload.execution.submission);
    const otherCutDigest = submissionDigest({
      ...submitted.payload.execution.submission,
      commitSha: "f".repeat(40),
    });
    assert.notEqual(otherCutDigest, dispatch.payload.reviewTarget?.digest);
    const successor = await appendCanonicalReviewSuccessor(f, dispatch, otherCutDigest, "other-cut");

    const rows = (await f.cell().read("repo.task.dispatches", { taskId })).dispatches,
      predecessor = rows.find((row) => row.dispatchId === dispatchId);
    assert.equal(predecessor?.fallbackState, "dispatched");
    assert.equal(predecessor?.nextDispatchId, successor.dispatchId);
    assert.ok(rows.some((row) => row.dispatchId === successor.dispatchId));

    const consented = await f.consent(reviewId);
    assert.equal(consented.outcome, "applied", JSON.stringify(consented));
  } finally {
    await f.close();
  }
});

test("consent still waits for a queued reviewer fallback successor in the same cut", async () => {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    closeoutProfile: "standard",
    providerRoundBackoffBaseSeconds: 300,
  });
  try {
    await f.install();
    await f.submit();
    const dispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
    assert.ok(dispatch?.type === "runtime_dispatch_requested");
    const { dispatchId, runtimeSessionId } = dispatch.payload,
      reviewId = `review-${dispatchId}`,
      digest = dispatch.payload.reviewTarget?.digest;
    assert.ok(digest);
    assert.equal((await f.review(runtimeSessionId, reviewId)).outcome, "applied");

    f.failPending();
    assert.equal(await f.awaitOutcome(runtimeSessionId), "failed");
    const successor = await appendCanonicalReviewSuccessor(f, dispatch, digest, "same-cut"),
      rows = (await f.cell().read("repo.task.dispatches", { taskId })).dispatches,
      successorRow = rows.find((row) => row.dispatchId === successor.dispatchId);
    assert.equal(successorRow?.status, "unknown", "a projected dispatch without a session is still queued");
    assert.equal(
      (await f.consent(reviewId)).code,
      "review_dispatch_unsettled",
      "a real same-cut successor remains part of the consent gate",
    );
  } finally {
    await f.close();
  }
});

async function appendCanonicalReviewSuccessor(
  f: Awaited<ReturnType<typeof fixture>>,
  predecessor: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>,
  digest: `sha256:${string}`,
  label: string,
): Promise<{ readonly dispatchId: string }> {
  const dispatchKey = `task-review-consent-successor:${label}`,
    identity = createHash("sha256")
      .update(`${workspaceId("completion-review")}\0${dispatchKey}`)
      .digest("hex"),
    payload = {
      ...predecessor.payload,
      dispatchId: `dispatch_${identity.slice(0, 24)}`,
      runtimeSessionId: `runtime_${identity.slice(24, 48)}`,
      dispatchKey,
      attemptGroupId: predecessor.payload.attemptGroupId ?? predecessor.payload.dispatchId,
      attemptIndex: (predecessor.payload.attemptIndex ?? 0) + 1,
      reviewTarget: { ...predecessor.payload.reviewTarget!, digest },
    },
    receipt = await f.cell().runtimeIngress(
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: `op-review-successor-${label}`,
        payload,
      },
      owner,
    );
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  return { dispatchId: payload.dispatchId };
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
