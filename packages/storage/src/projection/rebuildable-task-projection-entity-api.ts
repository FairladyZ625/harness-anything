// @write-boundary-exemption rebuildable-projection
import type { TaskProjection } from "@harness-anything/kernel";
import type { ProjectionContext } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import {
  countEntityProjectionRows,
  getEntityProjectionRow,
  listEntityProjectionRows,
} from "./rebuildable-task-projection-entities.ts";
import { readProjectionCut } from "./rebuildable-task-projection-sql.ts";

export function entityQueryApi(
  context: ProjectionContext,
): Pick<TaskProjection, "listEntities" | "countEntities" | "getEntity"> {
  const { projectionPath, readHead } = context;
  return {
    listEntities: (entityKind) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        requireReadyEntityCut(cut.watermark, cut.sourceRevision);
        return listEntityProjectionRows(db, entityKind);
      }),
    countEntities: (entityKind, valueEquals) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        requireReadyEntityCut(cut.watermark, cut.sourceRevision);
        return countEntityProjectionRows(db, entityKind, valueEquals);
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
