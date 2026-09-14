// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import { taskActionCommandUsage, thinCliCommands } from "../../daemon/src/protocol/daemon-protocol-commands.ts";
import { renderThinHelp } from "../src/cli/thin-command.ts";

test("help, explain, and the router describe one Task Action catalog", () => {
  const explain = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-catalog-consistency" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
      usage: taskActionCommandUsage,
    }).catalog(),
    helpRows = new Set(
      renderThinHelp([], "task")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("ha task ")),
    );
  assert.ok(explain.subjects[0]!.actions.length > 0);
  for (const row of explain.subjects[0]!.actions) {
    const usage = row.action.syntax.usage;
    assert.ok(
      thinCliCommands.some((command) => command.usage === usage),
      `${row.action.id}: explain usage "${usage}" matches no router command declaration`,
    );
    assert.ok(helpRows.has(usage), `${row.action.id}: ha task --help must list "${usage}" verbatim`);
  }
});
