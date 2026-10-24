// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewAgent } from "../src/task-review-dispatch.ts";

for (const [frozen, argument, setting, reviewerId, reviewerSource] of [
  ["frozen-reviewer", "argument-reviewer", "setting-reviewer", "argument-reviewer", "argument"],
  ["frozen-reviewer", undefined, "setting-reviewer", "frozen-reviewer", "frozen"],
  [undefined, "argument-reviewer", "setting-reviewer", "argument-reviewer", "argument"],
  [undefined, undefined, "setting-reviewer", "setting-reviewer", "settings"],
  [undefined, undefined, undefined, "closeout-reviewer", "bundled"],
] as const) {
  test(`reviewer selection and CLI stdout expose ${reviewerSource}`, () => {
    const selection = selectReviewAgent(frozen, argument, setting);
    assert.deepEqual(selection, { reviewerId, reviewerSource });
  });
}
