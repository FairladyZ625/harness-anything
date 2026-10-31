// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectReviewSeat } from "../src/review-panel.ts";

// dec_6A77D43B8523823ABA1F5E4D3C CH1: one seat per cut, and the reasons it is that seat. These
// cases read the production selector directly — the retired `selectReviewAgent` adapter silently
// turned an escalated selection into the bundled reviewer, so a test that went through it could not
// see the escalation at all.
for (const [frozen, argument, setting, reviewerId, source] of [
  ["frozen-reviewer", "argument-reviewer", "setting-reviewer", "argument-reviewer", "argument"],
  ["frozen-reviewer", undefined, "setting-reviewer", "frozen-reviewer", "frozen"],
  [undefined, "argument-reviewer", "setting-reviewer", "argument-reviewer", "argument"],
  [undefined, undefined, "setting-reviewer", "setting-reviewer", "settings"],
  [undefined, undefined, undefined, "closeout-reviewer", "bundled"],
] as const) {
  test(`reviewer selection exposes ${source}`, () => {
    const selection = selectReviewSeat({ frozenReviewer: frozen, argument, repositoryDefault: setting });
    assert.equal(selection.kind, "seat");
    if (selection.kind !== "seat") return;
    assert.equal(selection.seat.reviewerId, reviewerId);
    assert.equal(selection.seat.source, source);
  });
}

test("a matched path reviewer replaces the default seat", () => {
  const selection = selectReviewSeat({
    repositoryDefault: "setting-reviewer",
    pathReviewers: [{ agentId: "data-migration", paths: ["packages/storage/src/store/"] }],
  });
  assert.equal(selection.kind, "seat");
  if (selection.kind !== "seat") return;
  assert.equal(selection.seat.reviewerId, "data-migration");
  assert.equal(selection.seat.source, "path");
  assert.deepEqual(selection.seat.matchedPaths, ["packages/storage/src/store/"]);
});

test("a cut matching two professional reviewers escalates instead of dropping one", () => {
  const selection = selectReviewSeat({
    repositoryDefault: "setting-reviewer",
    pathReviewers: [
      { agentId: "data-migration", paths: ["migrations/"] },
      { agentId: "gui-acceptance-reviewer", paths: ["packages/gui/"] },
    ],
  });
  assert.equal(selection.kind, "escalated");
  if (selection.kind !== "escalated") return;
  assert.deepEqual(selection.reviewers, ["data-migration", "gui-acceptance-reviewer"]);
});
