// harness-test-tier: fast

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as closeout from "./closeout-task.mjs";

const { CloseoutCommandError, parseCloseoutArgs, runCloseout, validateCloseoutJudgment } = closeout;

const taskId = "task-closeout", executionId = "execution-closeout", packagePath = "tasks/task-closeout-fast-path", commitSha = "a".repeat(40);
const owner = { principal: { personId: "owner" }, executor: { kind: "agent", id: "ceo" } };
const worker = { principal: { personId: "owner" }, executor: { kind: "agent", id: "worker" } };

function judgment() {
  return {
    submission: {
      completionClaim: "The caller judged the implementation complete.",
      deliverables: ["tools/closeout-task.mjs"],
      outputs: ["deterministic closeout"],
      verificationNotes: ["targeted tests passed"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    },
    review: { verdict: "approved", reason: "Independent semantic review passed.", evidenceChecked: ["targeted tests"] },
    consent: { approved: true },
    completion: { ci: "passed", codeDocPaths: ["tools/closeout-task.mjs"] },
  };
}

function taskShowReceipt() {
  return {
    evidence: JSON.stringify({
      task: { taskId, status: "active", currentNode: "implementation", createdBy: owner },
      executions: [{ executionId, state: "active", iteration: 0, actor: worker, submission: null }],
      lease: { executionId, actor: worker },
      packagePath,
    }),
  };
}

function docStatusReceipt(rows = [{ path: `${packagePath}/closeout.md`, state: "eligible" }]) {
  return { evidence: `doc-scan:${JSON.stringify({ rows })}` };
}

function successfulRunner(overrides = {}) {
  const calls = [];
  const run = ({ step, args, actor }) => {
    calls.push({ step, args, actor });
    if (overrides[step]) return overrides[step]({ step, args, actor, calls });
    if (step === "task-show") return { command: ["ha", ...args], receipt: taskShowReceipt() };
    if (step === "doc-status") return { command: ["ha", ...args], receipt: docStatusReceipt() };
    return { command: ["ha", ...args], receipt: { outcome: "applied", step } };
  };
  return { calls, run };
}

test("closeout driver preserves all gates and derives actor/content-cut bindings", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-closeout-test-"));
  try {
    const fixture = successfulRunner({
      "task-submit": ({ args }) => {
        const packet = JSON.parse(readFileSync(args.at(-1), "utf8"));
        assert.deepEqual(packet, judgment().submission);
        return { command: ["ha", ...args], receipt: { outcome: "applied" } };
      },
      "task-review-execution": ({ args }) => {
        const packet = JSON.parse(readFileSync(args.at(-1), "utf8"));
        assert.deepEqual(packet, { ...judgment().review, commitSha, iteration: 0 });
        return { command: ["ha", ...args], receipt: { outcome: "applied" } };
      },
    });
    const receipt = runCloseout({ taskId, executionId, judgment: judgment() }, { run: fixture.run, temporaryDirectory });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.commitSha, commitSha);
    assert.deepEqual(fixture.calls.map((call) => call.step), ["task-show", "doc-status", "doc-sync", "task-submit", "task-review-execution", "task-review-consent", "task-complete"]);
    assert.deepEqual(fixture.calls.map((call) => call.actor), [null, "agent:worker", "agent:worker", "agent:worker", null, "agent:ceo", "agent:ceo"]);
    const complete = fixture.calls.at(-1).args;
    assert.deepEqual(complete, ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed", "--commit-sha", commitSha, "--iteration", "0", "--path", "tools/closeout-task.mjs"]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("default CLI entry is anchored to the closeout script instead of the caller cwd", () => {
  const callerCwd = path.join(import.meta.dirname, "fixtures", "nested-cwd");
  assert.equal(typeof closeout.resolveCloseoutLauncher, "function");
  assert.deepEqual(closeout.resolveCloseoutLauncher({ cwd: callerCwd }), {
    executable: process.execPath,
    leadingArgs: [path.join(import.meta.dirname, "..", "packages", "cli", "src", "index.ts")],
  });
});

test("empty codeDocPaths omits the complete reconcile tuple", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-closeout-empty-paths-"));
  const fixture = successfulRunner();
  const packet = judgment();
  packet.completion.codeDocPaths = [];
  try {
    runCloseout({ taskId, executionId, judgment: packet }, { run: fixture.run, temporaryDirectory });
    assert.deepEqual(fixture.calls.at(-1).args, ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed"]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("empty codeDocPaths preserves the code-doc completion gate rejection", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-closeout-code-doc-gate-"));
  const rejection = new CloseoutCommandError(["ha", "task", "complete"], 1, JSON.stringify({ ok: false, code: "code_doc_missing" }), "");
  const fixture = successfulRunner({ "task-complete": () => { throw rejection; } });
  const packet = judgment();
  packet.completion.codeDocPaths = [];
  try {
    assert.throws(
      () => runCloseout({ taskId, executionId, judgment: packet }, { run: fixture.run, temporaryDirectory }),
      (error) => error === rejection && error.stdout.includes("code_doc_missing"),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

for (const [step, code] of [["task-review-execution", "invalid_proof"], ["task-review-consent", "actor_unauthorized"]]) {
  test(`${step} rejection is rethrown unchanged`, () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-closeout-reject-"));
    const rejection = new CloseoutCommandError(["ha", step], 1, JSON.stringify({ ok: false, code }), `error code=${code}\n`);
    const fixture = successfulRunner({ [step]: () => { throw rejection; } });
    try {
      assert.throws(
        () => runCloseout({ taskId, executionId, judgment: judgment() }, { run: fixture.run, temporaryDirectory }),
        (error) => error === rejection && error.stdout.includes(code) && error.stderr.includes(code),
      );
      assert.equal(fixture.calls.at(-1).step, step);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
}

test("foreign eligible doc candidates defer task-owned artifacts to scoped completion sync", () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-closeout-foreign-"));
  const fixture = successfulRunner({
    "doc-status": ({ args }) => ({ command: ["ha", ...args], receipt: docStatusReceipt([
      { path: `${packagePath}/closeout.md`, state: "eligible" },
      { path: "tasks/someone-else/closeout.md", state: "eligible" },
    ]) }),
  });
  try {
    const receipt = runCloseout({ taskId, executionId, judgment: judgment() }, { run: fixture.run, temporaryDirectory });
    assert.equal(receipt.docSyncMode, "deferred_to_task_complete");
    assert.deepEqual(receipt.deferredForeignCandidates, ["tasks/someone-else/closeout.md"]);
    assert.deepEqual(fixture.calls.map((call) => call.step), ["task-show", "doc-status", "task-submit", "task-review-execution", "task-review-consent", "task-complete"]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("foreign candidates still stop when task-owned prose cannot ride task complete", () => {
  const fixture = successfulRunner({
    "doc-status": ({ args }) => ({ command: ["ha", ...args], receipt: docStatusReceipt([
      { path: `${packagePath}/task_plan.md`, state: "eligible" },
      { path: "tasks/someone-else/closeout.md", state: "eligible" },
    ]) }),
  });
  assert.throws(() => runCloseout({ taskId, executionId, judgment: judgment() }, { run: fixture.run }), /cannot carry.*task_plan\.md/u);
  assert.deepEqual(fixture.calls.map((call) => call.step), ["task-show", "doc-status"]);
});

test("judgments and CLI input are exact rather than inferred", () => {
  assert.equal(parseCloseoutArgs(["--task-id", taskId, "--execution-id", executionId, "--from-file", "judgment.json"]).taskId, taskId);
  assert.equal(validateCloseoutJudgment(judgment()).consent.approved, true);
  assert.throws(() => validateCloseoutJudgment({ ...judgment(), consent: { approved: false } }), /never invents consent/u);
  assert.throws(() => validateCloseoutJudgment({ ...judgment(), review: { ...judgment().review, generatedReason: "no" } }), /requires exactly/u);
});
