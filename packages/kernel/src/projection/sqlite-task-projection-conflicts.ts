import { warning } from "./post-merge-checks.ts";
import type { DeclaredSourceIdentityConflict } from "./sqlite-declared-source-manifest.ts";
import type { DeclaredProjectionSnapshot } from "./projection-source-snapshot.ts";
import type { ProjectionWarning } from "./types.ts";

export function identityConflictWarning(conflict: DeclaredSourceIdentityConflict): ProjectionWarning {
  const canonicalDetail = conflict.canonicalSourcePaths && conflict.canonicalSourcePaths.length > 0
    ? ` Canonical candidates: ${conflict.canonicalSourcePaths.join(" and ")}.`
    : "";
  return warning(
    "source-package",
    "declared_identity_conflict",
    `Declared ${conflict.projectionTable}/${conflict.primaryKey} has multiple owners: ${conflict.sourcePaths.join(" and ")}.${canonicalDetail} Task projection remains readable; its conflicting entity rows were withheld.`,
    "Run ha doctor --repair --json to preserve the selected source and quarantine duplicate declarations."
  );
}

export function identityConflictCountWarning(count: number): ProjectionWarning {
  return warning(
    "source-package",
    "declared_identity_conflict",
    `Task projection is readable, but ${count} declared identity conflict${count === 1 ? "" : "s"} were withheld from entity projection.`,
    "Run ha doctor --repair --json to preserve the selected source and quarantine duplicate declarations."
  );
}

export function dedupeProjectionWarnings(warnings: ReadonlyArray<ProjectionWarning>): ReadonlyArray<ProjectionWarning> {
  const seen = new Set<string>();
  return warnings.filter((item) => {
    const key = `${item.code}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function filterConflictedDeclaredTables(
  tables: ReadonlyArray<DeclaredProjectionSnapshot>,
  conflicts: ReadonlyArray<DeclaredSourceIdentityConflict>
): ReadonlyArray<DeclaredProjectionSnapshot> {
  const conflictByIdentity = new Map(conflicts.map((conflict) => [
    `${conflict.projectionTable}\0${conflict.primaryKey}`,
    conflict
  ]));
  return tables.map((table) => {
    const canonicalByIdentity = new Map<string, string>();
    for (const document of table.documents) {
      const key = `${table.table}\0${document.primaryKey}`;
      const conflict = conflictByIdentity.get(key);
      if (!conflict) continue;
      const canonicalPaths = table.documents
        .filter((candidate) => candidate.primaryKey === document.primaryKey && conflict.sourcePaths.includes(candidate.relativePath))
        .map((candidate) => candidate.canonicalRelativePath);
      if (new Set(canonicalPaths).size === 1) canonicalByIdentity.set(key, canonicalPaths[0]!);
    }
    const documents = table.documents.filter((document) => {
      const key = `${table.table}\0${document.primaryKey}`;
      const conflict = conflictByIdentity.get(key);
      return !conflict || document.relativePath === canonicalByIdentity.get(key);
    });
    return {
      ...table,
      rows: documents.map((document) => document.row),
      documents
    };
  });
}
