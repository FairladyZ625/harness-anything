import { localProjectionSourceFileSystem } from "../local/local-layout-file-system.ts";
import type { DeclaredSourceManifestRow } from "./sqlite-declared-source-manifest.ts";

export interface ProjectionValidationCacheEntry {
  readonly signature: string;
  readonly declaredManifest: ReadonlyArray<DeclaredSourceManifestRow>;
}

const projectionValidationCache = new Map<string, ProjectionValidationCacheEntry>();
const projectionValidationCacheLimit = 16;

export function readCachedProjectionValidation(projectionPath: string): ProjectionValidationCacheEntry | null {
  const cached = projectionValidationCache.get(projectionPath);
  if (!cached || localProjectionSourceFileSystem.statSignature(projectionPath) !== cached.signature) return null;
  projectionValidationCache.delete(projectionPath);
  projectionValidationCache.set(projectionPath, cached);
  return cached;
}

export function rememberProjectionValidation(
  projectionPath: string,
  declaredManifest: ReadonlyArray<DeclaredSourceManifestRow>
): void {
  const signature = localProjectionSourceFileSystem.statSignature(projectionPath);
  if (signature === null) return;
  projectionValidationCache.delete(projectionPath);
  projectionValidationCache.set(projectionPath, { signature, declaredManifest });
  while (projectionValidationCache.size > projectionValidationCacheLimit) {
    const oldest = projectionValidationCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    projectionValidationCache.delete(oldest);
  }
}
