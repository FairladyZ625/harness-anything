import { existsSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import type { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";

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
  return resolveDeclaredScopes(scopes, layout, outputRoot, false);
}

export function resolveDeclaredReadScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  return resolveDeclaredScopes(scopes, layout, outputRoot, true);
}

function resolveDeclaredScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string,
  allowRootRead: boolean
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
      .replaceAll("{{outputRoot}}", outputRoot);
    if (allowRootRead) {
      resolved = resolved.replaceAll("{{paths.rootDir}}", layout.rootDir);
    }
    if (resolved.includes("{{") || resolved.includes("}}")) return { ok: false };
    for (const expanded of expandScopeRoot(resolved)) {
      const absolute = path.resolve(expanded);
      if (!isPathInside(layout.rootDir, absolute)) return { ok: false };
      if (recursive && absolute === path.resolve(layout.rootDir)) return { ok: false };
      roots.push(absolute);
      permissions.push(...permissionPathsForScope(absolute, recursive));
    }
  }
  return roots.length > 0 ? {
    ok: true,
    roots: uniquePermissionPaths(roots),
    permissions: uniquePermissionPaths(permissions)
  } : { ok: false };
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  const parts = root.split(path.sep);
  if (!parts.includes("*")) return [root];
  let candidates = [parts[0] === "" ? path.sep : parts[0]];
  const remaining = parts[0] === "" ? parts.slice(1) : parts.slice(1);
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
