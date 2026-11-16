// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { realizedTaskPlan as realizedPlan } from "../../../tools/fixtures/task-plan.mjs";
import {
  cli,
  createRuntimeFixture,
  eventuallyFile,
  installIdentities,
  published,
  run,
  runMaybe,
  seedTask,
} from "./runtime-cli.fixtures.ts";

test("Runtime report is archived after the worker submits its execution", { timeout: 300_000 }, async (context) => {
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
    submittedPackagePath = String(submittedTask.workspacePackagePath),
    submittedPlanPath = `${submittedPackagePath}/task_plan.md`;
  published(root, env, submittedTask);
  writeFileSync(path.join(root, submittedPlanPath), realizedPlan("Submitted runtime archive"));
  run(root, env, ["doc", "sync", "--submit", "--path", submittedPlanPath]);
  const started = run(root, env, ["task", "start", submittedTaskId, "--execution-id", submittedExecutionId]);
  // The delivery commits below write repo Git directly, so the daemon must finish publishing the
  // cuts of the writes above first; otherwise the two HEAD writers race and git dies with
  // `cannot lock ref 'HEAD'`.
  published(root, env, started);
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
    submittedReportPath = `${submittedPackagePath}/artifacts/reports/${submittedDispatchId}.md`;
  // The report is archived by a doc-sync publication after the runtime settles, and the dispatch
  // read derives reportPath from the archived file, so the row is read only after the file exists.
  await eventuallyFile(path.join(root, submittedReportPath));
  assert.equal(existsSync(path.join(root, submittedReportPath)), true);
  const submittedDispatch = (
    run(root, env, ["task", "dispatches", submittedTaskId]).dispatches as Array<Record<string, unknown>>
  ).find((row) => row.dispatchId === submittedDispatchId);
  assert.equal(submittedDispatch?.reportPath, submittedReportPath);
});

test(
  "CLI discovers instances, runs direct prompts, resumes and streams with status retrieval",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    const { root, env, version } = fixture;
    const { artifactRoot } = seedTask(root, env, "direct");
    const inventory = run(root, env, ["runtime", "instance", "list"]),
      installation = (inventory.installations as Array<Record<string, unknown>>).find(
        (row) => row.kindId === "codex" && row.version === `codex ${version}`,
      );
    assert.ok(installation, JSON.stringify(inventory));
    const missingInstance = runMaybe(root, env, [
      "runtime",
      "run",
      "missing-instance",
      "--prompt",
      "must reject",
      "--detach",
    ]);
    assert.equal(missingInstance.status, 1);
    assert.equal(missingInstance.receipt.code, "runtime_instance_not_found");
    assert.equal(missingInstance.receipt.dispatchId, undefined);
    const directPrompt = run(root, env, ["runtime", "run", "cli-worker", "--prompt", "file prompt", "--no-stream"]);
    assert.equal((directPrompt.result as Record<string, unknown>).text, "final:file prompt");
    for (const directory of ["missions", "dispatches", "reports"])
      assert.equal(existsSync(path.join(artifactRoot, directory)), false, `${directory} must not exist without --task`);
    const resumed = run(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "second turn",
      "--resume",
      "provider-cli-session",
      "--no-stream",
    ]);
    assert.equal((resumed.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
    assert.equal((resumed.session as Record<string, unknown>).providerSessionId, "provider-cli-session");
    const streamed = spawnSync(
      process.execPath,
      [cli, "--root", root, "runtime", "run", "cli-worker", "--prompt", "stream prompt"],
      { encoding: "utf8", env },
    );
    assert.equal(streamed.status, 0, streamed.stderr);
    assert.equal(streamed.stdout.trim(), "final:stream prompt");
    const listed = run(root, env, ["runtime", "status", "--limit", "10"]),
      sessions = listed.sessions as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 3);
    assert.match(streamed.stderr, /\[message\] live:stream prompt/u, JSON.stringify(sessions));
    const detail = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId)]);
    assert.equal((detail.result as Record<string, unknown>).text, "resumed:provider-cli-session:second turn");
    const waited = run(root, env, ["runtime", "status", String(resumed.runtimeSessionId), "--wait", "--no-stream"]);
    assert.equal(waited.command, "runtime-status");
    assert.equal(waited.summary, "resumed:provider-cli-session:second turn");
  },
);

test(
  "Provider failures preserve reasons, redact secrets and publish failed task archives",
  { timeout: 300_000 },
  async (context) => {
    const fixture = createRuntimeFixture(context);
    installIdentities(fixture.parent, fixture.root, fixture.env);
    const { root, env } = fixture;
    const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "failure");
    // This file's subject is the terminal record a provider failure leaves behind: its reason,
    // redaction, archive and resume hint. The retry ladder is provider-fallback.integration.test.ts's
    // subject, so pin it to zero rounds here and keep each failure one attempt. Repository settings
    // are principal-owned, so this write runs as the fixture's person, not its runtime executor.
    run(root, { ...env, HARNESS_ACTOR: "" }, ["settings", "update", "--runtime-provider-max-retries", "0"]);
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const emptyFailure = runMaybe(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "failure:empty",
      "--no-stream",
    ]);
    assert.equal(emptyFailure.status, 1);
    assert.equal(emptyFailure.receipt.code, "provider_exit");
    assert.match(String(emptyFailure.receipt.reason), /^Provider exited with code 1 and produced no output\./u);
    assert.match(String(emptyFailure.receipt.summary), /^Provider exited with code 1 and produced no output\./u);
    const secret = "sk-runtime-secret-1234567890",
      secretFailure = runMaybe(root, env, [
        "runtime",
        "run",
        "cli-worker",
        "--prompt",
        "failure:secret",
        "--no-stream",
      ]);
    assert.equal(secretFailure.status, 1);
    assert.match(String(secretFailure.receipt.reason), /Provider exited with code 1.*OPENAI_API_KEY=\[REDACTED\]/u);
    assert.doesNotMatch(JSON.stringify(secretFailure.receipt), new RegExp(secret, "u"));
    assert.doesNotMatch(
      readFileSync(path.join(root, ".harness", "requests", "requests.jsonl"), "utf8"),
      new RegExp(secret, "u"),
    );
    const structuredFailure = runMaybe(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "failure:structured",
      "--no-stream",
    ]);
    assert.equal(structuredFailure.status, 1);
    assert.match(String(structuredFailure.receipt.reason), /structured provider failure/u);
    assert.doesNotMatch(JSON.stringify(structuredFailure.receipt), new RegExp(secret, "u"));
    const quotaFailure = runMaybe(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "failure:429",
      "--no-stream",
    ]);
    assert.equal(quotaFailure.status, 1);
    assert.equal(quotaFailure.receipt.code, "quota_exhausted");
    assert.match(
      String(quotaFailure.receipt.reason),
      /faultClass=quota_exhausted; resetAt=2026-09-06T05:06:07\.000Z;.*credit balance exhausted/u,
    );
    const quotaAttempt = (
      (quotaFailure.receipt.session as Record<string, unknown>).attemptChain as {
        attempts: Array<Record<string, unknown>>;
      }
    ).attempts[0]!;
    assert.equal(quotaAttempt.classification, "provider_quota");
    assert.equal(quotaAttempt.resetAt, "2026-09-06T05:06:07.000Z");
    assert.match(String(quotaAttempt.nextAction), /ha runtime run --resume-dispatch/u);
    writeFileSync(
      path.join(root, "failure-batch.json"),
      JSON.stringify({
        schema: "runtime-batch/v1",
        maxConcurrency: 1,
        dispatches: [{ instance: "cli-worker", prompt: "failure:empty" }],
      }),
    );
    const failureBatch = runMaybe(root, env, ["runtime", "batch", "failure-batch.json"]);
    assert.equal(failureBatch.status, 1);
    const failureRow = (failureBatch.receipt.dispatches as Array<Record<string, unknown>>)[0]!;
    assert.equal(failureRow.code, "provider_exit");
    assert.match(String(failureRow.reason), /^Provider exited with code 1 and produced no output\./u);
    run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
    const detachedFailure = run(root, env, [
      "agent",
      "run",
      "terra",
      "--prompt",
      "failure:429",
      "--cwd",
      ".",
      "--task",
      taskId,
      "--detach",
    ]);
    const failureWait = runMaybe(root, env, ["runtime", "status", "--task", taskId, "--wait", "--no-stream"]);
    assert.equal(detachedFailure.outcome, "running");
    assert.equal(failureWait.status, 1, `${failureWait.stderr}\n${JSON.stringify(failureWait.receipt)}`);
    assert.equal(failureWait.receipt.outcome, "failed");
    const failedRow = (failureWait.receipt.dispatches as Array<Record<string, unknown>>).find(
      (row) => row.dispatchId === detachedFailure.dispatchId,
    );
    assert.equal(failedRow?.status, "failed");
    assert.equal(failedRow?.classification, "provider_quota");
    assert.equal(failedRow?.resetAt, "2026-09-06T05:06:07.000Z");
    assert.equal(failedRow?.nextAction, `ha agent run terra --resume-dispatch ${String(detachedFailure.dispatchId)}`);
    assert.equal(failedRow?.exitCode, 1);
    assert.equal(failedRow?.dispatchPath, `${packagePath}/artifacts/dispatches/${detachedFailure.dispatchId}.json`);
    await eventuallyFile(path.join(artifactRoot, "reports", `${detachedFailure.dispatchId}.md`));
    const publishedFailureRow = (
      runMaybe(root, env, ["task", "dispatches", taskId]).receipt.dispatches as Array<Record<string, unknown>>
    ).find((row) => row.dispatchId === detachedFailure.dispatchId);
    assert.equal(publishedFailureRow?.reportPath, `${packagePath}/artifacts/reports/${detachedFailure.dispatchId}.md`);
    const healthAfterRuntimeFailure = (run(root, env, ["daemon", "status"]).repos as Array<Record<string, unknown>>)[0]
      ?.materialization as Record<string, unknown>;
    assert.equal(healthAfterRuntimeFailure.state, "ok", JSON.stringify(healthAfterRuntimeFailure));
    context.diagnostic(
      `detach -> task wait failure: ${JSON.stringify({
        detached: detachedFailure,
        wait: failureWait.receipt,
        dispatch: failedRow,
        materialization: healthAfterRuntimeFailure,
      })}`,
    );
  },
);
