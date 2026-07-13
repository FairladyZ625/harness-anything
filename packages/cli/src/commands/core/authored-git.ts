import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizeSlashes } from "../../cli/path.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";

export function authoredRelativePath(rootInput: HarnessLayoutInput, absolutePath: string): string {
  const layout = resolveHarnessLayout(rootInput);
  return validateAuthoredRelativePaths(layout.rootDir, layout.authoredRoot, [normalizeSlashes(path.relative(layout.authoredRoot, absolutePath))])[0] ?? "";
}

function validateAuthoredRelativePaths(
  rootDir: string,
  authoredRoot: string,
  relativePaths: ReadonlyArray<string>
): ReadonlyArray<string> {
  const authoredReal = normalizeExistingPath(authoredRoot);
  return [...new Set(relativePaths.map((entry) => normalizeSlashes(entry)).filter(Boolean))]
    .map((entry) => {
      if (path.isAbsolute(entry) || entry === "." || entry === ".." || entry.startsWith("../") || entry.includes("/../")) {
        throw new Error(`authored git path escapes authored root: ${entry}`);
      }
      const absolutePath = path.resolve(authoredRoot, entry);
      const normalizedAbsolute = normalizeExistingPath(absolutePath);
      const relativeToAuthored = path.relative(authoredReal, normalizedAbsolute);
      if (relativeToAuthored === ".." || relativeToAuthored.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToAuthored)) {
        throw new Error(`authored git path escapes authored root: ${entry}`);
      }
      const relativeToRoot = path.relative(normalizeExistingPath(rootDir), normalizedAbsolute);
      if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
        throw new Error(`authored git path escapes project root: ${entry}`);
      }
      return normalizeSlashes(relativeToAuthored);
    })
    .sort();
}

export function gitTopLevel(inputPath: string): string | null {
  try {
    return normalizeExistingPath(execFileSync("git", ["-C", inputPath, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim());
  } catch {
    return null;
  }
}

function normalizeExistingPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const pendingSegments: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync.native(current), ...pendingSegments);
}
