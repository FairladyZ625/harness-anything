import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The one CLI-side boundary for a repository file: `--body-file`, `--from-file`, `--prompt-file`,
 * `--batch-file` and their peers name paths relative to the selected workspace root. A caller can
 * spell the same file relative or absolute; both resolve inside that root, and an outside path is
 * refused here before a command handler reads it.
 */
export function resolveWorkspaceFilePath(rootDir: string, value: string, flag: string): string {
  const absolute = path.resolve(rootDir, value),
    relative = path.relative(rootDir, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error(`${flag} must stay within the selected repository.`), {
      code: "invalid_field",
    });
  return absolute;
}

export function readWorkspaceTextFile(rootDir: string, value: string, flag: string): string {
  return readFileSync(resolveWorkspaceFilePath(rootDir, value, flag), "utf8");
}
