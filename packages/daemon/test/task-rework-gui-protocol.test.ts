// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForDaemonMethod,
  daemonGuiInvokeFacets,
  parseDaemonRpcParams,
} from "../src/protocol/daemon-protocol.contract.ts";
import { generatedTaskActionProtocolDeclarations } from "@harness-anything/preset/internal/preset-command-contract";

test("GUI show/rework facets consume the CLI's generated payload and canonical action", () => {
  for (const [method, kind] of [
    ["repo.task.show", "task-show"],
    ["repo.task.rework", "task-rework"],
  ] as const) {
    const facet = daemonGuiInvokeFacets.find((entry) => entry.method === method)!;
    assert.ok(facet);
    if (kind === "task-rework") {
      const fields = generatedTaskActionProtocolDeclarations.find((entry) => entry.id === "rework")!.input.fields;
      assert.deepEqual(
        Object.keys((facet.params.fields.payload as { fields: object }).fields).sort(),
        fields.map((field) => field.field).sort(),
      );
    }
    const payload = {
      taskId: "task-one",
      ...(kind === "task-rework"
        ? {
            takeover: true,
            executionId: "execution-one",
            submissionDigest: `sha256:${"a".repeat(64)}`,
            reason: "Arrange this round.",
          }
        : {}),
    };
    assert.deepEqual(actionForDaemonMethod(method, payload), { kind, ...payload });
    assert.equal(parseDaemonRpcParams(method, { repo: { repoId: "repo-one" }, payload }).ok, true);
    assert.equal(
      parseDaemonRpcParams(method, {
        repo: { repoId: "repo-one" },
        payload: { ...payload, principal: "pretend-owner" },
      }).ok,
      false,
    );
  }
});
