// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runRawJson, runRawJsonMaybeFail, withTempRoot } from "./helpers/daemon-cli.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const noRuntimeSession = {
  HARNESS_ACTOR: "agent:test",
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  CODEX_SESSION_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
} as const;

test("in_review without an Execution preserves the legacy transition receipt", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], noRuntimeSession);
    const created = unwrapCommandReceipt(runRawJson(rootDir, ["new-task", "--title", "Legacy Review"], noRuntimeSession));
    const taskId = String(created.taskId);
    runRawJson(rootDir, ["task", "transition", taskId, "active"], noRuntimeSession);

    const receipt = runRawJson(rootDir, ["task", "transition", taskId, "in_review"], noRuntimeSession);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.command, "task transition");
    assert.deepEqual((receipt.details as { readonly data: unknown }).data, { taskId, status: "in_review" });
    assert.equal(JSON.stringify(receipt).includes("executionId"), false);
    assert.equal(JSON.stringify(receipt).includes("execution-submit-result"), false);
  });
});

test("Execution claim without a detectable runtime session records a pending primary and submit fails actionably", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], noRuntimeSession);
    const created = unwrapCommandReceipt(runRawJson(rootDir, ["new-task", "--title", "Pending Primary"], noRuntimeSession));
    const taskId = String(created.taskId);
    const claimed = unwrapCommandReceipt(runRawJson(rootDir, ["task", "claim", taskId, "--execution"], noRuntimeSession));
    const executionId = String(claimed.executionId);
    const execution = JSON.parse(readFileSync(path.join(
      rootDir,
      `harness/tasks/${taskId}-pending-primary/executions/${executionId}.md`
    ), "utf8"));
    assert.deepEqual(execution.session_bindings, [{
      binding_id: "primary:pending",
      session_ref: null,
      role: "primary",
      archive_status: "pending",
      attached_at: execution.session_bindings[0].attached_at,
      session: null,
      capture_range: execution.session_bindings[0].capture_range
    }]);

    const submitted = runRawJsonMaybeFail(rootDir, [
      "task", "transition", taskId, "in_review",
      "--lease-token", String(claimed.report.leaseToken),
      "--summary", "ready"
    ], noRuntimeSession);
    assert.equal(submitted.status, 1);
    assert.match(String((submitted.receipt.error as { readonly hint?: string }).hint), /primary Session binding is required.*ExecutionSagaService\.attachSession/u);
  });
});
