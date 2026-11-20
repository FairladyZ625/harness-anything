import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  computeSkillSnapshotDigest,
  resolveHarnessLayout,
  sha256Bytes,
  type SkillSnapshotFileDigest,
  type SkillSnapshotUnitDigest,
} from "@harness-anything/kernel";
import { writeFileDurably } from "@harness-anything/storage";
import { runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import type { ResolvedAgentSkill } from "./agent-skills.ts";
import { resolveContainedPath } from "./contained-path.ts";
import { resolveOwnedDirectory } from "./local-root-paths.ts";
import { ensureRealDirectory, isLinkedWorktree, removeMirrorEntry } from "./worktree-setup.ts";

interface PreparedSkillFile {
  readonly bytes: Buffer;
  readonly destPath: string;
}

export interface PreparedDispatchSkillSnapshot {
  readonly skillSnapshotDigest: string;
  readonly workspaceRoot: string;
  readonly snapshotRoot: string;
  readonly skills: readonly ResolvedAgentSkill[];
  readonly sourceToSnapshotPath: ReadonlyMap<string, string>;
  readonly files: readonly PreparedSkillFile[];
  readonly units: readonly SkillSnapshotUnitDigest[];
}

function safeSnapshotSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw runtimeSpawnError("agent_skill_snapshot_invalid", `Invalid ${label} segment for skill snapshot: ${value}`);
  }
  return trimmed;
}

function dispatchSnapshotLocation(rootDir: string, cwd: string) {
  const layout = resolveHarnessLayout(rootDir),
    workspaceRoot = isLinkedWorktree(cwd) ? cwd : layout.rootDir,
    localRoot = path.join(workspaceRoot, path.relative(layout.rootDir, layout.localRoot));
  return { workspaceRoot, localRoot };
}

export function sessionSkillSnapshotRoot(rootDir: string, cwd: string, runtimeSessionId: string): string {
  return path.join(
    dispatchSnapshotLocation(rootDir, cwd).localRoot,
    "runtime",
    "sealed-skills",
    safeSnapshotSegment(runtimeSessionId, "runtimeSessionId"),
  );
}

/**
 * Reads only the skill directories selected for this dispatch, resolves symlinks fail-closed,
 * computes the deterministic skillSnapshotDigest, and prepares the snapshot file buffers in memory.
 * Performing preparation before fence validation and dry-run exit guarantees zero orphan writes.
 */
export function prepareDispatchSkillSnapshot(input: {
  readonly rootDir: string;
  readonly cwd: string;
  readonly runtimeSessionId: string;
  readonly skills: readonly ResolvedAgentSkill[];
}): PreparedDispatchSkillSnapshot {
  const { workspaceRoot, localRoot } = dispatchSnapshotLocation(input.rootDir, input.cwd),
    snapshotRoot = path.join(
      localRoot,
      "runtime",
      "sealed-skills",
      safeSnapshotSegment(input.runtimeSessionId, "runtimeSessionId"),
    ),
    sourceToSnapshotPath = new Map<string, string>(),
    units: SkillSnapshotUnitDigest[] = [],
    allFiles: PreparedSkillFile[] = [],
    sealedSkills: ResolvedAgentSkill[] = [];

  for (const skill of input.skills) {
    const safeSkillId = safeSnapshotSegment(skill.id, "skillId"),
      skillDestDir = path.join(snapshotRoot, safeSkillId),
      realSkillRoot = realpathSync.native(skill.sourceDir);
    const unitFiles: SkillSnapshotFileDigest[] = [];
    collectSkillDirectoryFiles({
      skillId: skill.id,
      realSkillRoot,
      currentSourceDir: realSkillRoot,
      relativePrefix: "",
      skillDestDir,
      ancestorRealDirs: new Set([realSkillRoot]),
      unitFiles,
      allFiles,
      sourceToSnapshotPath,
    });
    if (!unitFiles.some((file) => file.relativePath === "SKILL.md")) {
      throw runtimeSpawnError(
        "agent_skill_snapshot_invalid",
        `Skill ${skill.id} (${skill.sourceDir}) is missing a regular SKILL.md manifest.`,
      );
    }
    sourceToSnapshotPath.set(path.resolve(skill.skillFile), path.join(skillDestDir, "SKILL.md"));
    units.push({ id: skill.id, files: unitFiles });
    sealedSkills.push({
      id: skill.id,
      sourceDir: skillDestDir,
      skillFile: path.join(skillDestDir, "SKILL.md"),
    });
  }

  return {
    skillSnapshotDigest: computeSkillSnapshotDigest(units),
    workspaceRoot,
    snapshotRoot,
    skills: sealedSkills,
    sourceToSnapshotPath,
    files: allFiles,
    units,
  };
}

function collectSkillDirectoryFiles(input: {
  readonly skillId: string;
  readonly realSkillRoot: string;
  readonly currentSourceDir: string;
  readonly relativePrefix: string;
  readonly skillDestDir: string;
  readonly ancestorRealDirs: ReadonlySet<string>;
  readonly unitFiles: SkillSnapshotFileDigest[];
  readonly allFiles: PreparedSkillFile[];
  readonly sourceToSnapshotPath: Map<string, string>;
}): void {
  const entries = readdirSync(input.currentSourceDir, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(input.currentSourceDir, entry.name),
      relativePosixPath = input.relativePrefix ? `${input.relativePrefix}/${entry.name}` : entry.name,
      realTarget = resolveContainedPath(input.realSkillRoot, entryPath);
    if (realTarget === null) {
      throw runtimeSpawnError(
        "agent_skill_snapshot_invalid",
        `Skill ${input.skillId} contains an unresolvable path or a path outside its directory at ${relativePosixPath}.`,
      );
    }
    const targetStat = statSync(realTarget);
    if (targetStat.isDirectory()) {
      if (input.ancestorRealDirs.has(realTarget)) {
        throw runtimeSpawnError(
          "agent_skill_snapshot_invalid",
          `Skill ${input.skillId} contains a symbolic link directory cycle at ${relativePosixPath}.`,
        );
      }
      const nextAncestors = new Set(input.ancestorRealDirs);
      nextAncestors.add(realTarget);
      collectSkillDirectoryFiles({
        ...input,
        currentSourceDir: realTarget,
        relativePrefix: relativePosixPath,
        ancestorRealDirs: nextAncestors,
      });
      continue;
    }
    if (!targetStat.isFile()) {
      throw runtimeSpawnError(
        "agent_skill_snapshot_invalid",
        `Skill ${input.skillId} contains unsupported non-regular entry ${relativePosixPath}.`,
      );
    }
    const bytes = readFileSync(realTarget),
      sha256 = sha256Bytes(bytes),
      destPath = path.join(input.skillDestDir, ...relativePosixPath.split("/"));
    input.unitFiles.push({
      relativePath: relativePosixPath,
      sha256,
      byteLength: bytes.byteLength,
    });
    input.allFiles.push({ bytes, destPath });
    input.sourceToSnapshotPath.set(path.resolve(entryPath), destPath);
    input.sourceToSnapshotPath.set(realTarget, destPath);
  }
}

/**
 * Materializes the exact hashed file buffers into the per-session snapshot directory.
 */
export function materializeDispatchSkillSnapshot(prepared: PreparedDispatchSkillSnapshot): void {
  if (prepared.files.length === 0) return;
  ensureRealDirectory(prepared.workspaceRoot, path.dirname(prepared.snapshotRoot));
  removeSnapshotDirectory(prepared.snapshotRoot);
  for (const file of prepared.files) {
    ensureRealDirectory(prepared.workspaceRoot, path.dirname(file.destPath));
    writeFileDurably(file.destPath, file.bytes, 0o400);
  }
  writeFileDurably(
    path.join(prepared.snapshotRoot, "manifest.json"),
    JSON.stringify({
      schema: "skill-snapshot/v1",
      skillSnapshotDigest: prepared.skillSnapshotDigest,
      skills: prepared.units,
    }),
    0o400,
  );
}

function removeSnapshotDirectory(target: string): void {
  if (!lstatSync(target, { throwIfNoEntry: false })) return;
  removeMirrorEntry(target);
}

function pruneEmptyParentDirectory(target: string): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return;
  if (readdirSync(target).length === 0) removeMirrorEntry(target, false);
}

/**
 * Removes a session's local skill snapshot directory upon failed launch or terminal settlement.
 */
export function reclaimSessionSkillSnapshot(rootDir: string, runtimeSessionId: string, cwd?: string): void {
  const safeId = safeSnapshotSegment(runtimeSessionId, "runtimeSessionId"),
    layout = resolveHarnessLayout(rootDir),
    relativeLocalRoot = path.relative(layout.rootDir, layout.localRoot).split(path.sep),
    roots = new Set([layout.rootDir, ...(cwd !== undefined && isLinkedWorktree(cwd) ? [cwd] : [])]);
  for (const workspaceRoot of roots) {
    if (!existsSync(workspaceRoot)) continue;
    const parent = resolveOwnedDirectory(realpathSync(workspaceRoot), ...relativeLocalRoot, "runtime", "sealed-skills");
    if (parent === null) continue;
    removeSnapshotDirectory(path.join(parent, safeId));
    pruneEmptyParentDirectory(parent);
    if (workspaceRoot !== layout.rootDir) pruneEmptyParentDirectory(path.dirname(parent));
  }
}

/**
 * Lists local runtimeSessionIds that currently have a materialized skill snapshot directory under layout.localRoot.
 */
export function listLocalSkillSnapshotSessionIds(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(rootDir),
    snapshotsDir = path.join(layout.localRoot, "runtime", "sealed-skills"),
    dirStat = lstatSync(snapshotsDir, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return [];
  return readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.includes("\\") && entry.name.trim() === entry.name)
    .map((entry) => entry.name);
}
