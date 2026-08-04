import path from "node:path";
import { localPathSafetyFileSystem } from "../local/local-layout-file-system.ts";

export type NoFollowPathCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Checks every existing component without resolving symlinks. A missing leaf
 * is allowed for a new authored document. Once a component is missing there
 * are no existing links left to follow; existing components before that point
 * are still checked individually.
 */
export function noFollowPathComponents(rootPath: string, targetPath: string): NoFollowPathCheck {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: "path is outside the authored root" };
  }

  const rootCheck = lstatDirectory(root, "authored root");
  if (!rootCheck.ok) return rootCheck;

  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = localPathSafetyFileSystem.lstat(current);
    } catch (error) {
      if (isMissingPath(error)) return { ok: true };
      return {
        ok: false,
        reason: `path component ${path.relative(root, current)} could not be checked without following links`
      };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: `path component ${path.relative(root, current)} is a symbolic link` };
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return { ok: false, reason: `path component ${path.relative(root, current)} is not a directory` };
    }
    if (index === segments.length - 1 && !stat.isFile() && !stat.isDirectory()) {
      return { ok: false, reason: `path component ${path.relative(root, current)} is not a regular file or directory` };
    }
  }
  return { ok: true };
}

function lstatDirectory(input: string, label: string): NoFollowPathCheck {
  try {
    const stat = localPathSafetyFileSystem.lstat(input);
    if (stat.isSymbolicLink()) return { ok: false, reason: `${label} is a symbolic link` };
    if (!stat.isDirectory()) return { ok: false, reason: `${label} is not a directory` };
    return { ok: true };
  } catch (error) {
    if (isMissingPath(error)) return { ok: true };
    return { ok: false, reason: `${label} could not be checked without following links` };
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

export interface NoFollowPathStat {
  readonly isSymbolicLink: () => boolean;
}

export interface NoFollowPathFileSystem {
  readonly lstat: (inputPath: string) => NoFollowPathStat;
}

/**
 * Validate every existing component of a repair path without following a
 * symlink. Missing suffixes are allowed because the caller may create them.
 */
export function assertNoSymlinkPath(
  rootPath: string,
  targetPath: string,
  fileSystem: NoFollowPathFileSystem
): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`repair path escapes authored root: ${targetPath}`);
  }

  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: NoFollowPathStat;
    try {
      stat = fileSystem.lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`repair path contains a symbolic link and was refused: ${current}`);
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
