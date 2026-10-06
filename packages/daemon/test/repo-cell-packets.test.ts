// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskSubmitExplainerReminder } from "../src/repo-cell-packets.ts";

test("task submit receipt reminds explainer authors except for lightweight tasks", () => {
  assert.match(taskSubmitExplainerReminder("baseline"), /update artifacts\/explainer\.html/u);
  assert.match(taskSubmitExplainerReminder(undefined), /authoring comments/u);
  assert.equal(taskSubmitExplainerReminder("lightweight"), "");
});
