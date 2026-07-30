// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/parse-args.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { cliError, CliErrorCode } from "../src/cli/error-codes.ts";
import { toCommandReceipt } from "../src/cli/receipt.ts";
import type { CliResult, ParsedCommand } from "../src/cli/types.ts";
import { canonicalTaskStartResult } from "../src/commands/core/task-holder-support.ts";
import { runTaskStartFacade, taskCloseoutFacadeSteps, taskCompleteFacadeSteps, taskStartFacadeSteps } from "../src/commands/core/task-lifecycle-facade.ts";

test("task start is one admitted claim-and-activate boundary that cannot enter review", () => {
  const parsed = parseArgs(["task", "start", "task_BOUNDARY", "--ttl-ms", "60000"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "task-start") return;
  const steps = taskStartFacadeSteps(parsed.value as ParsedCommand & { action: Extract<ParsedCommand["action"], { kind: "task-start" }> });
  assert.deepEqual(steps.map((step) => step.action.kind), ["task-claim"]);
  assert.equal(steps.some((step) => step.action.kind === "status-set" && step.action.status === "in_review"), false);
});

test("task closeout compatibility entry no longer submits and delegates the owner approval steps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-parser-"));
  const packet = path.join(root, "closeout.json");
  writeFileSync(packet, JSON.stringify({
    completionClaim: "Ready for deliberate closeout.",
    verdict: "approved",
    findings: "Acceptance checks passed.",
    rationale: "Evidence satisfies the task intent.",
    consentAssertedRationale: "The human approved through an external channel.",
    consentActions: ["approve_execution", "complete_task"],
    ci: "passed"
  }), "utf8");
  try {
    const parsed = parseArgs(["task", "closeout", "task_BOUNDARY", "--from-file", packet]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.action.kind !== "task-closeout") return;
    const steps = taskCloseoutFacadeSteps(
      parsed.value as ParsedCommand & { action: Extract<ParsedCommand["action"], { kind: "task-closeout" }> },
      "a".repeat(40)
    );
    assert.deepEqual(steps.map((step) => step.action.kind), [
      "task-review-execution", "task-code-doc-reconcile", "task-complete"
    ]);
    assert.equal(steps.some((step) => step.action.kind === "status-set"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task complete owner approval expands only to internal sync, Review, reconcile, and complete steps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-approval-parser-"));
  const packet = path.join(root, "approval.json");
  writeFileSync(packet, JSON.stringify({
    findings: "Acceptance checks passed.",
    rationale: "Evidence satisfies the task intent.",
    consentAssertedRationale: "The human approved through an external channel.",
    consentActions: ["approve_execution", "complete_task"],
    ci: "passed"
  }), "utf8");
  try {
    const compatibility = parseArgs(["task", "complete", "task_BOUNDARY", "--ci", "passed"]);
    assert.equal(compatibility.ok, true);
    if (compatibility.ok && compatibility.value.action.kind === "task-complete") {
      assert.equal(compatibility.value.action.approval, undefined);
    }

    const parsed = parseArgs(["task", "complete", "task_BOUNDARY", "--approve", "--from-file", packet]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.action.kind !== "task-complete") return;
    const steps = taskCompleteFacadeSteps(
      parsed.value as ParsedCommand & { action: Extract<ParsedCommand["action"], { kind: "task-complete" }> },
      "a".repeat(40),
      ["tasks/task_BOUNDARY/closeout.md"]
    );
    assert.deepEqual(steps.map((step) => step.action.kind), [
      "doc-sync", "task-review-execution", "task-code-doc-reconcile", "task-complete"
    ]);
    assert.equal(steps.some((step) => step.action.kind === "status-set"), false);
    const reconcile = steps.find((step) => step.action.kind === "task-code-doc-reconcile");
    assert.equal(reconcile?.action.kind === "task-code-doc-reconcile" && reconcile.action.sha, "a".repeat(40));
    assert.equal(reconcile?.action.kind === "task-code-doc-reconcile" && reconcile.action.force, true);
    const complete = steps.at(-1);
    assert.equal(complete?.action.kind, "task-complete");
    if (complete?.action.kind === "task-complete") assert.equal(complete.action.approval, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both lifecycle facades satisfy the accepted command admission contract", () => {
  const start = commandSpecs.find((spec) => spec.kind === "task-start");
  const closeout = commandSpecs.find((spec) => spec.kind === "task-closeout");
  assert.ok(start?.admission);
  assert.ok(closeout?.admission);
  assert.equal(start.options.length <= 8, true);
  assert.equal(closeout.options.length <= 8, true);
  assert.equal(start.admission.decisionRef, "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV");
  assert.equal(closeout.admission.decisionRef, "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV");
  assert.equal(closeout.admission.chain?.structuredInput, true);
});

for (const scenario of [
  {
    name: "success",
    result: {
      ok: true,
      command: "task-claim",
      taskId: "task_EQUIVALENT",
      executionId: "exe_EQUIVALENT",
      status: "active",
      report: {
        schema: "execution-claim-result/v1",
        executionId: "exe_EQUIVALENT",
        leaseToken: "token",
        leaseExpiresAt: "2026-07-31T00:00:00.000Z",
        reused: false
      }
    } satisfies CliResult
  },
  {
    name: "CAS conflict",
    result: {
      ok: false,
      command: "task-claim",
      taskId: "task_EQUIVALENT",
      error: cliError(CliErrorCode.WriteConflict, "INDEX changed during claim publication.")
    } satisfies CliResult
  },
  {
    name: "lease collision",
    result: {
      ok: false,
      command: "task-claim",
      taskId: "task_EQUIVALENT",
      error: cliError(CliErrorCode.WriteRejected, "Execution lease is held by another actor."),
      report: { schema: "task-holder-error/v1", code: "execution_lease_collision" }
    } satisfies CliResult
  }
] as const) {
  test(`deprecated claim and task start return the same canonical receipt for ${scenario.name}`, async () => {
    const parsed = parseArgs(["task", "start", "task_EQUIVALENT"]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.value.action.kind !== "task-start") return;
    const aliasReceipt = toCommandReceipt(canonicalTaskStartResult("task_EQUIVALENT", scenario.result));
    const startReceipt = await runTaskStartFacade(parsed.value, async (step) => {
      assert.equal(step.action.kind, "task-claim");
      return aliasReceipt;
    });
    assert.deepEqual(startReceipt, aliasReceipt);
  });
}
