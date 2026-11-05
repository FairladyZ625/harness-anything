// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { prepareGuiReworkCut } from "../test-support/rework-task.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";
import { parseDaemonGuiActionResponse } from "@harness-anything/daemon/client";

test("GUI rework reads the canonical cut, rejects a stale digest, and repeats one completed handoff through the canonical action", async () => {
  const fixture = await startGuiResidentDaemonFixture({ repoId: "gui-rework", daemonId: "gui-rework" });
  const keys = [
    "HARNESS_DAEMON_USER_ROOT",
    "HARNESS_DAEMON_ID",
    "HARNESS_DAEMON_REPO_ID",
    "HARNESS_DAEMON_ENDPOINT",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  Object.assign(process.env, fixture.env);
  try {
    const cut = await prepareGuiReworkCut(fixture),
      bridge = createLocalGuiServiceBridge();
    const scope = { repoId: fixture.repoId, taskId: cut.taskId };
    const read = async () => {
      const receipt = parseDaemonGuiActionResponse("repo.task.show", await bridge.invoke("showTask", scope));
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      return JSON.parse(String(receipt.evidence));
    };
    const initial = await read();
    assert.equal(initial.task.status, "submitted");
    assert.equal(initial.reworkTargets.length, 1);
    assert.equal(initial.reworkTargets[0].executionId, cut.executionId);
    const request = { ...scope, ...initial.reworkTargets[0], takeover: true, reason: "The owner arranges this round." };
    const stale = parseDaemonGuiActionResponse(
      "repo.task.rework",
      await bridge.invoke("reworkTask", { ...request, submissionDigest: `sha256:${"f".repeat(64)}` }),
    );
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "invalid_transition");
    assert.equal((await read()).task.executionArrangement, undefined);
    const arranged = parseDaemonGuiActionResponse("repo.task.rework", await bridge.invoke("reworkTask", request));
    assert.equal(arranged.outcome, "applied", JSON.stringify(arranged));
    const completed = await read();
    assert.equal(completed.task.executionArrangement.ready, true);
    assert.equal(completed.task.executionArrangement.executionId, cut.executionId);
    assert.equal(completed.task.executionArrangement.submissionDigest, request.submissionDigest);
    assert.equal(completed.task.iteration, 1);
    const repeated = parseDaemonGuiActionResponse("repo.task.rework", await bridge.invoke("reworkTask", request));
    assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
    const after = await read();
    assert.equal(after.task.iteration, 1);
    assert.equal(after.task.executionArrangement.id, completed.task.executionArrangement.id);
    assert.equal(after.executions.length, completed.executions.length);
    fixture.keycloak.revoke("person-gui", fixture.repoId, ["task-rework"]);
    const denied = parseDaemonGuiActionResponse("repo.task.rework", await bridge.invoke("reworkTask", request));
    assert.equal(denied.outcome, "op_rejected");
    assert.equal(denied.code, "authorization_denied");
  } finally {
    for (const key of keys) restoreEnv(key, previous[key]);
    await fixture.stop();
  }
});
