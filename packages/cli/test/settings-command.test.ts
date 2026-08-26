// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("Settings CLI projects read and owned update flags to the closed daemon actions", () => {
  const read = parseThinCommand(["settings", "read"]);
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.command.action, { kind: "settings-read" });

  const update = parseThinCommand([
    "settings",
    "update",
    "--default-preset",
    "strict-task",
    "--locale",
    "zh-CN",
    "--task-scaffold",
    "governance/task-scaffold.json",
    "--idempotency-key",
    "settings-one",
  ]);
  assert.equal(update.ok, true);
  if (update.ok)
    assert.deepEqual(update.command.action, {
      kind: "settings-update",
      defaultPreset: "strict-task",
      locale: "zh-CN",
      taskScaffold: "governance/task-scaffold.json",
      idempotencyKey: "settings-one",
    });
});

test("Settings CLI rejects unknown and unsupported locale fields", () => {
  assert.equal(parseThinCommand(["settings", "update", "--locale", "fr-FR"]).ok, false);
  assert.equal(parseThinCommand(["settings", "update", "--wip-limit", "1"]).ok, false);
  assert.equal(parseThinCommand(["settings", "read", "--locale", "en-US"]).ok, false);
});
