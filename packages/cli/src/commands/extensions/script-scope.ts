import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import type { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { isPathInside } from "../../cli/path.ts";

export { isPathInside } from "../../cli/path.ts";

export interface ResolvedScopeSet {
  readonly roots: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly reportedLeafConflicts?: ReadonlyArray<string>;
}

interface ScopeResolutionOptions {
  readonly reportLeafConflicts?: boolean;
}

export function listGeneratedFiles(rootDir: string): ReadonlyArray<string> {
  if (!existsSync(rootDir)) return [];
  let rootStat;
  try {
    rootStat = lstatSync(rootDir);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) return [];
  if (rootStat.isFile()) return [rootDir];
  if (!rootStat.isDirectory()) return [];
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
  outputRoot: string,
  options: ScopeResolutionOptions = {}
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  return resolveDeclaredScopes(scopes, layout, outputRoot, false, "write", options);
}

export function resolveDeclaredReadScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string,
  options: ScopeResolutionOptions = {}
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  return resolveDeclaredScopes(scopes, layout, outputRoot, true, "read", options);
}

function resolveDeclaredScopes(
  scopes: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string,
  allowRootRead: boolean,
  mode: "read" | "write",
  options: ScopeResolutionOptions
): { readonly ok: true } & ResolvedScopeSet | { readonly ok: false } {
  const roots: string[] = [];
  const permissions: string[] = [];
  const reportedLeafConflicts: string[] = [];
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
    for (const expanded of expandScopeRoot(resolved, layout.rootDir, recursive)) {
      const absolute = path.resolve(expanded);
      if (!isPathInside(layout.rootDir, absolute)) return { ok: false };
      if (recursive && absolute === path.resolve(layout.rootDir)) return { ok: false };
      if (mode === "write" && !isAllowedWriteScope(absolute, layout, outputRoot)) return { ok: false };
      if (scopePathContainsUnsafeComponent(absolute, layout.rootDir, options)) return { ok: false };
      const leafConflicts = reportableLeafConflicts(absolute, layout.rootDir, recursive, options.reportLeafConflicts === true);
      if (leafConflicts === null) return { ok: false };
      if (recursive && filesystemKind(absolute) === "directory" && recursiveScopeContainsSymlink(absolute)) return { ok: false };
      if (!validScopeTarget(absolute, recursive, mode) && leafConflicts.length === 0) return { ok: false };
      roots.push(absolute);
      permissions.push(...permissionPathsForScope(absolute, recursive));
      reportedLeafConflicts.push(...leafConflicts);
    }
  }
  return mode === "write" && roots.length === 0 ? {
    ok: true,
    roots: [],
    permissions: [],
    ...(reportedLeafConflicts.length > 0 ? { reportedLeafConflicts: uniquePermissionPaths(reportedLeafConflicts) } : {})
  } : roots.length > 0 ? {
    ok: true,
    roots: uniquePermissionPaths(roots),
    permissions: uniquePermissionPaths(permissions),
    ...(reportedLeafConflicts.length > 0 ? { reportedLeafConflicts: uniquePermissionPaths(reportedLeafConflicts) } : {})
  } : { ok: false };
}

function validScopeTarget(root: string, recursive: boolean, mode: "read" | "write"): boolean {
  try {
    const stat = lstatSync(root);
    return recursive ? stat.isDirectory() : stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    if (recursive) return true;
    if (!recursive && mode === "read") return false;
    try {
      return lstatSync(path.dirname(root)).isDirectory();
    } catch {
      return false;
    }
  }
}

export function scopePathContainsSymlink(root: string, projectRoot: string): boolean {
  return scopePathComponentsAreUnsafe(root, projectRoot, false);
}

export function scopePathContainsUnsafeComponent(
  root: string,
  projectRoot: string,
  options: ScopeResolutionOptions = {}
): boolean {
  return scopePathComponentsAreUnsafe(root, projectRoot, true, options.reportLeafConflicts === true);
}

function scopePathComponentsAreUnsafe(
  root: string,
  projectRoot: string,
  rejectPortableAliases: boolean,
  allowPortableLeafAliases = false
): boolean {
  const boundary = path.resolve(projectRoot);
  const target = path.resolve(root);
  const relative = path.relative(boundary, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  try {
    if (lstatSync(boundary).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  let current = boundary;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    const aliases = rejectPortableAliases ? portableSiblingAliases(current, segment) : [];
    const reportableLeaf = allowPortableLeafAliases && index === segments.length - 1;
    if (aliases.length > 0 && !reportableLeaf) return true;
    if (aliases.some((alias) => pathIsSymlink(path.join(current, alias)))) return true;
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      return true;
    }
  }
  return false;
}

function reportableLeafConflicts(
  root: string,
  projectRoot: string,
  recursive: boolean,
  enabled: boolean
): ReadonlyArray<string> | null {
  if (!enabled) return [];
  if (!recursive) return null;
  const target = path.resolve(root);
  const boundary = path.resolve(projectRoot);
  if (!sameOrInside(boundary, target)) return null;
  const aliases = portableSiblingAliases(path.dirname(target), path.basename(target))
    .map((entry) => path.join(path.dirname(target), entry));
  if (aliases.some(pathIsSymlink)) return null;
  const targetKind = filesystemKind(target);
  if (targetKind === "symlink" || targetKind === "other") return null;
  return [
    ...(aliases.length === 0 && targetKind !== "missing" && targetKind !== "directory" ? [target] : []),
    ...aliases
  ];
}

function filesystemKind(candidate: string): "missing" | "file" | "directory" | "symlink" | "other" {
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "missing";
  }
}

function portableSiblingAliases(parent: string, canonicalName: string): ReadonlyArray<string> {
  const key = portablePathKey(canonicalName);
  try {
    return readdirSync(parent).filter((entry) => entry !== canonicalName && portablePathKey(entry) === key);
  } catch {
    return [];
  }
}

function pathIsSymlink(candidate: string): boolean {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return true;
  }
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

export function recursiveScopeContainsSymlink(root: string): boolean {
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = lstatSync(resolvedRoot);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (rootStat.isSymbolicLink()) return true;
  if (!rootStat.isDirectory()) return false;

  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    let names: ReadonlyArray<string>;
    try {
      names = readdirSync(directory);
    } catch {
      return true;
    }
    for (const name of names) {
      const candidate = path.join(directory, name);
      let stat;
      try {
        stat = lstatSync(candidate);
      } catch {
        return true;
      }
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
  return false;
}

export function resolvedScopeSetIsSafe(
  scope: ResolvedScopeSet,
  projectRoots: string | ReadonlyArray<string>,
  mode: "read" | "write"
): boolean {
  const boundaries = (Array.isArray(projectRoots) ? projectRoots : [projectRoots]).map((root) => path.resolve(root));
  return scope.roots.every((root) => {
    const boundary = boundaries.find((candidate) => sameOrInside(candidate, root));
    if (!boundary) return false;
    const recursive = scopeRootIsRecursive(scope, root);
    const options = { reportLeafConflicts: scope.reportedLeafConflicts !== undefined };
    const currentConflicts = reportableLeafConflicts(root, boundary, recursive, options.reportLeafConflicts);
    const conflictsRemainDeclared = currentConflicts !== null && currentConflicts.every((candidate) =>
      scope.reportedLeafConflicts?.some((declared) => path.resolve(declared) === path.resolve(candidate))
    );
    return !scopePathContainsUnsafeComponent(root, boundary, options) &&
      conflictsRemainDeclared &&
      (!recursive || filesystemKind(root) !== "directory" || !recursiveScopeContainsSymlink(root)) &&
      (validScopeTarget(root, recursive, mode) || (currentConflicts?.length ?? 0) > 0);
  });
}

export function scopeRootIsRecursive(scope: ResolvedScopeSet, root: string): boolean {
  return scope.permissions.some((permission) => (
    permission.endsWith("/**") && path.resolve(permission.slice(0, -3)) === path.resolve(root)
  ));
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

export function sameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length === 0 || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

export function scriptPackageReadPermissions(scriptPath: string, manifestRoot: string): ReadonlyArray<string> {
  return uniquePermissionPaths([
    path.resolve(scriptPath),
    ...permissionPathsForScope(manifestRoot, true),
    ...manifestPackageJsonCandidatePaths(scriptPath, manifestRoot)
  ]);
}

export function scriptPackageIsSafe(scriptPath: string, manifestRoot: string): boolean {
  try {
    const rootStat = lstatSync(manifestRoot);
    const scriptStat = lstatSync(scriptPath);
    return rootStat.isDirectory() &&
      scriptStat.isFile() &&
      !rootStat.isSymbolicLink() &&
      !scriptStat.isSymbolicLink() &&
      !recursiveScopeContainsSymlink(manifestRoot);
  } catch {
    return false;
  }
}

function manifestPackageJsonCandidatePaths(scriptPath: string, manifestRoot: string): ReadonlyArray<string> {
  const candidates: string[] = [];
  const boundary = path.resolve(manifestRoot);
  let current = path.dirname(path.resolve(scriptPath));
  if (!sameOrInside(boundary, current)) return candidates;
  while (sameOrInside(boundary, current)) {
    candidates.push(path.join(current, "package.json"));
    if (current === boundary) return candidates;
    const parent = path.dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
  return candidates;
}

function expandScopeRoot(root: string, projectRoot: string, recursive: boolean): ReadonlyArray<string> {
  const target = path.resolve(root);
  if (!target.split(path.sep).some((part) => part.includes("*"))) return [root];
  const boundary = path.resolve(projectRoot);
  const relative = path.relative(boundary, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const parts = relative.split(path.sep).filter(Boolean);
  let candidates = [boundary];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    candidates = candidates.flatMap((candidate) => {
      if (!part.includes("*")) return [path.join(candidate, part)];
      if (scopePathContainsUnsafeComponent(candidate, boundary)) return [];
      try {
        if (!lstatSync(candidate).isDirectory()) return [];
        return readdirSync(candidate, { withFileTypes: true })
          .filter((entry) => !entry.isSymbolicLink() && globSegmentMatches(entry.name, part))
          .filter((entry) => last ? (recursive ? entry.isDirectory() : entry.isFile()) : entry.isDirectory())
          .map((entry) => path.join(candidate, entry.name));
      } catch {
        return [];
      }
    });
  }
  return candidates.filter((candidate) => {
    if (scopePathContainsUnsafeComponent(candidate, boundary)) return false;
    try {
      const stat = lstatSync(candidate);
      return recursive ? stat.isDirectory() : stat.isFile();
    } catch {
      return false;
    }
  });
}

function globSegmentMatches(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}
