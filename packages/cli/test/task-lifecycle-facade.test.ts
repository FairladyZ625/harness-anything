// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { REPLAY_TASK_GRAPH, TASK_LIFECYCLE_COMMAND_CATALOG } from "../../kernel/src/index.ts";
import { antiEntropyVerificationKey, decodeReceiptToken, encodeReceiptToken, signReceipt, verifyReceipt } from "../../../tools/gates/receipt-verify.mjs";
import {
  TASK_LIFECYCLE_CLI_COMMANDS,
  parseTaskLifecycleArgs,
  renderTaskLifecycleHelp,
  runTaskLifecycleFacade
} from "../src/commands/core/task-lifecycle.ts";

const actor = {
  principal: { personId: "person_zeyu" },
  executor: { kind: "agent" as const, id: "executor-session" }
};

test("lifecycle facade derives its five write commands from the W1 catalog", () => {
  const domainTypes = [...new Set(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType))].sort();
  assert.deepEqual(TASK_LIFECYCLE_CLI_COMMANDS.map((entry) => entry.commandType).sort(), domainTypes);
  assert.deepEqual(TASK_LIFECYCLE_CLI_COMMANDS.map((entry) => entry.verb).sort(), [
    "complete", "create", "review-execution", "start", "submit"
  ]);
  for (const forbidden of ["set-status", "claim", "release", "edit-graph"]) {
    assert.equal(TASK_LIFECYCLE_CLI_COMMANDS.some((entry) => entry.verb === forbidden), false);
  }
  for (const forbidden of [
    ["task", "transition", "task_1", "in_review"],
    ["task", "transition", "task_1", "done"],
    ["task", "claim", "task_1"],
    ["task", "release", "task_1"]
  ]) assert.equal(parseTaskLifecycleArgs(forbidden).ok, false, forbidden.join(" "));
});

test("four lifecycle write facades expose actionable help", () => {
  assert.match(renderTaskLifecycleHelp("start"), /Usage: ha task start <task-id> --execution-id <execution-id>/u);
  assert.match(renderTaskLifecycleHelp("submit"), /--lease-token.*--commit-sha/u);
  assert.match(renderTaskLifecycleHelp("review-execution"), /--anti-entropy-token.*--anti-entropy-report/u);
  assert.match(renderTaskLifecycleHelp("complete"), /--execution-id <submitted-execution-id>/u);
});

test("task create always sends the fixed replay/v1 graph", async () => {
  const parsed = parseTaskLifecycleArgs(["task", "create", "--title", "Replay contract"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const received: unknown[] = [];
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    service: {
      execute: async (input) => {
        received.push(input);
        return { outcome: "applied", opId: input.command.opId, revision: 1 };
      },
      show: async () => ({ outcome: "applied", evidence: "projection:task" })
    }
  });

  assert.equal(receipt.outcome, "applied");
  assert.deepEqual((received[0] as { command: { graph: unknown } }).command.graph, REPLAY_TASK_GRAPH);
});

test("task start is one StartExecution host call and cannot enter review", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "start", "task_BOUNDARY", "--execution-id", "exe_BOUNDARY"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const received: unknown[] = [];
  await runTaskLifecycleFacade(parsed.value, {
    actor,
    service: {
      execute: async (input) => {
        received.push(input);
        return { outcome: "applied", opId: input.command.opId, revision: 2 };
      },
      show: async () => ({ outcome: "applied", evidence: "projection:task" })
    }
  });

  assert.equal(received.length, 1);
  assert.equal((received[0] as { command: { type: string } }).command.type, "StartExecution");
});

test("task show uses only the projection read port", async () => {
  const parsed = parseTaskLifecycleArgs(["task", "show", "task_READ"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let writes = 0;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    service: {
      execute: async () => {
        writes += 1;
        throw new Error("show attempted a write");
      },
      show: async ({ taskId }) => ({ outcome: "applied", evidence: `projection:${taskId}` })
    }
  });

  assert.equal(writes, 0);
  assert.deepEqual(receipt, { outcome: "applied", evidence: "projection:task_READ" });
});

test("signed rejected anti-entropy report records changes_requested without completing", async () => {
  const key = Buffer.from("anti-entropy-test-key", "utf8");
  const headSha = "c".repeat(40);
  const unsigned = {
    scope: "replay:cli",
    kind: "anti-entropy-review",
    verdict: "rejected",
    headSha,
    expiry: "2026-08-12T00:00:00.000Z"
  } as const;
  const token = encodeReceiptToken({ ...unsigned, signature: signReceipt(unsigned, key) });
  const report = antiEntropyReport({ verdict: "rejected", headSha, iteration: 1 });
  const parsed = parseTaskLifecycleArgs([
    "task", "review-execution", "task_REVIEW",
    "--execution-id", "exe_REVIEW",
    "--anti-entropy-token", token,
    "--anti-entropy-report", "/frozen/report.md"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const received: unknown[] = [];
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    environment: { ANTI_ENTROPY_HMAC_KEY: key.toString("utf8") },
    now: new Date("2026-08-11T00:00:00.000Z"),
    readReport: async () => report,
    verifyAntiEntropyReceipt: verifyWithGate,
    service: {
      execute: async (input) => {
        received.push(input);
        return { outcome: "applied", opId: input.command.opId, revision: 4 };
      },
      show: async () => ({ outcome: "applied", evidence: "unused" })
    }
  });

  assert.equal(receipt.outcome, "applied");
  assert.equal(received.length, 1);
  const input = received[0] as { command: Record<string, unknown>; capabilityRef: string };
  assert.equal(input.command.type, "RecordReview");
  assert.equal(input.command.kind, "anti_entropy");
  assert.equal(input.command.verdict, "changes_requested");
  assert.equal(input.command.actorRole, "anti_entropy");
  assert.deepEqual(input.command.actor, {
    principal: actor.principal,
    executor: { kind: "agent", id: "reviewer-session-fixture" }
  });
  assert.equal(input.command.commitSha, headSha);
  assert.equal(input.command.iteration, 0);
  assert.match(String(input.command.reason), /reconcile the deletion list.*declared deletion count/iu);
  assert.match(input.capabilityRef, /^anti-entropy-receipt:sha256:[a-f0-9]{64}$/u);
  assert.equal(input.capabilityRef.includes(token), false);
});

test("invalid anti-entropy token rejects with a concrete signing next action", async () => {
  const headSha = "d".repeat(40);
  const unsigned = {
    scope: "replay:cli",
    kind: "anti-entropy-review",
    verdict: "approved",
    headSha,
    expiry: "2026-08-12T00:00:00.000Z"
  } as const;
  const token = encodeReceiptToken({ ...unsigned, signature: "0".repeat(64) });
  const parsed = parseTaskLifecycleArgs([
    "task", "review-execution", "task_REVIEW",
    "--execution-id", "exe_REVIEW",
    "--anti-entropy-token", token,
    "--anti-entropy-report", "/frozen/report.md"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let calls = 0;
  const receipt = await runTaskLifecycleFacade(parsed.value, {
    actor,
    environment: { ANTI_ENTROPY_HMAC_KEY: "anti-entropy-test-key" },
    now: new Date("2026-08-11T00:00:00.000Z"),
    readReport: async () => antiEntropyReport({ verdict: "approved", headSha, iteration: 2 }),
    verifyAntiEntropyReceipt: verifyWithGate,
    service: {
      execute: async () => {
        calls += 1;
        return { outcome: "applied" };
      },
      show: async () => ({ outcome: "applied", evidence: "unused" })
    }
  });

  assert.equal(calls, 0);
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.code, "invalid_anti_entropy_receipt");
  assert.equal(receipt.origin, "receipt-verify");
  assert.match(receipt.nextAction ?? "", /squad-sign.*current HEAD/iu);
});

test("acceptance review maps strict CLI fields to RecordReview without a return edge", async () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "review-execution", "task_ACCEPT",
    "--execution-id", "exe_ACCEPT",
    "--kind", "acceptance",
    "--verdict", "approved",
    "--review-id", "review_ACCEPT",
    "--reason", "The current submitted Execution satisfies acceptance.",
    "--commit-sha", "f".repeat(40),
    "--iteration", "1",
    "--evidence-checked", "artifact:report",
    "--acknowledge-archive-warnings"
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let received: unknown;
  await runTaskLifecycleFacade(parsed.value, {
    actor,
    service: {
      execute: async (input) => {
        received = input;
        return { outcome: "applied", opId: input.command.opId, revision: 7 };
      },
      show: async () => ({ outcome: "applied", evidence: "unused" })
    }
  });
  const input = received as { command: Record<string, unknown>; capabilityRef?: string };
  assert.deepEqual(input.command, {
    type: "RecordReview",
    taskId: "task_ACCEPT",
    actor,
    opId: input.command.opId,
    executionId: "exe_ACCEPT",
    reviewId: "review_ACCEPT",
    kind: "acceptance",
    verdict: "approved",
    actorRole: "acceptance",
    reason: "The current submitted Execution satisfies acceptance.",
    evidenceChecked: ["artifact:report"],
    commitSha: "f".repeat(40),
    iteration: 1,
    archiveWarningsAcknowledged: true
  });
  assert.equal(input.capabilityRef, undefined);
});

test("acceptance review refuses changes_requested and points to anti-entropy", () => {
  const parsed = parseTaskLifecycleArgs([
    "task", "review-execution", "task_ACCEPT",
    "--execution-id", "exe_ACCEPT",
    "--kind", "acceptance",
    "--verdict", "changes_requested",
    "--review-id", "review_ACCEPT",
    "--reason", "needs work",
    "--commit-sha", "f".repeat(40),
    "--iteration", "1"
  ]);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error.nextAction, /anti-entropy.*token/iu);
});

function antiEntropyReport(input: { readonly verdict: "approved" | "rejected"; readonly headSha: string; readonly iteration: 1 | 2 }): string {
  const rejectedFinding = input.verdict === "rejected" ? [
    "Finding: AE-001",
    "returnTo: implementation.active",
    "Redo: reconcile the deletion list",
    "wallId: W18/G33",
    "Observation: declared deletion count differs from the machine count",
    "Expectation: both counts are identical",
    "Verify-Command: node tools/gates/production-delta.mjs"
  ].join("\n") : "Evidence: all four anti-entropy checks passed";
  return [
    "# Anti-Entropy Review Report",
    "Report-Schema: harness-anti-entropy-report/v1",
    "Scope: replay:cli",
    `Head-SHA: ${input.headSha}`,
    `Iteration: ${input.iteration}`,
    "Reviewer-Session: reviewer-session-fixture",
    `Snapshot-Digest: ${"e".repeat(64)}`,
    `Verdict: ${input.verdict}`,
    "---",
    rejectedFinding,
    `Verdict: ${input.verdict}`
  ].join("\n");
}

async function verifyWithGate(input: { readonly token: string; readonly scope: string; readonly verdict: "approved" | "rejected"; readonly headSha: string; readonly now: Date; readonly environment: NodeJS.ProcessEnv }): Promise<{ readonly ok: boolean; readonly errors: readonly string[] }> {
  const decoded = decodeReceiptToken(input.token);
  if (decoded.receipt === null) return { ok: false, errors: decoded.errors };
  return verifyReceipt(decoded.receipt, {
    key: antiEntropyVerificationKey(input.environment),
    now: input.now,
    scope: input.scope,
    kind: "anti-entropy-review",
    verdict: input.verdict,
    headSha: input.headSha
  });
}
