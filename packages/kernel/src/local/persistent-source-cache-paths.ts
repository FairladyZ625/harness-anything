import path from "node:path";
import { listProjectionSourceDirectoryPaths, localProjectionSourceFileSystem } from "./local-layout-file-system.ts";

export function serializeSourceCacheSignatures<Signature extends string | null>(
  rootDir: string,
  signatures: ReadonlyMap<string, Signature>
): ReadonlyArray<{ readonly relativePath: string; readonly signature: Signature }> {
  return [...signatures].map(([inputPath, signature]) => ({
    relativePath: path.relative(rootDir, inputPath).split(path.sep).join("/"),
    signature
  }));
}

export function restoreSourceCacheSignatures<Signature extends string | null>(
  rootDir: string,
  signatures: ReadonlyArray<{ readonly relativePath: string; readonly signature: Signature }>
): ReadonlyMap<string, Signature> {
  return new Map(signatures.map(({ relativePath, signature }) => [path.resolve(rootDir, relativePath), signature]));
}

export function isSafeRelativeSourceCachePath(inputPath: string): boolean {
  return inputPath.length > 0 && !path.isAbsolute(inputPath) &&
    !inputPath.split(/[\\/]/u).some((segment) => segment === ".." || segment.length === 0);
}

export function sameSourceCacheSignatures(
  left: ReadonlyMap<string, string | null>,
  right: ReadonlyMap<string, string | null>
): boolean {
  return left.size === right.size && [...left].every(([inputPath, signature]) => right.get(inputPath) === signature);
}

export function captureRequiredSourceCacheSignatures(
  paths: Iterable<string>
): ReadonlyMap<string, string> | null {
  const signatures = new Map<string, string>();
  for (const inputPath of new Set(paths)) {
    const signature = localProjectionSourceFileSystem.statSignature(inputPath);
    if (signature === null) return null;
    signatures.set(inputPath, signature);
  }
  return signatures;
}

export function captureSourceCacheWatchSignatures(
  paths: Iterable<string>
): ReadonlyMap<string, string | null> {
  return new Map([...new Set(paths)].map((inputPath) => [
    inputPath,
    localProjectionSourceFileSystem.statSignature(inputPath)
  ]));
}

export function sourceCacheSignaturesMatch(signatures: ReadonlyMap<string, string | null>): boolean {
  return [...signatures].every(([inputPath, expected]) =>
    localProjectionSourceFileSystem.statSignature(inputPath) === expected);
}

export function listSourceCacheDirectoryPaths(rootPath: string): ReadonlyArray<string> {
  return listProjectionSourceDirectoryPaths(rootPath);
}
