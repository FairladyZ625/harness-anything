import type { MigrationArchivedEntityKind } from "../../kernel/src/index.ts";
import type { MigrationImportContext } from "./migration-import-run.ts";

export function scheduleArchivedEntity(
  context: MigrationImportContext,
  input: {
    readonly entityKind: MigrationArchivedEntityKind;
    readonly entityId: string;
    readonly sourcePath: string;
    readonly originalFields: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  },
): void {
  if (context.archivedIds[input.entityKind].has(input.entityId)) return;
  context.derivedIds[input.entityKind].delete(input.entityId);
  for (let index = context.fieldDerivations.length - 1; index >= 0; index -= 1)
    if (
      context.fieldDerivations[index]?.entityType === input.entityKind &&
      context.fieldDerivations[index]?.entityId === input.entityId
    )
      context.fieldDerivations.splice(index, 1);
  context.archivedIds[input.entityKind].add(input.entityId);
  context.dispositions.push({
    entityType: input.entityKind,
    entityId: input.entityId,
    sourcePath: input.sourcePath,
    disposition: "archived",
    reason: "truth_gap",
  });
  context.packageDrafts.push({
    migratedFrom: `archived:${input.entityKind}/${input.entityId}`,
    occurredAt: input.occurredAt,
    build: (workspaceRevision: number) =>
      context.prepare(
        context.sourceKey,
        context.actorFor(`${input.entityKind}/${input.entityId}`),
        "archived-entity",
        `${input.entityKind}/${input.entityId}`,
        input.occurredAt,
        workspaceRevision,
        {
          kind: "archived-entity",
          entityKind: input.entityKind,
          entityId: input.entityId,
          disposition: "archived",
          reason: "truth_gap",
          provenance: "imported_snapshot",
          sourcePath: input.sourcePath,
          originalFields: input.originalFields,
        },
        [],
      ),
  });
}
