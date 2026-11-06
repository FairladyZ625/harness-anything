// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parsePremiseReview, premiseReviewCommand } from "../src/premise-review.ts";

const printedStatement = (taskId: string) => /--statement "(.*)"$/u.exec(premiseReviewCommand(taskId))![1]!;

test("the printed premise-review command, copied unedited, answers nothing", () => {
  assert.deepEqual(parsePremiseReview(printedStatement("task_demo")), {
    ok: false,
    missing: ["restart", "alternative", "sunk-cost", "conclusion"],
  });
});

test("a premise review needs real answers and exactly one conclusion word", () => {
  const answered = (conclusion: string) =>
    "restart: no, measure the attach pause first. alternative: schedule upgrades off-peak. " +
    `sunk-cost: twenty rounds, not a reason. conclusion: ${conclusion}`;
  assert.deepEqual(parsePremiseReview(answered("narrow")), { ok: true, conclusion: "narrow" });
  assert.deepEqual(parsePremiseReview(answered("Stop.")), { ok: true, conclusion: "stop" });
  for (const conclusion of ["continue|narrow|stop", "continue but narrow it", ""])
    assert.equal(parsePremiseReview(answered(conclusion)).ok, false, conclusion);
  assert.deepEqual(parsePremiseReview("restart: <yes> alternative: none sunk-cost: no conclusion: continue"), {
    ok: false,
    missing: ["restart"],
  });
});
