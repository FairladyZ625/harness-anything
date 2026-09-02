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
  listFactDomainTypeRows,
  readFactAnchorRows,
  readFactGraphRows,
  readFactRow,
  searchFactRowsPage,
} from "./fact-event-projection.ts";
import type { TaskProjection } from "./task-projection-port.ts";
import type { ProjectionContext } from "./rebuildable-task-projection-types.ts";
import { withDatabase } from "./rebuildable-task-projection-database.ts";
import { readDecisionDocumentState } from "./decision-projection-documents.ts";
import { catchUpRound } from "./rebuildable-task-projection-catch-up.ts";
import { readProjectionCut } from "./rebuildable-task-projection-sql.ts";
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
  | "listFactDomainTypes"
  | "readFactAnchors"
  | "readFactGraph"
  | "admitDecision"
  | "readDecision"
  | "readDecisionDocumentState"
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
    readFact: (factId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          fact: readFactRow(db, factId),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    searchFacts: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead),
          page = searchFactRowsPage(db, filters);
        return {
          status: cut.status,
          facts: page.rows,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          ...(page.page ? { page: page.page } : {}),
        };
      }),
    listFactDomainTypes: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          domainTypes: listFactDomainTypeRows(db),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readFactAnchors: (refs) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          rows: readFactAnchorRows(db, refs),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readFactGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          ...readFactGraphRows(db),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
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
    readDecisionDocumentState: (decisionId) =>
      withDatabase(projectionPath, readHead, (db) => readDecisionDocumentState(db, decisionId)),
    readDecision: (decisionId) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          decision: readDecisionRow(db, decisionId),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readDecisions: (decisionIds) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          decisions: readDecisionRows(db, decisionIds),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    listDecisions: (filters) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          decisions: listDecisionRows(db, filters),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    listDecisionAgendaPage: (query) =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead),
          page = listDecisionAgendaRowsPage(db, query);
        return {
          status: cut.status,
          decisions: page.rows,
          page: page.page,
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
    readDecisionGraph: () =>
      withDatabase(projectionPath, readHead, (db) => {
        const cut = readProjectionCut(db, readHead);
        return {
          status: cut.status,
          ...readDecisionGraphRows(db),
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
        };
      }),
  };
}
