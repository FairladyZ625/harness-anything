// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { eventuallyFile } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Provider failures preserve reasons, redact secrets and publish failed task archives", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const { taskId, executionId, packagePath, artifactRoot } = seedTask(root, env, "failure");
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
  assert.equal(emptyFailure.receipt.reason, "Provider exited with code 1 and produced no output.");
  assert.equal(emptyFailure.receipt.summary, emptyFailure.receipt.reason);
  const secret = "sk-runtime-secret-1234567890",
    secretFailure = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "failure:secret", "--no-stream"]);
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
  const quotaFailure = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "failure:429", "--no-stream"]);
  assert.equal(quotaFailure.status, 1);
  assert.equal(quotaFailure.receipt.code, "quota_exhausted");
  assert.match(
    String(quotaFailure.receipt.reason),
    /faultClass=quota_exhausted; resetAt=2026-09-06T05:06:07\.000Z;.*credit balance exhausted/u,
  );
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
  assert.equal(failureRow.reason, "Provider exited with code 1 and produced no output.");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const detachedFailure = run(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--prompt",
    "failure:structured",
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
  assert.equal(failedRow?.exitCode, 1);
  assert.equal(failedRow?.dispatchPath, `${packagePath}/artifacts/dispatches/${detachedFailure.dispatchId}.json`);
  await eventuallyFile(path.join(artifactRoot, "reports", `${detachedFailure.dispatchId}.md`));
  const publishedFailureRow = (
    run(root, env, ["task", "dispatches", taskId]).dispatches as Array<Record<string, unknown>>
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
});
