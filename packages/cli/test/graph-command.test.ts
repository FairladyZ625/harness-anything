// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("ha graph parses a ref positional and --depth into a repo.task.read action", () => {
  const plain = parseThinCommand(["graph", "task_abc123"]),
    deep = parseThinCommand(["graph", "dec_1/C1", "--depth", "5"]),
    slugged = parseThinCommand(["graph", "milestone-w4"]);
  for (const parsed of [plain, deep, slugged]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (plain.ok) assert.deepEqual(plain.command.action, { kind: "graph", ref: "task_abc123" });
  if (deep.ok) assert.deepEqual(deep.command.action, { kind: "graph", ref: "dec_1/C1", depth: 5 });
  if (slugged.ok) assert.deepEqual(slugged.command.action, { kind: "graph", ref: "milestone-w4" });
  if (plain.ok) assert.equal(plain.command.method, "repo.task.read");
});

test("ha graph rejects a missing ref and an out-of-range depth", () => {
  const missing = parseThinCommand(["graph"]),
    flagged = parseThinCommand(["graph", "--depth", "3"]),
    badDepth = parseThinCommand(["graph", "task_abc", "--depth", "99"]),
    unknown = parseThinCommand(["graph", "task_abc", "--bogus"]);
  for (const parsed of [missing, flagged, badDepth, unknown]) assert.equal(parsed.ok, false, JSON.stringify(parsed));
});

test("ha graph renders the causal-graph payload as an ASCII tree", () => {
  const receipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "graph",
    outcome: "applied",
    evidence: JSON.stringify({
      schema: "causal-graph/v1",
      query: { ref: "task_root", resolvedRef: "task/task_root", depth: 3 },
      root: {
        ref: "task/task_root",
        kind: "task",
        id: "task_root",
        label: "Root",
        state: "active",
        detail: null,
        depth: 0,
        viaEdge: null,
        cycle: false,
        repeated: false,
        truncated: false,
        children: [
          {
            ref: "decision/dec_1",
            kind: "decision",
            id: "dec_1",
            label: "Pick postgres",
            state: "in_effect",
            detail: null,
            depth: 1,
            viaEdge: {
              relationId: "rel_1",
              relationType: "derives",
              direction: "directed",
              sourceRef: "decision/dec_1",
              targetRef: "task/task_root",
              state: "active",
              freshness: "current",
              traversal: "upstream",
            },
            cycle: false,
            repeated: false,
            truncated: false,
            children: [],
          },
          {
            ref: "task/task_child",
            kind: "task",
            id: "task_child",
            label: "Child",
            state: "planned",
            detail: null,
            depth: 1,
            viaEdge: {
              relationId: null,
              relationType: "child",
              direction: "directed",
              sourceRef: "task/task_root",
              targetRef: "task/task_child",
              state: null,
              freshness: null,
              traversal: "structural",
            },
            cycle: false,
            repeated: false,
            truncated: true,
            children: [],
          },
        ],
      },
      stats: { nodes: 3, edges: 1, cycles: 0, repeats: 0, truncated: 1 },
      watermark: 41,
    }),
  };
  const rendered = renderCliReceipt(receipt);
  assert.equal(rendered.stream, "stdout");
  assert.match(rendered.text, /^Task task_root — Root \[active\]/u);
  assert.match(rendered.text, /├── <- \[derives\] Decision dec_1 — Pick postgres \[in_effect\]/u);
  assert.match(rendered.text, /└── \[child\] Task task_child — Child \[planned\] …/u);
  assert.match(rendered.text, /nodes=3 edges=1 truncated=1 watermark=41/u);
});
