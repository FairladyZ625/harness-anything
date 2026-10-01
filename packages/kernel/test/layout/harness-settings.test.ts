// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readSettingsFacet, repositorySettings, writeRepositorySettingsFacet } from "../../src/index.ts";

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
  const settings = readSettingsFacet(body);
  assert.equal(settings.locale, "en-US");
  assert.equal(settings.tasks.wipLimit, 50);
});

test("settings without comments are unchanged", () => {
  const settings = readSettingsFacet(body);
  assert.equal(settings.defaultVertical, "software/coding");
  assert.equal(settings.scaffolds.task, "governance/task-scaffold.json");
});

test("absent declared keys use their declared defaults", () => {
  const settings = readSettingsFacet("settings:\n");
  assert.equal(settings.defaultProfile, "baseline");
  assert.equal(settings.tasks.wipLimit, 30);
  assert.equal(settings.tasks.rootThreshold, 3);
  assert.equal(settings.schedule.admissionWindowMs, 60_000);
});

test("the schedule admission window is read from the facet and refuses a sub-second value", () => {
  assert.equal(
    readSettingsFacet("settings:\n  schedule:\n    admissionWindowMs: 600000\n").schedule.admissionWindowMs,
    600_000,
  );
  assert.throws(() => readSettingsFacet("settings:\n  schedule:\n    admissionWindowMs: 999\n"));
});

test("CI workflows default to the witnessing opt-out and accept configured workflow basenames", () => {
  assert.deepEqual(readSettingsFacet(body).ci.workflows, []);
  assert.deepEqual(readSettingsFacet(`${body}\n  ci:\n    workflows: [ci]\n`).ci.workflows, ["ci"]);
});

test("CI workflows read an explicit empty list as the CI-witnessing opt-out", () => {
  assert.deepEqual(readSettingsFacet(`${body}\n  ci:\n    workflows: []\n`).ci.workflows, []);
});

test("CI workflows fail closed on duplicate, extension-bearing, or block arrays", () => {
  for (const workflows of ["[ci, ci]", "[ci.yml]", "", "\n      - ci"]) {
    const configured = `${body}\n  ci:\n    workflows: ${workflows}\n`;
    assert.throws(() => readSettingsFacet(configured), /settings\.ci\.workflows/u);
  }
});

test("the repository facet writer inserts, replaces, and leaves default CI workflows unmaterialized", () => {
  const defaultCi = writeRepositorySettingsFacet(body, readSettingsFacet(body));
  assert.doesNotMatch(defaultCi, /^  ci:/mu);
  const inserted = writeRepositorySettingsFacet(body, { ...readSettingsFacet(body), ci: { workflows: ["ci"] } });
  assert.match(inserted, /^  ci:\n    workflows: \[ci\]$/mu);
  assert.deepEqual(readSettingsFacet(inserted).ci.workflows, ["ci"]);
  const cleared = writeRepositorySettingsFacet(inserted, { ...readSettingsFacet(inserted), ci: { workflows: [] } });
  assert.match(cleared, /^  ci:\n    workflows: \[\]$/mu);
  assert.deepEqual(readSettingsFacet(cleared).ci.workflows, []);
  const replaced = writeRepositorySettingsFacet(`${body}\n  ci:\n    workflows: [legacy]\n`, readSettingsFacet(body));
  assert.doesNotMatch(replaced, /legacy/u);
  assert.deepEqual(readSettingsFacet(replaced).ci.workflows, []);
});

test("worktree setup steps round-trip as a block list and default to none", () => {
  assert.deepEqual(readSettingsFacet(body).worktree.setup, []);
  const steps = ["node-modules", "run: uv sync --frozen, then more"],
    written = writeRepositorySettingsFacet(body, { ...readSettingsFacet(body), worktree: { setup: steps } });
  assert.match(written, /^  worktree:\n    setup:\n      - node-modules\n      - run: uv sync --frozen, then more$/mu);
  assert.deepEqual(readSettingsFacet(written).worktree.setup, steps);
  assert.deepEqual(readSettingsFacet(`${body}  worktree:\n    setup: []\n`).worktree.setup, []);
  assert.throws(() => readSettingsFacet(`${body}  worktree:\n    setup: [node-modules]\n`), /setup: block list/u);
  assert.throws(() => readSettingsFacet(`${body}  worktree:\n    setup:\n      - pip install\n`), /worktree/u);
  const cleared = writeRepositorySettingsFacet(written, { ...readSettingsFacet(written), worktree: { setup: [] } });
  assert.doesNotMatch(cleared, /worktree:/u);
});

test("a reviewer authored at the pre-roles root key survives the first read and moves under roles on write", () => {
  const legacy = `${body}  defaultReviewer: closeout-reviewer\n`,
    read = readSettingsFacet(legacy);
  assert.deepEqual(read.roles, { defaultReviewer: "closeout-reviewer" });
  const rewritten = writeRepositorySettingsFacet(legacy, repositorySettings(read));
  assert.doesNotMatch(rewritten, /^  defaultReviewer:/mu);
  assert.deepEqual(readSettingsFacet(rewritten).roles, { defaultReviewer: "closeout-reviewer" });
  const both = `${legacy}  roles:\n    defaultReviewer: arch-reviewer\n`;
  assert.deepEqual(readSettingsFacet(both).roles, { defaultReviewer: "arch-reviewer" });
});
