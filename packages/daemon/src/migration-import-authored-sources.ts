import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel";

/** Read-only probes that decide whether an authored path is runtime state or a dependency
 * tree. Shared by the authored audit and its classifier without either importing the other. */
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
