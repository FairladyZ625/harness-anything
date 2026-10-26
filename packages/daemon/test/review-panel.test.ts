// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewSeat } from "../src/review-panel.ts";

test("a cut seats one default reviewer from the repository setting", () => {
  assert.deepEqual(selectReviewSeat({ repositoryDefault: "closeout-reviewer" }), {
    kind: "seat",
    seat: { reviewerId: "closeout-reviewer", source: "settings" },
  });
  assert.deepEqual(selectReviewSeat({}), {
    kind: "seat",
    seat: { reviewerId: "closeout-reviewer", source: "bundled" },
  });
});

test("a professional path rule replaces the default seat instead of adding one", () => {
  assert.deepEqual(
    selectReviewSeat({
      repositoryDefault: "closeout-reviewer",
      frozenReviewer: "closeout-reviewer",
      pathReviewers: [{ agentId: "data-migration", paths: ["packages/kernel/src/store/schema.ts"] }],
    }),
    {
      kind: "seat",
      seat: {
        reviewerId: "data-migration",
        source: "path",
        matchedPaths: ["packages/kernel/src/store/schema.ts"],
      },
    },
  );
});

test("an explicit argument and a task reviewer outrank the professional path seat", () => {
  const pathReviewers = [{ agentId: "data-migration", paths: ["packages/kernel/src/store/schema.ts"] }];
  assert.deepEqual(selectReviewSeat({ argument: "reviewer-a", pathReviewers }), {
    kind: "seat",
    seat: { reviewerId: "reviewer-a", source: "argument" },
  });
  assert.deepEqual(selectReviewSeat({ taskReviewer: "reviewer-b", pathReviewers }), {
    kind: "seat",
    seat: { reviewerId: "reviewer-b", source: "task" },
  });
});

test("two professional rules on one cut escalate instead of silently dropping one reviewer", () => {
  const selection = selectReviewSeat({
    pathReviewers: [
      { agentId: "gui-acceptance-reviewer", paths: ["packages/gui/src/a.ts"] },
      { agentId: "data-migration", paths: ["packages/kernel/src/store/schema.ts"] },
    ],
  });
  assert.equal(selection.kind, "escalated");
  assert.deepEqual(selection.kind === "escalated" ? selection.reviewers : [], [
    "data-migration",
    "gui-acceptance-reviewer",
  ]);
  assert.match(selection.kind === "escalated" ? selection.reason : "", /professional path reviewers/u);
  assert.match(selection.kind === "escalated" ? selection.reason : "", /one seat/u);
});

test("the frozen reviewer claim beats the repository default for an unfrozen override", () => {
  assert.deepEqual(selectReviewSeat({ frozenReviewer: "frozen-reviewer", repositoryDefault: "default-reviewer" }), {
    kind: "seat",
    seat: { reviewerId: "frozen-reviewer", source: "frozen" },
  });
});
