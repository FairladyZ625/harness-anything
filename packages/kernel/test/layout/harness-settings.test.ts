// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { setting, settingBlockValue } from "../../src/layout/index.ts";
import { readSettingsFacet } from "../../src/index.ts";

const body = [
  "schema: harness-anything/v1",
  "settings:",
  "  defaultVertical: software/coding",
  "  locale: en-US  # the team writes tickets in English",
  "  tasks:",
  "    wipLimit: 50  # bigger team, raised deliberately",
  "  scaffolds:",
  "    task: governance/task-scaffold.json",
  "",
].join("\n");

test("an annotated setting keeps its authored value instead of falling back", () => {
  assert.equal(setting(body, "locale"), "en-US");
  assert.equal(settingBlockValue(body, "tasks", "wipLimit"), "50");
});

test("settings without comments are unchanged", () => {
  assert.equal(setting(body, "defaultVertical"), "software/coding");
  assert.equal(settingBlockValue(body, "scaffolds", "task"), "governance/task-scaffold.json");
});

test("a key with no value reads as absent so the caller applies its own default", () => {
  assert.equal(setting("settings:\n  locale:\n  defaultPreset: standard-task\n", "locale"), undefined);
  assert.equal(settingBlockValue("settings:\n  tasks:\n    wipLimit: # unset\n", "tasks", "wipLimit"), undefined);
});

test("a key absent from the block reads as absent", () => {
  assert.equal(setting(body, "defaultProfile"), undefined);
  assert.equal(settingBlockValue(body, "tasks", "missing"), undefined);
  assert.equal(settingBlockValue(body, "absentBlock", "wipLimit"), undefined);
});

test("CI workflows default to rewrite-ci and accept configured workflow basenames", () => {
  assert.deepEqual(readSettingsFacet(body).ci.workflows, ["rewrite-ci"]);
  assert.deepEqual(readSettingsFacet(`${body}\n  ci:\n    workflows: [ci]\n`).ci.workflows, ["ci"]);
});

test("CI workflows fail closed on empty, duplicate, extension-bearing, or block arrays", () => {
  for (const workflows of ["[]", "[ci, ci]", "[ci.yml]", "", "\n      - ci"]) {
    const configured = `${body}\n  ci:\n    workflows: ${workflows}\n`;
    assert.throws(() => readSettingsFacet(configured), /settings\.ci\.workflows/u);
  }
});
