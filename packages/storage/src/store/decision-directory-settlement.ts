import path from "node:path";
import { localLayoutFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";

/** Only directory candidates: the settlement port refuses every nonempty directory. */
export function decisionDirectoryRetirements(
  retiredPaths: readonly string[],
  decisionsRoot?: string,
  options?: { readonly cold?: boolean },
): readonly string[] {
  const directories = new Set<string>(),
    touchedDecisionDirs = new Set<string>();
  for (const logical of retiredPaths) {
    const parts = logical.split("/");
    if (parts[0] !== "decisions" || !parts[1]?.startsWith("decision-") || parts.length < 3) continue;
    touchedDecisionDirs.add(parts[1]);
    for (let depth = parts.length - 1; depth >= 2; depth--) directories.add(parts.slice(0, depth).join("/"));
  }
  // Empty directories have no Git tree entry or document head. On a cold pass inspect the
  // reserved decisions namespace recursively; on incremental passes descend only into decision
  // directories already touched by retired paths so cost remains proportional to those paths.
  if (decisionsRoot && localLayoutFileSystem.exists(decisionsRoot)) {
    if (options?.cold !== false) {
      for (const entry of localLayoutFileSystem.readDirents(decisionsRoot))
        if (entry.isDirectory() && entry.name.startsWith("decision-"))
          collectDecisionSubdirectories(path.join(decisionsRoot, entry.name), `decisions/${entry.name}`, directories);
    } else {
      for (const dirName of touchedDecisionDirs) {
        const target = path.join(decisionsRoot, dirName);
        if (localLayoutFileSystem.exists(target))
          collectDecisionSubdirectories(target, `decisions/${dirName}`, directories);
      }
    }
  }
  return [...directories].sort().reverse();
}

/** Collect authored-relative non-directory candidates inside `decisions/decision-*` on cold reconciliation. */
export function decisionDirectoryFiles(decisionsRoot: string): readonly string[] {
  if (!localLayoutFileSystem.exists(decisionsRoot)) return [];
  const files: string[] = [];
  for (const entry of localLayoutFileSystem.readDirents(decisionsRoot))
    if (entry.isDirectory() && entry.name.startsWith("decision-"))
      collectDecisionFiles(path.join(decisionsRoot, entry.name), `decisions/${entry.name}`, files);
  return files.sort();
}

function collectDecisionSubdirectories(rootPath: string, logicalPrefix: string, directories: Set<string>): void {
  directories.add(logicalPrefix);
  for (const entry of localLayoutFileSystem.readDirents(rootPath))
    if (entry.isDirectory())
      collectDecisionSubdirectories(path.join(rootPath, entry.name), `${logicalPrefix}/${entry.name}`, directories);
}

function collectDecisionFiles(rootPath: string, logicalPrefix: string, files: string[]): void {
  for (const entry of localLayoutFileSystem.readDirents(rootPath)) {
    const logical = `${logicalPrefix}/${entry.name}`,
      child = path.join(rootPath, entry.name);
    if (entry.isDirectory()) collectDecisionFiles(child, logical, files);
    else files.push(logical);
  }
}
