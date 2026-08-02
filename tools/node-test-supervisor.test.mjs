// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  beginClosing,
  beginReaping,
  createRunningWorker,
  flushCompletionProof,
  settleWorker
} from "./node-test-supervisor.ts";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const close = { code: 0, signal: null, error: null };

test("a naturally closed worker passes only after its structured proof flushed", () => {
  const running = createRunningWorker("worker-a", "a.test.ts");
  const proof = flushCompletionProof(running, { success: true, counts: counts({ tests: 1, passed: 1 }) });
  assert.equal(settleWorker(beginClosing(proof), close).outcome, "passed");
  assert.equal(
    settleWorker(beginClosing(running), close).failure.kind,
    "closed-before-proof"
  );
});

test("a successful flushed proof permits pass after owned-tree reaping", () => {
  const running = createRunningWorker("worker-a", "a.test.ts");
  const proof = flushCompletionProof(running, { success: true, counts: counts({ tests: 1, passed: 1 }) });
  const settled = settleWorker(
    beginReaping(proof, { kind: "post-proof-exit-wedge" }),
    { code: null, signal: "SIGKILL", error: null }
  );
  assert.equal(settled.outcome, "passed-after-reap");
  assert.equal(settled.proof.workerId, "worker-a");
});

test("reaping before proof is an exact named failure", () => {
  const running = createRunningWorker("worker-a", "a.test.ts");
  const settled = settleWorker(
    beginReaping(running, { kind: "deadline-before-proof" }),
    { code: null, signal: "SIGKILL", error: null }
  );
  assert.deepEqual(settled.failure, { name: "a.test.ts", kind: "deadline-before-proof" });
});

test("a real failed proof remains failed after owned-tree reaping", () => {
  const running = createRunningWorker("worker-a", "a.test.ts");
  const proof = flushCompletionProof(running, { success: false, counts: counts({ tests: 1, failed: 1 }) });
  const settled = settleWorker(
    beginReaping(proof, { kind: "post-proof-exit-wedge" }),
    { code: null, signal: "SIGKILL", error: null },
    "real failure"
  );
  assert.equal(settled.outcome, "failed-after-reap");
  assert.deepEqual(settled.failure, { name: "real failure", kind: "test-failure" });
});

test("a non-lifecycle proof error cannot be converted into an exceptional pass", () => {
  const running = createRunningWorker("worker-a", "a.test.ts");
  const proof = flushCompletionProof(running, { success: true, counts: counts({ tests: 1, passed: 1 }) });
  const settled = settleWorker(
    beginReaping(proof, { kind: "invalid-structured-proof", detail: "second summary" }),
    { code: null, signal: "SIGKILL", error: null }
  );
  assert.equal(settled.outcome, "failed");
  assert.deepEqual(settled.failure, {
    name: "a.test.ts",
    kind: "invalid-structured-proof",
    detail: "second summary"
  });
});

test("completion reporter flushes every structured proof record before exit", () => {
  const result = spawnSync(process.execPath, [
    "tools/test-fixtures/.runner-stall/completion-reporter-flush.mjs"
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000
  });
  const proofOutput = result.output[3] ?? "";
  const records = proofOutput.trimEnd().split("\n").map((line) => JSON.parse(line));

  assert.equal(result.error, undefined, result.output[2] ?? "");
  assert.equal(result.status, 0, result.output[2] ?? "");
  assert.equal(proofOutput.endsWith("\n"), true);
  assert.equal(records.filter((record) => record.type === "test-file-summary").length, 20_000);
  assert.deepEqual(records.at(-1), {
    type: "test-run-summary",
    success: true,
    counts: counts({ tests: 20_000, passed: 20_000 })
  });
});

function counts(overrides = {}) {
  return {
    tests: 0,
    failed: 0,
    passed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides
  };
}
