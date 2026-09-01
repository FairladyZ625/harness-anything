// @write-boundary-exemption rebuildable-projection
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { getEntityProjectionRow, listEntityProjectionRows } from "./rebuildable-task-projection-entities.ts";
import { readProjectionCut } from "./rebuildable-task-projection-sql.ts";

export function entityQueryApi(context: ProjectionContext): Pick<TaskProjection, "listEntities" | "getEntity"> {
  const { projectionPath, readHead } = context;
  return {
    listEntities: (entityKind) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        requireReadyEntityCut(cut.watermark, cut.sourceRevision);
        return listEntityProjectionRows(db, entityKind);
      }),
    getEntity: (entityKind, entityId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        requireReadyEntityCut(cut.watermark, cut.sourceRevision);
        return getEntityProjectionRow(db, entityKind, entityId);
      }),
  };
}

function requireReadyEntityCut(watermark: number, sourceRevision: number): void {
  if (watermark === sourceRevision) return;
  throw Object.assign(new Error(`Entity projection is catching up (${watermark}/${sourceRevision}); retry the read.`), {
    code: "projection_pending" as const,
  });
}
