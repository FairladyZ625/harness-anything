// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

function workspaceLine(worktreeSetup: unknown): string {
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-show",
    outcome: "applied",
    summary: "task-show: applied",
    evidence: JSON.stringify({
      task: { status: "active", currentNode: "execute", completionGateIds: [] },
      workspace: { kind: "worktree", path: ".worktrees/task_1", branch: "task_1", state: "materialized" },
      worktreeSetup,
    }),
  });
  return rendered.text.split("\n").find((line) => line.startsWith("workspace: "))!;
}

test("a declared step this worktree has not run yet shows as pending, not as done", () => {
  assert.equal(
    workspaceLine({ declared: ["node-modules"], succeeded: [] }),
    "workspace: .worktrees/task_1 (worktree on branch task_1, materialized; " +
      "setup: node-modules (pending, runs at next start); managed by Harness, no command needed)",
  );
});

test("steps recorded as succeeded in this worktree show as done", () => {
  assert.equal(
    workspaceLine({ declared: ["node-modules", "run: uv sync"], succeeded: ["node-modules", "run: uv sync"] }),
    "workspace: .worktrees/task_1 (worktree on branch task_1, materialized; " +
      "setup: node-modules (done); run: uv sync (done); managed by Harness, no command needed)",
  );
});

test("a step that ran before Settings dropped it still shows as done", () => {
  assert.match(workspaceLine({ declared: [], succeeded: ["node-modules"] }), /; setup: node-modules \(done\); /u);
});

test("without a checkout on this node the setup record is unknown, not guessed", () => {
  assert.match(
    workspaceLine({ declared: ["node-modules"], succeeded: null }),
    /; setup: node-modules \(unknown: no checkout on this node\); /u,
  );
  assert.match(workspaceLine({ declared: [], succeeded: null }), /; setup: none; /u);
  assert.match(workspaceLine({ declared: [], succeeded: [] }), /; setup: none; /u);
});

test("task show states the expected-version optimistic-concurrency commands resend", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-show",
    outcome: "applied",
    expectedVersion: 161594,
    summary: "task-show: applied",
    evidence: JSON.stringify({ task: { status: "active", currentNode: "execute", completionGateIds: [] } }),
  });
  assert.match(
    rendered.text,
    /^expected-version: 161594 \(pass as --expected-version to assign\/unassign\/transition\)$/mu,
  );
});
