import { realpathSync } from "node:fs";
import path from "node:path";
import {
  readColdRebuildSource,
  readMarkdownSource,
  readScalar,
  resolveHarnessLayout,
  stableStringify,
  taskEntryToRow,
  validateMigrationImportEvent,
  type ActorIdentity,
  type CanonicalEventStore,
  type ColdDecisionProjectionRow,
  type MigrationImportEventV1,
  type RelationFactRow,
  type RelationGraphEdgeRow,
  type TaskProjection,
  type TaskSourceEntry,
} from "../../kernel/src/index.ts";
import { auditAuthoredCoverage, authoredPaths, parseResolutions } from "./migration-import-authored-audit.ts";
import { classifyAuthored, referencedContent } from "./migration-import-authored-classification.ts";
import { mediaType, portableMigrationPath, resolveAuthoredConflict } from "./migration-import-conflicts.ts";
import { addDecision as addDecisionImpl } from "./migration-import-entities.ts";
import {
  blob,
  claim,
  legacyDecisionState,
  prepare,
  preservedSourceDocument,
  readSourceAttribution,
  taskDocument,
  taskStatus,
  validDecision,
  validFact,
} from "./migration-import-events.ts";
import { archivedExecution, decodeLegacyExecution, symlinkTarget, utf8File } from "./migration-import-legacy.ts";
import {
  actorFor as actorForImpl,
  dropMap as dropMapImpl,
  existingSourceEntity as existingSourceEntityImpl,
  mappedIdentifier as mappedIdentifierImpl,
  prepareRelation as prepareRelationImpl,
  preparedCounts as preparedCountsImpl,
  projectedCounts as projectedCountsImpl,
  reboundRef as reboundRefImpl,
  reboundRelation as reboundRelationImpl,
  sourceCounts as sourceCountsImpl,
} from "./migration-import-relations.ts";
import {
  bySkip,
  clean,
  fromColdIssue,
  message,
  migrationImportError,
  reportTable,
  requiredMigrationText,
  skippedCounts,
  sourcePathFor,
  subtract,
  taskIndexPaths,
  timestamp,
  zeroCounts,
} from "./migration-import-report.ts";
import {
  idRemapConflict,
  includeSourceEventCoverage,
  migrationOperationId,
  validateSourceGit,
} from "./migration-import-source.ts";
import {
  addRepoDocuments as addRepoDocumentsImpl,
  addTask as addTaskImpl,
  addTaskPackage as addTaskPackageImpl,
  importedTaskMetadata as importedTaskMetadataImpl,
} from "./migration-import-tasks.ts";
import type {
  Draft,
  EntityKind,
  IdRemapping,
  ImportCounts,
  ImportedRelation,
  ImportedTask,
  MigrationImportReceipt,
  PackageDraft,
  Prepared,
  Skip,
} from "./migration-import-types.ts";
import { yieldToEventLoop } from "./process-port.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell.ts";

export const PEOPLE_ROSTER_PATH = "people.yaml",
  PEOPLE_REGISTRY_SURFACE = "people-registry";

export interface MigrationImportRunInput {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly shouldStop?: () => boolean;
}

export async function runSingleMigrationImport(
  input: MigrationImportRunInput,
  addFactImpl: (context: any, row: RelationFactRow) => void,
): Promise<MigrationImportReceipt> {
  const sourceArg = requiredMigrationText(input.action.sourceRoot, "sourceRoot"),
    sourceRoot = realpathSync.native(path.resolve(sourceArg)),
    destination = realpathSync.native(path.resolve(input.rootDir)),
    dryRun = input.action.dryRun === true;
  if (sourceRoot === destination)
    throw migrationImportError(
      "migration_source_is_destination",
      "--source must name a different, read-only legacy repository.",
    );
  const sourceLayout = resolveHarnessLayout(sourceRoot),
    sourceGit = validateSourceGit(sourceRoot, sourceLayout.authoredRoot),
    sourceKey = sourceGit.sourceId,
    destinationLayout = resolveHarnessLayout(destination),
    resolutions = parseResolutions(input.action.resolutions, sourceRoot, sourceLayout.authoredRoot),
    taskRead = readMarkdownSource(sourceRoot),
    packageOwners = new Map(
      taskRead.entries.map((entry) => [
        portableMigrationPath(path.relative(sourceLayout.authoredRoot, path.dirname(entry.indexPath))),
        readScalar(entry.frontmatter, "task_id") || entry.taskId,
      ]),
    ),
    allAuthoredEntries = authoredPaths(sourceLayout.authoredRoot),
    authoredEntries = allAuthoredEntries.filter(({ path: sourcePath }) => !sourcePath.startsWith("events/")),
    authoredCoverage = includeSourceEventCoverage(
      auditAuthoredCoverage(
        sourceRoot,
        sourceLayout.authoredRoot,
        destinationLayout.authoredRoot,
        authoredEntries,
        packageOwners,
        resolutions,
      ),
      allAuthoredEntries.length - authoredEntries.length,
    ),
    cold = readColdRebuildSource(sourceRoot),
    skips: Skip[] = cold.issues.map(fromColdIssue),
    validEntries = new Set(taskRead.entries.map((entry) => path.resolve(entry.indexPath)));
  for (const indexPath of taskIndexPaths(sourceLayout.tasksRoot))
    if (!validEntries.has(path.resolve(indexPath)))
      skips.push({
        entityType: "task",
        migratedFrom: path.basename(path.dirname(indexPath)),
        sourcePath: path.relative(sourceRoot, indexPath),
        reason: "INDEX.md is malformed",
      });
  const attribution = readSourceAttribution(sourceLayout.authoredRoot),
    attributionUse = { restored: 0, fallback: 0 };
  const actor = input.binding.actor,
    initialRevision = input.store.readHead()?.revision ?? 0,
    importId = `import_${sourceKey.slice(0, 12)}_${sourceGit.head.slice(0, 12)}`,
    decisionGraph = input.projection.readDecisionGraph(),
    existingTasks = new Set(input.projection.list().rows.map(({ taskId }) => taskId)),
    existingDecisions = new Set(decisionGraph.decisionAnchors.map(({ decisionId }) => decisionId)),
    existingFacts = new Set(input.projection.readFactGraph().facts.map(({ ref }) => ref)),
    existingRelations = new Set(
      [...decisionGraph.edges, ...input.projection.readFactGraph().edges].map(({ relationId }) => relationId),
    );
  const taskMap = new Map<string, string>(),
    decisionMap = new Map<string, string>(),
    factMap = new Map<string, string>(),
    relationMap = new Map<string, string>(),
    taskPackages = new Map<string, string>(),
    taskOccurredAt = new Map<string, string>(),
    factDocuments = new Map<
      string,
      Array<{
        readonly factId: string;
        readonly statement: string;
        readonly evidenceSource: string;
        readonly observedAt: string;
        readonly confidence: "low" | "medium" | "high";
        readonly state: "standing";
        readonly workspaceRevision: number;
      }>
    >(),
    drafts: Draft[] = [],
    packageDrafts: PackageDraft[] = [],
    remappings: IdRemapping[] = [],
    alreadyImported: Record<EntityKind, number> = {
      task: 0,
      decision: 0,
      fact: 0,
      relation: 0,
      coverage: 0,
    };
  const extracted = {
    sourceRoot,
    message,
    skips,
    timestamp,
    taskMap,
    existingSourceEntity,
    taskPackages,
    taskOccurredAt,
    alreadyImported,
    mappedIdentifier,
    existingTasks,
    taskStatus,
    clean,
    actor,
    drafts,
    importedTaskMetadata,
    taskDocument,
    claim,
    prepare,
    sourceKey,
    actorFor,
    blob,
    portableMigrationPath,
    sourceLayout,
    packageOwners,
    authoredEntries,
    path,
    utf8File,
    decodeLegacyExecution,
    archivedExecution,
    packageDrafts,
    mediaType,
    resolveAuthoredConflict,
    classifyAuthored,
    destinationLayout,
    resolutions,
    PEOPLE_REGISTRY_SURFACE,
    symlinkTarget,
    referencedContent,
    validDecision,
    decisionMap,
    existingDecisions,
    legacyDecisionState,
    preservedSourceDocument,
    validFact,
    cold,
    factMap,
    existingFacts,
    idRemapConflict,
    remappings,
    sourceGit,
    factDocuments,
    reboundRef,
    reboundRelation,
    input,
    attribution,
    attributionUse,
    migrationOperationId,
    migrationImportError,
    taskRead,
    get prepared() {
      return prepared;
    },
    get migratedEdges() {
      return migratedEdges;
    },
    relationMap,
  };

  for (const entry of taskRead.entries) addTask(entry);
  for (const entry of taskRead.entries) addTaskPackage(entry);
  addRepoDocuments();
  for (const row of cold.decisions) addDecision(row);
  for (const row of cold.facts) addFact(row);
  const entityDrafts = drafts.sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        `${a.kind}\0${a.migratedFrom}`.localeCompare(`${b.kind}\0${b.migratedFrom}`),
    ),
    prepared: Prepared[] = [];
  let revision = initialRevision;
  for (const draft of entityDrafts) {
    const next = draft.build(revision + 1),
      errors = validateMigrationImportEvent(next.event);
    if (errors.length) {
      skips.push({
        entityType: draft.kind,
        migratedFrom: draft.migratedFrom,
        sourcePath: sourcePathFor(draft.kind, draft.migratedFrom),
        reason: errors.join("; "),
      });
      dropMap(draft.kind, draft.migratedFrom);
      continue;
    }
    if (input.store.readEvent(next.event.opId) === null) {
      prepared.push(next);
      revision += 1;
    }
  }
  const migratedEdges: RelationGraphEdgeRow[] = [];
  for (const row of cold.truth.edges) {
    const rebound = reboundRelation(row);
    if (!rebound) continue;
    const held = existingSourceEntity("relation", row.relationId);
    if (held?.kind === "relation") {
      relationMap.set(row.relationId, held.relation.relation_id);
      migratedEdges.push(row);
      alreadyImported.relation += 1;
      continue;
    }
    const next = prepareRelation(rebound, revision + 1);
    const errors = validateMigrationImportEvent(next.event);
    if (errors.length || existingRelations.has(rebound.record.relation_id) || relationMap.has(row.relationId)) {
      skips.push({
        entityType: "relation",
        migratedFrom: row.relationId,
        sourcePath: row.sourcePath,
        reason:
          errors[0] ??
          [
            "relation id already exists after remapping; import the colliding owner ",
            "entity first so its endpoints trigger deterministic remapping",
          ].join(""),
      });
      continue;
    }
    relationMap.set(row.relationId, rebound.record.relation_id);
    migratedEdges.push(row);
    prepared.push(next);
    revision += 1;
  }
  for (const draft of packageDrafts.sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.migratedFrom.localeCompare(b.migratedFrom),
  )) {
    const next = draft.build(revision + 1),
      errors = validateMigrationImportEvent(next.event);
    if (errors.length)
      throw migrationImportError("invalid_migration_source", `${draft.migratedFrom}: ${errors.join("; ")}`);
    if (input.store.readEvent(next.event.opId) === null) {
      prepared.push(next);
      revision += 1;
    }
  }
  const idMapPath = `migrations/${importId}/id-map.json`,
    old = sourceCounts(),
    skipped = skippedCounts(skips),
    expected = subtract(old, skipped),
    idMap = {
      schema: "migration-id-map/v1",
      importId,
      source: sourceRoot,
      sourceGit,
      generatedAt: input.now(),
      generation: "v0",
      maps: {
        task: Object.fromEntries(taskMap),
        decision: Object.fromEntries(decisionMap),
        fact: Object.fromEntries(factMap),
        relation: Object.fromEntries(relationMap),
      },
      remappings,
      skipped: [...skips].sort(bySkip),
    },
    mapBody = `${stableStringify(idMap)}\n`,
    mapPrepared = prepare(
      sourceKey,
      actor,
      "id-map",
      importId,
      input.now(),
      revision + 1,
      {
        kind: "id-map",
        importId,
        documentClaim: claim(idMapPath, mapBody, "application/json"),
      },
      [blob(mapBody, "application/json")],
    );
  if (
    !validateMigrationImportEvent(mapPrepared.event).length &&
    input.store.readEvent(mapPrepared.event.opId) === null
  ) {
    prepared.push(mapPrepared);
    revision += 1;
  }
  // Replay yields one event-loop turn per committed event and stops at the next
  // safe point (between single-event publications) when the daemon is draining;
  // the events already appended stay durable and complete.
  const writesAllowed = !dryRun && authoredCoverage.passed;
  if (writesAllowed)
    for (const item of prepared) {
      if (input.shouldStop?.())
        throw migrationImportError(
          "daemon_shutdown",
          [
            "Daemon shutdown interrupted this migration after revision ",
            `${input.store.readHead()?.revision ?? 0}`,
            "; every committed event is durable. Rerun the same --source set to ",
            "resume; source-scoped operation ids make already imported entities ",
            "no-ops.",
          ].join(""),
        );
      input.store.append(item);
      input.projection.apply(item.event, item.plan);
      await yieldToEventLoop();
    }
  const actual = dryRun ? preparedCounts() : writesAllowed ? projectedCounts() : zeroCounts(),
    unexplained = (Object.keys(old) as EntityKind[]).filter((kind) => actual[kind] !== expected[kind]),
    exitCode: 0 | 1 | 3 = !authoredCoverage.passed || unexplained.length ? 1 : skips.length ? 3 : 0,
    summary = reportTable(
      dryRun,
      old,
      skipped,
      expected,
      actual,
      skips,
      idMapPath,
      unexplained,
      authoredCoverage,
      attributionUse,
      sourceGit,
      remappings,
      alreadyImported,
    ),
    publishedMap = dryRun ? null : input.store.readEvent(mapPrepared.event.opId),
    publication = publishedMap ? input.store.publication(publishedMap) : null,
    canonicalVisible =
      publication?.cut.opId === mapPrepared.event.opId && publication.cut.revision === publishedMap?.workspaceRevision,
    outcome =
      exitCode === 1 ? ("op_rejected" as const) : canonicalVisible ? ("applied" as const) : ("pending" as const);
  return {
    outcome,
    opId: mapPrepared.event.opId,
    revision: writesAllowed ? revision : initialRevision,
    evidence: JSON.stringify({
      importId,
      sourceRoot,
      sourceGit,
      remappings,
      counts: { old, skipped, expected, new: actual },
      authoredCoverage,
    }),
    visibility: "center",
    proof: {
      committedRevision: writesAllowed ? revision : initialRevision,
      appliedCut: writesAllowed ? input.projection.list().watermark : initialRevision,
      durable: canonicalVisible,
      canonicalVisible,
      worktreeVisible: writesAllowed,
    },
    summary,
    mode: dryRun ? "dry-run" : "apply",
    exitCode,
    counts: { old, skipped, expected, new: actual },
    authoredCoverage,
    skippedEntities: [...skips].sort(bySkip),
    idMapPath: writesAllowed ? idMapPath : null,
    ...(exitCode === 1
      ? {
          code: "migration_reconciliation_failed",
          nextAction: authoredCoverage.passed
            ? "Inspect the unexplained reconciliation mismatch before retrying."
            : "Implement or decide every blocked authored surface before retrying.",
        }
      : !canonicalVisible
        ? {
            nextAction: dryRun
              ? "Remove --dry-run to publish this reconciled migration plan."
              : `Query receipt ${mapPrepared.event.opId}; the canonical import-map publication is missing.`,
          }
        : {
            nextAction:
              exitCode === 3
                ? [
                    "Review the listed skipped entities; repair the source Git snapshot and ",
                    "rerun the same import; already imported entities will be retained.",
                  ].join("")
                : "Migration reconciliation passed; rerunning or appending another --source is safe.",
          }),
  };
  function addTask(entry: TaskSourceEntry): void {
    return addTaskImpl(extracted, entry);
  }
  function importedTaskMetadata(
    row: ReturnType<typeof taskEntryToRow>,
    taskId: string,
  ): { readonly metadata?: ImportedTask["metadata"] } {
    return importedTaskMetadataImpl(extracted, row, taskId);
  }
  function addTaskPackage(entry: TaskSourceEntry): void {
    return addTaskPackageImpl(extracted, entry);
  }
  function addRepoDocuments(): void {
    return addRepoDocumentsImpl(extracted);
  }
  function addDecision(row: ColdDecisionProjectionRow): void {
    return addDecisionImpl(extracted, row);
  }
  function addFact(row: RelationFactRow): void {
    return addFactImpl(extracted, row);
  }
  function reboundRelation(row: RelationGraphEdgeRow): {
    readonly oldId: string;
    readonly sourcePath: string;
    readonly ownerRef: string;
    readonly record: ImportedRelation;
  } | null {
    return reboundRelationImpl(extracted, row);
  }
  function reboundRef(ref: string): string | null {
    return reboundRefImpl(extracted, ref);
  }
  function prepareRelation(
    value: NonNullable<ReturnType<typeof reboundRelation>>,
    workspaceRevision: number,
  ): Prepared {
    return prepareRelationImpl(extracted, value, workspaceRevision);
  }
  function dropMap(kind: Draft["kind"], id: string): void {
    return dropMapImpl(extracted, kind, id);
  }
  function actorFor(entityId: string): ActorIdentity {
    return actorForImpl(extracted, entityId);
  }
  function existingSourceEntity(
    kind: MigrationImportEventV1["payload"]["entity"]["kind"],
    migratedFrom: string,
  ): MigrationImportEventV1["payload"]["entity"] | null {
    return existingSourceEntityImpl(extracted, kind, migratedFrom);
  }
  function mappedIdentifier(
    kind: "task" | "decision",
    sourceId: string,
    occupied: ReadonlySet<string>,
    used: ReadonlySet<string>,
  ): string {
    return mappedIdentifierImpl(extracted, kind, sourceId, occupied, used);
  }
  function sourceCounts(): ImportCounts {
    return sourceCountsImpl(extracted);
  }
  function preparedCounts(): ImportCounts {
    return preparedCountsImpl(extracted);
  }
  function projectedCounts(): ImportCounts {
    return projectedCountsImpl(extracted);
  }
}
