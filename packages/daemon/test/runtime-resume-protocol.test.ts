// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";

test("GUI resume spawn accepts only its resumeDispatchId route", () => {
  const params = {
    repo: { repoId: "canonical" },
    payload: { resumeDispatchId: "dispatch_0123456789abcdef01234567", idempotencyKey: "resume-from-gui" },
  };
  assert.equal(parseDaemonRpcParams("repo.agentRuntime.spawn", params).ok, true);
  assert.equal(
    parseDaemonRpcParams("repo.agentRuntime.spawn", {
      ...params,
      payload: { ...params.payload, dispatchId: "dispatch_fedcba987654321001234567" },
    }).ok,
    false,
  );
});
