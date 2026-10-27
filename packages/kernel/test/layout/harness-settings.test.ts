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

test("the worktree step timeout defaults to 20 minutes and reads a slower repository's larger value", () => {
  assert.equal(readSettingsFacet(body).worktree.setupStepTimeoutMs, 20 * 60 * 1000);
  assert.equal(
    readSettingsFacet("settings:\n  worktree:\n    setupStepTimeoutMs: 3600000\n").worktree.setupStepTimeoutMs,
    3_600_000,
  );
  assert.throws(() => readSettingsFacet("settings:\n  worktree:\n    setupStepTimeoutMs: 999\n"));
});

test("the backup execution limit defaults to 30 minutes, reads a larger value, and refuses under a minute", () => {
  assert.equal(readSettingsFacet(body).storage.backupExecutionLimitMs, 30 * 60_000);
  assert.equal(
    readSettingsFacet("settings:\n  storage:\n    backupExecutionLimitMs: 3600000\n").storage.backupExecutionLimitMs,
    3_600_000,
  );
  assert.throws(() => readSettingsFacet("settings:\n  storage:\n    backupExecutionLimitMs: 30000\n"));
});

test("the ACP handshake timeout defaults to 30 seconds, reads a larger value, and refuses under a second", () => {
  assert.equal(readSettingsFacet(body).runtime.providerHandshakeTimeoutMs, 30_000);
  assert.equal(
    readSettingsFacet("settings:\n  runtime:\n    providerHandshakeTimeoutMs: 120000\n").runtime
      .providerHandshakeTimeoutMs,
    120_000,
  );
  assert.throws(() => readSettingsFacet("settings:\n  runtime:\n    providerHandshakeTimeoutMs: 999\n"));
});

test("the dispatch stall timeout defaults to five minutes and is configurable above ten seconds", () => {
  assert.equal(readSettingsFacet(body).runtime.stallTimeoutMs, 300_000);
  assert.equal(readSettingsFacet("settings:\n  runtime:\n    stallTimeoutMs: 90000\n").runtime.stallTimeoutMs, 90_000);
  assert.throws(() => readSettingsFacet("settings:\n  runtime:\n    stallTimeoutMs: 9999\n"));
});

test("the schedule admission window is read from the facet and refuses a sub-second value", () => {
  assert.equal(
    readSettingsFacet("settings:\n  schedule:\n    admissionWindowMs: 600000\n").schedule.admissionWindowMs,
    600_000,
  );
  assert.throws(() => readSettingsFacet("settings:\n  schedule:\n    admissionWindowMs: 999\n"));
});

test("dispatch archive retention defaults to 60 days with no size cap and reads either limit independently", () => {
  assert.deepEqual(readSettingsFacet("settings:\n").dispatchArchive, { retentionDays: 60, retentionBytes: 0 });
  assert.deepEqual(
    readSettingsFacet("settings:\n  dispatchArchive:\n    retentionDays: 7\n    retentionBytes: 53687091200\n")
      .dispatchArchive,
    { retentionDays: 7, retentionBytes: 53_687_091_200 },
  );
  assert.throws(() => readSettingsFacet("settings:\n  dispatchArchive:\n    retentionDays: -1\n"));
  assert.throws(() => readSettingsFacet("settings:\n  dispatchArchive:\n    retentionBytes: -1\n"));
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
