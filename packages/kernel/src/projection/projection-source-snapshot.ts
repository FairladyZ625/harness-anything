import type { EntityDeclaration } from "../entity/declaration.ts";
import { executionDeclaration } from "../entity/execution-declaration.ts";
import { reviewDeclaration } from "../entity/review-declaration.ts";
import { sessionEntityDeclaration } from "../entity/session.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  readAttributionEventsFromSource,
  readAttributionEventSource,
  type AttributionEventSource
} from "../local/attribution-event-source.ts";
import type { AttributionEvent } from "../schemas/attribution-event.ts";
import {
  projectDeclaredEntitySource,
  readDeclaredProjectionRows,
  readDeclaredEntitySource,
  type DeclaredEntitySourceResult,
  type DeclaredEntitySourceHint,
  type DeclaredEntityDocumentProjection,
  type DeclaredProjectionRow
} from "./entity-declaration-projection.ts";
import { readLegacyPersonIds } from "./entity-attribution-projection.ts";
import { readDecisionProjectionRowsFromSource } from "./sqlite-decision-source.ts";
import { readMarkdownSource } from "./sqlite-task-source.ts";
import type { DecisionProjectionRow } from "./types.ts";

export const projectionEntityDeclarations = [
  sessionEntityDeclaration,
  executionDeclaration,
  reviewDeclaration
] as const;

export interface DeclaredProjectionSnapshot {
  readonly declaration: EntityDeclaration;
  readonly table: string;
  readonly rows: ReadonlyArray<DeclaredProjectionRow>;
  readonly documents: ReadonlyArray<DeclaredEntityDocumentProjection>;
}

export interface DeclaredEntitySourceSnapshot {
  readonly declaration: EntityDeclaration;
  readonly table: string;
  readonly source: DeclaredEntitySourceResult;
}

export interface ProjectionSourceFingerprint {
  readonly taskSource: ReturnType<typeof readMarkdownSource>;
  readonly declaredSources: ReadonlyArray<DeclaredEntitySourceSnapshot>;
  readonly attributionSource: AttributionEventSource;
  readonly legacyPersonIds: ReadonlyArray<string>;
  readonly fingerprint: string;
}

export interface ProjectionSourceSnapshot extends ProjectionSourceFingerprint {
  readonly decisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly declaredTables: ReadonlyArray<DeclaredProjectionSnapshot>;
  readonly attributionEvents: ReadonlyArray<AttributionEvent>;
}

export function captureProjectionSourceFingerprint(
  rootInput: HarnessLayoutInput,
  declaredSourceHints: ReadonlyArray<DeclaredEntitySourceHint> = []
): ProjectionSourceFingerprint {
  const taskSource = readMarkdownSource(rootInput);
  const declaredSources = projectionEntityDeclarations.map((declaration) => ({
    declaration,
    table: declaration.projection.table,
    source: readDeclaredEntitySource(rootInput, declaration, declaredSourceHints)
  }));
  const attributionSource = readAttributionEventSource(rootInput);
  const legacyPersonIds = [...readLegacyPersonIds(rootInput)].sort();
  const fingerprint = stablePayloadHash({
    schema: "projection-source-fingerprint/v2",
    taskSourceHash: taskSource.hash,
    declaredSources: declaredSources.map(({ table, source }) => ({ table, sourceHash: source.hash })),
    attributionSourceHash: attributionSource.hash,
    legacyPersonIds
  });
  return {
    taskSource,
    declaredSources,
    attributionSource,
    legacyPersonIds,
    fingerprint
  };
}

export function captureProjectionSourceSnapshot(rootInput: HarnessLayoutInput): ProjectionSourceSnapshot {
  const source = captureProjectionSourceFingerprint(rootInput);
  const decisionRows = readDecisionProjectionRowsFromSource(rootInput, source.taskSource.sourceInputs);
  const declaredTables = source.declaredSources.map(({ declaration, table, source: declaredSource }) => {
    const projected = projectDeclaredEntitySource(rootInput, declaration, declaredSource);
    return {
      declaration,
      table,
      rows: projected.rows,
      documents: projected.documents
    };
  });
  const attributionEvents = readAttributionEventsFromSource(source.attributionSource);
  return {
    ...source,
    decisionRows,
    declaredTables,
    attributionEvents
  };
}

export function hashDeclaredProjectionSnapshots(tables: ReadonlyArray<{
  readonly table: string;
  readonly rows: ReadonlyArray<DeclaredProjectionRow>;
}>): string {
  return stablePayloadHash({
    schema: "declared-projection-rows/v1",
    tables: tables.map(({ table, rows }) => ({ table, rows }))
  });
}

export function hashProjectionLegacyPersonIds(personIds: ReadonlyArray<string>): string {
  return stablePayloadHash({ schema: "projection-legacy-people/v1", personIds: [...personIds].sort() });
}

export function readDeclaredProjectionSnapshots(projectionPath: string): ReadonlyArray<DeclaredProjectionSnapshot> {
  return projectionEntityDeclarations.map((declaration) => ({
    declaration,
    table: declaration.projection.table,
    rows: readDeclaredProjectionRows(projectionPath, declaration),
    documents: []
  }));
}
