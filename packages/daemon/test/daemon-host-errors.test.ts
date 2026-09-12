// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { rejectHostAction, rejectPresetRun } from "../src/daemon-host-errors.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";

test("a host-rejected action keeps its coded message as the receipt explanation", () => {
  const message = "CI receipt cannot support completion: evidence executionId is not the current execution.",
    receipt = rejectHostAction({ kind: "task-complete", taskId: "task-1" } as RepoTaskAction, "invalid_proof", message);
  assert.equal(receipt.code, "invalid_proof");
  assert.equal(receipt.rejectionExplanation, message);
  assert.deepEqual(receipt.diagnostic, { kind: "failure", code: "invalid_proof" });
});

test("a host-rejected preset run keeps its coded message as the receipt explanation", () => {
  const message = "Repository repository-a is still warming up.",
    receipt = rejectPresetRun("run-1", "repo_warming", message);
  assert.equal(receipt.code, "repo_warming");
  assert.equal(receipt.rejectionExplanation, message);
});
