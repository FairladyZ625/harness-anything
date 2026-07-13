import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { compareArchitectureText, portablePathKey } from "./architecture-portable-path.mjs";

export function architectureRootPathIssue(options, architectureRoot) {
  if (!sameOrInside(options.projectRoot, architectureRoot)) return { kind: "escape", path: architectureRoot };
  if (options.hostValidatedBoundary !== true) {
    return pathComponentIssue(options.projectRoot, architectureRoot, "directory");
  }
  const kind = filesystemKind(architectureRoot);
  return kind === "directory" ? null : { kind, path: architectureRoot };
}

export function filesystemKind(filePath) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch { return "missing"; }
}

export function pathComponentIssue(root, target, leafKind) {
  const components = path.relative(path.resolve(root), path.resolve(target)).split(path.sep).filter(Boolean);
  let current = path.resolve(root);
  for (const [index, component] of components.entries()) {
    const aliases = portableSiblingAliases(current, component);
    if (aliases.length > 0) return { path: path.join(current, aliases[0]), kind: "portable-alias" };
    current = path.join(current, component);
    const kind = filesystemKind(current);
    const expectedKind = index === components.length - 1 ? leafKind : "directory";
    if (kind !== expectedKind) return { path: current, kind };
  }
  return null;
}

export function portableSiblingAliases(parent, canonicalName) {
  try {
    return readdirSync(parent)
      .filter((entry) => entry !== canonicalName && portablePathKey(entry) === portablePathKey(canonicalName))
      .sort(compareArchitectureText);
  } catch { return []; }
}

export function sameOrInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
