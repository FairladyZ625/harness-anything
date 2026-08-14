import path from "node:path";
import { isFactEvent, parseCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { parseEntityRef, validateRelationRecordsForHost, type EntityRelationRecord } from "../domain/index.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { parseFlowObject, parseObjectList, parseStringArray, readBlockScalar, unquote } from "../markdown/flow-frontmatter.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { parseRelationFlowRecords } from "./relation-flow-frontmatter.ts";
import type { DecisionAnchorTruth, EventBackedRelationTruth, FactAnchorRow, RelationCoverageRow, RelationFactRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { sourcePath } from "./sqlite-task-source.ts";
import { readDirIfPresent, readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";

export interface ColdDecisionProjectionRow { readonly decisionId: string; readonly legacyId?: string; readonly state: string; readonly title: string; readonly question: string; readonly chosen: readonly string[]; readonly rejected: readonly { readonly text: string; readonly whyNot: string }[]; readonly path: string; readonly moduleKeys: readonly string[]; readonly productLineKeys: readonly string[]; readonly riskTier?: string; readonly urgency?: string; readonly vertical?: string; readonly preset?: string; readonly decisionClass?: string; readonly proposedAt?: string; readonly provenance?: readonly Record<string, unknown>[]; readonly decidedAt?: string }
export interface ColdRebuildSource { readonly decisions: readonly ColdDecisionProjectionRow[]; readonly truth: EventBackedRelationTruth; readonly facts: readonly RelationFactRow[]; readonly claims: readonly ColdDecisionClaim[]; readonly complete: boolean }
interface ColdDecisionClaim { readonly decisionRef: string; readonly claimRef: string; readonly fulfillment: NonNullable<RelationCoverageRow["fulfillment"]>; readonly appliesTo: boolean }
interface DecisionSource { readonly decisionId: string; readonly decisionRef: string; readonly filePath: string; readonly frontmatter: string; readonly visible: boolean }
interface RelationEntry { readonly hostRef: string; readonly ownerRef: string; readonly record: EntityRelationRecord; readonly sourcePath: string; readonly recordIndex: number }
interface EventFactSource { readonly row: RelationFactRow; readonly sourcePath: string }

export function readColdRebuildSource(rootInput: HarnessLayoutInput): ColdRebuildSource {
  const layout = resolveHarnessLayout(rootInput), taskDirs = listDirs(layout.tasksRoot), taskIds = new Set(taskDirs.map(readTaskId));
  const decisionRead = readDecisions(layout.rootDir, layout.decisionsRoot), eventFacts = readFactEvents(layout.authoredRoot), factRows = new Map(eventFacts.map(({ row }) => [row.ref, row])), knownFactRefs = new Set(factRows.keys()), factAnchors = new Map<string, FactAnchorRow>();
  const entries: RelationEntry[] = [], decisionAnchors: DecisionAnchorTruth[] = [], claims: ColdDecisionClaim[] = [];
  let complete = decisionRead.complete;
  for (const taskDir of taskDirs) {
    const taskId = readTaskId(taskDir), factsPath = layout.taskDocumentPath(taskId, "facts.md"), body = readTextFileIfPresent(factsPath);
    if (body === null) continue;
    const parsed = parseLegacyFacts(taskId, sourcePath(layout.rootDir, factsPath), body); complete &&= parsed.complete;
    for (const row of parsed.rows) factRows.set(row.ref, row);
    for (const ref of parsed.knownFactRefs) knownFactRefs.add(ref);
    for (const row of parsed.anchors) factAnchors.set(row.factRef, row);
    for (const [recordIndex, record] of parseRelationFlowRecords(body).entries()) entries.push(relationEntry(record, `task/${taskId}`, sourcePath(layout.rootDir, factsPath), recordIndex));
    if (body.includes("Managed by `ha fact record`") && [...body.matchAll(/^### (F-[0-9A-HJKMNP-TV-Z]{8})$/gmu)].some((match) => !factRows.has(`fact/${taskId}/${match[1]}`))) complete = false;
  }
  for (const { row, sourcePath: eventPath } of eventFacts) factAnchors.set(row.ref, { factRef: row.ref, taskId: row.taskId, factId: row.factId, sourcePath: eventPath });
  for (const decision of decisionRead.sources.filter(({ visible }) => visible)) {
    const anchorRefs = [decision.decisionRef, ...decisionAnchorsFrom(decision.frontmatter).map((anchor) => `${decision.decisionRef}/${anchor}`)];
    decisionAnchors.push({ decisionRef: decision.decisionRef, decisionId: decision.decisionId, anchorRefs, sourcePath: sourcePath(layout.rootDir, decision.filePath) });
    claims.push(...decisionClaims(decision));
    for (const [recordIndex, record] of decisionRelations(decision.frontmatter).entries()) entries.push(relationEntry(record, decision.decisionRef, sourcePath(layout.rootDir, decision.filePath), recordIndex));
  }
  const knownDecisions = new Set(decisionAnchors.flatMap(({ anchorRefs }) => anchorRefs)), truthEdges = relationEdges(entries, taskIds, knownDecisions, knownFactRefs);
  return { decisions: decisionRead.rows, truth: { factAnchors: [...factAnchors.values()].sort(byFactRef), decisionAnchors, edges: truthEdges, coverageRows: [] }, facts: [...factRows.values()].sort((a, b) => a.ref.localeCompare(b.ref)), claims, complete };
}

export function buildColdCoverage(source: ColdRebuildSource, edgesInput: readonly RelationGraphEdgeRow[]): readonly RelationCoverageRow[] {
  const edges = [...edgesInput].filter(({ state }) => state === "active").sort((a, b) => `${a.sourceRef}\0${a.targetRef}\0${a.relationId}`.localeCompare(`${b.sourceRef}\0${b.targetRef}\0${b.relationId}`));
  const evidence = new Map<string, RelationGraphEdgeRow[]>(), facts = new Set(source.facts.map(({ ref }) => ref)), invalidated = new Set(edges.filter((edge) => edge.sourceRef.startsWith("fact/") && edge.targetRef.startsWith("fact/") && (edge.relationType === "invalidated-by" || edge.relationType === "supersedes-fact")).map(({ targetRef }) => targetRef)), refuted = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.relationType === "evidenced-by") evidence.set(edge.sourceRef, [...evidence.get(edge.sourceRef) ?? [], edge]);
    if (edge.relationType === "refuted-by" && edge.sourceRef.startsWith("decision/") && edge.targetRef.startsWith("fact/")) { const refs = refuted.get(edge.sourceRef) ?? new Set<string>(); refs.add(edge.targetRef); refuted.set(edge.sourceRef, refs); }
  }
  return source.claims.map((claim) => {
    const refutingFactRefs = [...refuted.get(claim.claimRef) ?? []].sort(), coverage: { readonly factRef?: string; readonly path: readonly string[] } | null = refutingFactRefs.length ? null : claim.fulfillment === "evidenced" ? firstFact(claim.claimRef, evidence, facts, invalidated) : claim.fulfillment === "standing-policy" ? standingPolicy(claim, edges) : null;
    return { decisionRef: claim.decisionRef, claimRef: claim.claimRef, status: coverage ? "covered" as const : "uncovered" as const, fulfillment: claim.fulfillment, ...(coverage?.factRef ? { coveringFactRef: coverage.factRef } : {}), ...(refutingFactRefs.length ? { refutingFactRefs } : {}), relationPath: coverage?.path ?? [] };
  }).sort((a, b) => a.claimRef.localeCompare(b.claimRef));
}

function readDecisions(rootDir: string, decisionsRoot: string): { readonly sources: readonly DecisionSource[]; readonly rows: readonly ColdDecisionProjectionRow[]; readonly complete: boolean } {
  const drafts: Array<Omit<DecisionSource, "visible"> & { readonly watermark: string; readonly typedRevision: string }> = [], rows: ColdDecisionProjectionRow[] = [], watermarks = new Map<string, number>(); let complete = true;
  for (const filePath of listFiles(decisionsRoot).filter((candidate) => path.basename(candidate) === "decision.md")) {
    const body = readTextFileIfPresent(filePath), frontmatter = body === null ? null : readFrontmatter(body);
    if (!frontmatter || readScalar(frontmatter, "schema") !== "decision-package/v1") { complete = false; continue; }
    const decisionId = readScalar(frontmatter, "decision_id"); if (!decisionId) { complete = false; continue; }
    const watermark = readScalar(frontmatter, "_coordinatorWatermark"), typedRevision = readScalar(frontmatter, "workspaceRevision"); if (watermark) watermarks.set(watermark, (watermarks.get(watermark) ?? 0) + 1);
    drafts.push({ decisionId, decisionRef: `decision/${decisionId}`, filePath, frontmatter, watermark, typedRevision }); rows.push(decisionRow(rootDir, filePath, frontmatter, decisionId));
  }
  const sources = drafts.map((row) => ({ decisionId: row.decisionId, decisionRef: row.decisionRef, filePath: row.filePath, frontmatter: row.frontmatter, visible: row.watermark ? watermarks.get(row.watermark) === 1 : Boolean(row.typedRevision) })).sort((a, b) => a.decisionRef.localeCompare(b.decisionRef));
  return { sources, rows: rows.sort((a, b) => legacyNumber(a.legacyId) - legacyNumber(b.legacyId) || a.decisionId.localeCompare(b.decisionId)), complete };
}
function decisionRow(rootDir: string, filePath: string, frontmatter: string, decisionId: string): ColdDecisionProjectionRow {
  const applies = decisionAppliesTo(frontmatter), chosen = objectList(frontmatter, "chosen"), rejected = objectList(frontmatter, "rejected"), provenance = objectList(frontmatter, "provenance"), legacy = /(?:^|_)E(\d+)(?:_|$)/u.exec(decisionId)?.[1], decisionClass = readScalar(frontmatter, "decisionClass").replace("_", "-");
  return { decisionId, ...(legacy ? { legacyId: `E${Number(legacy)}` } : {}), state: readScalar(frontmatter, "state") || "unknown", title: unquote(readScalar(frontmatter, "title")) || decisionId, question: unquote(readScalar(frontmatter, "question")), chosen: chosen.flatMap((entry) => typeof entry.text === "string" ? [entry.text] : []), rejected: rejected.flatMap((entry) => typeof entry.text === "string" ? [{ text: entry.text, whyNot: String(entry.why_not ?? entry.whyNot ?? "") }] : []), path: sourcePath(rootDir, filePath), moduleKeys: applies.modules, productLineKeys: applies.productLines, ...optional("riskTier", readScalar(frontmatter, "riskTier")), ...optional("urgency", readScalar(frontmatter, "urgency")), ...optional("vertical", unquote(readScalar(frontmatter, "vertical"))), ...optional("preset", unquote(readScalar(frontmatter, "preset"))), ...optional("decisionClass", decisionClass), ...optional("proposedAt", unquote(readScalar(frontmatter, "proposedAt"))), ...(provenance.length ? { provenance } : {}), ...optional("decidedAt", unquote(readScalar(frontmatter, "decidedAt"))) };
}
function decisionClaims(decision: DecisionSource): readonly ColdDecisionClaim[] { const applies = decisionAppliesTo(decision.frontmatter); return objectList(decision.frontmatter, "claims").filter((claim) => claim.load_bearing !== false && claim.loadBearing !== false).flatMap((claim) => typeof claim.id === "string" ? [{ decisionRef: decision.decisionRef, claimRef: `${decision.decisionRef}/${claim.id}`, fulfillment: fulfillment(claim.fulfillment), appliesTo: applies.modules.length > 0 || applies.productLines.length > 0 }] : []); }
function decisionAppliesTo(frontmatter: string): { readonly modules: readonly string[]; readonly productLines: readonly string[] } { const inline = readScalar(frontmatter, "applies_to"); if (inline.startsWith("{")) { const value = parseFlowObject(inline, { tolerateInvalidArrays: true }); return { modules: strings(value.modules), productLines: strings(value.productLines) }; } return { modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules"), { tolerateInvalidArrays: true }), productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"), { tolerateInvalidArrays: true }) }; }
function decisionAnchorsFrom(frontmatter: string): readonly string[] { return ["claims", "chosen", "rejected"].flatMap((key) => objectList(frontmatter, key).flatMap((entry) => typeof entry.id === "string" ? [entry.id] : [])); }
function decisionRelations(frontmatter: string): readonly EntityRelationRecord[] { const inline = readScalar(frontmatter, "relations"); if (inline.startsWith("[")) { try { const rows = JSON.parse(inline) as unknown; return Array.isArray(rows) ? rows.filter(isRelation) : []; } catch { return []; } } return parseRelationFlowRecords(frontmatter); }
function objectList(frontmatter: string, key: string): readonly Record<string, unknown>[] { const inline = readScalar(frontmatter, key); if (inline.startsWith("[")) { try { const rows = JSON.parse(inline) as unknown; return Array.isArray(rows) ? rows.filter(isRecord) : []; } catch { return []; } } return parseObjectList(frontmatter, key, { tolerateInvalidArrays: true }); }

function parseLegacyFacts(taskId: string, portablePath: string, body: string): { readonly rows: readonly RelationFactRow[]; readonly anchors: readonly FactAnchorRow[]; readonly knownFactRefs: readonly string[]; readonly complete: boolean } {
  const rows: RelationFactRow[] = [], anchors: FactAnchorRow[] = [], knownFactRefs: string[] = []; let candidates = 0;
  for (const line of body.split(/\r?\n/u).map((value) => value.trim())) {
    if (!line.startsWith("- {") || !/(?:^|[,{}]\s*)fact_id\s*:/u.test(line)) continue; candidates += 1; const fields = flowFields(line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"))), factId = scalar(fields.fact_id), provenance = flowObjects(fields.provenance), tags = flowArray(fields.memoryTags), migrated = flowFields(stripBraces(fields.migration)).state === "migrated";
    if (!/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(factId) || !scalar(fields.statement) || !scalar(fields.source) || !scalar(fields.observedAt) || !["low", "medium", "high"].includes(scalar(fields.confidence)) || !["semantic", "episodic", "procedural", ""].includes(scalar(fields.memoryClass)) || !provenance.length) continue;
    const ref = `fact/${taskId}/${factId}`; knownFactRefs.push(ref); if (!migrated) { rows.push({ schema: "task-fact-row/v1", ref, taskId, factId, statement: scalar(fields.statement), source: scalar(fields.source), observedAt: scalar(fields.observedAt), confidence: scalar(fields.confidence) as RelationFactRow["confidence"], memoryClass: (scalar(fields.memoryClass) || "episodic") as RelationFactRow["memoryClass"], memoryTags: tags, provenance: provenance as RelationFactRow["provenance"] }); anchors.push({ factRef: ref, taskId, factId, sourcePath: portablePath }); }
  }
  return { rows, anchors, knownFactRefs, complete: rows.length <= candidates && candidates === rows.length + migratedFactCount(body) };
}
function readFactEvents(authoredRoot: string): readonly EventFactSource[] { const eventsRoot = path.join(authoredRoot, "events"), rows = new Map<string, EventFactSource>(); for (const file of listFiles(eventsRoot).filter((candidate) => path.extname(candidate) === ".json" && path.basename(candidate) !== "head.json")) { const body = readTextFileIfPresent(file); if (body === null) continue; const event = parseCanonicalEvent(body); if (!isFactEvent(event)) continue; const ref = `fact/${event.taskId}/${event.factId}`, row: RelationFactRow = { schema: "task-fact-row/v1", ref, taskId: event.taskId, factId: event.factId, statement: event.payload.statement, source: event.payload.evidenceSource, observedAt: event.payload.observedAt, confidence: event.payload.confidence, memoryClass: event.payload.memoryClass, memoryTags: event.payload.memoryTags, provenance: event.payload.provenance }; rows.set(ref, { row, sourcePath: `event:${event.opId}` }); } return [...rows.values()]; }

function relationEntry(record: EntityRelationRecord, hostRef: string, portablePath: string, recordIndex: number): RelationEntry { const source = parseEntityRef(record.source), host = source?.kind === "fact" && source.ownerTaskId ? `fact/${source.ownerTaskId}/${source.id}` : hostRef; return { hostRef: host, ownerRef: hostRef, record, sourcePath: portablePath, recordIndex }; }
function relationEdges(entries: readonly RelationEntry[], taskIds: ReadonlySet<string>, decisionRefs: ReadonlySet<string>, factRefs: ReadonlySet<string>): readonly RelationGraphEdgeRow[] { const seen = new Set<string>(), known = (ref: string): boolean => { const parsed = parseEntityRef(ref); return Boolean(parsed && !parsed.externalHarness && (parsed.kind === "task" ? taskIds.has(parsed.id) : parsed.kind === "decision" ? decisionRefs.has(ref) : factRefs.has(ref))); }; return [...entries].sort((a, b) => `${a.sourcePath}\0${a.recordIndex}`.localeCompare(`${b.sourcePath}\0${b.recordIndex}`)).flatMap((entry) => { const incompatibleOnly = validateRelationRecordsForHost(entry.hostRef, [entry.record]).filter(({ code }) => code !== "invalid_relation_type_subset"); if (seen.has(entry.record.relation_id) || incompatibleOnly.length || !known(entry.record.source) || !known(entry.record.target)) return []; seen.add(entry.record.relation_id); return [{ relationId: entry.record.relation_id, sourceRef: entry.record.source, targetRef: entry.record.target, relationType: entry.record.type, direction: entry.record.direction, strength: entry.record.strength, origin: entry.record.origin, state: entry.record.state, rationale: entry.record.rationale, ownerRef: entry.ownerRef, sourcePath: entry.sourcePath, recordIndex: entry.recordIndex }]; }).sort((a, b) => `${a.sourceRef}\0${a.targetRef}\0${a.relationId}`.localeCompare(`${b.sourceRef}\0${b.targetRef}\0${b.relationId}`)); }
function firstFact(start: string, graph: ReadonlyMap<string, readonly RelationGraphEdgeRow[]>, facts: ReadonlySet<string>, invalidated: ReadonlySet<string>): { readonly factRef: string; readonly path: readonly string[] } | null { const queue: Array<{ readonly ref: string; readonly path: readonly string[] }> = [{ ref: start, path: [] }], seen = new Set<string>(); while (queue.length) { const current = queue.shift()!; if (seen.has(current.ref)) continue; seen.add(current.ref); if (facts.has(current.ref) && !invalidated.has(current.ref)) return { factRef: current.ref, path: current.path }; for (const edge of graph.get(current.ref) ?? []) queue.push({ ref: edge.targetRef, path: [...current.path, edge.relationId] }); } return null; }
function standingPolicy(claim: ColdDecisionClaim, edges: readonly RelationGraphEdgeRow[]): { readonly path: readonly string[] } | null { if (claim.appliesTo) return { path: [] }; const edge = edges.find((candidate) => (candidate.relationType === "refines" || candidate.relationType === "relates") && ((sameDecision(candidate.sourceRef, claim.decisionRef) && candidate.targetRef.startsWith("decision/")) || (sameDecision(candidate.targetRef, claim.decisionRef) && candidate.sourceRef.startsWith("decision/")))); return edge ? { path: [edge.relationId] } : null; }

function flowFields(body: string): Record<string, string> { const fields: Record<string, string> = {}; for (const part of splitTopLevel(body)) { const separator = part.indexOf(":"); if (separator > 0) fields[part.slice(0, separator).trim()] = part.slice(separator + 1).trim(); } return fields; }
function flowObjects(value = ""): readonly Record<string, string>[] { const inner = stripArray(value); return splitTopLevel(inner).flatMap((part) => part.startsWith("{") ? [Object.fromEntries(Object.entries(flowFields(stripBraces(part))).map(([key, field]) => [key, scalar(field)]))] : []); }
function flowArray(value = ""): readonly string[] { return splitTopLevel(stripArray(value)).map(scalar).filter(Boolean); }
function splitTopLevel(value: string): string[] { const parts: string[] = []; let quote = false, square = 0, brace = 0, start = 0; for (let index = 0; index < value.length; index += 1) { const char = value[index], previous = value[index - 1]; if (char === '"' && previous !== "\\") quote = !quote; if (!quote && char === "[") square += 1; if (!quote && char === "]") square -= 1; if (!quote && char === "{") brace += 1; if (!quote && char === "}") brace -= 1; if (!quote && !square && !brace && char === ",") { parts.push(value.slice(start, index).trim()); start = index + 1; } } const tail = value.slice(start).trim(); if (tail) parts.push(tail); return parts; }
function scalar(value = ""): string { return unquote(value); }
function stripArray(value = ""): string { return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).trim() : ""; }
function stripBraces(value = ""): string { return value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1).trim() : ""; }
function migratedFactCount(body: string): number { return body.split(/\r?\n/u).filter((line) => /fact_id\s*:/.test(line) && /migration:\s*\{[^}]*state:\s*migrated/u.test(line)).length; }
function listDirs(root: string): readonly string[] { return (readDirIfPresent(root) ?? []).flatMap((entry) => { const candidate = path.join(root, entry.name), stat = statPathIfPresent(candidate); return entry.isDirectory() && stat?.isDirectory() ? [candidate] : []; }).sort(); }
function listFiles(root: string): readonly string[] { const stat = statPathIfPresent(root); if (!stat) return []; if (stat.isFile()) return [root]; if (!stat.isDirectory()) return []; return (readDirIfPresent(root) ?? []).filter((entry) => entry.name !== ".git" && entry.name !== "node_modules").flatMap((entry) => listFiles(path.join(root, entry.name))).sort(); }
function readTaskId(taskDir: string): string { const body = readTextFileIfPresent(path.join(taskDir, "INDEX.md")), frontmatter = body === null ? null : readFrontmatter(body); return frontmatter ? readScalar(frontmatter, "task_id") || path.basename(taskDir) : path.basename(taskDir); }
function optional<Key extends string>(key: Key, value: string): { readonly [K in Key]?: string } { return value ? { [key]: value } as { [K in Key]: string } : {}; }
function legacyNumber(value?: string): number { return value ? Number(value.slice(1)) : Number.MAX_SAFE_INTEGER; }
function fulfillment(value: unknown): NonNullable<RelationCoverageRow["fulfillment"]> { return value === "delivered" || value === "standing-policy" || value === "standing_policy" ? value.replace("_", "-") as NonNullable<RelationCoverageRow["fulfillment"]> : "evidenced"; }
function sameDecision(ref: string, decisionRef: string): boolean { return ref === decisionRef || ref.startsWith(`${decisionRef}/`); }
function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isRelation(value: unknown): value is EntityRelationRecord { return isRecord(value) && typeof value.relation_id === "string" && typeof value.source === "string" && typeof value.target === "string"; }
function byFactRef(a: FactAnchorRow, b: FactAnchorRow): number { return a.factRef.localeCompare(b.factRef); }
