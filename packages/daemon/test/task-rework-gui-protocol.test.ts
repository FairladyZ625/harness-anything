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

test("GUI admits task-show metadata and rework outcomes only on their own receipt, preserving transport closure", async () => {
  const { validateDaemonGuiCommandReceipt } = await import("../src/protocol/daemon-protocol-validate-results.ts");
  const receipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "task-show",
    outcome: "applied",
    opId: "read:task-one",
    revision: 3,
    visibility: "center",
    evidence: "{}",
    proof: { committedRevision: 3, appliedCut: 3, durable: true, canonicalVisible: true, worktreeVisible: null },
  };
  assert.deepEqual(validateDaemonGuiCommandReceipt({ ...receipt, assignmentRevision: 2 }), []);
  assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, assignmentRevision: -1 }), []);
  assert.notDeepEqual(
    validateDaemonGuiCommandReceipt({ ...receipt, command: "task-start", assignmentRevision: 2 }),
    [],
  );
  for (const outcome of ["applied", "no_changes", "pending", "indeterminate", "op_rejected"]) {
    const continued = { ...receipt, command: "task-rework", continuation: { outcome, code: "original-code" } };
    assert.deepEqual(validateDaemonGuiCommandReceipt(continued), []);
    assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...continued, command: "task-start" }), []);
  }
  for (const continuation of [null, "applied", { outcome: "succeeded" }])
    assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, command: "task-rework", continuation }), []);
  assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, undeclared: true }), []);
});
