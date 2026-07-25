import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "./path.ts";

export type ContainedOutputPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "absolute-path" | "outside-container" | "canonical-target" | "symlink" };

export interface ContainedOutputPathOptions {
  readonly requestedPath: string;
  readonly containerRoots: ReadonlyArray<string>;
  readonly relativeTo: string;
  readonly canonicalRoots?: ReadonlyArray<string>;
  readonly allowAbsolute?: boolean;
}

export function resolveContainedOutputPath(options: ContainedOutputPathOptions): ContainedOutputPathResult {
  if (path.isAbsolute(options.requestedPath) && options.allowAbsolute === false) {
    return { ok: false, reason: "absolute-path" };
  }
  const targetPath = path.resolve(options.relativeTo, options.requestedPath);
  const containerRoot = options.containerRoots.find((root) => isPathInside(root, targetPath));
  if (!containerRoot) return { ok: false, reason: "outside-container" };
  if ((options.canonicalRoots ?? []).some((root) => isPathInside(root, targetPath))) {
    return { ok: false, reason: "canonical-target" };
  }
  if (hasSymlinkInExistingPath(containerRoot, targetPath)) {
    return { ok: false, reason: "symlink" };
  }
  return { ok: true, path: targetPath };
}

function hasSymlinkInExistingPath(rootPath: string, targetPath: string): boolean {
  let current = path.resolve(rootPath);
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  const relative = path.relative(current, path.resolve(targetPath));
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}
