// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executionDeclaration, resolveEntityDocumentPath, type ExecutionRecord } from "../../kernel/src/index.ts";
import { runRawJson, runRawJsonMaybeFail, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { writeIndex } from "./helpers/local-lifecycle-fixtures.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0";
const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5";
const packageDirectory = `${taskId}-duplicate-owner`;

test("P0 duplicate declared identity is a negative control before repair", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture" });
    writeIndex(rootDir, packageDirectory, "Duplicate owner fixture", "active", { taskId });
    const execution: ExecutionRecord = {
      schema: "execution/v2",
      execution_id: executionId,
      task_ref: `task/${taskId}`,
      state: "active",
      primary_actor: {
        principal: { personId: "person_fixture" },
        executor: { kind: "agent", id: "fixture" },
        responsibleHuman: "person_fixture"
      },
      claimed_at: "2026-08-04T00:00:00.000Z",
      submitted_at: null,
      closed_at: null,
      session_bindings: [],
      outputs: [],
      submission: null
    };
    const body = `${JSON.stringify(execution, null, 2)}\n`;
    for (const directory of [packageDirectory, taskId]) {
      const executionRoot = path.join(rootDir, "harness/tasks", directory, "executions");
      mkdirSync(executionRoot, { recursive: true });
      writeFileSync(path.join(executionRoot, `${executionId}.md`), body, "utf8");
    }

    const canonicalExecutionPath = resolveEntityDocumentPath(rootDir, executionDeclaration, { taskId, executionId });
    assert.equal(
      path.relative(rootDir, canonicalExecutionPath).split(path.sep).join("/"),
      `harness/tasks/${packageDirectory}/executions/${executionId}.md`
    );

    const result = runRawJsonMaybeFail(rootDir, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.ok, true, JSON.stringify(result.receipt));
    const conflictWarnings = (result.receipt.warnings as ReadonlyArray<Record<string, unknown>>)
      .filter((warning) => warning.code === "declared_identity_conflict");
    assert.equal(conflictWarnings.length > 0, true);
    assert.equal(new Set(conflictWarnings.map((warning) => `${warning.code}\0${warning.message}`)).size, conflictWarnings.length);
    assert.equal(conflictWarnings.some((warning) => String(warning.message).includes("Canonical candidates:")), true);

    const doctor = runRawJsonMaybeFail(rootDir, ["doctor"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    assert.equal(doctor.status, 1, JSON.stringify(doctor.receipt));
    assert.equal(doctor.receipt.ok, false, JSON.stringify(doctor.receipt));
    const doctorReport = (doctor.receipt.details as { readonly data?: { readonly report?: Record<string, any> } } | undefined)?.data?.report;
    assert.equal(doctorReport?.readOnly, true, JSON.stringify(doctor.receipt));
    assert.equal(doctorReport?.ledger?.ok, false, JSON.stringify(doctor.receipt));
    assert.equal(doctorReport?.ledger?.declaredIdentity?.conflictCount, 1, JSON.stringify(doctor.receipt));
    assert.equal(doctorReport?.ledger?.notChecked?.includes("projection cache integrity"), true, JSON.stringify(doctor.receipt));

    const repaired = runRawJsonMaybeFail(rootDir, ["doctor", "--repair"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    assert.equal(repaired.status, 0, JSON.stringify(repaired.receipt));
    assert.equal(repaired.receipt.ok, true, JSON.stringify(repaired.receipt));
    const repairReport = (repaired.receipt.details as { readonly data?: { readonly report?: Record<string, any> } } | undefined)?.data?.report;
    assert.equal(repairReport?.readOnly, false, JSON.stringify(repaired.receipt));
    assert.equal(repairReport?.ledger?.repair?.changed, true, JSON.stringify(repaired.receipt));
    assert.equal(repairReport?.ledger?.declaredIdentity?.conflictCount, 0, JSON.stringify(repaired.receipt));
    assert.equal(repairReport?.ledger?.declaredIdentity?.misplacedCount, 0, JSON.stringify(repaired.receipt));
    assert.equal(existsSync(canonicalExecutionPath), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks", taskId, "executions", `${executionId}.md`)), false);

    const afterRepair = runRawJsonMaybeFail(rootDir, ["task", "list"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    assert.equal(afterRepair.status, 0, JSON.stringify(afterRepair.receipt));
    assert.equal((afterRepair.receipt.warnings as ReadonlyArray<Record<string, unknown>> ?? []).some((warning) => warning.code === "declared_identity_conflict"), false);
  });
});
