// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
    "graph-panorama",
    "harness-install",
    "preset-creator",
    "preset-trigger",
    "vertical-creator",
  ]);
  for (const skillName of ["graph-panorama", "harness-install", "preset-trigger"]) {
    assert.equal(existsSync(path.join(skillsRoot, skillName, "SKILL.md")), true, skillName);
    assert.equal(existsSync(path.join(skillsRoot, skillName, "agents", "openai.yaml")), true, skillName);
  }
});

test("runtime skill sync links current skills and prunes retired managed links", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-skills-"));
  try {
    const sourceSkills = path.join(repoRoot, "skills");
    symlinkSync(sourceSkills, path.join(tempRoot, "skills"), "dir");
    const retiredSkillNames = ["decision", "decisions"];

    for (const targetDir of runtimeSkillTargetDirs) {
      const targetRoot = path.join(tempRoot, targetDir);
      mkdirSync(targetRoot, { recursive: true });
      for (const skillName of retiredSkillNames) {
        const source = path.join(tempRoot, "skills", skillName);
        symlinkSync(path.relative(targetRoot, source), path.join(targetRoot, skillName), "dir");
      }
    }

    const result = syncRuntimeSkills({ repoRoot: tempRoot });
    const skillNames = readdirSync(sourceSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(result.skillNames, skillNames);
    assert.deepEqual(result.targetDirs, runtimeSkillTargetDirs);
    assert.deepEqual(
      result.pruned,
      runtimeSkillTargetDirs.flatMap((targetDir) => retiredSkillNames.map((skillName) => `${targetDir}/${skillName}`)),
    );

    for (const targetDir of runtimeSkillTargetDirs) {
      for (const skillName of skillNames) {
        const link = path.join(tempRoot, targetDir, skillName);
        assert.equal(lstatSync(link).isSymbolicLink(), true, `${targetDir}/${skillName}`);
        assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), path.join(tempRoot, "skills", skillName));
      }
      for (const skillName of retiredSkillNames) {
        assert.throws(() => lstatSync(path.join(tempRoot, targetDir, skillName)), { code: "ENOENT" });
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("graph panorama skill reads SQLite projection and writes only generated HTML", () => {
  const body = readFileSync(path.join(skillsRoot, "graph-panorama", "SKILL.md"), "utf8");

  assert.match(body, /name: graph-panorama/u);
  assert.match(body, /relation_edges/u);
  assert.match(body, /relation_coverage/u);
  assert.match(body, /node tools\/graph-panorama\.mjs/u);
  assert.match(body, /HTML artifact is for human inspection/u);
  assert.match(body, /agents should read SQLite directly/u);
  assert.match(body, /Do not edit authored markdown/u);
  assert.match(body, /Do not generate DOT or Mermaid output/u);
  assert.doesNotMatch(body, /\bwriteFileSync\b|\bfs\.write|\bapply_patch\b|cat\s*>\s*.+\.md|tee\s+.+\.md/u);
});

test("preset trigger routes task creation through dynamic preset discovery", () => {
  const body = readFileSync(path.join(skillsRoot, "preset-trigger", "SKILL.md"), "utf8");
  const metadata = readFileSync(path.join(skillsRoot, "preset-trigger", "agents", "openai.yaml"), "utf8");
  const bundledPresetsRoot = path.join(
    repoRoot,
    "packages",
    "cli",
    "src",
    "commands",
    "extensions",
    "assets",
    "software-coding",
    "presets",
  );
  const bundledPresetIds = readdirSync(bundledPresetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(bundledPresetsRoot, entry.name, "preset.json")))
    .map((entry) => entry.name);

  assert.match(body, /name: preset-trigger/u);
  assert.match(body, /Use whenever an agent is creating, planning, scoping, or preparing a Harness task package/u);
  assert.match(body, /ha preset list/u);
  assert.match(body, /ha task create --help/u);
  assert.match(body, /ha preset inspect <id>/u);
  assert.match(body, /ha task create --title "<title>" --vertical <vertical-id> --preset <id>/u);
  assert.match(body, /Do not replace it with a hardcoded vertical/u);
  assert.doesNotMatch(body, /--vertical software\/coding/u);
  assert.match(body, /pre-discovery router/u);
  assert.match(body, /post-discovery semantic contract/u);
  assert.match(body, /Do not hand-create task package directories/u);
  assert.match(body, /report that failure instead of\s+guessing a preset ID/u);
  assert.doesNotMatch(body, /## Available Presets/u);
  assert.doesNotMatch(body, /^\s*- `[^`]+`:\s/mu);
  for (const presetId of bundledPresetIds) {
    assert.equal(body.includes(presetId), false, `hardcoded bundled preset ID: ${presetId}`);
  }
  assert.match(metadata, /default_prompt: "Use \$preset-trigger /u);
});
