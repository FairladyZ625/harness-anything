// @write-boundary-exemption rebuildable-projection
import {
  assertDecisionAdmission,
  listDecisionAgendaRowsPage,
  listDecisionRows,
  readDecisionGraphRows,
  readDecisionRow,
  readDecisionRows,
} from "./decision-event-projection.ts";
import {
  assertFactAdmission,
  FactProjectionError,
  readFactAnchorRows,
  readFactGraphRows,
  readFactRow,
  searchFactRowsPage,
} from "./fact-event-projection.ts";
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { catchUpRound } from "./rebuildable-task-projection-catch-up.ts";
import { watermark } from "./rebuildable-task-projection-sql.ts";
export type { ProjectionPage, TaskProjectionListQuery, TaskRelationQuery } from "./task-query-projection.ts";
export type { TaskProjection } from "./task-projection-port.ts";

// Fact and decision admission plus read query API.
export function knowledgeQueryApi(
  context: ProjectionContext,
): Pick<
  TaskProjection,
  | "admitFact"
  | "readFact"
  | "searchFacts"
  | "readFactAnchors"
  | "readFactGraph"
  | "admitDecision"
  | "readDecision"
  | "readDecisions"
  | "listDecisions"
  | "listDecisionAgendaPage"
  | "readDecisionGraph"
> {
  const { eventStore, limit, projectionPath, readHead } = context;
  return {
    admitFact: (event) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit);
        if (round.watermark !== round.sourceRevision)
          throw new FactProjectionError(
            "content_not_ready",
            `Fact admission requires projection revision ${round.sourceRevision}; ` +
              `current watermark is ${round.watermark}.`,
          );
        assertFactAdmission(db, event);
      }),
    readFact: (taskId, factId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          fact: readFactRow(db, taskId, factId),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    searchFacts: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = searchFactRowsPage(db, filters);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          facts: page.rows,
          watermark: current,
          sourceRevision: round.sourceRevision,
          ...(page.page ? { page: page.page } : {}),
        };
      }),
    readFactAnchors: (refs) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          rows: readFactAnchorRows(db, refs),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readFactGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          ...readFactGraphRows(db),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    admitDecision: (event) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit);
        if (round.watermark !== round.sourceRevision)
          throw new FactProjectionError(
            "content_not_ready",
            `Decision admission requires projection revision ${round.sourceRevision}; ` +
              `current watermark is ${round.watermark}.`,
          );
        assertDecisionAdmission(db, event);
      }),
    readDecision: (decisionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decision: readDecisionRow(db, decisionId),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readDecisions: (decisionIds) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: readDecisionRows(db, decisionIds),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    listDecisions: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: listDecisionRows(db, filters),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    listDecisionAgendaPage: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db),
          page = listDecisionAgendaRowsPage(db, query);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          decisions: page.rows,
          page: page.page,
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
    readDecisionGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const round = catchUpRound(db, eventStore, limit),
          current = watermark(db);
        return {
          status: current === round.sourceRevision ? "ready" : "pending",
          ...readDecisionGraphRows(db),
          watermark: current,
          sourceRevision: round.sourceRevision,
        };
      }),
  };
}
