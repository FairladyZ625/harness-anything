// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "@harness-anything/application/internal/task-action-explanation-service";
import { taskActionCommandUsage } from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands";
import {
  generatedTaskActionProtocolDeclarations,
  taskActionHelpRows,
  taskExecutionProtocolCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands-task";
import { renderEntityActionExplanation } from "../src/cli/entity-action-explain-render.ts";
import { parseThinCommand, renderThinCapabilities, renderThinHelp } from "../src/cli/thin-command.ts";

test("Task lifecycle help is projected from the generated Action declarations", () => {
  const rows = taskActionHelpRows;
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
  assert.match(submit?.usage ?? "", /--commit/u);
  assert.doesNotMatch(submit?.usage ?? "", /--from-file|--json-input/u);
  assert.doesNotMatch(submit?.help ?? "", /--from-file|--json-input/u);
  const complete = rows.find(({ usage }) => usage.startsWith("ha task complete "));
  assert.doesNotMatch(complete?.usage ?? "", /--ci|--path/u);
  assert.match(complete?.summary ?? "", /--resolved-by.*cancel \+ relate/u);
  assert.equal(
    rows.some((row) => "available" in row),
    false,
  );
});

test("Task help replaces every descriptor-backed lifecycle row", () => {
  const help = renderThinHelp([], "task");
  for (const row of taskActionHelpRows) {
    assert.match(help, new RegExp(row.summary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(help, new RegExp(row.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(help, /ha task create/u);
  assert.match(help, /ha task progress append/u);
  assert.match(help, /ha task delete \[--soft <soft>\].*--soft — optional; value; format: <task-id>/su);
  assert.doesNotMatch(help, /availability: (?:true|false)|available: (?:true|false)/u);
});

test("worker escalation has one discoverable CLI command with actionable guidance", () => {
  const commands = taskExecutionProtocolCommands.filter(({ id }) => id === "task-escalate"),
    command = commands[0],
    help = renderThinHelp([], "task", "ha task escalate");
  assert.equal(commands.length, 1);
  assert.ok(command);
  assert.match(command.usage, /ha task escalate <task-id>.*--question/u);
  for (const text of [command.summary, help]) {
    assert.match(text, /forbidden boundaries/u);
    assert.match(text, /precondition is false/u);
    assert.match(text, /another task/u);
    assert.match(text, /do not use for choices you can decide yourself/u);
    assert.match(text, /Example: ha task escalate/u);
  }
  assert.match(help, /ha task escalate <task-id>/u);
  const capabilities = renderThinCapabilities();
  assert.match(capabilities, /task-escalate/u);
});

test("human explain output labels catalog availability as not evaluated", () => {
  const catalog = makeTaskActionExplanationService({
      actor: { principal: { personId: "person-help" }, executor: null },
      authorize: () => {
        throw new Error("catalog rendering must not evaluate authorization");
      },
      usage: taskActionCommandUsage,
    }).catalog(),
    rendered = renderEntityActionExplanation(catalog);
  assert.match(rendered, /Task actions \(catalog; availability is not evaluated without an object\)/u);
  assert.match(rendered, /start: not evaluated/u);
  assert.match(rendered, /usage: ha task start <task-id>/u);
  assert.doesNotMatch(rendered, /start: available/u);
});

test("start exposes and parses an explicit stack anchor through its canonical CLI action", () => {
  assert.match(renderThinHelp([], "task"), /--stack-on/u);
  const parsed = parseThinCommand(["task", "start", "task_work", "--stack-on", "task_base"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) assert.equal(parsed.command.action.stackOn, "task_base");
});

test("complete parses sibling resolution evidence on the existing command", () => {
  const argv = [
    "task",
    "complete",
    "task-target",
    "--resolved-by",
    "task-source",
    "--resolution-rationale",
    "Delivery abc fixes B",
    "--resolution-fact",
    "fact/F-1234ABCD",
  ];
  const parsed = parseThinCommand(argv);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) {
    assert.equal(parsed.command.action.resolvedBy, "task-source");
    assert.equal(parsed.command.action.resolutionRationale, "Delivery abc fixes B");
    assert.equal(parsed.command.action.resolutionFact, "fact/F-1234ABCD");
  }
  assert.match(renderThinHelp([], "task"), /--resolved-by/u);
});
