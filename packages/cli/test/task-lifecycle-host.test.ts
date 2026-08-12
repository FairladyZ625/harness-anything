// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskLifecycleEffect } from "../../application/src/index.ts";
import { makeJournaledWriteCoordinator } from "../../kernel/src/index.ts";
import type { CommandRunnerContext } from "../src/cli/runner-registry.ts";
import type { ParsedCommand, TaskLifecycleCliAction } from "../src/cli/types.ts";
import { makeLocalGateReceiptVerifier, verifySignedAntiEntropyReceipt } from "../src/cli/task-lifecycle-authority.ts";
import { makeTaskLifecycleHost, runTaskLifecycleFacadeCommand } from "../src/commands/core/task-lifecycle-host.ts";
import { parseTaskLifecycleArgs, runTaskLifecycleFacade } from "../src/commands/core/task-lifecycle.ts";
import { encodeReceiptToken, signReceipt } from "../../../tools/gates/receipt-verify.mjs";

const actor = {
  principal: { personId: "person_host" },
  executor: { kind: "agent" as const, id: "executor-host" }
};

test("host binds the lease to the authenticated actor, execution, and version", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-host-"));
  try {
    const host = makeTaskLifecycleHost({
      rootDir,
      layoutInput: rootDir,
      makeWriteCoordinator: () => makeJournaledWriteCoordinator({ rootDir }),
      actorAttribution: () => ({
        actor: { kind: "agent", id: "executor-host" },
        commitAuthor: { name: "Host Test", email: "host@example.test" },
        source: "env"
      })
    } as CommandRunnerContext);

    const create = parsed(["task", "create", "--task-id", "task_HOST", "--title", "Host task"]);
    assert.equal((await runTaskLifecycleFacade(create, { actor, workspaceId: rootDir, service: host })).outcome, "applied");

    const start = parsed(["task", "start", "task_HOST", "--execution-id", "execution_HOST"]);
    const first = await runTaskLifecycleFacade(start, { actor, workspaceId: rootDir, service: host });
    assert.equal(first.outcome, "applied");

    const streamPath = path.join(rootDir, "harness/task-events.ndjson");
    assert.equal(readFileSync(streamPath, "utf8").includes("credential"), false);
    const projectionBytes = readFileSync(path.join(rootDir, ".harness/cache/task.sqlite")).toString("latin1");
    assert.equal(projectionBytes.includes("credential"), false);

    const retried = await runTaskLifecycleFacade(start, { actor, workspaceId: rootDir, service: host });
    assert.equal(retried.outcome, "rejected");
    assert.equal(retried.code, "invalid_transition");
    const shown = await host.show({ taskId: "task_HOST" });
    assert.deepEqual(JSON.parse(shown.evidence ?? "{}").lease?.actor, actor);

    const submit = parsed([
      "task", "submit", "task_HOST", "--execution-id", "execution_HOST",
      "--claim", "ready", "--commit-sha", "a".repeat(40)
    ]);
    const submitted = await runTaskLifecycleFacade(submit, { actor, workspaceId: rootDir, service: host });
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("real runner accepts a valid anti-entropy signature and rejects tampered, expired, or missing verification", async () => {
  const previousKey = process.env.ANTI_ENTROPY_HMAC_KEY;
  process.env.ANTI_ENTROPY_HMAC_KEY = "runner-receipt-key";
  try {
    for (const variant of ["valid", "tampered", "expired", "missing"] as const) {
      const rootDir = mkdtempSync(path.join(tmpdir(), `ha-task-g34-${variant}-`));
      try {
        const context = runnerContext(rootDir, actor, variant === "missing" ? {} : { verifyAntiEntropyReceipt: verifySignedAntiEntropyReceipt });
        await submittedTask(context, `task_${variant}`, `execution_${variant}`);
        const headSha = "b".repeat(40);
        const reportPath = writeReport(rootDir, headSha, "approved");
        const token = signedToken(headSha, variant === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
          variant === "tampered" ? "0".repeat(64) : undefined);
        const result = await runRunner(context, [
          "task", "review-execution", `task_${variant}`, "--execution-id", `execution_${variant}`,
          "--anti-entropy-token", token, "--anti-entropy-report", reportPath
        ]);
        if (variant === "valid") assert.equal(result.ok, true);
        else {
          assert.equal(result.ok, false);
          assert.match(String((result as { readonly code?: string }).code), variant === "missing" ? /receipt_verifier_unavailable/u : /invalid_anti_entropy_receipt/u);
        }
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  } finally {
    if (previousKey === undefined) delete process.env.ANTI_ENTROPY_HMAC_KEY;
    else process.env.ANTI_ENTROPY_HMAC_KEY = previousKey;
  }
});

test("host rejects unauthorized completion and forged gate receipt before accepting verified authority", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-g09-"));
  const previousKey = process.env.ANTI_ENTROPY_HMAC_KEY;
  process.env.ANTI_ENTROPY_HMAC_KEY = "runner-receipt-key";
  const ownerContext = runnerContext(rootDir, actor, {
    verifyAntiEntropyReceipt: verifySignedAntiEntropyReceipt,
    authorizeTaskLifecycleActor: testAuthorizer,
    verifyGateReceipt: makeLocalGateReceiptVerifier(rootDir)
  });
  const reviewer = { principal: { personId: "person_reviewer" }, executor: { kind: "agent" as const, id: "reviewer-host" } };
  const reviewerContext = runnerContext(rootDir, reviewer, {
    verifyAntiEntropyReceipt: verifySignedAntiEntropyReceipt,
    authorizeTaskLifecycleActor: testAuthorizer,
    verifyGateReceipt: makeLocalGateReceiptVerifier(rootDir)
  });
  try {
    await submittedTask(ownerContext, "task_G09", "execution_G09", ["--completion-gate", "G10"]);
    const commitSha = "b".repeat(40);
    const reportPath = writeReport(rootDir, commitSha, "approved");
    assert.equal((await runRunner(reviewerContext, [
      "task", "review-execution", "task_G09", "--execution-id", "execution_G09",
      "--anti-entropy-token", signedToken(commitSha, "2099-01-01T00:00:00.000Z"), "--anti-entropy-report", reportPath
    ])).ok, true);
    assert.equal((await runRunner(reviewerContext, [
      "task", "review-execution", "task_G09", "--execution-id", "execution_G09", "--kind", "acceptance",
      "--verdict", "approved", "--review-id", "review_G09", "--reason", "accepted",
      "--commit-sha", commitSha, "--iteration", "0"
    ])).ok, true);

    const intruder = runnerContext(rootDir, { principal: { personId: "person_intruder" }, executor: null }, {
      verifyAntiEntropyReceipt: verifySignedAntiEntropyReceipt,
      authorizeTaskLifecycleActor: testAuthorizer,
      verifyGateReceipt: makeLocalGateReceiptVerifier(rootDir)
    });
    const unauthorized = await runRunner(intruder, ["task", "complete", "task_G09", "--execution-id", "execution_G09", "--gate-receipt", "G10:artifacts/g10.json"]);
    assert.equal(unauthorized.ok, false);
    assert.equal((unauthorized as { readonly code?: string }).code, "actor_unauthorized");

    const forged = await runRunner(ownerContext, ["task", "complete", "task_G09", "--execution-id", "execution_G09", "--gate-receipt", "G10:artifacts/missing.json"]);
    assert.equal(forged.ok, false);
    assert.equal((forged as { readonly code?: string }).code, "gate_receipt_unverified");
    mkdirSync(path.join(rootDir, "artifacts"), { recursive: true });
    writeFileSync(path.join(rootDir, "artifacts/g10.json"), "receipt\n", "utf8");
    const completed = await runRunner(ownerContext, ["task", "complete", "task_G09", "--execution-id", "execution_G09", "--gate-receipt", "G10:artifacts/g10.json"]);
    assert.equal(completed.ok, true);
  } finally {
    if (previousKey === undefined) delete process.env.ANTI_ENTROPY_HMAC_KEY;
    else process.env.ANTI_ENTROPY_HMAC_KEY = previousKey;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function parsed(args: readonly string[]) {
  const result = parseTaskLifecycleArgs(args);
  assert.equal(result.ok, true, args.join(" "));
  if (!result.ok) throw new Error(result.error.nextAction);
  return result.value;
}

function runnerContext(rootDir: string, axes: typeof actor | { readonly principal: { readonly personId: string }; readonly executor: null }, overrides: Partial<CommandRunnerContext>): CommandRunnerContext {
  return {
    rootDir,
    layoutInput: rootDir,
    makeWriteCoordinator: () => makeJournaledWriteCoordinator({ rootDir, lockConflictRetry: { maxWaitMs: 2_000 } }),
    actorAttribution: () => ({
      actor: axes.executor ? { kind: "agent", id: axes.executor.id } : { kind: "human", id: axes.principal.personId },
      commitAuthor: { name: "Host Test", email: "host@example.test" },
      source: "env"
    }),
    actorAxes: () => axes,
    ...overrides
  } as CommandRunnerContext;
}

async function submittedTask(context: CommandRunnerContext, taskId: string, executionId: string, createExtra: readonly string[] = []): Promise<void> {
  assert.equal((await runRunner(context, ["task", "create", "--task-id", taskId, "--title", "Runner task", ...createExtra])).ok, true);
  const started = await runRunner(context, ["task", "start", taskId, "--execution-id", executionId]);
  assert.equal(started.ok, true);
  assert.equal((await runRunner(context, [
    "task", "submit", taskId, "--execution-id", executionId,
    "--claim", "ready", "--commit-sha", "b".repeat(40)
  ])).ok, true);
}

async function runRunner(context: CommandRunnerContext, args: readonly string[]) {
  const action = parsed(args) as TaskLifecycleCliAction;
  return runTaskLifecycleEffect(runTaskLifecycleFacadeCommand(context, { rootDir: context.rootDir, action, json: true } as ParsedCommand));
}

function writeReport(rootDir: string, headSha: string, verdict: "approved" | "rejected"): string {
  const reportPath = path.join(rootDir, `report-${verdict}-${headSha.slice(0, 4)}.md`);
  writeFileSync(reportPath, [
    "# Anti-Entropy Review Report", "Report-Schema: harness-anti-entropy-report/v1", "Scope: replay:cli",
    `Head-SHA: ${headSha}`, "Iteration: 1", "Reviewer-Session: reviewer-session-fixture",
    `Snapshot-Digest: ${"e".repeat(64)}`, `Verdict: ${verdict}`, "---", "Evidence: verified runner fixture", `Verdict: ${verdict}`
  ].join("\n"), "utf8");
  return reportPath;
}

function signedToken(headSha: string, expiry: string, signature?: string): string {
  const unsigned = { scope: "replay:cli", kind: "anti-entropy-review", verdict: "approved", headSha, expiry } as const;
  const key = Buffer.from("runner-receipt-key", "utf8");
  return encodeReceiptToken({ ...unsigned, signature: signature ?? signReceipt(unsigned, key) });
}

const testAuthorizer: NonNullable<CommandRunnerContext["authorizeTaskLifecycleActor"]> = async ({ capability, actor: candidate }) => {
  if (capability === "acceptance-review@v1" && candidate.principal.personId === "person_reviewer") {
    return { ok: true, capabilityRef: "test-authority:reviewer", actorRole: "acceptance" };
  }
  if (capability === "task-complete@v1" && candidate.principal.personId === actor.principal.personId) {
    return { ok: true, capabilityRef: "test-authority:owner", actorRole: "owner" };
  }
  return { ok: false, nextAction: `Authorize ${candidate.principal.personId} before retrying.` };
};
