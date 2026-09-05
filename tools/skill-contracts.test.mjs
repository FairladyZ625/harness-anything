// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeSkillTargetDirs, syncRuntimeSkills } from "./sync-runtime-skills.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillsRoot = path.join(repoRoot, "skills");

test("repository skills are discoverable with agent metadata", () => {
  const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, [
    "harness-ceo",
    "harness-contributing",
    "harness-download",
    "harness-install",
    "harness-migration",
    "preset-creator",
    "preset-trigger",
    "vertical-creator",
  ]);
  for (const skillName of [
    "harness-ceo",
    "harness-download",
    "harness-install",
    "harness-migration",
    "preset-trigger",
  ]) {
    assert.equal(existsSync(path.join(skillsRoot, skillName, "SKILL.md")), true, skillName);
    assert.equal(existsSync(path.join(skillsRoot, skillName, "agents", "openai.yaml")), true, skillName);
  }
});

test("runtime skill sync links every repository skill into project runtime dirs", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-skills-"));
  try {
    const sourceSkills = path.join(repoRoot, "skills");
    symlinkSync(sourceSkills, path.join(tempRoot, "skills"), "dir");

    const result = syncRuntimeSkills({ repoRoot: tempRoot });
    const skillNames = readdirSync(sourceSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(result.skillNames, skillNames);
    assert.deepEqual(result.targetDirs, runtimeSkillTargetDirs);

    for (const targetDir of runtimeSkillTargetDirs) {
      for (const skillName of skillNames) {
        const link = path.join(tempRoot, targetDir, skillName);
        assert.equal(lstatSync(link).isSymbolicLink(), true, `${targetDir}/${skillName}`);
        assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), path.join(tempRoot, "skills", skillName));
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("adoption skills route to the branch that carries them and to each other", () => {
  const install = readFileSync(path.join(skillsRoot, "harness-install", "SKILL.md"), "utf8");
  const migration = readFileSync(path.join(skillsRoot, "harness-migration", "SKILL.md"), "utf8");

  for (const [skillName, body] of [
    ["harness-install", install],
    ["harness-migration", migration],
  ]) {
    assert.match(body, new RegExp(`^name: ${skillName}$`, "mu"), skillName);
    assert.match(body, /origin\/main:skills\//u, skillName);
    assert.doesNotMatch(body, /rebuild\/main/u, skillName);
  }

  assert.match(install, /harness-migration/u, "install must route an existing ledger to migration");
});

test("the install skill carries the cold-start facts the CLI does not surface", () => {
  const body = readFileSync(path.join(skillsRoot, "harness-install", "SKILL.md"), "utf8");

  assert.match(body, /"decisionClass": "ordinary"/u, "decision packet shape is not discoverable from --help");
  assert.match(body, /fromFile must stay inside the workspace/u);
  assert.match(body, /Execution Review requires an independent transport-bound arbiter/u);
  assert.match(body, /HARNESS_ACTOR=agent:/u, "executor is the only movable half of actor independence");
  assert.match(
    body,
    /evidence\.lease\.executionId|\["lease"\]\["executionId"\]/u,
    "task start does not print the execution id",
  );
  assert.doesNotMatch(body, /export HARNESS_DAEMON_USER_ROOT=/u, "an install must land in the serving user root");
});

test("preset trigger skill routes task creation through preset selection", () => {
  const body = readFileSync(path.join(skillsRoot, "preset-trigger", "SKILL.md"), "utf8");

  assert.match(body, /name: preset-trigger/u);
  assert.match(body, /choose the preset before creating the task package/u);
  assert.match(body, /ha task create --title "<title>" --vertical software\/coding --preset <id>/u);
  assert.match(body, /standard-task/u);
  assert.match(body, /decision-conformance/u);
  assert.match(body, /milestone-closeout/u);
  assert.match(body, /ha capabilities preset/u);
  assert.match(body, /Do not hand-create task package directories/u);
});

test("用户级技能链接可跨目录重复同步，并直接读取源码更新", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-user-skills-"));
  try {
    const sourceRoot = path.join(tempRoot, "source checkout");
    const skillRoot = path.join(sourceRoot, "skills", "example");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "first");
    const targetDirs = [path.join(tempRoot, "user", "codex"), path.join(tempRoot, "user", "claude")];
    syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs });
    syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "updated");
    for (const dir of targetDirs) {
      assert.equal(lstatSync(path.join(dir, "example")).isSymbolicLink(), true);
      assert.equal(readFileSync(path.join(dir, "example", "SKILL.md"), "utf8"), "updated");
    }
    assert.equal(existsSync(path.join(sourceRoot, ".codex")), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const conflict of ["directory", "foreign-link", "broken-link"]) {
  test(`同步前发现 ${conflict} 冲突，不覆盖用户内容也不部分写入`, () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-skill-conflict-"));
    try {
      const sourceRoot = path.join(tempRoot, "source");
      const skillRoot = path.join(sourceRoot, "skills", "example");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(path.join(skillRoot, "SKILL.md"), "source");
      const first = path.join(tempRoot, "first");
      const second = path.join(tempRoot, "second");
      mkdirSync(second);
      const target = path.join(second, "example");
      const foreign = path.join(tempRoot, "foreign");
      if (conflict === "directory") {
        mkdirSync(target);
        writeFileSync(path.join(target, "custom.md"), "user content");
      } else {
        if (conflict === "foreign-link") mkdirSync(foreign);
        symlinkSync(foreign, target, "dir");
      }
      assert.throws(() => syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [first, second] }), /技能目标已存在/u);
      assert.equal(existsSync(first), false);
      if (conflict === "directory") {
        assert.equal(readFileSync(path.join(target, "custom.md"), "utf8"), "user content");
      } else {
        assert.equal(readlinkSync(target), foreign);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
