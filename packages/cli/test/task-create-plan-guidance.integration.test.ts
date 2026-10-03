// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { createRuntimeFixture, published, run, runMaybe } from "./runtime-cli.fixtures.ts";

test("CLI plan-file rejection directs repair to its input and the same create succeeds after repair", (context) => {
  const { root, env } = createRuntimeFixture(context),
    taskId = "task_cli_plan_guidance",
    source = "plans/input.md",
    plan = realizedTaskPlan("CLI input repair"),
    args = ["task", "create", "--id", taskId, "--admin", "--title", "CLI input repair", "--plan-file", source];
  mkdirSync(path.join(root, "plans"));
  writeFileSync(path.join(root, source), plan.replace(/\n\n## Verification\n\n[^\n]+/u, ""));
  const rejected = runMaybe(root, env, args);
  assert.equal(rejected.status, 1);
  assert.equal(rejected.receipt.code, "plan_placeholder");
  const rendered = renderCliReceipt(rejected.receipt).text;
  assert.match(rendered, /Edit plans\/input.md, then rerun ha task create/u);
  assert.match(rendered, /Verification/u);
  assert.doesNotMatch(rendered, /ha doc sync|Edit harness\/tasks/u);
  assert.equal(runMaybe(root, env, ["task", "show", taskId]).status, 1);
  writeFileSync(path.join(root, source), plan);
  const created = run(root, env, args);
  published(root, env, created);
  const graph = run(root, env, ["graph", taskId, "--depth", "1"]);
  assert.equal(graph.ok, true);
  const badDepth = runMaybe(root, env, ["graph", taskId, "--depth", "17"]);
  assert.equal(badDepth.status, 2);
  assert.equal(badDepth.receipt.code, "invalid_field");
  const review = runMaybe(root, env, [
    "task",
    "review-execution",
    taskId,
    "--review-id",
    "review-invalid-fields",
    "--json-input",
    JSON.stringify({ schema: "review/v1", verdict: "approved", reason: "Checked input.", evidenceChecked: [source] }),
  ]);
  assert.equal(review.status, 1);
  assert.equal(review.receipt.code, "invalid_command");
  assert.match(renderCliReceipt(review.receipt).text, /Review JSON requires exactly/u);
  context.diagnostic(JSON.stringify({ rejected: rejected.receipt, created, graph, review: review.receipt }));
});
