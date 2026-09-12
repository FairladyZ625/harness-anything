// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { runMaybe } from "./runtime-cli.commands.fixture.ts";
import { eventuallyRuntimeReaderReuse } from "./runtime-cli.observations.fixture.ts";
import { createRuntimeFixture } from "./runtime-cli.setup.fixture.ts";

test("Detached runtime results are retrieved from another CLI process over a reused connection", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env, userRoot, daemonId } = fixture;
  const detachedProcess = runMaybe(root, env, [
      "runtime",
      "run",
      "cli-worker",
      "--prompt",
      "stream prompt",
      "--detach",
    ]),
    detachedReceipt = detachedProcess.receipt,
    detachedRuntimeSessionId = String(detachedReceipt.runtimeSessionId);
  assert.equal(detachedProcess.status, 0, detachedProcess.stderr);
  assert.equal(detachedReceipt.nextAction, `ha runtime status ${detachedRuntimeSessionId} --wait`);
  assert.match(
    String(detachedReceipt.summary),
    new RegExp(`next: ha runtime status ${detachedRuntimeSessionId} --wait$`, "u"),
  );
  const retrievalProcess = runMaybe(root, env, [
      "runtime",
      "status",
      detachedRuntimeSessionId,
      "--wait",
      "--no-stream",
    ]),
    retrievedText = String((retrievalProcess.receipt.result as Record<string, unknown>).text);
  assert.equal(retrievalProcess.status, 0, retrievalProcess.stderr);
  assert.equal(retrievalProcess.receipt.outcome, "succeeded");
  assert.equal(retrievedText, "final:stream prompt");
  assert.equal(Number.isInteger(detachedProcess.pid) && Number.isInteger(retrievalProcess.pid), true);
  assert.notEqual(
    detachedProcess.pid,
    retrievalProcess.pid,
    "detach and status --wait must execute in different CLI processes",
  );
  const readerReuse = await eventuallyRuntimeReaderReuse(userRoot, daemonId);
  context.diagnostic(
    `detach cross-process retrieval: ${JSON.stringify({ launcherPid: detachedProcess.pid, retrievalPid: retrievalProcess.pid, runtimeSessionId: detachedRuntimeSessionId, outcome: retrievalProcess.receipt.outcome, resultText: retrievedText, readerReuse })}`,
  );
});
