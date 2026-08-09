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
import { canonicalTaskStartResult, taskHolderCommandFailure } from "../src/commands/core/task-holder-support.ts";
import { runTaskLifecycleWithDemotions } from "../src/commands/core/task-lifecycle-demotions.ts";
import {
  dispatchLifecycleFacadeSteps
} from "../src/commands/core/task-lifecycle-facade-guidance.ts";
import {
  runTaskStartFacade,
  taskCloseoutFacadeSteps,
  taskStartFacadeSteps
} from "../src/commands/core/task-lifecycle-facade.ts";

test("unknown task-holder failures remain unclassified instead of impersonating a journal diagnosis", () => {
  const receipt = toCommandReceipt(taskHolderCommandFailure(new Error("task holder fixture exploded")));

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "unclassified_command_failure");
  assert.equal(receipt.error?.hint, "task holder fixture exploded");
});

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
  assert.equal(
    result.warnings?.[0]?.message,
    "External-engine terminal status completed outside the local consent transaction. Run `ha task show task-external --json` to confirm the resulting state. Do not run another terminal transition from this receipt. If follow-up work is needed, inspect `ha task supersede --help` before creating replacement work."
  );
  assert.doesNotMatch(result.warnings?.[0]?.message ?? "", /<[^>]+>/u);
  assert.match(result.warnings?.[0]?.revivalCondition ?? "", /third independent user/u);
});

for (const [status, expectedHint] of [
  [
    "done",
    "Direct done is blocked because completion consent is recorded only by the typed completion transaction. Run `ha task show task-local --json` to confirm the current state. If the task is not terminal, inspect `ha task complete --help` and prepare the required approval packet before retrying completion. If it is already terminal and follow-up work is needed, inspect `ha task supersede --help` before creating replacement work."
  ],
  [
    "cancelled",
    "Direct cancellation is blocked unless it is an audited recovery. Run `ha task show task-local --json` to confirm the current state. If the task is not terminal and cancellation is still intended, inspect `ha task transition --help` and supply a truthful audited reason. If it is already terminal and follow-up work is needed, inspect `ha task supersede --help` before creating replacement work."
  ]
] as const) {
  test(`local direct ${status} renders only concrete inspection commands`, () => {
    const context = {
      artifactStore: {
        readTaskPackage: () => Effect.succeed({
          taskId: "task-local",
          rootPath: "/fixture/task-local",
          disposition: "active",
          documents: [{
            path: "INDEX.md",
            kind: "document",
            body: ["---", "lifecycle:", "  engine: local", "  status: active", "---"].join("\n")
          }]
        })
      }
    } as unknown as CommandRunnerContext;
    const command = {
      rootDir: "/fixture",
      json: true,
      action: { kind: "status-set", taskId: "task-local", status, force: false }
    } as ParsedCommand;

    const result = Effect.runSync(runTaskLifecycleWithDemotions(context, command));

    assert.equal(result.ok, false);
    assert.equal(result.error?.hint, expectedHint);
    assert.doesNotMatch(result.error?.hint ?? "", /<[^>]+>/u);
    for (const argv of [
      ["task", "show", "task-local", "--json"],
      status === "done" ? ["task", "complete", "--help"] : ["task", "transition", "--help"],
      ["task", "supersede", "--help"]
    ]) {
      assert.equal(parseArgs(argv).ok, true, argv.join(" "));
    }
  });
}

test("failed audited cancellation leaves no unpaired audit progress", () => {
  const taskId = "task-audit-atomic";
  const progress: string[] = [];
  const statusInputs: Array<{ readonly auditText?: string }> = [];
  const context = {
    rootDir: "/fixture",
    layoutInput: "/fixture",
    artifactStore: {
      readTaskPackage: () => Effect.succeed({
        taskId,
        rootPath: "/fixture/task-audit-atomic",
        disposition: "active",
        documents: [{
          path: "INDEX.md",
          kind: "document",
          body: ["---", "lifecycle:", "  engine: local", "  status: active", "---"].join("\n")
        }]
      })
    },
    engine: {
      appendProgress: (input: { readonly text: string }) => Effect.sync(() => {
        progress.push(input.text);
        return { taskId, path: "progress.md" };
      }),
      setStatus: (input: { readonly auditText?: string }) => {
        statusInputs.push(input);
        return Effect.fail({
          _tag: "InvalidTransition" as const,
          taskId,
          from: "done" as const,
          to: "cancelled" as const
        });
      }
    }
  } as unknown as CommandRunnerContext;
  const command = {
    rootDir: "/fixture",
    json: true,
    action: {
      kind: "status-set",
      taskId,
      status: "cancelled",
      force: true,
      reason: "atomic audit regression"
    }
  } as ParsedCommand;

  const failure = Effect.runSync(Effect.flip(runTaskLifecycleWithDemotions(context, command)));

  assert.equal(failure._tag, "InvalidTransition");
  assert.deepEqual(progress, []);
  assert.match(statusInputs[0]?.auditText ?? "", /^FORCE_STATUS_SET_AUDIT:/u);
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
    assert.deepEqual(steps.map((step) => step.action.kind), ["task-complete"]);
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

test("task complete owner approval remains one complete intent for daemon planning", () => {
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
    assert.equal(parsed.value.action.kind, "task-complete");
    assert.equal(parsed.value.action.approval?.executionId, "exe_01KXTE6GJPW73Y1EWCA0Q0798V");
    assert.equal(parsed.value.action.approval?.consentAssertedRationale, "The human approved through an external channel.");
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

test("dispatchLifecycleFacadeSteps soft-warns when doc-sync fails because the daemon-backed path is required", async () => {
  const docSyncStep = {
    rootDir: "/fixture",
    json: true,
    action: { kind: "doc-sync", mode: "submit", paths: ["tasks/task_FIXTURE/task_plan.md"] }
  } as ParsedCommand;

  const result = await dispatchLifecycleFacadeSteps(
    [docSyncStep],
    () => Promise.resolve(failureReceipt(
      CliErrorCode.DaemonBackedPathRequired,
      "Use the canonical writer."
    )),
    "task-complete"
  );

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "doc_sync_dirty");
});

test("dispatchLifecycleFacadeSteps soft-warns when doc-sync fails because the daemon is unreachable", async () => {
  const docSyncStep = {
    rootDir: "/fixture",
    json: true,
    action: { kind: "doc-sync", mode: "submit", paths: ["tasks/task_FIXTURE/task_plan.md"] }
  } as ParsedCommand;

  const result = await dispatchLifecycleFacadeSteps(
    [docSyncStep],
    () => Promise.resolve(failureReceipt(
      CliErrorCode.DaemonUnavailable,
      "The local writer is offline."
    )),
    "task-closeout"
  );

  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "doc_sync_dirty");
});

test("dispatchLifecycleFacadeSteps hard-fails when doc-sync is rejected for a non-journal reason", async () => {
  const docSyncStep = {
    rootDir: "/fixture",
    json: true,
    action: { kind: "doc-sync", mode: "submit", paths: ["tasks/task_FIXTURE/task_plan.md"] }
  } as ParsedCommand;

  const result = await dispatchLifecycleFacadeSteps(
    [docSyncStep],
    () => Promise.resolve(failureReceipt(
      CliErrorCode.WriteRejected,
      "Doc sync selected path is outside the authored root."
    )),
    "task-complete"
  );

  assert.equal(result.ok, false);
  assert.equal(result.receipt.ok, false);
});

function failureReceipt(code: CliErrorCode, hint: string) {
  return toCommandReceipt({
    ok: false,
    command: "doc-sync-submit",
    error: cliError(code, hint)
  });
}
