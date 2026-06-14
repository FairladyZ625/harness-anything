import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";

export function listGeneratedFiles(rootDir: string): ReadonlyArray<string> {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true }).flatMap((entry): ReadonlyArray<string> => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return listGeneratedFiles(entryPath);
    if (entry.isFile()) return [entryPath];
    return [];
  }).sort();
}

export function resolveDeclaredWriteScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string
): { readonly ok: true; readonly roots: ReadonlyArray<string> } | { readonly ok: false } {
  const roots: string[] = [];
  for (const scope of scopes) {
    const root = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
    const resolved = root
      .replaceAll("{{paths.generatedRoot}}", layout.generatedRoot)
      .replaceAll("{{paths.localRoot}}", layout.localRoot)
      .replaceAll("{{paths.authoredRoot}}", layout.authoredRoot)
      .replaceAll("{{outputRoot}}", outputRoot);
    if (resolved.includes("{{") || resolved.includes("}}")) return { ok: false };
    const absolute = path.resolve(resolved);
    if (!isPathInside(layout.rootDir, absolute)) return { ok: false };
    roots.push(absolute);
  }
  return roots.length > 0 ? { ok: true, roots } : { ok: false };
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
