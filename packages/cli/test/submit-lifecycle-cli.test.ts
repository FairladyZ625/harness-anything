// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runRawJson, runRawJsonMaybeFail, withTempRoot } from "./helpers/daemon-cli.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const noRuntimeSession = {
  HARNESS_ACTOR: "agent:test",
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  CODEX_SESSION_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
} as const;

test("in_review without an Execution submission fails closed", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], noRuntimeSession);
    const created = unwrapCommandReceipt(runRawJson(rootDir, ["new-task", "--title", "Legacy Review"], noRuntimeSession));
    const taskId = String(created.taskId);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    runRawJson(rootDir, ["task", "transition", taskId, "active"], noRuntimeSession);

    const result = runRawJsonMaybeFail(rootDir, ["task", "transition", taskId, "in_review"], noRuntimeSession);

    assert.equal(result.status, 1);
    assert.equal(result.receipt.ok, false);
    assert.equal((result.receipt.error as { readonly code?: string }).code, "execution_submission_required");
    assert.match(String((result.receipt.error as { readonly hint?: string }).hint), /Execution.*submit/iu);
    assert.match(readFileSync(path.join(rootDir, String(created.packagePath), "INDEX.md"), "utf8"), /status: active/u);
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

test("default check hard-fails a local in_review Task without exactly one submitted Execution", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], noRuntimeSession);
    const created = unwrapCommandReceipt(runRawJson(rootDir, ["new-task", "--title", "Consistency Gate"], noRuntimeSession));
    const taskId = String(created.taskId);
    const taskRoot = path.join(rootDir, String(created.packagePath));
    const indexPath = path.join(taskRoot, "INDEX.md");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/^(  status:\s*).+$/mu, "$1in_review"), "utf8");

    const invalid = runRawJsonMaybeFail(rootDir, ["check"], noRuntimeSession);

    assert.equal(invalid.status, 1);
    assert.equal((invalid.receipt.error as { readonly code?: string }).code, "check_profile_failed");
    const warnings = (invalid.receipt.warnings ?? []) as ReadonlyArray<{ readonly code?: string; readonly severity?: string }>;
    assert.equal(warnings.some((warning) => warning.code === "execution_submission_required" && warning.severity === "hard-fail"), true);

    const executionId = "exe_01KX7H00000000000000000001";
    mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
      schema: "execution/v1",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "submitted",
      primary_actor: {
        principal: { personId: "worker" },
        executor: { kind: "agent", id: "worker-agent" },
        responsibleHuman: "worker"
      },
      claimed_at: "2026-07-11T00:00:00.000Z",
      submitted_at: "2026-07-11T00:01:00.000Z",
      closed_at: null,
      session_bindings: [{ role: "primary", archive_status: "complete" }],
      outputs: [],
      submission: { summary: "submitted", verification: ["tests passed"], residual_risks: [] }
    }, null, 2)}\n`, "utf8");

    const valid = runRawJson(rootDir, ["check"], noRuntimeSession);
    assert.equal(valid.ok, true);
    assert.equal(((valid.warnings ?? []) as ReadonlyArray<{ readonly code?: string }>).some((warning) => warning.code === "execution_submission_required"), false);
  });
});
