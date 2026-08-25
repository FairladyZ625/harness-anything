import { realpathSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";

export function resolveContainedPath(rootDir: string, requestedPath: string): string | null {
  let root: string, candidate: string;
  try {
    root = realpathSync.native(rootDir);
    candidate = realpathSync.native(path.resolve(rootDir, requestedPath));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return candidate;
}
