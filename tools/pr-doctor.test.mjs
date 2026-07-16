// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { recentDequeueEvents } from "./pr-doctor.mjs";

test("pr doctor reports GitHub transport faults separately from dequeue events", () => {
  const result = recentDequeueEvents("owner/repo", [{
    number: 42,
    headRefName: "feature",
    headRefOid: "abc123"
  }], () => {
    throw new Error("gh api failed: EOF");
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.transportFailures, ["#42 feature: unable to read check-runs (gh api failed: EOF)"]);
});

test("pr doctor keeps confirmed dequeue check-runs in the dequeue event stream", () => {
  const result = recentDequeueEvents("owner/repo", [{
    number: 43,
    headRefName: "feature-two",
    headRefOid: "def456"
  }], () => [{
    name: "Mergify Queue Summary",
    output: { title: "Pull request dequeued", summary: "required check failed" }
  }]);

  assert.deepEqual(result.events, ["#43 Mergify Queue Summary: Pull request dequeued"]);
  assert.deepEqual(result.transportFailures, []);
});
