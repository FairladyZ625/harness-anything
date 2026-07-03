import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { formatRelationFlowRecord, parseFactFlowRecords, parseEntityRef, validateRelationRecordsForHost } from "../domain/index.ts";
import type { EntityRelationRecord, EntityRelationValidationIssue } from "../domain/index.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { sourcePath } from "./sqlite-task-source.ts";

export interface RelationGraphEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface RelationCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: "covered" | "uncovered";
  readonly coveringFactRef?: string;
  readonly relationPath: ReadonlyArray<string>;
}

export interface RelationGraphProjection {
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly coverageRows: ReadonlyArray<RelationCoverageRow>;
}

interface DecisionSource {
  readonly decisionId: string;
  readonly decisionRef: string;
  readonly filePath: string;
  readonly frontmatter: string;
  readonly visible: boolean;
}

interface GraphRefIndex {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionAnchors: ReadonlySet<string>;
  readonly factRefs: ReadonlySet<string>;
}

export interface RelationRecordEntry {
  readonly hostRef: string;
  readonly ownerRef: string;
  readonly record: EntityRelationRecord;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface RelationRecordValidationIssue {
  readonly entry: RelationRecordEntry;
  readonly issue: EntityRelationValidationIssue | {
    readonly code: "relation_provenance_inheritance_mismatch";
    readonly relationId?: string;
    readonly message: string;
  };
}

export function buildRelationGraphProjection(rootInput: HarnessLayoutInput): RelationGraphProjection {
  const decisions = readDecisionSources(rootInput);
  const refIndex = buildGraphRefIndex(rootInput, decisions);
  const entries = collectRelationRecordEntries(rootInput, decisions);
  const edges = relationEntriesToEdges(entries, refIndex);
  return {
    edges,
    coverageRows: buildCoverageRows(decisions.filter((decision) => decision.visible), edges, refIndex)
  };
}

export function validateRelationGraphRecords(rootInput: HarnessLayoutInput): ReadonlyArray<RelationRecordValidationIssue> {
  return validateRelationRecordEntries(collectRelationRecordEntries(rootInput, readDecisionSources(rootInput)));
}

export function detectRelationGraphCycles(edges: ReadonlyArray<RelationGraphEdgeRow>): ReadonlyArray<ReadonlyArray<string>> {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.state !== "active") continue;
    const source = parseEntityRef(edge.sourceRef);
    const target = parseEntityRef(edge.targetRef);
    if (!source || source.externalHarness || !target || target.externalHarness) continue;
    const existing = graph.get(edge.sourceRef) ?? [];
    existing.push(edge.targetRef);
    graph.set(edge.sourceRef, existing);
    if (!graph.has(edge.targetRef)) graph.set(edge.targetRef, []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(ref: string): void {
    if (visiting.has(ref)) {
      cycles.push(stack.slice(stack.indexOf(ref)).concat(ref));
      return;
    }
    if (visited.has(ref)) return;
    visiting.add(ref);
    stack.push(ref);
    for (const target of graph.get(ref) ?? []) {
      if (cycles.length > 0) return;
      visit(target);
    }
    stack.pop();
    visiting.delete(ref);
    visited.add(ref);
  }

  for (const ref of graph.keys()) {
    if (cycles.length > 0) break;
    visit(ref);
  }
  return cycles;
}

function collectRelationRecordEntries(
  rootInput: HarnessLayoutInput,
  decisions: ReadonlyArray<DecisionSource>
): ReadonlyArray<RelationRecordEntry> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const entries: RelationRecordEntry[] = [];

  for (const taskDir of listTaskDirs(layout.tasksRoot)) {
    const taskId = readTaskPackageId(taskDir);
    const indexPath = path.join(taskDir, "INDEX.md");
    if (existsSync(indexPath)) {
      const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
      if (frontmatter) {
        entries.push(...recordsToEntries({
          hostRef: `task/${taskId}`,
          ownerRef: `task/${taskId}`,
          records: parseRelationFlowRecords(frontmatter),
          sourceFile: indexPath,
          rootDir
        }));
      }
    }

    const factsPath = path.join(taskDir, layout.factDocumentName);
    if (existsSync(factsPath)) {
      const factsBody = readFileSync(factsPath, "utf8");
      entries.push(...recordsToEntries({
        hostRefForRecord: (record) => factRelationHostRef(taskId, record),
        ownerRef: `task/${taskId}`,
        records: parseRelationFlowRecords(factsBody),
        sourceFile: factsPath,
        rootDir
      }));
    }
  }

  for (const decision of decisions) {
    if (!decision.visible) continue;
    entries.push(...recordsToEntries({
      hostRef: decision.decisionRef,
      ownerRef: decision.decisionRef,
      records: parseRelationFlowRecords(decision.frontmatter),
      sourceFile: decision.filePath,
      rootDir
    }));
  }

  return entries.sort(compareRelationRecordEntries);
}

function recordsToEntries(input: {
  readonly hostRef?: string;
  readonly hostRefForRecord?: (record: EntityRelationRecord) => string;
  readonly ownerRef: string;
  readonly records: ReadonlyArray<EntityRelationRecord>;
  readonly sourceFile: string;
  readonly rootDir: string;
}): ReadonlyArray<RelationRecordEntry> {
  const entries: RelationRecordEntry[] = [];
  for (const [index, record] of input.records.entries()) {
    entries.push({
      hostRef: input.hostRefForRecord?.(record) ?? input.hostRef ?? input.ownerRef,
      ownerRef: input.ownerRef,
      sourcePath: sourcePath(input.rootDir, input.sourceFile),
      record,
      recordIndex: index
    });
  }
  return entries;
}

function factRelationHostRef(taskId: string, record: EntityRelationRecord): string {
  const source = parseEntityRef(record.source);
  if (source?.kind === "fact") return `fact/${taskId}/${source.id}`;
  return `task/${taskId}`;
}

function relationEntriesToEdges(
  entries: ReadonlyArray<RelationRecordEntry>,
  refIndex: GraphRefIndex
): ReadonlyArray<RelationGraphEdgeRow> {
  const edges: RelationGraphEdgeRow[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (validateRelationRecordsForHost(entry.hostRef, [entry.record]).length > 0) continue;
    if (!isKnownLocalEndpoint(entry.record.source, refIndex) || !isKnownLocalEndpoint(entry.record.target, refIndex)) continue;

    const canonicalRecord = canonicalRelationRecord(entry.record);
    const previous = seen.get(entry.record.relation_id);
    if (previous) {
      if (previous === canonicalRecord) continue;
      continue;
    }
    seen.set(entry.record.relation_id, canonicalRecord);
    edges.push({
      relationId: entry.record.relation_id,
      sourceRef: entry.record.source,
      targetRef: entry.record.target,
      relationType: entry.record.type,
      direction: entry.record.direction,
      strength: entry.record.strength,
      origin: entry.record.origin,
      state: entry.record.state,
      rationale: entry.record.rationale,
      ownerRef: entry.ownerRef,
      sourcePath: entry.sourcePath,
      recordIndex: entry.recordIndex
    });
  }
  return edges.sort(compareEdges);
}

function validateRelationRecordEntries(entries: ReadonlyArray<RelationRecordEntry>): ReadonlyArray<RelationRecordValidationIssue> {
  const issues: RelationRecordValidationIssue[] = [];
  const seen = new Map<string, { readonly canonicalRecord: string; readonly entry: RelationRecordEntry }>();
  for (const entry of entries) {
    for (const issue of validateRelationRecordsForHost(entry.hostRef, [entry.record])) {
      issues.push({ entry, issue });
      if (issue.code === "relation_host_source_mismatch") {
        issues.push({
          entry,
          issue: {
            code: "relation_provenance_inheritance_mismatch",
            relationId: entry.record.relation_id,
            message: `Relation ${entry.record.relation_id} cannot inherit provenance from ${entry.hostRef} because its source is ${entry.record.source}`
          }
        });
      }
    }

    const canonicalRecord = canonicalRelationRecord(entry.record);
    const previous = seen.get(entry.record.relation_id);
    if (!previous) {
      seen.set(entry.record.relation_id, { canonicalRecord, entry });
      continue;
    }
    if (previous.canonicalRecord === canonicalRecord) continue;
    issues.push({
      entry,
      issue: {
        code: "duplicate_relation_id",
        relationId: entry.record.relation_id,
        message: `Duplicate relation_id ${entry.record.relation_id} in ${previous.entry.sourcePath} and ${entry.sourcePath}`
      }
    });
  }
  return issues;
}

function canonicalRelationRecord(record: EntityRelationRecord): string {
  return formatRelationFlowRecord(record);
}

function buildCoverageRows(
  decisions: ReadonlyArray<DecisionSource>,
  edges: ReadonlyArray<RelationGraphEdgeRow>,
  refIndex: GraphRefIndex
): ReadonlyArray<RelationCoverageRow> {
  const activeEdges = edges.filter((edge) => edge.state === "active");
  const graph = new Map<string, RelationGraphEdgeRow[]>();
  const invalidatedFactRefs = new Set(
    activeEdges
      .filter((edge) => (edge.relationType === "invalidated-by" || edge.relationType === "supersedes-fact") && edge.targetRef.startsWith("fact/"))
      .map((edge) => edge.targetRef)
  );
  for (const edge of activeEdges) {
    const existing = graph.get(edge.sourceRef) ?? [];
    existing.push(edge);
    graph.set(edge.sourceRef, existing);
  }

  const rows: RelationCoverageRow[] = [];
  for (const decision of decisions) {
    for (const anchor of findRelationGraphDecisionAnchors(decision.frontmatter)) {
      const claimRef = `${decision.decisionRef}/${anchor}`;
      const reachable = firstReachableLiveFact(claimRef, graph, refIndex, invalidatedFactRefs);
      rows.push({
        decisionRef: decision.decisionRef,
        claimRef,
        status: reachable ? "covered" : "uncovered",
        ...(reachable ? { coveringFactRef: reachable.factRef, relationPath: reachable.path } : { relationPath: [] })
      });
    }
  }
  return rows.sort((a, b) => a.claimRef.localeCompare(b.claimRef));
}

function firstReachableLiveFact(
  startRef: string,
  graph: ReadonlyMap<string, ReadonlyArray<RelationGraphEdgeRow>>,
  refIndex: GraphRefIndex,
  invalidatedFactRefs: ReadonlySet<string>
): { readonly factRef: string; readonly path: ReadonlyArray<string> } | null {
  const visited = new Set<string>();
  const queue: Array<{ readonly ref: string; readonly path: ReadonlyArray<string> }> = [{ ref: startRef, path: [] }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.ref)) continue;
    visited.add(current.ref);
    if (current.ref.startsWith("fact/") && isKnownLocalEndpoint(current.ref, refIndex) && !invalidatedFactRefs.has(current.ref)) {
      return { factRef: current.ref, path: current.path };
    }
    for (const edge of graph.get(current.ref) ?? []) {
      if (!visited.has(edge.targetRef)) {
        queue.push({ ref: edge.targetRef, path: current.path.concat(edge.relationId) });
      }
    }
  }
  return null;
}

function readDecisionSources(rootInput: HarnessLayoutInput): ReadonlyArray<DecisionSource> {
  const layout = resolveHarnessLayout(rootInput);
  const decisions: Array<Omit<DecisionSource, "visible"> & { readonly watermark: string }> = [];
  const watermarkCounts = new Map<string, number>();
  for (const filePath of listTextFiles(layout.decisionsRoot)) {
    if (path.basename(filePath) !== "decision.md") continue;
    const frontmatter = readFrontmatter(readFileSync(filePath, "utf8"));
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") continue;
    const decisionId = readScalar(frontmatter, "decision_id") || path.basename(path.dirname(filePath));
    const watermark = readScalar(frontmatter, "_coordinatorWatermark");
    if (watermark.length > 0) watermarkCounts.set(watermark, (watermarkCounts.get(watermark) ?? 0) + 1);
    decisions.push({
      decisionId,
      decisionRef: `decision/${decisionId}`,
      filePath,
      frontmatter,
      watermark
    });
  }
  return decisions.map((decision) => ({
    decisionId: decision.decisionId,
    decisionRef: decision.decisionRef,
    filePath: decision.filePath,
    frontmatter: decision.frontmatter,
    visible: decision.watermark.length > 0 && watermarkCounts.get(decision.watermark) === 1
  })).sort((a, b) => a.decisionRef.localeCompare(b.decisionRef));
}

function buildGraphRefIndex(rootInput: HarnessLayoutInput, decisions: ReadonlyArray<DecisionSource>): GraphRefIndex {
  const layout = resolveHarnessLayout(rootInput);
  const taskIds = new Set<string>();
  const factRefs = new Set<string>();
  for (const taskDir of listTaskDirs(layout.tasksRoot)) {
    const taskId = readTaskPackageId(taskDir);
    taskIds.add(taskId);
    const factsPath = path.join(taskDir, layout.factDocumentName);
    if (!existsSync(factsPath)) continue;
    for (const record of parseFactFlowRecords(readFileSync(factsPath, "utf8"))) {
      factRefs.add(`${taskId}/${record.fact_id}`);
    }
  }

  const decisionIds = new Set<string>();
  const decisionAnchors = new Set<string>();
  for (const decision of decisions) {
    if (!decision.visible) continue;
    decisionIds.add(decision.decisionId);
    for (const anchor of findRelationGraphDecisionAnchors(decision.frontmatter)) {
      decisionAnchors.add(`${decision.decisionId}/${anchor}`);
    }
  }
  return { taskIds, decisionIds, decisionAnchors, factRefs };
}

function isKnownLocalEndpoint(refText: string, refIndex: GraphRefIndex): boolean {
  const ref = parseEntityRef(refText);
  if (!ref || ref.externalHarness) return false;
  if (ref.kind === "task") return refIndex.taskIds.has(ref.id);
  if (ref.kind === "decision") return refIndex.decisionIds.has(ref.id) && (!ref.anchor || refIndex.decisionAnchors.has(`${ref.id}/${ref.anchor}`));
  if (ref.kind === "fact") return Boolean(ref.ownerTaskId) && refIndex.factRefs.has(`${ref.ownerTaskId}/${ref.id}`);
  return false;
}

function parseRelationFlowRecords(body: string): ReadonlyArray<EntityRelationRecord> {
  const records: EntityRelationRecord[] = [];
  const lines = body.split(/\r?\n/u);
  let inRelations = false;
  for (const line of lines) {
    if (/^\s*relations:\s*$/u.test(line)) {
      inRelations = true;
      continue;
    }
    if (!inRelations) continue;
    if (/^\s*-\s*\{/u.test(line)) {
      const record = parseRelationFlowLine(line);
      if (record) records.push(record);
      continue;
    }
    if (line.trim().length === 0 || /^\s+#/u.test(line)) continue;
    if (/^\S/u.test(line)) inRelations = false;
  }
  return records;
}

function parseRelationFlowLine(line: string): EntityRelationRecord | null {
  const body = line.match(/^\s*-\s*\{\s*(.*)\s*\}\s*$/u)?.[1];
  if (!body || !body.includes("relation_id:")) return null;
  const fields = new Map<string, string>();
  for (const chunk of splitFlowFields(body)) {
    const separator = chunk.indexOf(":");
    if (separator <= 0) continue;
    fields.set(chunk.slice(0, separator).trim(), parseFlowValue(chunk.slice(separator + 1).trim()));
  }
  const record = {
    relation_id: fields.get("relation_id") ?? "",
    source: fields.get("source") ?? "",
    target: fields.get("target") ?? "",
    type: fields.get("type") ?? "",
    strength: fields.get("strength") ?? "",
    direction: fields.get("direction") ?? "",
    origin: fields.get("origin") ?? "",
    rationale: fields.get("rationale") ?? "",
    state: fields.get("state") ?? ""
  };
  if (!record.relation_id || !record.source || !record.target) return null;
  if (!isRelationType(record.type) || !isRelationStrength(record.strength) || !isRelationDirection(record.direction) || !isRelationOrigin(record.origin) || !isRelationState(record.state)) {
    return null;
  }
  return {
    relation_id: record.relation_id,
    source: record.source,
    target: record.target,
    type: record.type,
    strength: record.strength,
    direction: record.direction,
    origin: record.origin,
    rationale: record.rationale,
    state: record.state
  };
}

function splitFlowFields(body: string): ReadonlyArray<string> {
  const fields: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? "";
    if ((character === "\"" || character === "'") && body[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === "," && !quote) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) fields.push(current.trim());
  return fields;
}

function parseFlowValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function findRelationGraphDecisionAnchors(frontmatter: string): ReadonlyArray<string> {
  return [...readFlowObjectBlock(frontmatter, "claims").matchAll(/^\s*-\s*\{\s*id:\s*"?([A-Za-z][A-Za-z0-9_-]*)"?/gmu)]
    .map((match) => match[1])
    .filter((anchor): anchor is string => Boolean(anchor));
}

function readFlowObjectBlock(frontmatter: string, key: string): string {
  const lines = frontmatter.split(/\r?\n/u);
  const output: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === `${key}:`) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*-\s*\{/u.test(line)) {
      output.push(line);
      continue;
    }
    if (/^\S/u.test(line)) break;
  }
  return output.join("\n");
}

function readTaskPackageId(taskDir: string): string {
  const indexPath = path.join(taskDir, "INDEX.md");
  if (!existsSync(indexPath)) return path.basename(taskDir);
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  return (frontmatter ? readScalar(frontmatter, "task_id") : "") || path.basename(taskDir);
}

function listTaskDirs(tasksRoot: string): ReadonlyArray<string> {
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tasksRoot, entry.name))
    .sort();
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const stat = statSync(inputPath);
  if (stat.isFile()) return isRelationGraphTextLikePath(inputPath) ? [inputPath] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(inputPath, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => listTextFiles(path.join(inputPath, entry.name)))
    .sort();
}

function isRelationGraphTextLikePath(filePath: string): boolean {
  return /\.(md|markdown|txt|ya?ml|json)$/iu.test(filePath);
}

function compareEdges(a: RelationGraphEdgeRow, b: RelationGraphEdgeRow): number {
  return `${a.sourceRef}\0${a.targetRef}\0${a.relationId}`.localeCompare(`${b.sourceRef}\0${b.targetRef}\0${b.relationId}`);
}

function compareRelationRecordEntries(a: RelationRecordEntry, b: RelationRecordEntry): number {
  return `${a.sourcePath}\0${a.recordIndex}`.localeCompare(`${b.sourcePath}\0${b.recordIndex}`);
}

function isRelationType(value: string): value is EntityRelationRecord["type"] {
  return ["supports", "supersedes", "derives", "blocks", "relates", "implements", "invalidated-by", "supersedes-fact"].includes(value);
}

function isRelationStrength(value: string): value is EntityRelationRecord["strength"] {
  return value === "strong" || value === "weak";
}

function isRelationDirection(value: string): value is EntityRelationRecord["direction"] {
  return value === "directed" || value === "undirected";
}

function isRelationOrigin(value: string): value is EntityRelationRecord["origin"] {
  return value === "declared" || value === "imported_snapshot" || value === "generated" || value === "inferred";
}

function isRelationState(value: string): value is EntityRelationRecord["state"] {
  return value === "active" || value === "deprecated" || value === "deleted";
}
