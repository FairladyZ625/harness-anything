// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("ha trace rejects missing, empty, absolute, Windows drive, and parent-escape paths", () => {
  for (const argv of [["trace"], ["trace", "../outside.ts"], ["trace", "/etc/passwd"], ["trace", "C:\\evil.ts"]]) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, false, `expected CLI rejection for ${JSON.stringify(argv)}`);
    if (!parsed.ok) assert.equal(parsed.code, "invalid_trace_path");
  }
});

test("ha trace parses Windows-slashed path and --limit before or after <path>", () => {
  const after = parseThinCommand([
    "trace",
    "packages\\daemon\\src\\fact-observed-commit.ts",
    "--limit",
    "15",
    "--json",
  ]);
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(after.command.method, "repo.task.read");
    assert.deepEqual(after.command.action, {
      kind: "trace",
      path: "packages/daemon/src/fact-observed-commit.ts",
      limit: 15,
    });
  }

  const before = parseThinCommand(["trace", "--limit", "25", "packages/daemon/src/fact-observed-commit.ts"]);
  assert.equal(before.ok, true);
  if (before.ok) {
    assert.deepEqual(before.command.action, {
      kind: "trace",
      path: "packages/daemon/src/fact-observed-commit.ts",
      limit: 25,
    });
  }
});

test("ha trace renders the four-section causal trace report including RJ3 Why Not redline", () => {
  const receipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "trace",
    outcome: "no_changes",
    evidence: JSON.stringify({
      schema: "file-trace-read/v1",
      ok: true,
      path: "packages/daemon/src/fact-observed-commit.ts",
      projectionCut: { status: "ready", watermark: 180, sourceRevision: 180 },
      touchHistory: [
        {
          commitSha: "b3dacc5578e6ca6898087eb483566706ba51f555",
          shortSha: "b3dacc557",
          prNumber: 3809,
          taskId: "task_c91624aa9991224b22edd39472",
          taskTitle: "Restore fact-observed-commit",
          taskStatus: "done",
          summary: "Merge pull request #3809 from FairladyZ625/task_c91624aa9991224b22edd39472",
        },
      ],
      decisions: [
        {
          decisionId: "dec_BB2BCE9F995CD3A126E2918734",
          title: "Adopt observedCommit",
          state: "in_effect",
          summary: "Auto-capture git HEAD SHA",
          viaTaskIds: ["task_c91624aa9991224b22edd39472"],
          viaModulePrefix: "packages/daemon/src",
          chosen: [{ id: "CH4", summary: "Capture git HEAD SHA automatically" }],
          rejected: [
            {
              id: "RJ3",
              summary: "Maintain static code-doc-anchors.json",
              whyNot: "Static file anchors cause merge conflicts.",
            },
          ],
        },
      ],
      facts: [
        {
          factId: "F-300F8791",
          domainType: "architecture.invariant",
          subjectRef: "packages/daemon/src/fact-observed-commit.ts",
          summary: "fact-observed-commit captures HEAD commit cleanly.",
          loadBearing: true,
          observedCommit: "0603933faa35e8c946f9b0bcf6f4ee243d02dfeb",
          recordedByTaskId: "task_c91624aa9991224b22edd39472",
        },
      ],
      activeTasks: [],
    }),
  };
  const rendered = renderCliReceipt(receipt);
  assert.equal(rendered.stream, "stdout");
  assert.match(rendered.text, /=== Causal Trace: packages\/daemon\/src\/fact-observed-commit\.ts/u);
  assert.match(rendered.text, /\[1\] Touch History \(1 commits, 1 tasks\)/u);
  assert.match(rendered.text, /\[2\] Governing Decisions & Redlines \(1\)/u);
  assert.match(rendered.text, /RJ3 \(PROHIBITED\)/u);
  assert.match(rendered.text, /Why Not: Static file anchors cause merge conflicts\./u);
  assert.match(rendered.text, /\[3\] Load-Bearing Facts \(1\)/u);
  assert.match(rendered.text, /\[4\] Active Worktree Radar \(0 concurrent tasks\)/u);

  const emptyReceipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "trace",
    outcome: "no_changes",
    evidence: JSON.stringify({
      schema: "file-trace-read/v1",
      ok: true,
      path: "src/brand-new-file.ts",
      projectionCut: { status: "ready", watermark: 180, sourceRevision: 180 },
      touchHistory: [],
      decisions: [],
      facts: [],
      activeTasks: [],
    }),
  };
  const emptyRendered = renderCliReceipt(emptyReceipt);
  assert.match(emptyRendered.text, /\(no recorded history\)/u);
});
