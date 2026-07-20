import type { VersionControlSystem } from "../../../ports/version-control-system.ts";

export function memoizePublicationVcs(delegate: VersionControlSystem): VersionControlSystem {
  const normalizedPaths = new Map<string, string>();
  const topLevels = new Map<string, string | null>();
  const commitExistence = new Map<string, boolean>();
  const pathExistence = new Map<string, boolean>();
  return {
    ...delegate,
    normalizePath: (inputPath) => memoized(normalizedPaths, inputPath, () => delegate.normalizePath(inputPath)),
    topLevel: (inputPath) => memoized(topLevels, inputPath, () => delegate.topLevel(inputPath)),
    commitExists: (repoRoot, ref) => memoized(commitExistence, `${repoRoot}\0${ref}`, () => delegate.commitExists(repoRoot, ref)),
    pathExistsAtCommit: (repoRoot, ref, relativePath) => memoized(
      pathExistence,
      `${repoRoot}\0${ref}\0${relativePath}`,
      () => delegate.pathExistsAtCommit(repoRoot, ref, relativePath)
    )
  };
}

function memoized<Key, Value>(cache: Map<Key, Value>, key: Key, compute: () => Value): Value {
  if (cache.has(key)) return cache.get(key)!;
  const value = compute();
  cache.set(key, value);
  return value;
}
