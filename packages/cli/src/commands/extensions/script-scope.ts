import { existsSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import type { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import { isPathInside } from "../../cli/path.ts";

export { isPathInside } from "../../cli/path.ts";

export interface ResolvedScopeSet {
  readonly roots: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
}

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
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  return resolveDeclaredScopes(scopes, layout, outputRoot, false, "write");
}

export function resolveDeclaredReadScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  return resolveDeclaredScopes(scopes, layout, outputRoot, true, "read");
}

function resolveDeclaredScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string,
  allowRootRead: boolean,
  mode: "read" | "write"
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  const roots: string[] = [];
  const permissions: string[] = [];
  for (const scope of scopes) {
    const recursive = scope.endsWith("/**");
    const root = recursive ? scope.slice(0, -3) : scope;
    let resolved = root
      .replaceAll("{{paths.generatedRoot}}", layout.generatedRoot)
      .replaceAll("{{paths.localRoot}}", layout.localRoot)
      .replaceAll("{{paths.authoredRoot}}", layout.authoredRoot)
      .replaceAll("{{paths.tasksRoot}}", layout.tasksRoot)
      .replaceAll("{{paths.decisionsRoot}}", layout.decisionsRoot)
      .replaceAll("{{paths.sessionsRoot}}", layout.sessionsRoot)
      .replaceAll("{{paths.adrRoot}}", layout.adrRoot)
      .replaceAll("{{paths.milestonesRoot}}", layout.milestonesRoot)
      .replaceAll("{{outputRoot}}", outputRoot);
    if (allowRootRead) {
      resolved = resolved.replaceAll("{{paths.rootDir}}", layout.rootDir);
    }
    if (resolved.includes("{{") || resolved.includes("}}")) return { ok: false };
    for (const expanded of expandScopeRoot(resolved)) {
      const absolute = path.resolve(expanded);
      if (!isPathInside(layout.rootDir, absolute)) return { ok: false };
      if (recursive && absolute === path.resolve(layout.rootDir)) return { ok: false };
      if (mode === "write" && !isAllowedWriteScope(absolute, layout, outputRoot)) return { ok: false };
      roots.push(absolute);
      permissions.push(...permissionPathsForScope(absolute, recursive));
    }
  }
  return mode === "write" && roots.length === 0 ? {
    ok: true,
    roots: [],
    permissions: []
  } : roots.length > 0 ? {
    ok: true,
    roots: uniquePermissionPaths(roots),
    permissions: uniquePermissionPaths(permissions)
  } : { ok: false };
}

function isAllowedWriteScope(root: string, layout: ReturnType<typeof resolveHarnessLayout>, outputRoot: string): boolean {
  const absolute = path.resolve(root);
  if (!isPathInside(layout.authoredRoot, absolute)) return false;
  if (isPathInside(absolute, layout.authoredRoot)) return false;
  const resolvedOutputRoot = path.resolve(outputRoot);
  if (absolute === resolvedOutputRoot || isPathInside(resolvedOutputRoot, absolute)) return true;
  return !forbiddenWriteRoots(layout).some((forbiddenRoot) => scopesOverlap(absolute, forbiddenRoot));
}

function forbiddenWriteRoots(layout: ReturnType<typeof resolveHarnessLayout>): ReadonlyArray<string> {
  return [
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.projectionPath,
    layout.tasksRoot,
    layout.decisionsRoot,
    layout.sessionsRoot,
    path.join(layout.rootDir, ".git")
  ];
}

function scopesOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

export function uniquePermissionPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

export function permissionPathsForScope(root: string, recursive: boolean): ReadonlyArray<string> {
  const paths = recursive ? [root, `${root}/**`] : [root];
  if (!existsSync(root)) return paths;
  const real = realpathSync(root);
  return real === path.resolve(root)
    ? paths
    : [...paths, ...(recursive ? [real, `${real}/**`] : [real])];
}

function expandScopeRoot(root: string): ReadonlyArray<string> {
  const parsed = path.parse(path.resolve(root));
  const relativeParts = path.relative(parsed.root, path.resolve(root)).split(path.sep).filter((part) => part.length > 0);
  const parts = [parsed.root, ...relativeParts];
  if (!parts.includes("*")) return [root];
  let candidates = [parts[0]];
  const remaining = parts.slice(1);
  for (const part of remaining) {
    candidates = candidates.flatMap((candidate) => {
      if (part !== "*") return [path.join(candidate, part)];
      if (!existsSync(candidate)) return [];
      return readdirSync(candidate, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(candidate, entry.name));
    });
  }
  return candidates;
}
