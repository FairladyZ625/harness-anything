import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeSkillTargetDirs, syncRuntimeSkills } from "./sync-runtime-skills.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillsRoot = path.join(repoRoot, "skills");

test("repository decision skills are discoverable with agent metadata", () => {
  const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ["decision", "decisions", "graph-panorama", "preset-creator", "preset-trigger", "vertical-creator"]);
  for (const skillName of ["decision", "decisions", "graph-panorama", "preset-trigger"]) {
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

test("decision skills are thin CLI triggers and do not instruct direct markdown writes", () => {
  for (const skillName of ["decision", "decisions"]) {
    const body = readFileSync(path.join(skillsRoot, skillName, "SKILL.md"), "utf8");

    assert.match(body, new RegExp(`name: ${skillName}`, "u"), skillName);
    assert.match(body, /npx ha decision propose/u, skillName);
    assert.match(body, /npx ha decision accept/u, skillName);
    assert.match(body, /WriteCoordinator/u, skillName);
    assert.match(body, /Do not edit, create, patch, append, or rewrite/u, skillName);
    assert.doesNotMatch(body, /\bwriteFileSync\b|\bfs\.write|\bapply_patch\b|cat\s*>\s*.+decision\.md|tee\s+.+decision\.md/u, skillName);
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
