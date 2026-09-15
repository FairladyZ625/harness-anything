// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("squad cancel routes a required run id through the daemon", () => {
  const parsed = parseThinCommand(["squad", "cancel", "squad_0123456789abcdef01234567"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.command.method, "repo.task.run");
    assert.deepEqual(parsed.command.action, {
      kind: "squad-cancel",
      squadRunId: "squad_0123456789abcdef01234567",
    });
  }
  assert.equal(parseThinCommand(["squad", "cancel"]).ok, false);
});

test("Squad list renders healthy rows as ids and degraded rows with state and error columns", () => {
  const rendered = renderCliReceipt({
    ok: true,
    command: "squad-list",
    evidence: JSON.stringify({
      schema: "squad-list/v1",
      squads: [
        {
          schema: "squad-declaration/v1",
          id: "core-squad",
          name: "Core Squad",
          leader: "leader",
          workers: ["worker"],
          leaderTurnBudget: 4,
          layer: "user",
          source: "squads/core-squad.json",
        },
        {
          id: "broken-squad",
          layer: "user",
          state: "invalid",
          error: {
            code: "invalid_entity_contract",
            hint: 'squad declaration is missing required field "leader".',
          },
        },
      ],
    }),
  });

  assert.deepEqual(rendered, {
    stream: "stdout",
    text: [
      "core-squad",
      'broken-squad\tinvalid\tinvalid_entity_contract: squad declaration is missing required field "leader".',
    ].join("\n"),
  });
});

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
