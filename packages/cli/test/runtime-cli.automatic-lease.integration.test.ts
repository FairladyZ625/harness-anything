// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import { run, runMaybe, published } from "./runtime-cli.commands.fixture.ts";
import { createRuntimeFixture } from "./runtime-cli.setup.fixture.ts";

test("Task dispatch rejects an incomplete plan then automatically acquires its lease", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const taskId = "task-runtime-automatic-lease";
  const automaticTaskId = `${taskId}-automatic`;
  const automaticTask = run(root, env, [
    "task",
    "create",
    "--id",
    automaticTaskId,
    "--admin",
    "--title",
    "Automatic lease",
  ]);
  const automaticPackagePath = String(automaticTask.packagePath),
    automaticPlanPath = `${automaticPackagePath}/task_plan.md`,
    oneSectionMissing = realizedPlan("Automatic lease").replace(
      /\n\n## CI\/Gate Authority Stop Condition\n\n[^\n]+/u,
      "",
    );
  published(root, env, automaticTask);
  writeFileSync(path.join(root, "harness", automaticPlanPath), oneSectionMissing);
  const automaticArgs = [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "must acquire its lease",
      "--task",
      automaticTaskId,
      "--detach",
    ],
    placeholderLease = runMaybe(root, env, automaticArgs);
  assert.equal(placeholderLease.status, 1);
  assert.equal(placeholderLease.receipt.code, "plan_placeholder");
  assert.deepEqual(placeholderLease.receipt.diagnostic, {
    kind: "missing-sections",
    documentPath: automaticPlanPath,
    diskDiffers: true,
    missingSections: [{ section: "CI/Gate Authority Stop Condition", reason: "empty" }],
  });
  writeFileSync(path.join(root, "harness", automaticPackagePath, "task_plan.md"), realizedPlan("Automatic lease"));
  const automaticPlanSync = run(root, env, ["doc", "sync", "--submit", "--path", automaticPlanPath]);
  const automaticLease = runMaybe(root, env, automaticArgs);
  assert.equal(automaticLease.status, 0, JSON.stringify(automaticLease));
  assert.equal(automaticLease.receipt.outcome, "running");
  assert.equal(typeof automaticLease.receipt.dispatchId, "string");
  context.diagnostic(
    `revision-aware plan hint: ${JSON.stringify({
      before: {
        outcome: placeholderLease.receipt.outcome,
        code: placeholderLease.receipt.code,
        diagnostic: placeholderLease.receipt.diagnostic,
      },
      sync: { outcome: automaticPlanSync.outcome, summary: automaticPlanSync.summary },
      after: {
        outcome: automaticLease.receipt.outcome,
        dispatchId: automaticLease.receipt.dispatchId,
      },
    })}`,
  );
  // This case owns the detached session and settles it before its daemon is torn down.
  run(root, env, ["runtime", "status", String(automaticLease.receipt.runtimeSessionId), "--wait", "--no-stream"]);
});
