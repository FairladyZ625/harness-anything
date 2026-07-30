// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { parseArgs } from "../src/cli/parse-args.ts";
import { commandSpecs } from "../src/cli/command-spec/index.ts";
import { cliError, CliErrorCode } from "../src/cli/error-codes.ts";
import { toCommandReceipt } from "../src/cli/receipt.ts";
import type { CommandRunnerContext } from "../src/cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../src/cli/types.ts";
import { canonicalTaskStartResult } from "../src/commands/core/task-holder-support.ts";
import { runTaskLifecycleWithDemotions } from "../src/commands/core/task-lifecycle-demotions.ts";
import { runTaskStartFacade, taskCloseoutFacadeSteps, taskCompleteFacadeSteps, taskStartFacadeSteps } from "../src/commands/core/task-lifecycle-facade.ts";
import { dispatchLifecycleFacadeSteps } from "../src/commands/core/task-lifecycle-facade-guidance.ts";

test("non-local terminal status success preserves the owner-visible demotion warning", () => {
  const taskId = "task-external";
  const context = {
    artifactStore: {
      readTaskPackage: () => Effect.succeed({
        taskId,
        rootPath: "/fixture/task-external",
        disposition: "active",
        documents: [{
          path: "INDEX.md",
          kind: "document",
          body: ["---", "lifecycle:", "  engine: multica", "  status: active", "---"].join("\n")
        }]
      })
    },
    engine: {
      setStatus: () => Effect.succeed({ taskId, status: "done" })
    }
  } as unknown as CommandRunnerContext;
  const command = {
    rootDir: "/fixture",
    json: true,
    action: { kind: "status-set", taskId, status: "done", force: false }
  } as ParsedCommand;

  const result = Effect.runSync(runTaskLifecycleWithDemotions(context, command));

  assert.equal(result.ok, true);
  assert.equal(result.warnings?.[0]?.code, "terminal_status_requires_task_complete");
  assert.match(result.warnings?.[0]?.message ?? "", /ha task complete task-external --approve/u);
  assert.match(result.warnings?.[0]?.revivalCondition ?? "", /third independent user/u);
});

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

test("task closeout rejects changes_requested instead of silently completing it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-verdict-"));
  const packet = path.join(root, "closeout.json");
  writeFileSync(packet, JSON.stringify({
    completionClaim: "The delivery needs another round.",
    verdict: "changes_requested",
    findings: "One acceptance check is still open.",
    rationale: "The submitted evidence does not cover the open check.",
    ci: "passed"
  }), "utf8");
  try {
    const parsed = parseArgs(["task", "closeout", "task_BOUNDARY", "--from-file", packet]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.error.code, "invalid_task_metadata");
      assert.match(parsed.error.hint, /only accepts verdict approved.+review-execution.+changes_requested/iu);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task complete owner approval requires consent to grant complete_task", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-approval-consent-scope-"));
  const packet = path.join(root, "approval.json");
  writeFileSync(packet, JSON.stringify({
    findings: "Acceptance checks passed.",
    rationale: "Evidence satisfies the task intent.",
    consentAssertedRationale: "The human approved through an external channel.",
    consentActions: ["approve_execution"],
    ci: "passed"
  }), "utf8");
  try {
    const parsed = parseArgs(["task", "complete", "task_BOUNDARY", "--approve", "--from-file", packet]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.error.code, "invalid_task_metadata");
      assert.match(parsed.error.hint, /approve_execution and complete_task exactly once/iu);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task complete owner approval materializes accepted prose before Review, reconcile, and complete", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-approval-parser-"));
  const packet = path.join(root, "approval.json");
  writeFileSync(packet, JSON.stringify({
    executionId: "exe_01KXTE6GJPW73Y1EWCA0Q0798V",
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
      "doc-sync", "materializer-run", "task-review-execution", "task-code-doc-reconcile", "task-complete"
    ]);
    const materializer = steps[1];
    assert.deepEqual(materializer?.action, { kind: "materializer-run", dryRun: false, currentSessionOnly: true });
    assert.equal(steps.some((step) => step.action.kind === "status-set"), false);
    const reconcile = steps.find((step) => step.action.kind === "task-code-doc-reconcile");
    assert.equal(reconcile?.action.kind === "task-code-doc-reconcile" && reconcile.action.sha, "a".repeat(40));
    assert.equal(reconcile?.action.kind === "task-code-doc-reconcile" && reconcile.action.force, true);
    const complete = steps.at(-1);
    assert.equal(complete?.action.kind, "task-complete");
    if (complete?.action.kind === "task-complete") {
      assert.equal(complete.action.approval, undefined);
      assert.equal("executionId" in complete.action && complete.action.executionId,
        "exe_01KXTE6GJPW73Y1EWCA0Q0798V");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct-mode doc sync unavailability becomes a completion warning", async () => {
  const steps: ReadonlyArray<ParsedCommand> = [
    { rootDir: "/tmp", json: true, action: { kind: "doc-sync", mode: "submit", paths: ["tasks/task_BOUNDARY/closeout.md"] } },
    {
      rootDir: "/tmp",
      json: true,
      action: {
        kind: "task-complete",
        taskId: "task_BOUNDARY",
        reviewerId: "person_reviewer",
        evidenceMode: "execution-review"
      }
    }
  ];
  const docFailure = toCommandReceipt({
    ok: false,
    command: "doc-sync-submit",
    error: cliError(CliErrorCode.JournalUnavailable, "Doc sync submit requires the daemon-backed CLI path.")
  });
  const completed = toCommandReceipt({
    ok: true,
    command: "task-complete",
    taskId: "task_BOUNDARY",
    status: "done",
    completionGate: { ok: true }
  });
  const dispatched = await dispatchLifecycleFacadeSteps(steps, async (step) =>
    step.action.kind === "doc-sync" ? docFailure : completed
  );

  assert.equal(dispatched.ok, true);
  if (dispatched.ok) {
    assert.equal(dispatched.receipts.length, 1);
    assert.equal(dispatched.warnings.length, 1);
    assert.deepEqual(dispatched.warnings[0], {
      severity: "warning",
      code: "doc_sync_dirty",
      message: "Task prose remains dirty because daemon-backed doc sync is unavailable; completion continued under the existing soft-warning policy.",
      paths: ["tasks/task_BOUNDARY/closeout.md"],
      nextCommand: "ha doc sync --submit"
    });
  }
});

test("owner completion lease failures never direct the owner into task start", async () => {
  const step: ParsedCommand = {
    rootDir: "/tmp",
    json: true,
    action: {
      kind: "task-code-doc-reconcile",
      taskId: "task_BOUNDARY",
      sha: "a".repeat(40),
      paths: [],
      force: true
    }
  };
  const leaseFailure = toCommandReceipt({
    ok: false,
    command: "task-code-doc-reconcile",
    taskId: "task_BOUNDARY",
    error: cliError(
      CliErrorCode.WriteRejected,
      "Task requires an active lease; run 'ha task start task_BOUNDARY' before retrying."
    )
  });
  const dispatched = await dispatchLifecycleFacadeSteps([step], async () => leaseFailure, "task-complete");

  assert.equal(dispatched.ok, false);
  if (!dispatched.ok) {
    assert.match(dispatched.receipt.error?.hint ?? "", /Owner approval is lease-independent/iu);
    assert.match(dispatched.receipt.error?.hint ?? "", /ha task complete task_BOUNDARY --approve --from-file/iu);
    assert.doesNotMatch(dispatched.receipt.error?.hint ?? "", /ha task start/iu);
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
