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

test("task show exposes automatic review dispatch failure and its retry command", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-show",
    outcome: "applied",
    summary: "task-show: applied",
    evidence: JSON.stringify({
      task: {
        status: "in_review",
        currentNode: "review",
        completionGateIds: [],
        reviewDispatchFailure: {
          executionId: "execution-edge-1",
          dispatchKey: "review-key-1",
          code: "runtime_spawn_failed",
          message:
            "Node edge-one could not start the automatic reviewer. Ask the task owner to retry with ha task dispatch-review task-one.",
          failedAt: "2026-11-07T00:00:00.000Z",
        },
      },
    }),
  });
  assert.match(
    rendered.text,
    /^review dispatch failed: runtime_spawn_failed; Node edge-one could not start the automatic reviewer\. Ask the task owner to retry with ha task dispatch-review task-one\.$/mu,
  );
});

test("task show labels the delivery baseline as the start-frozen comparison cut, not the delivery head", () => {
  const sha = "4".repeat(40),
    rendered = renderCliReceipt({
      ok: true,
      command: "task-show",
      outcome: "applied",
      summary: "task-show: applied",
      evidence: JSON.stringify({
        task: { status: "in_review", currentNode: "review", completionGateIds: [] },
        deliveryBaselineNote:
          "the comparison cut frozen at execution start, before the first submission — " +
          "not the delivery head; advancing main or --amend never refreshes it",
        currentExecutions: [{ executionId: "execution-1", state: "submitted" }],
        executions: [
          { schema: "execution/v1", executionId: "execution-1", deliveryBaseline: { kind: "commit", commitSha: sha } },
        ],
      }),
    });
  assert.match(
    rendered.text,
    new RegExp(
      `^delivery baseline: ${sha} \\(the comparison cut frozen at execution start, before the first submission — ` +
        "not the delivery head; advancing main or --amend never refreshes it\\)$",
      "mu",
    ),
  );
});

test("task show prints the daemon-derived takeover cut and actual handoff phase", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const rendered = renderCliReceipt({
    ok: true,
    command: "task-show",
    summary: "task-show: applied",
    outcome: "applied",
    opId: "show",
    evidence: JSON.stringify({
      task: {
        status: "active",
        currentNode: "implementation",
        completionGateIds: [],
        executionArrangement: { id: "arrangement-1", iteration: 2, ready: false },
      },
      reworkTargets: [{ executionId: "execution-old", submissionDigest: digest }],
    }),
  });
  assert.match(
    rendered.text,
    new RegExp(`rework cut: --execution-id execution-old --submission-digest ${digest}`, "u"),
  );
  assert.match(rendered.text, /execution arrangement: arrangement-1; handoff pending; round 2/u);
});
