// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { taskSubmitExplainerReminder } from "../src/repo-cell-packets.ts";

test("task submit receipt tells explainer authors to freeze the page except for lightweight tasks", () => {
  assert.match(taskSubmitExplainerReminder("baseline"), /在 artifacts\/explainer\.html 的 header 写下结论并冻结该页/u);
  assert.match(taskSubmitExplainerReminder(undefined), /冻结/u);
  assert.equal(taskSubmitExplainerReminder("lightweight"), "");
});
