import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { classifyAuthored } from "./migration-import-authored-classification.ts";
import { portableMigrationPath, resolveAuthoredConflict } from "./migration-import-conflicts.ts";
import { migrationImportError } from "./migration-import-report.ts";
import type { AuthoredCoverage, AuthoredDisposition, ResolutionChoice } from "./migration-import-types.ts";

export function parseResolutions(
  value: unknown,
  sourceRoot: string,
  authoredRoot: string,
): ReadonlyMap<string, ResolutionChoice> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw migrationImportError(
      "invalid_migration_resolution",
      "--resolve values must use <repo-relative-path>=destination|source.",
    );
  const result = new Map<string, ResolutionChoice>();
  for (const raw of value) {
    const match = /^(.*)=(destination|source)$/u.exec(raw),
      repoPath = match?.[1];
    if (
      !repoPath ||
      path.isAbsolute(repoPath) ||
      repoPath.includes("\\") ||
      path.posix.normalize(repoPath) !== repoPath ||
      repoPath.split("/").includes("..")
    )
      throw migrationImportError(
        "invalid_migration_resolution",
        `Invalid --resolve path ${JSON.stringify(repoPath ?? raw)}; use one normalized repository-relative path.`,
      );
    const absolute = path.resolve(sourceRoot, ...repoPath.split("/")),
      relative = portableMigrationPath(path.relative(authoredRoot, absolute));
    if (!relative || relative === ".." || relative.startsWith("../"))
      throw migrationImportError(
        "invalid_migration_resolution",
        `--resolve path ${repoPath} is outside the source authored root.`,
      );
    if (result.has(relative))
      throw migrationImportError(
        "invalid_migration_resolution",
        `Duplicate --resolve path after normalization: ${repoPath}.`,
      );
    result.set(relative, match![2] as ResolutionChoice);
  }
  return result;
}

export function auditAuthoredCoverage(
  sourceRoot: string,
  root: string,
  destinationRoot: string,
  entries: ReturnType<typeof authoredPaths>,
  packageOwners: ReadonlyMap<string, string>,
  resolutions: ReadonlyMap<string, ResolutionChoice>,
): AuthoredCoverage {
  const classified = entries.map((entry) => ({
    ...entry,
    ...resolveAuthoredConflict(
      classifyAuthored(root, destinationRoot, entry.path, entry.symlink, packageOwners),
      sourceRoot,
      root,
      destinationRoot,
      entry.path,
      entry.symlink,
      resolutions,
    ),
  }));
  for (const target of resolutions.keys())
    if (!classified.some((row) => row.path === target && row.resolution !== undefined))
      throw migrationImportError(
        "invalid_migration_resolution",
        [
          "--resolve path ",
          `${portableMigrationPath(path.relative(sourceRoot, path.join(root, target)))}`,
          " is not currently a destination conflict.",
        ].join(""),
      );
  const counts: Record<AuthoredDisposition, number> = {
      migrated: 0,
      excluded: 0,
      required: 0,
    },
    grouped = new Map<
      string,
      {
        surface: string;
        disposition: AuthoredDisposition;
        reason: string;
        paths: string[];
      }
    >();
  for (const row of classified) {
    counts[row.disposition] += 1;
    const key = `${row.surface}\0${row.disposition}\0${row.reason}`,
      group = grouped.get(key) ?? {
        surface: row.surface,
        disposition: row.disposition,
        reason: row.reason,
        paths: [],
      };
    group.paths.push(row.path);
    grouped.set(key, group);
  }
  const rows = [...grouped.values()]
    .map(({ paths, ...row }) => ({
      ...row,
      old: paths.length,
      samples: paths.slice(0, 3),
    }))
    .sort((a, b) => `${a.disposition}\0${a.surface}`.localeCompare(`${b.disposition}\0${b.surface}`));
  return { passed: counts.required === 0, counts, rows };
}

export function authoredPaths(
  root: string,
  relative = "",
): readonly { readonly path: string; readonly symlink: boolean }[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const portable = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name),
        target = path.join(root, relative, entry.name);
      if (entry.isDirectory() && (runtimeStateDirectory(target) || installedDependencyTree(target)))
        return [{ path: `${portable}/**`, symlink: false }];
      if (entry.isDirectory()) {
        const nested = authoredPaths(root, path.join(relative, entry.name));
        return nested.length ? nested : [{ path: `${portable}/`, symlink: false }];
      }
      return [{ path: portable, symlink: entry.isSymbolicLink() }];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function runtimeStateDirectory(directory: string): boolean {
  let names: ReadonlySet<string>;
  try {
    names = new Set(readdirSync(directory));
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
  return (
    (names.has("HEAD") && names.has("objects") && names.has("refs")) ||
    (names.has("locks") && names.has("write-journal")) ||
    names.has("preserved-worktree-edits") ||
    (names.has("browse-audit.jsonl") && names.has("browse-network.log"))
  );
}

export function installedDependencyTree(directory: string): boolean {
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
  if (names.includes(".package-lock.json")) return true;
  if (!names.includes(".bin")) return false;
  for (const name of names.slice(0, 32)) {
    const candidate = path.join(directory, name);
    try {
      if (
        statSync(candidate).isDirectory() &&
        (statSync(path.join(candidate, "package.json")).isFile() ||
          (name.startsWith("@") &&
            readdirSync(candidate).some((child) => {
              try {
                return statSync(path.join(candidate, child, "package.json")).isFile();
              } catch {
                return false;
              }
            })))
      )
        return true;
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return false;
}

export function appleDesktopMetadata(root: string, sourcePath: string): boolean {
  try {
    const bytes = readFileSync(path.join(root, sourcePath));
    return bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]));
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}
