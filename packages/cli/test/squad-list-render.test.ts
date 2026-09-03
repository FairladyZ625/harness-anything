// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

test("Squad list renders healthy and degraded rows with state and error columns", () => {
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
          validity: "valid",
          issues: [],
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
      "core-squad\tvalid\tnone",
      'broken-squad\tinvalid\tinvalid_entity_contract: squad declaration is missing required field "leader".',
    ].join("\n"),
  });
});
