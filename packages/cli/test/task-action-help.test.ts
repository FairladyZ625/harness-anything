// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import { generatedTaskActionProtocolDeclarations } from "../../daemon/src/protocol/daemon-protocol-commands-task.ts";
import { renderEntityActionExplanation } from "../src/cli/entity-action-explain-render.ts";
import { projectedTaskActionHelpRows } from "../src/cli/task-action-help.ts";
import { renderThinHelp } from "../src/cli/thin-command.ts";

test("Task lifecycle help is projected from the generated Action declarations", () => {
  const rows = projectedTaskActionHelpRows();
  assert.deepEqual(
    rows.map(({ summary }) => summary),
    generatedTaskActionProtocolDeclarations.map(({ explain }) => explain),
  );
  assert.deepEqual(
    rows.map(({ usage }) => usage.startsWith("ha task ")),
    generatedTaskActionProtocolDeclarations.map(() => true),
  );
  const submit = rows.find(({ usage }) => usage.startsWith("ha task submit "));
  assert.match(submit?.usage ?? "", /--amend/u);
  assert.match(submit?.usage ?? "", /--from-file.*--json-input/u);
  assert.match(submit?.help ?? "", /mutually exclusive with: --json-input/u);
  assert.equal(
    rows.some((row) => "available" in row),
    false,
  );
});

test("Task help replaces every descriptor-backed lifecycle row", () => {
  const help = renderThinHelp([], "task");
  for (const row of projectedTaskActionHelpRows()) {
    assert.match(help, new RegExp(row.summary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(help, new RegExp(row.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(help, /ha task create/u);
  assert.match(help, /ha task progress append/u);
  assert.match(help, /ha task delete \[--soft <soft>\].*--soft — optional; value; format: <task-id>/su);
  assert.doesNotMatch(help, /availability: (?:true|false)|available: (?:true|false)/u);
});

test("human explain output labels catalog availability as not evaluated", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-help" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
    }).catalog(),
    rendered = renderEntityActionExplanation(catalog);
  assert.match(rendered, /Task actions \(catalog; availability is not evaluated without an object\)/u);
  assert.match(rendered, /start: not evaluated/u);
  assert.match(rendered, /usage: ha task start <task-id>/u);
  assert.doesNotMatch(rendered, /start: available/u);
});
