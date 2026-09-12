// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import { run, published } from "./runtime-cli.commands.fixture.ts";
import { eventuallyFile } from "./runtime-cli.observations.fixture.ts";
import { installIdentities, createRuntimeFixture } from "./runtime-cli.setup.fixture.ts";

test("Runtime report is archived after the worker submits its execution", async (context) => {
  const fixture = createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { root, env } = fixture;
  const taskId = "task-runtime-archive",
    executionId = "exec-runtime-archive";
  const submittedTaskId = `${taskId}-submitted`,
    submittedExecutionId = `${executionId}-submitted`,
    submittedTask = run(root, env, [
      "task",
      "create",
      "--id",
      submittedTaskId,
      "--admin",
      "--title",
      "Submitted runtime archive",
    ]),
    submittedPackagePath = String(submittedTask.packagePath),
    submittedPlanPath = `${submittedPackagePath}/task_plan.md`;
  published(root, env, submittedTask);
  writeFileSync(path.join(root, "harness", submittedPlanPath), realizedPlan("Submitted runtime archive"));
  run(root, env, ["doc", "sync", "--submit", "--path", submittedPlanPath]);
  run(root, env, ["task", "start", submittedTaskId, "--execution-id", submittedExecutionId]);
  // This standard task submits a public code cut bound to the runtime cwd.
  const deliveryGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  deliveryGit(["init", "-b", "main"]);
  deliveryGit(["config", "user.name", "Harness Test"]);
  deliveryGit(["config", "user.email", "harness@example.test"]);
  writeFileSync(path.join(root, "README.md"), "Runtime archive baseline.\n");
  deliveryGit(["add", "README.md"]);
  deliveryGit(["commit", "-m", "test: seed runtime delivery baseline"]);
  deliveryGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(path.join(root, "README.md"), "Runtime archive delivery.\n");
  deliveryGit(["add", "README.md"]);
  deliveryGit(["commit", "-m", "test: record runtime delivery"]);
  const submittedCut = { commitSha: deliveryGit(["rev-parse", "HEAD"]) };
  const submittedRuntime = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      `submit-before-exit:${submittedTaskId}:${submittedCut.commitSha}`,
      "--task",
      submittedTaskId,
      "--no-stream",
    ]),
    submittedDispatchId = String((submittedRuntime.spawn as Record<string, unknown>).dispatchId),
    submittedReportPath = `${submittedPackagePath}/artifacts/reports/${submittedDispatchId}.md`,
    submittedDispatch = (
      run(root, env, ["task", "dispatches", submittedTaskId]).dispatches as Array<Record<string, unknown>>
    ).find((row) => row.dispatchId === submittedDispatchId);
  await eventuallyFile(path.join(root, "harness", submittedReportPath));
  assert.equal(existsSync(path.join(root, "harness", submittedReportPath)), true);
  assert.equal(submittedDispatch?.reportPath, submittedReportPath);
});
