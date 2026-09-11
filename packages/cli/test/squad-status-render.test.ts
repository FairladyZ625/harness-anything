// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("Squad status renders token, tool-call, and compaction metrics for each attempt", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "squad-status",
    summary: "squad-run core-squad: converged",
    leaders: [
      {
        turnId: "leader-1",
        status: "succeeded",
        tokenUsage: { input: 120, output: 30 },
        toolCallCount: 4,
        compacted: true,
      },
    ],
    workers: [
      {
        attemptId: "worker-1",
        status: "succeeded",
        tokenUsage: { input: 80, output: 20 },
        toolCallCount: 2,
        compacted: false,
      },
    ],
  });

  assert.deepEqual(rendered, {
    stream: "stdout",
    text: [
      "squad-run core-squad: converged",
      "leader leader-1: status=succeeded tokens=120in/30out tools=4 compacted=true",
      "worker worker-1: status=succeeded tokens=80in/20out tools=2 compacted=false",
    ].join("\n"),
  });
});
