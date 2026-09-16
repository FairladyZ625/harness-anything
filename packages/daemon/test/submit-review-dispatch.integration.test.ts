// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { waitForFixturePublication } from "./repo-settings.fixture.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

test(
  "a submit under a review-disabled closeout profile freezes no dispatch and never launches a reviewer",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { closeoutProfile: "standard" });
    try {
      await f.install();
      assert.equal(f.launches.length, 0, "review-disabled profiles must not dispatch at submit");
      assert.equal(
        f.events().filter((event) => event.type === "runtime_dispatch_requested").length,
        0,
        "no reviewer dispatch event may be recorded for a review-disabled cut",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "a failed review dispatch leaves the accepted submission submitted and stays retryable from complete",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      f.disableInstances();
      const submitted = (await f.submit()) as Record<string, unknown>;
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      const reviewStep = ((submitted.steps as Record<string, unknown>[] | undefined) ?? []).find(
        (step) => step.code === "review_missing",
      );
      assert.ok(reviewStep, `the failed dispatch must surface as a step: ${JSON.stringify(submitted)}`);
      assert.equal(f.launches.length, 0);
      assert.equal(
        f.events().filter((event) => event.type === "execution_submitted").length,
        1,
        "the accepted submission is recorded even though the review dispatch failed",
      );
      const completed = await f.complete();
      assert.equal(completed.code, "review_missing", JSON.stringify(completed));
      assert.equal(f.launches.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "an amended submission is a new cut: submit dispatches a fresh reviewer under the same frozen declaration",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, undefined, { autoSubmit: false });
    try {
      await f.install();
      await f.submit();
      assert.equal(f.launches.length, 1);
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
      assert.equal(f.launches.length, 2, "the amended cut owns its own review dispatch");
      const dispatches = f
        .events()
        .filter(
          (event) =>
            event.type === "runtime_dispatch_requested" && !event.payload.idempotencyKey.includes(":fallback:"),
        );
      assert.equal(dispatches.length, 2);
      assert.notEqual(
        dispatches[0]!.payload.idempotencyKey,
        dispatches[1]!.payload.idempotencyKey,
        "each submitted cut gets its own dispatch attempt",
      );
    } finally {
      await f.close();
    }
  },
);
