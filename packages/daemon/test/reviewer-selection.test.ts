// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewAgent } from "../src/task-review-dispatch.ts";
import { renderCliReceipt } from "../../cli/src/cli/receipt-render-registry.ts";

for (const [frozen, argument, setting, reviewerId, reviewerSource] of [
  ["frozen-reviewer", "argument-reviewer", "setting-reviewer", "frozen-reviewer", "frozen"],
  [undefined, "argument-reviewer", "setting-reviewer", "argument-reviewer", "argument"],
  [undefined, undefined, "setting-reviewer", "setting-reviewer", "settings"],
  [undefined, undefined, undefined, "closeout-reviewer", "bundled"],
] as const) {
  test(`reviewer selection and CLI stdout expose ${reviewerSource}`, () => {
    const selection = selectReviewAgent(frozen, argument, setting);
    assert.deepEqual(selection, { reviewerId, reviewerSource });
    const rendered = renderCliReceipt({ ok: true, command: "task-adjudicate", ...selection });
    assert.equal(rendered.stream, "stdout");
    assert.ok(rendered.text.includes(`reviewer: ${reviewerId} (source: ${reviewerSource})`));
  });
}

test("adjudicate stdout preserves committed state and the dispatch-only recovery instruction", () => {
  const recovery =
    "Task task-1 is already in_review. Recover with " +
    "ha task dispatch-review task-1 --agent specialist; do not repeat adjudicate.";
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-adjudicate",
    reviewerId: "specialist",
    reviewerSource: "argument",
    steps: [{ outcome: "op_rejected", code: "review_dispatch_failed", rejectionExplanation: recovery }],
  });
  assert.equal(rendered.stream, "stdout");
  assert.ok(rendered.text.includes(recovery));
});
