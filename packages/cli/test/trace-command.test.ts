// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("ha trace sends the raw path and --limit before or after it on the shared repo.task.read method", () => {
  for (const argv of [
    ["trace", "packages\\daemon\\src\\x.ts", "--limit", "15", "--json"],
    ["trace", "--limit", "15", "packages\\daemon\\src\\x.ts"],
  ]) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) continue;
    assert.equal(parsed.command.method, "repo.task.read");
    assert.deepEqual(parsed.command.action, { kind: "trace", path: "packages\\daemon\\src\\x.ts", limit: 15 });
  }
  const bare = parseThinCommand(["trace", "tools/gates/cost-budget.json"]);
  assert.equal(
    bare.ok && JSON.stringify(bare.command.action),
    JSON.stringify({ kind: "trace", path: "tools/gates/cost-budget.json" }),
  );
});

test("ha trace refuses a missing path and an out-of-range limit locally", () => {
  for (const argv of [["trace"], ["trace", "--limit", "5"]]) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, false, JSON.stringify(argv));
    if (!parsed.ok) assert.equal(parsed.code, "missing_field");
  }
  for (const limit of ["0", "201", "abc"]) {
    const parsed = parseThinCommand(["trace", "a/b.ts", "--limit", limit]);
    assert.equal(parsed.ok, false, limit);
  }
});

test("ha trace renders history, redlines with whyNot, anchored facts, collisions and git unavailability", () => {
  const evidence = {
    schema: "file-trace-read/v1",
    ok: true,
    path: "packages/daemon/src/daemon-host/fact-observed-commit.ts",
    projectionCut: { status: "ready", watermark: 180, sourceRevision: 180 },
    git: { availability: "available" },
    touchHistory: [
      {
        commitSha: "b".repeat(40),
        shortSha: "bbbbbbbbb",
        prNumber: 3809,
        taskId: "task_c91624aa9991224b22edd39472",
        taskTitle: "Restore observed commit",
        taskStatus: "done",
        summary: "Merge pull request #3809 from o/task_c91624aa9991224b22edd39472",
        paths: [],
      },
    ],
    decisions: [
      {
        decisionId: "dec_BB2BCE9F995CD3A126E2918734",
        title: "Adopt observedCommit",
        state: "in_effect",
        summary: "Capture HEAD",
        viaTaskIds: ["task_c91624aa9991224b22edd39472"],
        viaModulePrefix: "packages/daemon/src",
        tracePaths: [],
        chosen: [{ id: "CH4", summary: "Capture git HEAD SHA automatically" }],
        rejected: [{ id: "RJ3", summary: "Maintain static code-doc-anchors.json", whyNot: "Static anchors conflict." }],
      },
    ],
    facts: [
      {
        factId: "F-300F8791",
        ref: "fact/F-300F8791",
        domainType: "architecture.invariant",
        summary: "fact-observed-commit captures HEAD.",
        evidenceSource: "packages/daemon/src/daemon-host/fact-observed-commit.ts:15",
        observedCommit: "0603933faa35e8c946f9b0bcf6f4ee243d02dfeb",
        recordedByTaskId: null,
        matchReason: "evidence_source",
        tracePaths: [],
      },
    ],
    activeTasks: [
      {
        taskId: "task_cccccccccccccccccccccccccc",
        title: "Concurrent edit",
        status: "active",
        branch: "task_cccccccccccccccccccccccccc",
        commits: 2,
        matchReason: "branch_diff",
      },
    ],
  };
  const receipt = (value: object) => ({
    schema: "command-receipt/v2",
    ok: true,
    command: "trace",
    outcome: "no_changes",
    evidence: JSON.stringify(value),
  });
  const rendered = renderCliReceipt(receipt(evidence));
  assert.equal(rendered.stream, "stdout");
  assert.match(
    rendered.text,
    /=== Causal Trace: packages\/daemon\/src\/daemon-host\/fact-observed-commit\.ts \(cut: rev 180\) ===/u,
  );
  assert.match(
    rendered.text,
    /\[1\] Touch History \(1 commits\)\n {2}• PR #3809 \(bbbbbbbbb\) -> task_c91624aa9991224b22edd39472 \[done\]/u,
  );
  assert.match(rendered.text, /\[2\] Governing Decisions & Redlines \(1\)/u);
  assert.match(
    rendered.text,
    /✗ RJ3 \(PROHIBITED\): Maintain static code-doc-anchors\.json\n {6}Why Not: Static anchors conflict\./u,
  );
  assert.match(
    rendered.text,
    /\[3\] Anchored Facts \(1\)\n {2}• F-300F8791 \[architecture\.invariant; evidence_source @ 0603933f\]/u,
  );
  assert.match(
    rendered.text,
    /\[4\] Active Branch Collisions \(1\)\n {2}• task_cccccccccccccccccccccccccc \[active\]/u,
  );
  assert.doesNotMatch(rendered.text, /Git history unavailable/u);
  const offline = renderCliReceipt(
    receipt({
      ...evidence,
      git: { availability: "unavailable", reason: "git_worktree_unavailable", message: "no worktree" },
      touchHistory: [],
      decisions: [],
      facts: [],
      activeTasks: [],
    }),
  );
  assert.match(offline.text, /! Git history unavailable \(git_worktree_unavailable\): no worktree/u);
  assert.match(offline.text, /\(no recorded history\)/u);
});
