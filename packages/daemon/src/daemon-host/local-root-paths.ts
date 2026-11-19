import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { resolveHarnessLayout } from "@harness-anything/kernel";

export function resolveOwnedLocalRoot(layout: ReturnType<typeof resolveHarnessLayout>): string | null {
  return resolveOwnedLocalDirectory(layout, []);
}

export function resolveOwnedLocalDirectory(
  layout: ReturnType<typeof resolveHarnessLayout>,
  segments: readonly string[],
  allowMissing = false,
): string | null {
  if (!existsSync(layout.rootDir)) return null;
  const realRepoRoot = realpathSync(layout.rootDir);
  const relativeSegments = path
    .relative(layout.rootDir, layout.localRoot)
    .split(path.sep)
    .filter((segment) => segment.length > 0 && segment !== ".");
  return relativeSegments.length === 0
    ? null
    : resolveDirectory(realRepoRoot, [...relativeSegments, ...segments], allowMissing);
}

export function resolveOwnedDirectory(ownedBaseDir: string, ...segments: readonly string[]): string | null {
  return resolveDirectory(ownedBaseDir, segments, false);
}

function resolveDirectory(ownedBaseDir: string, segments: readonly string[], allowMissing: boolean): string | null {
  let current = ownedBaseDir;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes(path.sep)) return null;
    const candidate = path.join(current, segment),
      stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat && allowMissing) {
      current = candidate;
      continue;
    }
    if (!stat?.isDirectory()) return null;
    const realCandidate = realpathSync(candidate);
    if (!isStrictRealChild(ownedBaseDir, realCandidate)) return null;
    current = realCandidate;
  }
  return current;
}

export function ownedSubdirectoryOrAbsent(ownedParentDir: string, childName: string): string | "absent" | null {
  const candidate = path.join(ownedParentDir, childName),
    stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return "absent";
  return resolveOwnedDirectory(ownedParentDir, childName);
}

export function isStrictRealChild(realParent: string, realCandidate: string): boolean {
  const prefix = realParent.endsWith(path.sep) ? realParent : `${realParent}${path.sep}`;
  return realCandidate.startsWith(prefix);
}
