#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
  if (!options.missingOnly) {
    for (const targetDir of targets) {
      for (const skillName of skillNames) {
        assertSkillTarget(path.join(targetDir, skillName), path.join(skillsRoot, skillName));
      }
    }
  }
  const linked = [];
  const pruned = [];
  const preserved = [];

  for (const targetDir of targets) {
    mkdirSync(targetDir, { recursive: true });

    for (const skillName of skillNames) {
      const source = path.join(skillsRoot, skillName);
      const link = path.join(targetDir, skillName);
      if (options.missingOnly && lstatSync(link, { throwIfNoEntry: false })) {
        preserved.push(path.relative(repoRoot, link).split(path.sep).join("/"));
        continue;
      }
      ensureSkillSymlink(link, source, targetDir);
      linked.push(path.relative(repoRoot, link).split(path.sep).join("/"));
    }

    if (options.missingOnly) continue;
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() || skillNames.includes(entry.name)) continue;
      const link = path.join(targetDir, entry.name);
      if (isInside(realpathSync(skillsRoot), linkTarget(link))) {
        rmSync(link);
        pruned.push(path.relative(repoRoot, link).split(path.sep).join("/"));
      }
    }
  }

  return { skillNames, targetDirs, linked, pruned, preserved };
}

function assertSkillTarget(link, source) {
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isSymbolicLink() || linkTarget(link) !== realpathSync(source)) {
    throw new Error(`技能目标已存在且不属于本源码链接，请先核对并保留用户内容：${link}`);
  }
}

/** Where a link points, resolved the way the OS does: from its folder's real path. */
function linkTarget(link) {
  return path.resolve(realpathSync(path.dirname(link)), readlinkSync(link));
}

function ensureSkillSymlink(link, source, targetDir) {
  assertSkillTarget(link, source);
  if (lstatSync(link, { throwIfNoEntry: false })) return;
  // Relative to the resolved folders: a symlinked ancestor (macOS /var, a linked home) changes the depth.
  const relativeSource = path.relative(realpathSync(targetDir), realpathSync(source)).split(path.sep).join("/");
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
      "missing-only": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "用法：node tools/sync-runtime-skills.mjs [--target-dir <Agent技能目录>]... [--missing-only]\n不传目录时仅同步本仓库的项目级技能；显式目录可用于用户级安装。默认遇到不同来源内容先报冲突；--missing-only 仅补缺失技能，保留全部已有内容且不清理旧链接。",
    );
  } else {
    const result = syncRuntimeSkills({ targetDirs: values["target-dir"], missingOnly: values["missing-only"] });
    console.log(JSON.stringify(result, null, 2));
  }
}
