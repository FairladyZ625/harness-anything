// harness-test-tier: integration
import assert from "node:assert/strict";
import { test } from "node:test";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { fixture, owner } from "./task-completion-review.fixture.ts";

test(
  "provider fallback rebinds the task review prompt and registers under the successor dispatch",
  { timeout: 30_000 },
  async () => {
    const f = await fixture(1, true, false, false, false, undefined, {
      autoSubmit: false,
      closeoutProfile: "standard",
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerRoundBackoffBaseSeconds: 0,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      assert.equal((await f.forward()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");
      const firstStream = readDispatchStream(f.root, firstDispatch.payload.dispatchId);
      assert.ok(
        firstStream?.header.fallbackAttempt,
        `first dispatch has no provider fallback chain: ${JSON.stringify(firstStream?.header)}`,
      );
      assert.deepEqual(
        firstStream.header.fallbackAttempt.candidates.map(({ instance }) => instance),
        ["review-first", "review-second"],
      );
      await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId));
      const settledStream = readDispatchStream(f.root, firstDispatch.payload.dispatchId);
      assert.equal(settledStream?.attemptOutcome?.classification, "provider_quota", JSON.stringify(settledStream));
      assert.equal(settledStream?.fallbackState, "scheduled", JSON.stringify(settledStream));
      await f.waitForLaunches(2);

      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested"),
        first = attempts[0]?.payload,
        successor = attempts[1]?.payload,
        prompt = f.launches[1]?.prompt ?? "";
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      assert.ok(first && successor);
      assert.deepEqual(
        f.launches.map(({ instanceId }) => instanceId),
        ["review-first", "review-second"],
        "the second dispatch must be the provider fallback attempt",
      );
      assert.notEqual(successor.dispatchId, first.dispatchId);
      assert.ok(
        prompt.includes(`review-${successor.dispatchId}`),
        "review id must belong to the actual fallback dispatch",
      );
      assert.ok(
        prompt.includes(`${f.packagePath}/artifacts/reports/${successor.dispatchId}.json`),
        "review packet path must belong to the actual fallback dispatch",
      );
      assert.ok(
        prompt.includes(`${f.packagePath}/artifacts/reports/${successor.dispatchId}.md`),
        "review report path must belong to the actual fallback dispatch",
      );
      assert.equal(
        prompt.includes(`review-${first.dispatchId}`),
        false,
        "the old review id must not remain in the prompt",
      );
      assert.equal(
        prompt.includes(`${f.packagePath}/artifacts/reports/${first.dispatchId}.json`),
        false,
        "the old review packet path must not remain in the prompt",
      );
      assert.equal(
        prompt.includes(`${f.packagePath}/artifacts/reports/${first.dispatchId}.md`),
        false,
        "the old review report path must not remain in the prompt",
      );

      const reviewed = await f.reviewDispatchedArtifacts(
        String(successor.runtimeSessionId),
        String(successor.dispatchId),
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      const review = f.events().find((event) => event.type === "review_recorded");
      assert.ok(review?.type === "review_recorded");
      assert.equal(review.payload.review.reviewId, `review-${successor.dispatchId}`);
      assert.ok(
        review.payload.carriedDocumentClaims?.some(
          (claim) => claim.path === `${f.packagePath}/artifacts/reports/${successor.dispatchId}.md`,
        ),
        "the registered report must be the successor dispatch's report",
      );
    } finally {
      await f.close();
    }
  },
);
