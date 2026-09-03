// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";
import { materializePacketStdin } from "../src/index.ts";

test("task closeout accepts one execution, template, or schema mode and discloses the packet fields", () => {
  const derived = parseThinCommand(["task", "closeout", "task-closeout", "--from-file", "judgment.json"]),
    explicit = parseThinCommand([
      "task",
      "closeout",
      "task-closeout",
      "--execution-id",
      "execution-closeout",
      "--from-file",
      "judgment.json",
    ]),
    inlinePacket = '{"review":{},"consent":{},"completion":{}}',
    inline = parseThinCommand(["task", "closeout", "task-closeout", "--json-input", inlinePacket]),
    stdin = parseThinCommand(["task", "closeout", "task-closeout", "--json-input", "@-"]),
    template = parseThinCommand(["task", "closeout", "task-closeout", "--print-template"]),
    schema = parseThinCommand(["task", "closeout", "task-closeout", "--print-schema"]),
    missing = parseThinCommand(["task", "closeout", "task-closeout"]),
    conflicting = parseThinCommand([
      "task",
      "closeout",
      "task-closeout",
      "--from-file",
      "judgment.json",
      "--print-template",
    ]),
    conflictingSources = parseThinCommand([
      "task",
      "closeout",
      "task-closeout",
      "--from-file",
      "judgment.json",
      "--json-input",
      inlinePacket,
    ]),
    irrelevantSelector = parseThinCommand([
      "task",
      "closeout",
      "task-closeout",
      "--execution-id",
      "execution-closeout",
      "--print-schema",
    ]);
  assert.equal(derived.ok, true);
  assert.equal(explicit.ok, true);
  assert.equal(inline.ok, true);
  assert.equal(stdin.ok, true);
  assert.equal(template.ok, true);
  assert.equal(schema.ok, true);
  assert.equal(missing.ok, false);
  assert.equal(conflicting.ok, false);
  assert.equal(conflictingSources.ok, false);
  assert.equal(irrelevantSelector.ok, false);
  if (derived.ok)
    assert.deepEqual(derived.command.action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      fromFile: "judgment.json",
    });
  if (explicit.ok)
    assert.deepEqual(explicit.command.action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      executionId: "execution-closeout",
      fromFile: "judgment.json",
    });
  if (inline.ok)
    assert.deepEqual(inline.command.action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      jsonInput: inlinePacket,
    });
  if (stdin.ok)
    assert.deepEqual(materializePacketStdin(stdin.command, () => inlinePacket).action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      jsonInput: inlinePacket,
    });
  if (template.ok)
    assert.deepEqual(template.command.action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      printTemplate: true,
    });
  if (schema.ok)
    assert.deepEqual(schema.command.action, {
      kind: "task-closeout",
      taskId: "task-closeout",
      printSchema: true,
    });
  const help = renderThinHelp([], "task");
  assert.match(help, /task-closeout-packet\/v1 JSON; run --print-schema for the field contract/u);
});
