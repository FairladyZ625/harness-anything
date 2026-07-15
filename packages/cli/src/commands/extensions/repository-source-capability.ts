import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { relativePath } from "../../cli/path.ts";

type RepositorySourceCollection = "project-config" | "gate-tooling" | "product-source";

export function repositorySourceProjection(
  rootInput: HarnessLayoutInput,
  collections: ReadonlyArray<RepositorySourceCollection>,
  snapshotRoot: string
): { readonly value: unknown; readonly readPermissions: ReadonlyArray<string> } {
  const layout = resolveHarnessLayout(rootInput);
  const selected = new Set(collections);
  const sourcePaths = [
    ...(selected.has("project-config") ? [
      path.join(layout.rootDir, "package.json"),
      path.join(layout.rootDir, "eslint.config.mjs"),
      path.join(layout.rootDir, ".github")
    ] : []),
    ...(selected.has("gate-tooling") ? [path.join(layout.rootDir, "tools")] : []),
    ...(selected.has("product-source") ? [path.join(layout.rootDir, "packages")] : [])
  ];
  const files = [...new Set(sourcePaths.flatMap(walkRepositoryTextFiles))].sort();
  const projected = files.map((source) => {
    const relative = relativePath(layout.rootDir, source);
    const target = path.join(snapshotRoot, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
    return { path: relative, size: statSync(source).size };
  });
  return {
    value: {
      schema: "repository-source-snapshot/v1",
      view: "text-snapshot",
      collections,
      root: snapshotRoot,
      files: projected
    },
    readPermissions: projected.length > 0 ? [snapshotRoot] : []
  };
}

function walkRepositoryTextFiles(root: string): ReadonlyArray<string> {
  if (!root || !existsSync(root)) return [];
  const stats = statSync(root);
  if (stats.isFile()) return repositoryTextFile(root) ? [root] : [];
  if (!stats.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry): ReadonlyArray<string> => {
    if (entry.isSymbolicLink() || [".git", "coverage", "dist", "node_modules"].includes(entry.name)) return [];
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? walkRepositoryTextFiles(candidate) : entry.isFile() && repositoryTextFile(candidate) ? [candidate] : [];
  });
}

function repositoryTextFile(filename: string): boolean {
  return /(?:^|\/)(?:package\.json|eslint\.config\.mjs)$/u.test(filename)
    || /\.(?:cjs|js|json|md|mjs|ts|tsx|ya?ml)$/iu.test(filename);
}
