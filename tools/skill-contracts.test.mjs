import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillsRoot = path.join(repoRoot, "skills");

test("repository decision skills are discoverable with agent metadata", () => {
  const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, ["decision", "decisions", "graph-panorama", "preset-creator", "vertical-creator"]);
  for (const skillName of ["decision", "decisions", "graph-panorama"]) {
    assert.equal(existsSync(path.join(skillsRoot, skillName, "SKILL.md")), true, skillName);
    assert.equal(existsSync(path.join(skillsRoot, skillName, "agents", "openai.yaml")), true, skillName);
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
