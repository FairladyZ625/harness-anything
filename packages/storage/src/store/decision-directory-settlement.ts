import { localLayoutFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";

/** Only directory candidates: the settlement port refuses every nonempty directory. */
export function decisionDirectoryRetirements(
  retiredPaths: readonly string[],
  decisionsRoot?: string,
): readonly string[] {
  const directories = new Set<string>();
  for (const logical of retiredPaths) {
    const parts = logical.split("/");
    if (parts[0] !== "decisions" || !parts[1]?.startsWith("decision-") || parts.length < 3) continue;
    for (let depth = parts.length - 1; depth >= 2; depth--) directories.add(parts.slice(0, depth).join("/"));
  }
  // Empty directories have no Git tree entry or document head. Inspect only this reserved namespace
  // on a cold pass; incremental settlement remains proportional to the retired paths.
  if (decisionsRoot && localLayoutFileSystem.exists(decisionsRoot))
    for (const entry of localLayoutFileSystem.readDirents(decisionsRoot))
      if (entry.isDirectory() && entry.name.startsWith("decision-")) directories.add(`decisions/${entry.name}`);
  return [...directories].sort().reverse();
}
