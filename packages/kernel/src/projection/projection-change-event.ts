import type {
  DeclaredProjectionDelta,
  DeclaredSourceManifestRow
} from "./sqlite-declared-source-manifest.ts";
import type { ProjectionReadResult } from "./types.ts";

/**
 * Ephemeral invalidation payload emitted after the derived projection has been
 * published. It deliberately contains no actor or write-audit fields; those
 * belong to the runtime event ledger.
 */
export interface ProjectionChangeEvent {
  readonly schema: "projection-change/v1";
  readonly sourceHash: string;
  readonly entities: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
  }>;
}

export type IncrementalTaskProjectionResult = ProjectionReadResult & (
  | { readonly mode: "incremental" | "unchanged"; readonly sourceHash: string; readonly change: ProjectionChangeEvent }
  | { readonly mode: "rebuild"; readonly sourceHash?: undefined; readonly change?: undefined }
);

export function projectionChange(
  sourceHash: string,
  entities: ReadonlyArray<{ readonly kind: string; readonly id: string }>
): ProjectionChangeEvent {
  const unique = new Map(entities
    .filter((entity) => entity.id.length > 0)
    .map((entity) => [`${entity.kind}\0${entity.id}`, entity] as const));
  return {
    schema: "projection-change/v1",
    sourceHash,
    entities: [...unique.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
  };
}

export function declaredProjectionEntityChanges(
  previous: ReadonlyArray<Pick<DeclaredSourceManifestRow, "sourcePath" | "sourceKind" | "primaryKey">>,
  delta: DeclaredProjectionDelta
): ReadonlyArray<{ readonly kind: string; readonly id: string }> {
  const previousByPath = new Map(previous.map((row) => [row.sourcePath, row]));
  return [
    ...delta.manifest.deleteSourcePaths.map((sourcePath) => previousByPath.get(sourcePath)),
    ...delta.manifest.upsertRows
  ].filter((row): row is NonNullable<typeof row> => Boolean(row?.primaryKey))
    .map((row) => ({ kind: row.sourceKind, id: row.primaryKey }));
}
