#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

export const runtimeSkillTargetDirs = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills"
];

export function discoverRepositorySkills(repoRoot = defaultRepoRoot) {
  const skillsRoot = path.join(repoRoot, "skills");
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(skillsRoot, name, "SKILL.md")))
    .sort();
}

export function syncRuntimeSkills(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const skillsRoot = path.join(repoRoot, "skills");
  const skillNames = discoverRepositorySkills(repoRoot);
  const linked = [];
  const pruned = [];

  for (const targetDirTemplate of runtimeSkillTargetDirs) {
    const targetDir = path.join(repoRoot, targetDirTemplate);
    mkdirSync(targetDir, { recursive: true });

    for (const skillName of skillNames) {
      const source = path.join(skillsRoot, skillName);
      const link = path.join(targetDir, skillName);
      ensureSkillSymlink(link, source, targetDir);
      linked.push(path.relative(repoRoot, link).split(path.sep).join("/"));
    }

    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() || skillNames.includes(entry.name)) continue;
      const link = path.join(targetDir, entry.name);
      const resolved = path.resolve(targetDir, readlinkSync(link));
      if (isInside(skillsRoot, resolved)) {
        rmSync(link);
        pruned.push(path.relative(repoRoot, link).split(path.sep).join("/"));
      }
    }
  }

  return { skillNames, targetDirs: runtimeSkillTargetDirs, linked, pruned };
}

function ensureSkillSymlink(link, source, targetDir) {
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) {
      throw new Error(`runtime skill target exists and is not a symlink: ${link}`);
    }
    const existing = path.resolve(targetDir, readlinkSync(link));
    if (existing === source) return;
    rmSync(link);
  }

  const relativeSource = path.relative(targetDir, source).split(path.sep).join("/");
  symlinkSync(relativeSource, link, "dir");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = syncRuntimeSkills();
  console.log(JSON.stringify(result, null, 2));
}
