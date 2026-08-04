import type { EntityDeclaration } from "../entity/declaration.ts";
import { executionDeclaration } from "../entity/execution-declaration.ts";
import { consentDeclaration } from "../entity/consent-declaration.ts";
import { reviewDeclaration } from "../entity/review-declaration.ts";
import { sessionEntityDeclaration } from "../entity/session.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  readUnionAttributionEventsFromSource,
  readAttributionEventSource,
  type AttributionEventSource
} from "../local/attribution-event-source.ts";
import type { UnionAttributionEvent } from "../schemas/attribution-event-union.ts";
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
  consentDeclaration,
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

/**
 * Content-free shape information for production diagnostics. Hashes identify
 * a source generation without putting authored bodies or paths on the wire.
 */
export interface ProjectionSourceSummary {
  readonly taskEntryCount: number;
  readonly taskInputCount: number;
  readonly taskSourceHash: string;
  readonly declaredSourceCount: number;
  readonly declaredInputCount: number;
  readonly declaredSourceHash: string;
  readonly attributionInputCount: number;
  readonly attributionSourceHash: string;
  readonly legacyPersonIdCount: number;
  readonly legacyPersonIdsHash: string;
  readonly fingerprint: string;
}

export interface ProjectionSourceSnapshot extends ProjectionSourceFingerprint {
  readonly decisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly declaredTables: ReadonlyArray<DeclaredProjectionSnapshot>;
  readonly attributionEvents: ReadonlyArray<UnionAttributionEvent>;
}

export interface ProjectionSourceCacheReuse {
  readonly task?: boolean;
  readonly declared?: boolean;
  readonly attribution?: boolean;
  readonly touchedTaskPaths?: ReadonlyArray<string>;
  readonly validateReusedTaskDirectories?: boolean;
  readonly validateReusedDeclaredDirectories?: boolean;
}

export function summarizeProjectionSourceFingerprint(
  source: ProjectionSourceFingerprint
): ProjectionSourceSummary {
  return {
    taskEntryCount: source.taskSource.entries.length,
    taskInputCount: source.taskSource.sourceInputs.length,
    taskSourceHash: source.taskSource.hash,
    declaredSourceCount: source.declaredSources.length,
    declaredInputCount: source.declaredSources.reduce(
      (count, declared) => count + declared.source.inputs.length,
      0
    ),
    declaredSourceHash: stablePayloadHash({
      schema: "projection-declared-source-summary/v1",
      sources: source.declaredSources.map(({ table, source: declared }) => ({
        table,
        inputCount: declared.inputs.length,
        hash: declared.hash
      }))
    }),
    attributionInputCount: source.attributionSource.inputs.length,
    attributionSourceHash: source.attributionSource.hash,
    legacyPersonIdCount: source.legacyPersonIds.length,
    legacyPersonIdsHash: hashProjectionLegacyPersonIds(source.legacyPersonIds),
    fingerprint: source.fingerprint
  };
}

export function captureProjectionSourceFingerprint(
  rootInput: HarnessLayoutInput,
  declaredSourceHints: ReadonlyArray<DeclaredEntitySourceHint> = [],
  validation: "stable" | "verify" = "stable",
  touchedDeclaredPaths: ReadonlyArray<string> = [],
  reuseUntouchedSourceCaches: ProjectionSourceCacheReuse = {}
): ProjectionSourceFingerprint {
  const taskSource = readMarkdownSource(
    rootInput,
    validation,
    reuseUntouchedSourceCaches.task === true,
    reuseUntouchedSourceCaches.touchedTaskPaths ?? [],
    reuseUntouchedSourceCaches.validateReusedTaskDirectories !== false
  );
  const declaredSources = projectionEntityDeclarations.map((declaration) => ({
    declaration,
    table: declaration.projection.table,
    source: readDeclaredEntitySource(
      rootInput,
      declaration,
      declaredSourceHints,
      validation,
      touchedDeclaredPaths,
      reuseUntouchedSourceCaches.declared === true,
      reuseUntouchedSourceCaches.validateReusedDeclaredDirectories !== false
    )
  }));
  const attributionSource = readAttributionEventSource(rootInput, validation, reuseUntouchedSourceCaches.attribution === true);
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
  const attributionEvents = readUnionAttributionEventsFromSource(source.attributionSource);
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
