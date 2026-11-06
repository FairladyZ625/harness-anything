// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "@harness-anything/application/internal/task-action-explanation-service";
import {
  daemonProtocolCommands,
  hiddenSince,
  taskActionCommandUsage,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands";
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
      [
        renderThinHelp([], "task", undefined, [], true),
        renderThinHelp([], "preset"),
        renderThinHelp([], "pin"),
        renderThinHelp([], "unpin"),
      ]
        .join("\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.startsWith("ha task ") ||
            line.startsWith("ha preset ") ||
            line.startsWith("ha pin ") ||
            line.startsWith("ha unpin "),
        ),
    );
  assert.ok(explain.subjects[0]!.actions.length > 0);
  for (const row of explain.subjects[0]!.actions) {
    const usage = row.action.syntax.usage,
      command = daemonProtocolCommands.find((entry) => entry.usage === usage);
    assert.ok(command, `${row.action.id}: explain usage "${usage}" matches no router command declaration`);
    if (hiddenSince(command) === null) {
      assert.ok(
        helpRows.has(usage),
        `${row.action.id}: ha ${usage.split(" ")[1]} --help must list "${usage}" verbatim`,
      );
      continue;
    }
    // A hidden declaration keeps its route and explain row but is deliberately absent from help.
    assert.ok(!helpRows.has(usage), `${row.action.id}: hidden command "${usage}" must not be listed by domain help`);
  }
});

test("doc sync help states the authored-prose region rule before a submission", () => {
  const help = renderThinHelp([], "doc");
  assert.match(help, /authored prose sections/iu);
  assert.match(help, /reorder/iu);
  assert.match(help, /frontmatter/iu);
  assert.match(help, /task start/iu);
});
