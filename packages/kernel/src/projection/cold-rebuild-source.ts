import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import {
  isDecisionEvent,
  isFactEvent,
  isMigrationImportEvent,
  isRelationEvent,
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
} from "../domain/doc-sync.contract.ts";
import { deriveRelationId, isFactId, parseEntityRef, relationRecord } from "../domain/index.ts";
import { relationOwnerRef, type EntityRelationRecord } from "../domain/entity-relation.ts";
import {
  embeddedRelationEventsForReplay,
  reduceRelationEntity,
  type RelationEntity,
  type RelationEventV1,
} from "../domain/relation-event.ts";
import type { MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import {
  parseFlowObject,
  parseObjectList,
  parseStringArray,
  readBlockScalar,
  unquote,
} from "../markdown/flow-frontmatter.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { parseRelationFlowRecords } from "./relation-flow-frontmatter.ts";
import type {
  DecisionAnchorTruth,
  EventBackedRelationTruth,
  FactAnchorRow,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
} from "./relation-graph-projection.ts";
import {
  legacyRelationManualReason,
  normalizeLegacyRelationMigrationEvent,
  normalizeLegacyRelationRecord,
} from "./relation-migration-normalization.ts";
import { sourcePath } from "./sqlite-task-source.ts";
import { readDirIfPresent, readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";
import { coverageOf } from "../domain/decision-coverage.ts";
import { factLiveness } from "../domain/fact-liveness.ts";
import type { FactEventV1 } from "../domain/fact-event.ts";
import { normalizePersistedTimestamp } from "../domain/timestamp.ts";
import { readMigrationRelationEdges } from "./relation-migration-edges.ts";

export interface ColdDecisionProjectionRow {
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: readonly string[];
  readonly rejected: readonly { readonly text: string; readonly whyNot: string }[];
  readonly chosenRecords: readonly { readonly id: string; readonly text: string; readonly rationale?: string }[];
  readonly rejectedRecords: readonly { readonly id: string; readonly text: string; readonly whyNot: string }[];
  readonly claimRecords: readonly {
    readonly id: string;
    readonly text: string;
    readonly loadBearing: boolean;
    readonly fulfillment: RelationCoverageRow["fulfillment"];
  }[];
  readonly body: string;
  readonly path: string;
  readonly moduleKeys: readonly string[];
  readonly productLineKeys: readonly string[];
  readonly riskTier?: string;
  readonly urgency?: string;
  readonly vertical?: string;
  readonly preset?: string;
  readonly decisionClass?: string;
  readonly proposedAt?: string;
  readonly provenance?: readonly Record<string, unknown>[];
  readonly decidedAt?: string;
}
export interface ColdRebuildIssue {
  readonly entityType: "decision" | "fact" | "relation";
  readonly migratedFrom: string;
  readonly sourcePath: string;
  readonly reason: string;
}
export interface ColdRebuildSource {
  readonly decisions: readonly ColdDecisionProjectionRow[];
  readonly truth: EventBackedRelationTruth;
  readonly facts: readonly RelationFactRow[];
  readonly tasks: readonly { readonly ref: string; readonly status: string }[];
  readonly knownFactRefs: ReadonlySet<string>;
  /** Legacy task-local refs accepted only by the migration importer. */
  readonly legacyFactRefs: ReadonlyMap<string, string>;
  /** Legacy relation IDs whose endpoint re-key changed their canonical digest. */
  readonly legacyRelationIds: ReadonlyMap<string, string>;
  readonly issues: readonly ColdRebuildIssue[];
  readonly complete: boolean;
}
interface DecisionSource {
  readonly decisionId: string;
  readonly decisionRef: string;
  readonly filePath: string;
  readonly frontmatter: string;
  readonly visible: boolean;
}
interface RelationEntry {
  readonly hostRef: string;
  readonly ownerRef: string;
  readonly record: EntityRelationRecord;
  readonly sourcePath: string;
  readonly recordIndex: number;
}
interface EventFactSource {
  readonly identityRef: string;
  readonly row: RelationFactRow;
  readonly sourcePath: string;
}
interface AuthoredEventRead {
  readonly rows: readonly EventFactSource[];
  readonly relations: readonly RelationEntry[];
  readonly legacyFactRefs: ReadonlyMap<string, string>;
  readonly legacyRelationIds: ReadonlyMap<string, string>;
  readonly issues: readonly ColdRebuildIssue[];
}

/** Read authored L1 plus current canonical event envelopes for a cold projection.
 * Current event rows win over matching task-local Fact snapshots; migration-only
 * identity re-keying remains confined to the legacy reader below. */
export function readColdRebuildSource(
  rootInput: HarnessLayoutInput,
  seedTruth: EventBackedRelationTruth = emptyRelationTruth,
): ColdRebuildSource {
  return readColdRebuildSourceInternal(rootInput, false, seedTruth);
}

/** Migration-only source reader for pre-canonical task-local fact documents and
 * event envelopes. This boundary keeps the legacy parser out of resident
 * projection and post-merge paths. */
export function readLegacyMigrationSource(rootInput: HarnessLayoutInput): ColdRebuildSource {
  return readColdRebuildSourceInternal(rootInput, true, emptyRelationTruth);
}

const emptyRelationTruth: EventBackedRelationTruth = {
  factAnchors: [],
  decisionAnchors: [],
  edges: [],
  coverageRows: [],
};

function readColdRebuildSourceInternal(
  rootInput: HarnessLayoutInput,
  migrationMode: boolean,
  seedTruth: EventBackedRelationTruth,
): ColdRebuildSource {
  const layout = resolveHarnessLayout(rootInput),
    taskDirs = listDirs(layout.tasksRoot),
    taskIds = new Set(taskDirs.map(readTaskId)),
    seedKnownRefs = new Set(seedTruth.edges.flatMap((edge) => [edge.sourceRef, edge.targetRef]));
  for (const edge of seedTruth.edges)
    for (const ref of [edge.sourceRef, edge.targetRef]) {
      const parsed = parseEntityRef(ref);
      if (parsed?.kind === "task" && !parsed.externalHarness) taskIds.add(parsed.id);
    }
  const decisionRead = readDecisions(layout.rootDir, layout.decisionsRoot),
    eventRead = readAuthoredEvents(layout.rootDir, layout.authoredRoot, migrationMode),
    eventFacts = eventRead.rows,
    factRows = new Map(eventFacts.map(({ identityRef, row }) => [identityRef, row])),
    knownFactRefs = new Set([...factRows.keys(), ...seedTruth.factAnchors.map(({ factRef }) => factRef)]),
    legacyFactRefs = new Map<string, string>(eventRead.legacyFactRefs),
    legacyRelationIds = new Map<string, string>(eventRead.legacyRelationIds),
    factAnchors = new Map<string, FactAnchorRow>(seedTruth.factAnchors.map((row) => [row.factRef, row])),
    normalizeRelation = (record: EntityRelationRecord): EntityRelationRecord =>
      migrationMode ? normalizeLegacyRelationRecord(record, legacyFactRefs, legacyRelationIds) : record;
  const entries: RelationEntry[] = [],
    decisionAnchors: DecisionAnchorTruth[] = [];
  const issues: ColdRebuildIssue[] = [...decisionRead.issues, ...eventRead.issues];
  let complete = decisionRead.complete && eventRead.issues.length === 0;
  for (const taskDir of taskDirs) {
    const taskId = readTaskId(taskDir),
      indexPath = path.join(taskDir, "INDEX.md"),
      indexBody = readTextFileIfPresent(indexPath),
      indexFrontmatter = indexBody === null ? null : readFrontmatter(indexBody),
      factsPath = layout.taskDocumentPath(taskId, "facts.md"),
      body = readTextFileIfPresent(factsPath);
    if (body !== null) {
      const parsed = parseLegacyFacts(taskId, sourcePath(layout.rootDir, factsPath), body);
      complete &&= parsed.complete;
      issues.push(...parsed.issues);
      // Event-backed rows are authoritative when the legacy task-local file is
      // still present during the migration window. Otherwise key legacy rows by
      // their full source identity so equal F-* ids under different tasks both
      // reach the migration layer and its deterministic re-keying rule.
      for (const row of parsed.rows) {
        const legacyRef = row.taskId ? `fact/${row.taskId}/${row.factId}` : row.ref;
        if (!factRows.has(row.ref) && !factRows.has(legacyRef)) factRows.set(legacyRef, row);
      }
      for (const ref of parsed.knownFactRefs) knownFactRefs.add(ref);
      for (const [legacyRef, canonicalRef] of parsed.legacyFactRefs) legacyFactRefs.set(legacyRef, canonicalRef);
      for (const row of parsed.anchors) factAnchors.set(row.factRef, row);
      for (const row of parsed.rows) {
        if (row.taskId) {
          const identity = {
            source: `task/${row.taskId}`,
            target: row.ref,
            type: "produces" as const,
            direction: "directed" as const,
          };
          entries.push(
            relationEntry(
              {
                relation_id: deriveRelationId(identity),
                ...identity,
                strength: "strong",
                origin: "generated",
                state: "active",
                rationale: "Fact owner.",
              },
              identity.source,
              sourcePath(layout.rootDir, factsPath),
              1,
            ),
          );
        }
      }
    }
    const hosted = [
      ...(indexFrontmatter
        ? frontmatterRelations(indexFrontmatter).map((record) => ({
            record: normalizeRelation(record),
            from: indexPath,
          }))
        : []),
      ...(body === null
        ? []
        : parseRelationFlowRecords(body).map((record) => ({
            record: normalizeRelation(record),
            from: factsPath,
          }))),
    ];
    for (const [recordIndex, { record, from }] of hosted.entries())
      entries.push(relationEntry(record, `task/${taskId}`, sourcePath(layout.rootDir, from), recordIndex));
    if (body === null) continue;
    if (
      body.includes("Managed by `ha fact record`") &&
      [...body.matchAll(/^### (F-[0-9A-HJKMNP-TV-Z]{8})$/gmu)].some((match) => !factRows.has(`fact/${match[1]}`))
    )
      complete = false;
  }
  for (const file of listColdRebuildFiles(path.join(layout.authoredRoot, "facts"))) {
    const factId = /^F-[0-9A-HJKMNP-TV-Z]{8}\.md$/u.test(path.basename(file)) ? path.basename(file, ".md") : null;
    if (!factId) continue;
    const ref = `fact/${factId}`;
    knownFactRefs.add(ref);
    if (!factAnchors.has(ref))
      factAnchors.set(ref, { factRef: ref, factId, sourcePath: sourcePath(layout.rootDir, file) });
  }
  for (const { row, sourcePath: eventPath } of eventFacts)
    factAnchors.set(row.ref, {
      factRef: row.ref,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      factId: row.factId,
      sourcePath: eventPath,
    });
  for (const decision of decisionRead.sources.filter(({ visible }) => visible)) {
    const anchorRefs = [
      decision.decisionRef,
      ...decisionAnchorsFrom(decision.frontmatter).map((anchor) => `${decision.decisionRef}/${anchor}`),
    ];
    decisionAnchors.push({
      decisionRef: decision.decisionRef,
      decisionId: decision.decisionId,
      anchorRefs,
      sourcePath: sourcePath(layout.rootDir, decision.filePath),
    });
    for (const [recordIndex, rawRecord] of frontmatterRelations(decision.frontmatter).entries()) {
      const record = normalizeRelation(rawRecord);
      entries.push(
        relationEntry(record, decision.decisionRef, sourcePath(layout.rootDir, decision.filePath), recordIndex),
      );
    }
  }
  const normalizedEventRelations = eventRead.relations.map((entry) => {
      const record = normalizeRelation(entry.record);
      return record === entry.record
        ? entry
        : relationEntry(record, entry.ownerRef, entry.sourcePath, entry.recordIndex);
    }),
    seedRelations = seedTruth.edges.map(relationEntryFromEdge),
    canonicalRelations = [
      ...new Map(
        [...normalizedEventRelations, ...seedRelations].map((entry) => [entry.record.relation_id, entry]),
      ).values(),
    ],
    eventRelationIds = new Set(canonicalRelations.map(({ record }) => record.relation_id)),
    materializedEntries = [
      ...entries.filter(({ record }) => !eventRelationIds.has(record.relation_id)),
      ...canonicalRelations,
    ],
    allDecisionAnchors = [
      ...new Map([...decisionAnchors, ...seedTruth.decisionAnchors].map((row) => [row.decisionRef, row])).values(),
    ];
  const knownDecisions = new Set(allDecisionAnchors.flatMap(({ anchorRefs }) => anchorRefs)),
    relationRead = readMigrationRelationEdges(
      materializedEntries,
      taskIds,
      knownDecisions,
      knownFactRefs,
      seedKnownRefs,
      migrationMode,
    );
  complete &&= relationRead.issues.length === 0;
  issues.push(...relationRead.issues);
  const facts = [...factRows.values()]
    .map((row) => ({ ...row, liveness: factLiveness(row, relationRead.rows) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  const tasks = taskDirs.map((taskDir) => {
    const body = readTextFileIfPresent(path.join(taskDir, "INDEX.md")),
      frontmatter = body === null ? null : readFrontmatter(body);
    return {
      ref: `task/${readTaskId(taskDir)}`,
      status: frontmatter
        ? readScalar(frontmatter, "  status") || readScalar(frontmatter, "status") || "unknown"
        : "unknown",
    };
  });
  return {
    decisions: decisionRead.rows,
    truth: {
      factAnchors: [...factAnchors.values()].sort(byFactRef),
      decisionAnchors: allDecisionAnchors,
      edges: relationRead.rows,
      coverageRows: [],
    },
    facts,
    tasks,
    knownFactRefs,
    legacyFactRefs,
    legacyRelationIds,
    issues: issues.sort((a, b) =>
      `${a.sourcePath}\0${a.migratedFrom}`.localeCompare(`${b.sourcePath}\0${b.migratedFrom}`),
    ),
    complete,
  };
}

export function buildColdCoverage(
  source: ColdRebuildSource,
  edgesInput: readonly RelationGraphEdgeRow[],
): readonly RelationCoverageRow[] {
  return [
    ...coverageOf(
      source.decisions.map((decision) => {
        const ref = `decision/${decision.decisionId}`;
        return {
          ref,
          state: decision.state,
          decisionClass:
            decision.decisionClass === "standing-policy" ? "standing_policy" : (decision.decisionClass ?? "ordinary"),
          appliesTo: { modules: decision.moduleKeys, productLines: decision.productLineKeys },
          claims: decision.claimRecords.map((claim) => ({
            ref: `${ref}/${claim.id}`,
            loadBearing: claim.loadBearing,
            fulfillment: claim.fulfillment,
          })),
        };
      }),
      source.facts,
      source.tasks,
      edgesInput,
    ),
  ].sort((a, b) => a.claimRef.localeCompare(b.claimRef));
}

function readDecisions(
  rootDir: string,
  decisionsRoot: string,
): {
  readonly sources: readonly DecisionSource[];
  readonly rows: readonly ColdDecisionProjectionRow[];
  readonly issues: readonly ColdRebuildIssue[];
  readonly complete: boolean;
} {
  const drafts: Array<
      Omit<DecisionSource, "visible"> & { readonly watermark: string; readonly typedRevision: string }
    > = [],
    rows: ColdDecisionProjectionRow[] = [],
    issues: ColdRebuildIssue[] = [],
    watermarks = new Map<string, number>();
  let complete = true;
  for (const filePath of listColdRebuildFiles(decisionsRoot).filter(
    (candidate) => path.basename(candidate) === "decision.md",
  )) {
    const body = readTextFileIfPresent(filePath),
      frontmatter = body === null ? null : readFrontmatter(body);
    const portable = sourcePath(rootDir, filePath),
      fallback = path.basename(path.dirname(filePath));
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") {
      complete = false;
      issues.push({
        entityType: "decision",
        migratedFrom: fallback,
        sourcePath: portable,
        reason: "decision.md must contain decision-package/v1 frontmatter",
      });
      continue;
    }
    const decisionId = readScalar(frontmatter, "decision_id");
    if (!decisionId) {
      complete = false;
      issues.push({
        entityType: "decision",
        migratedFrom: fallback,
        sourcePath: portable,
        reason: "decision_id is missing",
      });
      continue;
    }
    const watermark = readScalar(frontmatter, "_coordinatorWatermark"),
      typedRevision = readScalar(frontmatter, "workspaceRevision");
    if (watermark) watermarks.set(watermark, (watermarks.get(watermark) ?? 0) + 1);
    drafts.push({ decisionId, decisionRef: `decision/${decisionId}`, filePath, frontmatter, watermark, typedRevision });
    rows.push(decisionRow(rootDir, filePath, body!, frontmatter, decisionId));
  }
  const sources = drafts
    .map((row) => ({
      decisionId: row.decisionId,
      decisionRef: row.decisionRef,
      filePath: row.filePath,
      frontmatter: row.frontmatter,
      visible: row.watermark ? watermarks.get(row.watermark) === 1 : Boolean(row.typedRevision),
    }))
    .sort((a, b) => a.decisionRef.localeCompare(b.decisionRef));
  return {
    sources,
    rows: rows.sort(
      (a, b) =>
        coldRebuildLegacyNumber(a.legacyId) - coldRebuildLegacyNumber(b.legacyId) ||
        a.decisionId.localeCompare(b.decisionId),
    ),
    issues,
    complete,
  };
}
function decisionRow(
  rootDir: string,
  filePath: string,
  body: string,
  frontmatter: string,
  decisionId: string,
): ColdDecisionProjectionRow {
  const applies = decisionAppliesTo(frontmatter),
    chosen = objectList(frontmatter, "chosen"),
    rejected = objectList(frontmatter, "rejected"),
    claimRows = objectList(frontmatter, "claims"),
    provenance = objectList(frontmatter, "provenance").map((entry) => ({
      ...entry,
      ...(typeof entry.boundAt === "string" ? { boundAt: canonicalTimestamp(entry.boundAt) } : {}),
    })),
    legacy = /(?:^|_)E(\d+)(?:_|$)/u.exec(decisionId)?.[1],
    decisionClass = readScalar(frontmatter, "decisionClass").replace("_", "-");
  const chosenRecords = chosen.flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.text === "string"
        ? [
            {
              id: entry.id,
              text: entry.text,
              ...(typeof entry.rationale === "string" ? { rationale: entry.rationale } : {}),
            },
          ]
        : [],
    ),
    rejectedRecords = rejected.flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.text === "string"
        ? [{ id: entry.id, text: entry.text, whyNot: String(entry.why_not ?? entry.whyNot ?? "") }]
        : [],
    ),
    claimRecords = claimRows.flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.text === "string"
        ? [
            {
              id: entry.id,
              text: entry.text,
              loadBearing: entry.load_bearing !== false && entry.loadBearing !== false,
              fulfillment: fulfillment(entry.fulfillment),
            },
          ]
        : [],
    );
  return {
    decisionId,
    ...(legacy ? { legacyId: `E${Number(legacy)}` } : {}),
    state: readScalar(frontmatter, "state") || "unknown",
    title: unquote(readScalar(frontmatter, "title")) || decisionId,
    question: unquote(readScalar(frontmatter, "question")),
    chosen: chosenRecords.map(({ text }) => text),
    rejected: rejectedRecords.map(({ text, whyNot }) => ({ text, whyNot })),
    chosenRecords,
    rejectedRecords,
    claimRecords,
    body: documentProse(body),
    path: sourcePath(rootDir, filePath),
    moduleKeys: applies.modules,
    productLineKeys: applies.productLines,
    ...optional("riskTier", readScalar(frontmatter, "riskTier")),
    ...optional("urgency", readScalar(frontmatter, "urgency")),
    ...optional("vertical", unquote(readScalar(frontmatter, "vertical"))),
    ...optional("preset", unquote(readScalar(frontmatter, "preset"))),
    ...optional("decisionClass", decisionClass),
    ...optional("proposedAt", canonicalTimestamp(unquote(readScalar(frontmatter, "proposedAt")))),
    ...(provenance.length ? { provenance } : {}),
    ...optional("decidedAt", canonicalTimestamp(unquote(readScalar(frontmatter, "decidedAt")))),
  };
}
function decisionAppliesTo(frontmatter: string): {
  readonly modules: readonly string[];
  readonly productLines: readonly string[];
} {
  const inline = readScalar(frontmatter, "applies_to");
  if (inline.startsWith("{")) {
    const value = parseFlowObject(inline, { tolerateInvalidArrays: true });
    return { modules: coldRebuildStrings(value.modules), productLines: coldRebuildStrings(value.productLines) };
  }
  return {
    modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules"), { tolerateInvalidArrays: true }),
    productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"), {
      tolerateInvalidArrays: true,
    }),
  };
}
function decisionAnchorsFrom(frontmatter: string): readonly string[] {
  return ["claims", "chosen", "rejected"].flatMap((key) =>
    objectList(frontmatter, key).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])),
  );
}
function frontmatterRelations(frontmatter: string): readonly EntityRelationRecord[] {
  const inline = readScalar(frontmatter, "relations");
  if (inline.startsWith("[")) {
    try {
      const rows = JSON.parse(inline) as unknown;
      return Array.isArray(rows) ? rows.filter(isRelation) : [];
    } catch {
      return [];
    }
  }
  return parseRelationFlowRecords(frontmatter);
}
function objectList(frontmatter: string, key: string): readonly Record<string, unknown>[] {
  const inline = readScalar(frontmatter, key);
  if (inline.startsWith("[")) {
    try {
      const rows = JSON.parse(inline) as unknown;
      return Array.isArray(rows) ? rows.filter(isColdRebuildRecord) : [];
    } catch {
      return [];
    }
  }
  return parseObjectList(frontmatter, key, { tolerateInvalidArrays: true });
}

function parseLegacyFacts(
  taskId: string,
  portablePath: string,
  body: string,
): {
  readonly rows: readonly RelationFactRow[];
  readonly anchors: readonly FactAnchorRow[];
  readonly knownFactRefs: readonly string[];
  readonly legacyFactRefs: ReadonlyMap<string, string>;
  readonly issues: readonly ColdRebuildIssue[];
  readonly complete: boolean;
} {
  const rows: RelationFactRow[] = [],
    anchors: FactAnchorRow[] = [],
    knownFactRefs: string[] = [],
    legacyFactRefs = new Map<string, string>(),
    seenLegacyRefs = new Set<string>(),
    issues: ColdRebuildIssue[] = [];
  let candidates = 0;
  for (const [index, line] of body
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .entries()) {
    if (!line.startsWith("- {") || !/(?:^|[,{}]\s*)fact_id\s*:/u.test(line)) continue;
    candidates += 1;
    const fields = flowFields(line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"))),
      factId = coldRebuildScalar(fields.fact_id),
      rawProvenance = flowObjects(fields.provenance),
      provenance = rawProvenance.every(isRelationFactProvenance) ? rawProvenance : null,
      tags = flowArray(fields.memoryTags),
      migrated = flowFields(stripBraces(fields.migration)).state === "migrated";
    if (
      !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId) ||
      !coldRebuildScalar(fields.statement) ||
      !coldRebuildScalar(fields.source) ||
      !coldRebuildScalar(fields.observedAt) ||
      !["low", "medium", "high"].includes(coldRebuildScalar(fields.confidence)) ||
      !["semantic", "episodic", "procedural", ""].includes(coldRebuildScalar(fields.memoryClass)) ||
      !provenance?.length
    ) {
      issues.push({
        entityType: "fact",
        migratedFrom: factId || `${taskId}:line-${index + 1}`,
        sourcePath: portablePath,
        reason: "legacy fact record is malformed",
      });
      continue;
    }
    const legacyRef = `fact/${taskId}/${factId}`,
      ref = `fact/${factId}`;
    if (seenLegacyRefs.has(legacyRef)) {
      issues.push({
        entityType: "fact",
        migratedFrom: legacyRef,
        sourcePath: portablePath,
        reason: "legacy fact ref occurs more than once in the same source document",
      });
      continue;
    }
    seenLegacyRefs.add(legacyRef);
    knownFactRefs.push(ref);
    legacyFactRefs.set(legacyRef, ref);
    if (!migrated) {
      rows.push({
        schema: "task-fact-row/v1",
        ref,
        taskId,
        factId,
        statement: coldRebuildScalar(fields.statement),
        source: coldRebuildScalar(fields.source),
        observedAt: canonicalTimestamp(coldRebuildScalar(fields.observedAt)),
        confidence: coldRebuildScalar(fields.confidence) as RelationFactRow["confidence"],
        memoryClass: (coldRebuildScalar(fields.memoryClass) || "episodic") as RelationFactRow["memoryClass"],
        memoryTags: tags,
        provenance: provenance.map((entry) => ({
          ...entry,
          boundAt: canonicalTimestamp(entry.boundAt ?? ""),
        })),
        liveness: "standing",
      });
      anchors.push({ factRef: ref, taskId, factId, sourcePath: portablePath });
    }
  }
  return {
    rows,
    anchors,
    knownFactRefs,
    legacyFactRefs,
    issues,
    complete: rows.length <= candidates && candidates === rows.length + migratedFactCount(body),
  };
}
function readAuthoredEvents(rootDir: string, authoredRoot: string, allowLegacyFactRefs: boolean): AuthoredEventRead {
  const eventsRoot = path.join(authoredRoot, "events"),
    rows = new Map<string, EventFactSource>(),
    relations: RelationEntry[] = [],
    relationHistory: Array<RelationEventV1 | MigrationImportEventV1> = [],
    legacyFactRefs = new Map<string, string>(),
    legacyRelationIds = new Map<string, string>(),
    issues: ColdRebuildIssue[] = [];
  for (const file of listColdRebuildFiles(eventsRoot).filter(
    (candidate) => path.extname(candidate) === ".json" && path.basename(candidate) !== "head.json",
  )) {
    const body = readTextFileIfPresent(file);
    if (body === null) continue;
    let event;
    try {
      event = normalizePersistedCanonicalEvent(parseCanonicalEvent(body));
    } catch (error) {
      event = allowLegacyFactRefs ? parseLegacyFactEvent(body) : null;
      if (event === null) {
        const reason = error instanceof Error ? error.message : String(error);
        consumeKnownError(error);
        issues.push({
          entityType: "fact",
          migratedFrom: path.basename(file, ".json"),
          sourcePath: sourcePath(rootDir, file),
          reason,
        });
        continue;
      }
    }
    if (isFactEvent(event)) {
      const ref = `fact/${event.factId}`,
        legacyRef = event.taskId ? `fact/${event.taskId}/${event.factId}` : null,
        identityRef =
          allowLegacyFactRefs &&
          legacyRef !== null &&
          event.payload.factsDocumentClaim.path !== `facts/${event.factId}.md`
            ? legacyRef
            : ref,
        row: RelationFactRow = {
          schema: "task-fact-row/v1",
          ref,
          ...(event.taskId ? { taskId: event.taskId } : {}),
          factId: event.factId,
          statement: event.payload.statement,
          source: event.payload.evidenceSource,
          observedAt: event.payload.observedAt,
          confidence: event.payload.confidence,
          memoryClass: event.payload.memoryClass,
          memoryTags: event.payload.memoryTags,
          provenance: relationProvenance(event.payload.provenance),
          liveness: "standing",
        };
      addEventFactSource(rows, issues, identityRef, row, `event:${event.opId}`);
      if (allowLegacyFactRefs && legacyRef !== null) legacyFactRefs.set(legacyRef, ref);
      const superseded =
          allowLegacyFactRefs && event.payload.supersedes
            ? /^fact\/[^/]+\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(event.payload.supersedes.factRef)
            : null,
        replayEvent =
          superseded && event.payload.supersedes
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  supersedes: { ...event.payload.supersedes, factRef: `fact/${superseded[1]}` },
                },
              }
            : event;
      relationHistory.push(...embeddedRelationEventsForReplay(replayEvent));
      continue;
    }
    if (isRelationEvent(event)) {
      relationHistory.push(event);
      continue;
    }
    if (isDecisionEvent(event)) {
      relationHistory.push(...embeddedRelationEventsForReplay(event));
      continue;
    }
    if (!isMigrationImportEvent(event)) continue;
    const entity = event.payload.entity;
    if (entity.kind === "fact") {
      const ref = `fact/${entity.fact.factId}`,
        row: RelationFactRow = {
          schema: "task-fact-row/v1",
          ref,
          ...(entity.fact.taskId ? { taskId: entity.fact.taskId } : {}),
          factId: entity.fact.factId,
          statement: entity.fact.statement,
          source: entity.fact.evidenceSource,
          observedAt: entity.fact.observedAt,
          confidence: entity.fact.confidence,
          memoryClass: entity.fact.memoryClass,
          memoryTags: entity.fact.memoryTags,
          provenance: entity.fact.provenance,
          liveness: "standing",
        };
      addEventFactSource(rows, issues, ref, row, `event:${event.opId}`);
      if (entity.fact.taskId) {
        if (allowLegacyFactRefs) legacyFactRefs.set(`fact/${entity.fact.taskId}/${entity.fact.factId}`, ref);
        const identity = {
          source: `task/${entity.fact.taskId}`,
          target: ref,
          type: "produces" as const,
          direction: "directed" as const,
        };
        relations.push(
          relationEntry(
            {
              relation_id: deriveRelationId(identity),
              ...identity,
              strength: "strong",
              origin: "generated",
              state: "active",
              rationale: "Migrated fact owner.",
            },
            identity.source,
            `event:${event.opId}`,
            1,
          ),
        );
      }
    } else if (entity.kind === "relation") {
      if (allowLegacyFactRefs)
        for (const endpoint of [entity.relation.source, entity.relation.target]) {
          const match = /^fact\/[^/]+\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(endpoint);
          if (match) legacyFactRefs.set(endpoint, `fact/${match[1]}`);
        }
      relationHistory.push(event);
    }
  }
  const normalizedHistory = relationHistory
      .sort((a, b) => a.workspaceRevision - b.workspaceRevision)
      .map((sourceEvent) => {
        const event =
            allowLegacyFactRefs &&
            sourceEvent.schema === "migration-import-event/v1" &&
            sourceEvent.payload.entity.kind === "relation"
              ? normalizeLegacyRelationMigrationEvent(sourceEvent, legacyFactRefs, legacyRelationIds)
              : sourceEvent,
          migrated = event.schema === "migration-import-event/v1" ? event.payload.entity : null,
          sourceMigrated = sourceEvent.schema === "migration-import-event/v1" ? sourceEvent.payload.entity : null,
          relationId =
            migrated?.kind === "relation" ? migrated.relation.relation_id : (event as RelationEventV1).relationId,
          normalizedAlias = sourceMigrated?.kind === "relation" && sourceMigrated.relation.relation_id !== relationId,
          hasCanonicalFacet =
            !normalizedAlias &&
            (migrated?.kind === "relation" ||
              (event.schema === "relation-event/v1" && event.type !== "relation_retired"));
        return { event, sourceEvent, migrated, relationId, normalizedAlias, hasCanonicalFacet };
      }),
    canonicalRelationIds = new Set(
      normalizedHistory.filter(({ hasCanonicalFacet }) => hasCanonicalFacet).map(({ relationId }) => relationId),
    ),
    projected = new Map<string, { readonly entity: RelationEntity; readonly sourcePath: string }>();
  for (const { event, sourceEvent, migrated, relationId, normalizedAlias } of normalizedHistory) {
    const manualReason =
      allowLegacyFactRefs && migrated?.kind === "relation" ? legacyRelationManualReason(migrated.relation) : null;
    if (manualReason !== null) {
      const sourceRelation = sourceEvent.schema === "migration-import-event/v1" ? sourceEvent.payload.entity : null;
      issues.push({
        entityType: "relation",
        migratedFrom: sourceRelation?.kind === "relation" ? sourceRelation.relation.relation_id : relationId,
        sourcePath: `event:${event.opId}`,
        reason: manualReason,
      });
      continue;
    }
    if (normalizedAlias && canonicalRelationIds.has(relationId)) continue;
    const entity = reduceRelationEntity(projected.get(relationId)?.entity ?? null, event);
    projected.set(relationId, { entity, sourcePath: `event:${event.opId}` });
  }
  for (const { entity, sourcePath: eventPath } of projected.values())
    relations.push(relationEntry(relationRecord(entity), relationOwnerRef(entity.source), eventPath, 0));
  return { rows: [...rows.values()], relations, legacyFactRefs, legacyRelationIds, issues };
}

function addEventFactSource(
  rows: Map<string, EventFactSource>,
  issues: ColdRebuildIssue[],
  identityRef: string,
  row: RelationFactRow,
  eventPath: string,
): void {
  if (rows.has(identityRef)) {
    issues.push({
      entityType: "fact",
      migratedFrom: identityRef,
      sourcePath: eventPath,
      reason: "fact ref occurs more than once in the source event ledger",
    });
    return;
  }
  rows.set(identityRef, { identityRef, row, sourcePath: eventPath });
}

/** Migration input only: old fact events carried a task-local document claim and
 * therefore fail the current fact-event validator. Parse enough of that envelope
 * to re-key its fact and relations without widening the normal read/validation path. */
function parseLegacyFactEvent(body: string): FactEventV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>,
    payloadValue = candidate.payload;
  if (payloadValue === null || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return null;
  const payload = payloadValue as Record<string, unknown>;
  if (
    candidate.schema !== "fact-event/v1" ||
    candidate.type !== "fact_recorded" ||
    typeof candidate.taskId !== "string" ||
    !candidate.taskId ||
    !isFactId(String(candidate.factId)) ||
    typeof candidate.opId !== "string" ||
    typeof candidate.occurredAt !== "string" ||
    typeof payload.statement !== "string" ||
    typeof payload.evidenceSource !== "string" ||
    typeof payload.observedAt !== "string" ||
    typeof payload.confidence !== "string" ||
    !["low", "medium", "high"].includes(payload.confidence) ||
    typeof payload.memoryClass !== "string" ||
    !["semantic", "episodic", "procedural"].includes(payload.memoryClass) ||
    !Array.isArray(payload.memoryTags) ||
    !Array.isArray(payload.provenance)
  )
    return null;
  const envelope = { ...candidate, schema: candidate.schema };
  return isFactEvent(envelope) ? envelope : null;
}

function relationProvenance(
  value: readonly { readonly runtime: string; readonly sessionId: string | null; readonly boundAt: string }[],
): RelationFactRow["provenance"] {
  return value.flatMap((entry) =>
    entry.sessionId === null ? [] : [{ runtime: entry.runtime, sessionId: entry.sessionId, boundAt: entry.boundAt }],
  );
}

function relationEntry(
  record: EntityRelationRecord,
  hostRef: string,
  portablePath: string,
  recordIndex: number,
): RelationEntry {
  const source = parseEntityRef(record.source),
    host = source?.kind === "fact" ? `fact/${source.id}` : hostRef;
  return { hostRef: host, ownerRef: hostRef, record, sourcePath: portablePath, recordIndex };
}

function relationEntryFromEdge(edge: RelationGraphEdgeRow): RelationEntry {
  return {
    hostRef: edge.ownerRef,
    ownerRef: edge.ownerRef,
    record: {
      relation_id: edge.relationId,
      source: edge.sourceRef,
      target: edge.targetRef,
      type: edge.relationType,
      direction: edge.direction,
      strength: edge.strength,
      origin: edge.origin,
      state: edge.state,
      rationale: edge.rationale,
    },
    sourcePath: edge.sourcePath,
    recordIndex: edge.recordIndex,
  };
}

function flowFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of splitColdRebuildTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator > 0) fields[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return fields;
}
function flowObjects(value = ""): readonly Record<string, string>[] {
  const inner = stripArray(value);
  return splitColdRebuildTopLevel(inner).flatMap((part) =>
    part.startsWith("{")
      ? [
          Object.fromEntries(
            Object.entries(flowFields(stripBraces(part))).map(([key, field]) => [key, coldRebuildScalar(field)]),
          ),
        ]
      : [],
  );
}
function flowArray(value = ""): readonly string[] {
  return splitColdRebuildTopLevel(stripArray(value)).map(coldRebuildScalar).filter(Boolean);
}
function splitColdRebuildTopLevel(value: string): string[] {
  const parts: string[] = [];
  let quote = false,
    square = 0,
    brace = 0,
    start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index],
      previous = value[index - 1];
    if (char === '"' && previous !== "\\") quote = !quote;
    if (!quote && char === "[") square += 1;
    if (!quote && char === "]") square -= 1;
    if (!quote && char === "{") brace += 1;
    if (!quote && char === "}") brace -= 1;
    if (!quote && !square && !brace && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}
function coldRebuildScalar(value = ""): string {
  return unquote(value);
}
function canonicalTimestamp(value: string): string {
  return normalizePersistedTimestamp(value) ?? value;
}
function stripArray(value = ""): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).trim() : "";
}
function stripBraces(value = ""): string {
  return value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1).trim() : "";
}
function migratedFactCount(body: string): number {
  return body
    .split(/\r?\n/u)
    .filter((line) => /fact_id\s*:/.test(line) && /migration:\s*\{[^}]*state:\s*migrated/u.test(line)).length;
}
function listDirs(root: string): readonly string[] {
  return (readDirIfPresent(root) ?? [])
    .flatMap((entry) => {
      const candidate = path.join(root, entry.name),
        stat = statPathIfPresent(candidate);
      return entry.isDirectory() && stat?.isDirectory() ? [candidate] : [];
    })
    .sort();
}
function listColdRebuildFiles(root: string): readonly string[] {
  const stat = statPathIfPresent(root);
  if (!stat) return [];
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return (readDirIfPresent(root) ?? [])
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => listColdRebuildFiles(path.join(root, entry.name)))
    .sort();
}
function readTaskId(taskDir: string): string {
  const body = readTextFileIfPresent(path.join(taskDir, "INDEX.md")),
    frontmatter = body === null ? null : readFrontmatter(body);
  return frontmatter
    ? readScalar(frontmatter, "task_id") || readScalar(frontmatter, "taskId") || path.basename(taskDir)
    : path.basename(taskDir);
}
function optional<Key extends string>(key: Key, value: string): { readonly [K in Key]?: string } {
  return value ? ({ [key]: value } as { [K in Key]: string }) : {};
}
function coldRebuildLegacyNumber(value?: string): number {
  return value ? Number(value.slice(1)) : Number.MAX_SAFE_INTEGER;
}
function fulfillment(value: unknown): RelationCoverageRow["fulfillment"] {
  return value === "evidenced" || value === "delivered"
    ? value
    : value === "standing-policy" || value === "standing_policy"
      ? "standing-policy"
      : null;
}
function coldRebuildStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function isColdRebuildRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isRelationFactProvenance(
  value: Readonly<Record<string, string>>,
): value is RelationFactRow["provenance"][number] {
  return Boolean(value.runtime && value.sessionId && value.boundAt);
}
function isRelation(value: unknown): value is EntityRelationRecord {
  return (
    isColdRebuildRecord(value) &&
    typeof value.relation_id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string"
  );
}
function byFactRef(a: FactAnchorRow, b: FactAnchorRow): number {
  return a.factRef.localeCompare(b.factRef);
}
function documentProse(body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(body);
  return match ? body.slice(match[0].length) : "";
}
