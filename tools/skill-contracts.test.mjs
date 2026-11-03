// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
    "codex-unattended-turn",
    "create-agent",
    "create-skill",
    "gate-customization",
    "harness-ceo",
    "harness-contributing",
    "harness-download",
    "harness-dsh-install",
    "harness-gui",
    "harness-install",
    "harness-issue",
    "harness-migration",
    "harness-reckoning",
    "preset-creator",
    "preset-trigger",
    "self-iteration",
    "task-explainer-html",
    "vertical-creator",
  ]);
  for (const skillName of [
    "create-agent",
    "create-skill",
    "harness-ceo",
    "harness-download",
    "harness-dsh-install",
    "harness-gui",
    "harness-install",
    "harness-issue",
    "harness-migration",
    "harness-reckoning",
    "preset-trigger",
    "self-iteration",
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
        assert.equal(realpathSync(link), realpathSync(path.join(tempRoot, "skills", skillName)));
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Windows 技能链接用绝对目录联接，其他平台保持相对符号链接且可重复同步", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-skill-junction-"));
  try {
    const sourceRoot = path.join(tempRoot, "source");
    const skillRoot = path.join(sourceRoot, "skills", "example");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "source");

    const windowsTarget = path.join(tempRoot, "windows");
    syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [windowsTarget], platform: "win32" });
    const windowsLink = path.join(windowsTarget, "example");
    assert.equal(readlinkSync(windowsLink), realpathSync(skillRoot), "a junction must store the absolute source");
    assert.equal(realpathSync(windowsLink), realpathSync(skillRoot));
    // The second run reads the absolute target back and must not report a conflict.
    syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [windowsTarget], platform: "win32" });

    if (process.platform !== "win32") {
      const posixTarget = path.join(tempRoot, "posix");
      syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [posixTarget], platform: "linux" });
      assert.equal(path.isAbsolute(readlinkSync(path.join(posixTarget, "example"))), false);
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
  assert.match(body, /work-closeout/u);
  assert.match(
    body,
    /ha work create --title[^\n]*--decision/u,
    "a work is created through its own entry with a Decision",
  );
  assert.match(body, /ha task create --work <work-id>/u, "tasks are filed under a work with --work");
  assert.match(body, /ha agenda --work <work-id>/u);
  assert.doesNotMatch(
    body,
    /create-milestone|milestone-closeout|`module`/u,
    "retired grouping presets must not return",
  );
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

test("missing-only installation fills gaps while preserving customized and retired skills", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-missing-skills-"));
  try {
    const sourceRoot = path.join(tempRoot, "source");
    const targetDir = path.join(tempRoot, "user", "skills");
    mkdirSync(targetDir, { recursive: true });
    for (const name of ["custom", "foreign", "broken", "missing"]) {
      mkdirSync(path.join(sourceRoot, "skills", name), { recursive: true });
      writeFileSync(path.join(sourceRoot, "skills", name, "SKILL.md"), "upstream");
    }
    mkdirSync(path.join(targetDir, "custom"));
    writeFileSync(path.join(targetDir, "custom", "SKILL.md"), "user customization");
    mkdirSync(path.join(tempRoot, "foreign"));
    symlinkSync(path.join(tempRoot, "foreign"), path.join(targetDir, "foreign"), "dir");
    symlinkSync(path.join(tempRoot, "absent"), path.join(targetDir, "broken"), "dir");
    symlinkSync(path.join(sourceRoot, "skills", "retired"), path.join(targetDir, "retired"), "dir");

    const result = syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [targetDir], missingOnly: true });
    assert.equal(readFileSync(path.join(targetDir, "custom", "SKILL.md"), "utf8"), "user customization");
    assert.equal(readlinkSync(path.join(targetDir, "foreign")), path.join(tempRoot, "foreign"));
    assert.equal(readlinkSync(path.join(targetDir, "broken")), path.join(tempRoot, "absent"));
    assert.equal(lstatSync(path.join(targetDir, "retired")).isSymbolicLink(), true);
    assert.equal(readFileSync(path.join(targetDir, "missing", "SKILL.md"), "utf8"), "upstream");
    assert.equal(result.linked.length, 1);
    assert.equal(result.preserved.length, 3);
    assert.deepEqual(result.pruned, []);
    const repeated = syncRuntimeSkills({ repoRoot: sourceRoot, targetDirs: [targetDir], missingOnly: true });
    assert.deepEqual(repeated.linked, []);
    assert.equal(repeated.preserved.length, 4);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("missing-only CLI installs the complete discovered set into an empty HOME and is repeatable", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dsh-skills-home-"));
  try {
    const targetDir = path.join(tempRoot, ".agents", "skills");
    const args = [path.join(repoRoot, "tools", "sync-runtime-skills.mjs"), "--missing-only", "--target-dir", targetDir];
    const run = () =>
      JSON.parse(
        execFileSync(process.execPath, args, {
          cwd: tempRoot,
          env: { ...process.env, HOME: tempRoot, USERPROFILE: tempRoot, CODEX_HOME: path.join(tempRoot, ".codex") },
          encoding: "utf8",
        }),
      );
    const installed = run();
    assert.equal(installed.linked.length, installed.skillNames.length);
    for (const name of [
      "harness-ceo",
      "harness-install",
      "create-skill",
      "create-agent",
      "harness-gui",
      "harness-dsh-install",
    ]) {
      assert.equal(
        readFileSync(path.join(targetDir, name, "SKILL.md"), "utf8"),
        readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8"),
      );
    }
    assert.deepEqual(run().linked, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issue form, intake, and template agree on required headings", () => {
  const form = readFileSync(path.join(repoRoot, ".github", "ISSUE_TEMPLATE", "issue.yml"), "utf8");
  const intake = readFileSync(path.join(repoRoot, ".github", "workflows", "issue-intake.yml"), "utf8");
  const template = readFileSync(path.join(skillsRoot, "harness-issue", "references", "issue-body-template.md"), "utf8");

  const formLines = form.split(/\r?\n/u);
  const bodyStart = formLines.indexOf("body:");
  assert.notEqual(bodyStart, -1, "issue form must declare a body");
  const formFields = [];
  let currentField = null;
  for (const line of formLines.slice(bodyStart + 1)) {
    if (/^  - type: /u.test(line)) {
      const type = line.slice("  - type: ".length).trim();
      currentField = type === "markdown" ? null : { type, label: null, required: null };
      if (currentField) formFields.push(currentField);
      continue;
    }
    if (/^\S/u.test(line)) {
      currentField = null;
      continue;
    }
    if (currentField === null) continue;
    const label = /^      label: (.+)$/u.exec(line);
    if (label) currentField.label = label[1].trim();
    const required = /^      required: (true|false)$/u.exec(line);
    if (required) currentField.required = required[1] === "true";
    // A checkboxes field has no field-level validation; each option carries its own required flag.
    if (/^          required: true$/u.test(line) && currentField.type === "checkboxes") currentField.required = true;
  }

  assert.equal(formFields.length, 12, "the issue form has one field per section");
  for (const field of formFields) {
    assert.ok(field.label, "every issue form field must declare a label");
    assert.notEqual(field.required, null, `issue form field ${field.label} must declare required true or false`);
  }

  const formHeadings = formFields.map((field) => `### ${field.label}`);
  const requiredHeadings = formFields.filter((field) => field.required).map((field) => `### ${field.label}`);
  const optionalHeadings = formFields.filter((field) => !field.required).map((field) => `### ${field.label}`);
  assert.deepEqual(
    optionalHeadings,
    ["### Screenshot or recording"],
    "screenshot evidence is the only optional section",
  );

  const intakeBlock = /const requiredHeadings = \[([\s\S]*?)\];/u.exec(intake);
  assert.ok(intakeBlock, "issue intake must declare requiredHeadings");
  const intakeHeadings = [...intakeBlock[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);

  const templateHeadings = template
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("### "))
    .map((line) => line.trim());

  assert.deepEqual([...intakeHeadings].sort(), [...requiredHeadings].sort());
  assert.deepEqual([...templateHeadings].sort(), [...formHeadings].sort());
  assert.equal(new Set(formHeadings).size, formHeadings.length, "form labels must be unique");
  assert.equal(new Set(intakeHeadings).size, intakeHeadings.length, "intake headings must be unique");
  assert.equal(new Set(templateHeadings).size, templateHeadings.length, "template headings must be unique");
  assert.doesNotMatch(intake, /github\.rest\.issues\.update|issues\.update\b/u, "intake must not change issue state");
  assert.doesNotMatch(intake, /state:\s*["']?(?:closed|open)\b/u, "intake must not write a state field");

  const onBlock = /^on:\r?\n([\s\S]*?)^permissions:/mu.exec(intake)?.[1];
  assert.ok(onBlock, "issue intake must declare on before permissions");
  assert.deepEqual(
    onBlock
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
    ["issues:", "types: [opened]"],
    "issue intake must run only when an issue is opened",
  );
  assert.match(intake, /^permissions:\r?\n  issues: write$/mu, "intake still needs to comment");
});
