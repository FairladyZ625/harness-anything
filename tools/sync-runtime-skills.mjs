#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

export const runtimeSkillTargetDirs = [".agents/skills", ".claude/skills", ".codex/skills"];

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
  const targetDirs = options.targetDirs ?? runtimeSkillTargetDirs;
  if (!Array.isArray(targetDirs) || targetDirs.length === 0) {
    throw new Error("至少指定一个技能目标目录");
  }
  const targets = [...new Set(targetDirs.map((dir) => path.resolve(repoRoot, dir)))];
  // Check every collision before changing any target, including broken symlinks.
  for (const targetDir of targets) {
    for (const skillName of skillNames) {
      assertSkillTarget(path.join(targetDir, skillName), path.join(skillsRoot, skillName));
    }
  }
  const linked = [];
  const pruned = [];

  for (const targetDir of targets) {
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

  return { skillNames, targetDirs, linked, pruned };
}

function assertSkillTarget(link, source) {
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isSymbolicLink() || path.resolve(path.dirname(link), readlinkSync(link)) !== source) {
    throw new Error(`技能目标已存在且不属于本源码链接，请先核对并保留用户内容：${link}`);
  }
}

function ensureSkillSymlink(link, source, targetDir) {
  assertSkillTarget(link, source);
  if (lstatSync(link, { throwIfNoEntry: false })) return;
  const relativeSource = path.relative(targetDir, source).split(path.sep).join("/");
  symlinkSync(relativeSource, link, "dir");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const { values } = parseArgs({
    options: {
      "target-dir": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "用法：node tools/sync-runtime-skills.mjs [--target-dir <Agent技能目录>]...\n不传目录时仅同步本仓库的项目级技能；显式目录可用于用户级安装。现有不同内容或不同来源链接不会被覆盖。",
    );
  } else {
    const result = syncRuntimeSkills({ targetDirs: values["target-dir"] });
    console.log(JSON.stringify(result, null, 2));
  }
}
